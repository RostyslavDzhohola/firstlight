// Quality auto-pick (SPEC §7.3): software / blocklisted adapters → Low; otherwise a ~2 s probe at
// Medium on the current view, decided by decideProbe() (timing.ts): GPU timestamps where available
// (p50 < 6 ms → High, then a short re-probe at High for Ultra; > 14 ms → Low), else rAF time
// (vsync-limited: only "too slow" or a very fast high-refresh display can be told apart).
// A probe with fewer than 30 frames or a hidden tab is invalid: Medium for this session, not saved.

import { isSoftwareRenderer, type RenderCtx } from "./renderer.ts";
import { beginManualFrame, decideProbe, decideUltra, type TimestampSource } from "./timing.ts";
import { warmup } from "./warmup.ts";
import type { Tier } from "./quality.ts";

export interface ProbeResult {
  tier: Tier;
  /** False → apply for this session only (`ctx.setProbedTier(tier, { persist: false })`). */
  valid: boolean;
  method: "software" | "gpu-timer" | "raf" | "invalid" | "error";
  gpuP50: number | null;
  rafP50: number;
  highGpuP50: number | null;
  ms: number;
}

const nextFrame = () => new Promise<number>((r) => requestAnimationFrame((t) => r(t)));
const visible = () => typeof document === "undefined" || document.visibilityState === "visible";

async function measure(ctx: RenderCtx, ms: number, beforeFrame?: () => void, onFrac?: (f: number) => void): Promise<{ gpu: number[]; raf: number[]; visible: boolean }> {
  const raf: number[] = [];
  let stayedVisible = visible();
  const src = ctx.renderer as unknown as TimestampSource;
  ctx.gpu.drain();
  let last = await nextFrame();
  const begin = last;
  const end = last + ms;
  for (;;) {
    beforeFrame?.();
    beginManualFrame(src);
    ctx.render();
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
  return { gpu: ctx.gpu.drain(), raf, visible: stayedVisible };
}

/**
 * Never throws: failures come back as an invalid Medium result. `onProgress(0–1)` moves through the
 * warm-up and the measurement (and the re-probe at High, when there is one), monotonic, ending at 1.
 */
export async function runProbe(ctx: RenderCtx, beforeFrame?: () => void, onProgress?: (frac: number) => void): Promise<ProbeResult> {
  let shown = 0;
  const report = (f: number) => {
    const next = Math.max(shown, Math.min(1, f));
    if (next === shown && f !== 1) return;
    shown = next;
    onProgress?.(shown);
  };
  try {
    return await probeTier(ctx, beforeFrame, (a, b) => (f) => report(a + (b - a) * f));
  } finally {
    report(1);
  }
}

/** The probe itself; `part(a, b)` reports a stage's own 0–1 as a…b of the probe's bar. */
async function probeTier(ctx: RenderCtx, beforeFrame: (() => void) | undefined, part: (a: number, b: number) => (f: number) => void): Promise<ProbeResult> {
  const t0 = performance.now();
  if (isSoftwareRenderer(ctx.gpuName)) {
    return { tier: "low", valid: true, method: "software", gpuP50: null, rafP50: 0, highGpuP50: null, ms: 0 };
  }
  try {
    ctx.setTier("medium", { persist: false, auto: true });
    await warmup(ctx, { frames: 3, beforeFrame, label: "probe", onProgress: (p) => part(0, 0.45)(p.frac) });
    const m = await measure(ctx, 2000, beforeFrame, part(0.45, 0.7));
    // Drop the first few frames (pipeline creation tails).
    const d = decideProbe({ raf: m.raf.slice(3), gpu: m.gpu.slice(2), gpuAvailable: ctx.gpu.available, visible: m.visible });
    let tier = d.tier;
    let highGpuP50: number | null = null;
    if (d.valid && d.reprobeHigh) {
      ctx.setTier("high", { persist: false, auto: true });
      await warmup(ctx, { frames: 3, beforeFrame, label: "probe", onProgress: (p) => part(0.7, 0.9)(p.frac) });
      const h = await measure(ctx, 1200, beforeFrame, part(0.9, 1));
      const u = h.visible ? decideUltra(h.gpu.slice(2)) : { tier: "high" as Tier, gpuP50: null };
      tier = u.tier;
      highGpuP50 = u.gpuP50;
    }
    return { tier, valid: d.valid, method: d.method, gpuP50: d.gpuP50, rafP50: d.rafP50, highGpuP50, ms: performance.now() - t0 };
  } catch (e) {
    console.warn("[gfx] probe failed, using medium for this session", e);
    return { tier: "medium", valid: false, method: "error", gpuP50: null, rafP50: 0, highGpuP50: null, ms: performance.now() - t0 };
  }
}
