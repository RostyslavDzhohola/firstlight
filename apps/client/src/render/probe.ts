// Quality auto-pick (SPEC §7.3): software / blocklisted adapters → Low; otherwise a ~2 s probe at
// Medium on the current view, decided by decideProbe() (timing.ts): GPU timestamps where available,
// the GPU's busy time on WebGPU (D-framerate-2) (p50 < 6 ms → High, then a short re-probe at High for
// Ultra; > 14 ms → Low), else rAF time (vsync-limited: only "too slow" or a very fast high-refresh
// display can be told apart).
// A probe with fewer than 30 frames or a hidden tab is invalid: Medium for this session, not saved.
// On Medium with a busy-time reading, the probe also plans the High extras this device's headroom
// pays for and measures again with them on, keeping only what that measurement fits (D-framerate-3).

import { isSoftwareRenderer, type RenderCtx } from "./renderer.ts";
import { beginManualFrame, decideProbe, decideUltra, percentile, PROBE_MIN_GPU, type TimestampSource } from "./timing.ts";
import { warmup } from "./warmup.ts";
import { EXTRA_COSTS, extrasBudget, keepExtras, planExtras, type CostModel } from "./extrasPlan.ts";
import { TIER_TABLE, type Extra, type Tier } from "./quality.ts";

export interface ProbeResult {
  tier: Tier;
  /** False → apply for this session only (`ctx.setProbedTier(tier, { persist: false })`). */
  valid: boolean;
  method: "software" | "gpu-busy" | "gpu-timer" | "raf" | "invalid" | "error";
  gpuP50: number | null;
  rafP50: number;
  highGpuP50: number | null;
  /** Main-thread ms per probe frame (world update + render submission), p50. */
  cpuP50: number | null;
  /** The extras on top of the tier (Medium only, D-framerate-3), and the busy time measured with them. */
  extras: Extra[];
  extrasGpuP50: number | null;
  ms: number;
}

const nextFrame = () => new Promise<number>((r) => requestAnimationFrame((t) => r(t)));
const visible = () => typeof document === "undefined" || document.visibilityState === "visible";

async function measure(ctx: RenderCtx, ms: number, beforeFrame?: () => void, onFrac?: (f: number) => void): Promise<{ gpu: number[]; busy: number[]; raf: number[]; cpu: number[]; visible: boolean }> {
  const raf: number[] = [];
  const cpu: number[] = [];
  let stayedVisible = visible();
  const src = ctx.renderer as unknown as TimestampSource;
  ctx.gpu.drain();
  ctx.gpu.drainBusy();
  let last = await nextFrame();
  const begin = last;
  const end = last + ms;
  for (;;) {
    const c0 = performance.now();
    beforeFrame?.();
    beginManualFrame(src);
    ctx.render();
    cpu.push(performance.now() - c0);
    ctx.gpu.frame();
    const t = await nextFrame();
    raf.push(t - last);
    last = t;
    onFrac?.((t - begin) / ms);
    stayedVisible &&= visible();
    if (t >= end) break;
  }
  // Let the last timestamp resolves land.
  await nextFrame();
  await nextFrame();
  return { gpu: ctx.gpu.drain(), busy: ctx.gpu.drainBusy(), raf, cpu, visible: stayedVisible };
}

/**
 * Never throws: failures come back as an invalid Medium result. `onProgress(0–1)` moves through the
 * warm-up and the measurement (and the re-probe at High, when there is one), monotonic, ending at 1.
 */
export async function runProbe(ctx: RenderCtx, beforeFrame?: () => void, onProgress?: (frac: number) => void, costs: CostModel = EXTRA_COSTS): Promise<ProbeResult> {
  let shown = 0;
  const report = (f: number) => {
    const next = Math.max(shown, Math.min(1, f));
    if (next === shown && f !== 1) return;
    shown = next;
    onProgress?.(shown);
  };
  try {
    return await probeTier(ctx, beforeFrame, (a, b) => (f) => report(a + (b - a) * f), costs);
  } finally {
    report(1);
  }
}

/** The probe itself; `part(a, b)` reports a stage's own 0–1 as a…b of the probe's bar. */
async function probeTier(ctx: RenderCtx, beforeFrame: (() => void) | undefined, part: (a: number, b: number) => (f: number) => void, costs: CostModel): Promise<ProbeResult> {
  const t0 = performance.now();
  if (isSoftwareRenderer(ctx.gpuName)) {
    return { tier: "low", valid: true, method: "software", gpuP50: null, rafP50: 0, highGpuP50: null, cpuP50: null, extras: [], extrasGpuP50: null, ms: 0 };
  }
  try {
    ctx.setTier("medium", { persist: false, auto: true, extras: [] }); // plain Medium, whatever was saved
    await warmup(ctx, { frames: 3, beforeFrame, label: "probe", onProgress: (p) => part(0, 0.45)(p.frac) });
    const m = await measure(ctx, 2000, beforeFrame, part(0.45, 0.7));
    // Drop the first few frames (pipeline creation tails).
    const d = decideProbe({ raf: m.raf.slice(3), gpu: m.gpu.slice(2), busy: m.busy.slice(2), gpuAvailable: ctx.gpu.available, visible: m.visible });
    const cpuP50 = m.cpu.length > 3 ? percentile(m.cpu.slice(3), 0.5) : null;
    let tier = d.tier;
    let highGpuP50: number | null = null;
    let extras: Extra[] = [];
    let extrasGpuP50: number | null = null;
    if (d.valid && d.reprobeHigh) {
      ctx.setTier("high", { persist: false, auto: true, extras: [] });
      await warmup(ctx, { frames: 3, beforeFrame, label: "probe", onProgress: (p) => part(0.7, 0.85)(p.frac) });
      const h = await measure(ctx, 1200, beforeFrame, part(0.85, 0.9));
      const u = h.visible ? decideUltra(h.gpu.slice(2), h.busy.slice(2)) : { tier: "high" as Tier, gpuP50: null };
      tier = u.tier; // Medium again when High missed its own budget (frame rate first)
      highGpuP50 = u.gpuP50;
    }
    if (d.valid && tier === "medium" && d.method === "gpu-busy" && d.gpuP50 !== null) {
      const budgetMs = extrasBudget(d.rafP50, TIER_TABLE.medium.gpuTargetMs); // the busiest scenes' tail too
      const plan = planExtras({ gpuMs: d.gpuP50, cpuMs: cpuP50, frameMs: d.rafP50, budgetMs }, costs);
      if (plan.extras.length) {
        ctx.setTier("medium", { persist: false, auto: true, extras: plan.extras });
        await warmup(ctx, { frames: 3, beforeFrame, label: "probe", onProgress: (p) => part(0.9, 0.95)(p.frac) });
        const v = await measure(ctx, 1200, beforeFrame, part(0.95, 1)); // as long as the High re-probe
        const busy = v.busy.slice(2);
        if (v.visible && busy.length >= PROBE_MIN_GPU) {
          extrasGpuP50 = percentile(busy, 0.5);
          extras = keepExtras(plan, extrasGpuP50, budgetMs, costs);
        }
      }
    }
    return { tier, valid: d.valid, method: d.method, gpuP50: d.gpuP50, rafP50: d.rafP50, highGpuP50, cpuP50, extras, extrasGpuP50, ms: performance.now() - t0 };
  } catch (e) {
    console.warn("[gfx] probe failed, using medium for this session", e);
    return { tier: "medium", valid: false, method: "error", gpuP50: null, rafP50: 0, highGpuP50: null, cpuP50: null, extras: [], extrasGpuP50: null, ms: performance.now() - t0 };
  }
}
