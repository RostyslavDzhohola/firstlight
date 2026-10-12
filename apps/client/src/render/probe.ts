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

async function measure(ctx: RenderCtx, ms: number, beforeFrame?: () => void): Promise<{ gpu: number[]; raf: number[]; visible: boolean }> {
  const raf: number[] = [];
  let stayedVisible = visible();
  const src = ctx.renderer as unknown as TimestampSource;
  ctx.gpu.drain();
  let last = await nextFrame();
  const end = last + ms;
  for (;;) {
    beforeFrame?.();
    beginManualFrame(src);
    ctx.render();
    ctx.gpu.frame();
    const t = await nextFrame();
    raf.push(t - last);
    last = t;
    stayedVisible &&= visible();
    if (t >= end) break;
  }
  // Let the last timestamp resolves land.
  await nextFrame();
  await nextFrame();
  return { gpu: ctx.gpu.drain(), raf, visible: stayedVisible };
}

/** Never throws: failures come back as an invalid Medium result. */
export async function runProbe(ctx: RenderCtx, beforeFrame?: () => void): Promise<ProbeResult> {
  const t0 = performance.now();
  if (isSoftwareRenderer(ctx.gpuName)) {
    return { tier: "low", valid: true, method: "software", gpuP50: null, rafP50: 0, highGpuP50: null, ms: 0 };
  }
  try {
    ctx.setTier("medium", { persist: false, auto: true });
    await warmup(ctx, { frames: 3, beforeFrame });
    const m = await measure(ctx, 2000, beforeFrame);
    // Drop the first few frames (pipeline creation tails).
    const d = decideProbe({ raf: m.raf.slice(3), gpu: m.gpu.slice(2), gpuAvailable: ctx.gpu.available, visible: m.visible });
    let tier = d.tier;
    let highGpuP50: number | null = null;
    if (d.valid && d.reprobeHigh) {
      ctx.setTier("high", { persist: false, auto: true });
      await warmup(ctx, { frames: 3, beforeFrame });
      const h = await measure(ctx, 1200, beforeFrame);
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
