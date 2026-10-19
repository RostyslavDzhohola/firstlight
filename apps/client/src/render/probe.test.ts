import { afterEach, describe, expect, it, vi } from "vitest";
import * as THREE from "three/webgpu";
import { runProbe } from "./probe.ts";
import type { RenderCtx } from "./renderer.ts";
import type { Extra } from "./quality.ts";
import type { CostModel } from "./extrasPlan.ts";

/**
 * A renderer on a hand-moved frame clock: every frame is 16 ms, the GPU timer says `gpuMs`, and its
 * busy time (WebGPU pass union) `busyMs(extras on)` when given.
 */
function fakeCtx(gpuMs: number | null, busyMs?: (extras: readonly Extra[]) => number) {
  let clock = 0;
  vi.stubGlobal("window", {});
  vi.stubGlobal("document", { visibilityState: "visible" });
  vi.stubGlobal("requestAnimationFrame", (cb: (t: number) => void) => setTimeout(() => cb((clock += 16)), 0));
  vi.spyOn(performance, "now").mockImplementation(() => clock);
  const tiers: string[] = [];
  const calls: { tier: string; extras: readonly Extra[] | undefined }[] = [];
  let extras: readonly Extra[] = [];
  let pending: number[] = [];
  let busy: number[] = [];
  const ctx = {
    scene: new THREE.Scene(),
    camera: new THREE.PerspectiveCamera(),
    webgpu: true,
    tier: "medium",
    gpuName: "Apple M1",
    renderer: { debug: {}, info: { frame: 0, reset() {} }, compileAsync: async () => {} },
    setTier: (t: string, opts?: { extras?: readonly Extra[] }) => {
      tiers.push(t);
      calls.push({ tier: t, extras: opts?.extras });
      extras = opts?.extras ?? [];
    },
    render() {
      if (gpuMs !== null) pending.push(gpuMs);
      if (busyMs) busy.push(busyMs(extras));
    },
    gpu: {
      available: gpuMs !== null,
      frame() {},
      drain: () => {
        const out = pending;
        pending = [];
        return out;
      },
      drainBusy: () => {
        const out = busy;
        busy = [];
        return out;
      },
    },
  } as unknown as RenderCtx;
  return { ctx, tiers, calls };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("runProbe progress (first visit: Tuning graphics…)", () => {
  it("moves monotonically through its warm-up and measurement to 1 (one pass)", async () => {
    const { ctx } = fakeCtx(null);
    const seen: number[] = [];
    await runProbe(ctx, undefined, (f) => seen.push(f));
    expect(seen.length).toBeGreaterThan(20); // warm-up steps and every measured frame
    for (let i = 1; i < seen.length; i++) expect(seen[i]!).toBeGreaterThanOrEqual(seen[i - 1]!);
    expect(seen.some((f) => f > 0.1 && f < 0.6)).toBe(true); // it moves through the measurement
    expect(seen.at(-1)).toBe(1);
  });

  it("covers the re-probe at High too, still monotonic", async () => {
    const { ctx, tiers } = fakeCtx(3); // fast GPU: re-probe at High for Ultra
    const seen: number[] = [];
    await runProbe(ctx, undefined, (f) => seen.push(f));
    expect(tiers).toEqual(["medium", "high"]);
    for (let i = 1; i < seen.length; i++) expect(seen[i]!).toBeGreaterThanOrEqual(seen[i - 1]!);
    expect(seen.some((f) => f > 0.7 && f < 1)).toBe(true); // the second pass has its own share
    expect(seen.at(-1)).toBe(1);
  });
});

describe("runProbe extras on Medium (D-framerate-3)", () => {
  const model: CostModel = { normals: { value: 3, gpu: 0.1, cpu: 0 }, water2: { value: 1, gpu: 0.05, cpu: 0 }, grass: { value: 1, gpu: 0.8, cpu: 0 } };

  it("measures plain Medium, plans from its busy time, and keeps what the second measurement fits", async () => {
    // three's sum is implausible (52 ms at 60 fps, the M1); the busy time is 8 ms, 8.9 with extras on
    const { ctx, calls } = fakeCtx(52, (on) => (on.length ? 8.9 : 8));
    const r = await runProbe(ctx, undefined, undefined, model);
    expect(calls[0]).toEqual({ tier: "medium", extras: [] }); // never measures with saved extras
    expect(calls[1]).toEqual({ tier: "medium", extras: ["normals", "water2"] }); // look per ms: 30, 20; grass would pass 12 ms
    expect(r).toMatchObject({ tier: "medium", valid: true, method: "gpu-busy", gpuP50: 8, extras: ["normals", "water2"], extrasGpuP50: 8.9 });
  });

  it("drops the extras the second measurement doesn't fit", async () => {
    const { ctx } = fakeCtx(52, (on) => (on.length ? 13.5 : 8));
    const r = await runProbe(ctx, undefined, undefined, model);
    expect(r.extras).toEqual([]);
    expect(r.tier).toBe("medium");
  });

  it("adds nothing without a busy time, or off Medium", async () => {
    const none = await runProbe(fakeCtx(52).ctx, undefined, undefined, model); // frame time only
    expect(none).toMatchObject({ tier: "medium", method: "raf", extras: [] });
    const fast = fakeCtx(52, () => 4); // High (re-probed), never extras
    const high = await runProbe(fast.ctx, undefined, undefined, model);
    expect(high.tier).not.toBe("medium");
    expect(high.extras).toEqual([]);
    expect(fast.calls.every((c) => c.extras?.length === 0)).toBe(true);
  });
});
