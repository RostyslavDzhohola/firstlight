// Quality auto-pick (SPEC §7.3): software / blocklisted adapters → Low; otherwise a ~2 s probe at
// Medium on the spawn view. GPU timestamp queries where available (p50 < 6 ms → High, then a short
// re-probe at High: p50 < 4 ms → Ultra; p50 > 14 ms → Low). Without a GPU timer only rAF time is
// available, which is vsync-limited, so it can only detect "too slow" (> 20 ms → Low) or a very
// fast high-refresh display (< 6 ms → High).

import { isSoftwareRenderer, type RenderCtx } from "./renderer.ts";
import { percentile } from "./timing.ts";
import { warmup } from "./warmup.ts";
import type { Tier } from "./quality.ts";

export interface ProbeResult {
  tier: Tier;
  method: "software" | "gpu-timer" | "raf";
  gpuP50: number | null;
  rafP50: number;
  highGpuP50: number | null;
  ms: number;
}

const nextFrame = () => new Promise<number>((r) => requestAnimationFrame((t) => r(t)));

async function measure(ctx: RenderCtx, ms: number, beforeFrame?: () => void): Promise<{ gpu: number[]; raf: number[] }> {
  const raf: number[] = [];
  ctx.gpu.drain();
  let last = await nextFrame();
  const end = last + ms;
  for (;;) {
    beforeFrame?.();
    ctx.render();
    ctx.gpu.frame();
    const t = await nextFrame();
    raf.push(t - last);
    last = t;
    if (t >= end) break;
  }
  // Let the last timestamp resolves land.
  await nextFrame();
  await nextFrame();
  return { gpu: ctx.gpu.drain(), raf };
}

export async function runProbe(ctx: RenderCtx, beforeFrame?: () => void): Promise<ProbeResult> {
  const t0 = performance.now();
  if (isSoftwareRenderer(ctx.gpuName)) {
    return { tier: "low", method: "software", gpuP50: null, rafP50: 0, highGpuP50: null, ms: 0 };
  }
  ctx.setTier("medium", { persist: false, auto: true });
  await warmup(ctx, { frames: 3, beforeFrame });
  const m = await measure(ctx, 2000, beforeFrame);
  // Drop the first few samples (pipeline creation tails).
  const gpu = m.gpu.slice(3);
  const raf = m.raf.slice(3);
  const rafP50 = percentile(raf, 0.5);
  if (ctx.gpu.available && gpu.length >= 8) {
    const g = percentile(gpu, 0.5);
    if (g > 14) return { tier: "low", method: "gpu-timer", gpuP50: g, rafP50, highGpuP50: null, ms: performance.now() - t0 };
    if (g >= 6) return { tier: "medium", method: "gpu-timer", gpuP50: g, rafP50, highGpuP50: null, ms: performance.now() - t0 };
    // Fast at Medium: re-probe at High for Ultra.
    ctx.setTier("high", { persist: false, auto: true });
    await warmup(ctx, { frames: 3, beforeFrame });
    const h = await measure(ctx, 1200, beforeFrame);
    const hg = h.gpu.length >= 6 ? percentile(h.gpu.slice(2), 0.5) : null;
    const tier: Tier = hg !== null && hg < 4 ? "ultra" : "high";
    return { tier, method: "gpu-timer", gpuP50: g, rafP50, highGpuP50: hg, ms: performance.now() - t0 };
  }
  const tier: Tier = rafP50 > 20 ? "low" : rafP50 < 6 ? "high" : "medium";
  return { tier, method: "raf", gpuP50: null, rafP50, highGpuP50: null, ms: performance.now() - t0 };
}
