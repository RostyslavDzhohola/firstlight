import { afterEach, describe, expect, it, vi } from "vitest";
import * as THREE from "three/webgpu";
import { runProbe } from "./probe.ts";
import type { RenderCtx } from "./renderer.ts";

/** A renderer on a hand-moved frame clock: every frame is 16 ms, the GPU timer says `gpuMs`. */
function fakeCtx(gpuMs: number | null) {
  let clock = 0;
  vi.stubGlobal("window", {});
  vi.stubGlobal("document", { visibilityState: "visible" });
  vi.stubGlobal("requestAnimationFrame", (cb: (t: number) => void) => setTimeout(() => cb((clock += 16)), 0));
  vi.spyOn(performance, "now").mockImplementation(() => clock);
  const tiers: string[] = [];
  let pending: number[] = [];
  const ctx = {
    scene: new THREE.Scene(),
    camera: new THREE.PerspectiveCamera(),
    webgpu: true,
    tier: "medium",
    gpuName: "Apple M1",
    renderer: { debug: {}, info: { frame: 0, reset() {} }, compileAsync: async () => {} },
    setTier: (t: string) => void tiers.push(t),
    render() {
      if (gpuMs !== null) pending.push(gpuMs);
    },
    gpu: {
      available: gpuMs !== null,
      frame() {},
      drain: () => {
        const out = pending;
        pending = [];
        return out;
      },
      drainBusy: () => [],
    },
  } as unknown as RenderCtx;
  return { ctx, tiers };
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
