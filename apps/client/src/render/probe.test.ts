import { afterEach, describe, expect, it, vi } from "vitest";
import * as THREE from "three/webgpu";
import { runProbe } from "./probe.ts";
import type { RenderCtx } from "./renderer.ts";
import type { Extra } from "./quality.ts";
import type { CostModel } from "./extrasPlan.ts";

const listeners = new Set<() => void>();
const fakeDocument = {
  visibilityState: "visible" as "visible" | "hidden",
  addEventListener: (type: string, cb: () => void) => type === "visibilitychange" && listeners.add(cb),
  removeEventListener: (type: string, cb: () => void) => type === "visibilitychange" && listeners.delete(cb),
};
/** The tab is hidden for a moment and shown again between two frames (only the event says so). */
function hideForAMoment() {
  for (const state of ["hidden", "visible"] as const) {
    fakeDocument.visibilityState = state;
    for (const cb of [...listeners]) cb();
  }
}

/** Main-thread ms a frame's render takes, and the display's frame interval, with these extras on. */
interface FrameCost {
  cpuMs?: (extras: readonly Extra[]) => number;
  frameMs?: (extras: readonly Extra[]) => number;
}

/**
 * A renderer on a hand-moved frame clock: every frame is 16 ms (or `frameMs(extras on)`), a render
 * takes `cpuMs(extras on)` of main thread, the GPU timer says `gpuMs`, and its busy time (WebGPU pass
 * union) `busyMs(extras on)` when given.
 */
function fakeCtx(gpuMs: number | null, busyMs?: (extras: readonly Extra[]) => number, cost: FrameCost = {}) {
  let clock = 0;
  let frameT = 0;
  vi.stubGlobal("window", {});
  vi.stubGlobal("document", fakeDocument);
  fakeDocument.visibilityState = "visible";
  listeners.clear();
  vi.stubGlobal("requestAnimationFrame", (cb: (t: number) => void) =>
    setTimeout(() => {
      frameT = Math.max(clock, frameT + (cost.frameMs?.(extras) ?? 16));
      clock = frameT;
      cb(clock);
    }, 0));
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
      clock += cost.cpuMs?.(extras) ?? 0;
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

  it("runs the caller's frame hook (the world update) in every warm-up as well as the measurements", async () => {
    const { ctx } = fakeCtx(3); // Medium, then the re-probe at High: two warm-ups
    let bar = 0;
    const hookAt: number[] = [];
    await runProbe(ctx, () => hookAt.push(bar), (f) => (bar = f));
    // The bar: Medium's warm-up to 0.45, its measurement to 0.7, High's warm-up to 0.85, its measurement on.
    expect(hookAt.some((f) => f < 0.45), "Medium's warm-up").toBe(true);
    expect(hookAt.some((f) => f >= 0.7 && f < 0.85), "High's warm-up").toBe(true);
    expect(hookAt.some((f) => f >= 0.85), "High's measurement").toBe(true);
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
    // three's sum is implausible (52 ms at 60 fps, the M1); the busy time is 6.5 ms, 7.2 with extras on
    const { ctx, calls } = fakeCtx(52, (on) => (on.length ? 7.2 : 6.5));
    const r = await runProbe(ctx, undefined, undefined, model);
    expect(calls[0]).toEqual({ tier: "medium", extras: [] }); // never measures with saved extras
    // look per ms: 30, 20; grass would pass the busiest-scene tail budget (extrasBudget: 7.9 ms at 60 Hz)
    expect(calls[1]).toEqual({ tier: "medium", extras: ["normals", "water2"] });
    expect(r).toMatchObject({ tier: "medium", valid: true, method: "gpu-busy", gpuP50: 6.5, extras: ["normals", "water2"], extrasGpuP50: 7.2 });
  });

  it("plans nothing where the probe view's busy time already fills the tail budget (the M1: 7.1–7.7 ms)", async () => {
    const { ctx, calls } = fakeCtx(52, () => 7.9);
    const r = await runProbe(ctx, undefined, undefined, model);
    expect(calls).toHaveLength(1);
    expect(r).toMatchObject({ tier: "medium", extras: [] });
  });

  it("drops the extras the second measurement doesn't fit", async () => {
    const { ctx } = fakeCtx(52, (on) => (on.length ? 9 : 6.5));
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

  it("falls back from a High that misses its own budget to Medium, with the extras Medium's measurement allows", async () => {
    // Medium 5 ms (→ re-probe at High), High 12 ms (over its 10 ms), Medium with extras 5.6 ms
    let tier = "medium";
    const { ctx, calls } = fakeCtx(52, (on) => (tier === "high" ? 12 : on.length ? 5.6 : 5));
    const setTier = ctx.setTier.bind(ctx);
    (ctx as { setTier: typeof ctx.setTier }).setTier = (t, o) => {
      tier = t;
      setTier(t, o);
    };
    const r = await runProbe(ctx, undefined, undefined, model);
    expect(calls.map((c) => c.tier)).toEqual(["medium", "high", "medium"]);
    expect(r).toMatchObject({ tier: "medium", highGpuP50: 12, gpuP50: 5, extras: ["normals", "water2"], extrasGpuP50: 5.6 });
  });

  it("drops extras whose GPU time fits when the main thread slows with them (CPU over baseline and budget)", async () => {
    // GPU 6.5 → 7.2 ms fits (as above); the main thread goes 2 → 6 ms a frame, past its 3 ms budget
    const { ctx, calls } = fakeCtx(52, (on) => (on.length ? 7.2 : 6.5), { cpuMs: (on) => (on.length ? 6 : 2) });
    const r = await runProbe(ctx, undefined, undefined, model);
    expect(calls[1]).toEqual({ tier: "medium", extras: ["normals", "water2"] }); // planned and measured
    expect(r).toMatchObject({ tier: "medium", valid: true, cpuP50: 2, extrasGpuP50: 7.2, extras: [] });
  });

  it("drops extras whose GPU time fits when the frames slow with them (frame interval over the display's)", async () => {
    const { ctx } = fakeCtx(52, (on) => (on.length ? 7.2 : 6.5), { frameMs: (on) => (on.length ? 33 : 16) });
    const r = await runProbe(ctx, undefined, undefined, model);
    expect(r).toMatchObject({ tier: "medium", valid: true, extrasGpuP50: 7.2, extras: [] });
  });

  it("keeps extras whose main-thread and frame costs stay inside the budget", async () => {
    // 1 → 2 ms of main thread is double, but inside the 3 ms budget; frames stay on the display's 16 ms
    const { ctx } = fakeCtx(52, (on) => (on.length ? 7.2 : 6.5), { cpuMs: (on) => (on.length ? 2 : 1) });
    const r = await runProbe(ctx, undefined, undefined, model);
    expect(r.extras).toEqual(["normals", "water2"]);
  });
});

describe("runProbe and a tab hidden at any stage (whole-probe visibility)", () => {
  const model: CostModel = { normals: { value: 3, gpu: 0.1, cpu: 0 }, water2: { value: 1, gpu: 0.05, cpu: 0 } };
  /** Hide the tab for a moment the first time the probe's bar is inside (a, b]. */
  const hideWithin = (a: number, b: number) => {
    let done = false;
    return (f: number) => {
      if (done || f <= a || f > b) return;
      done = true;
      hideForAMoment();
    };
  };
  const invalid = { tier: "medium", valid: false, method: "invalid", extras: [] };

  it("is still valid with the tab shown throughout (the case below without the hiding)", async () => {
    const r = await runProbe(fakeCtx(52, (on) => (on.length ? 5.6 : 5)).ctx, undefined, undefined, model);
    expect(r).toMatchObject({ valid: true });
    expect(listeners.size).toBe(0); // the watcher is gone after the probe
  });

  it("Medium's warm-up", async () => {
    const r = await runProbe(fakeCtx(52, () => 6.5).ctx, undefined, hideWithin(0, 0.45), model);
    expect(r).toMatchObject(invalid);
  });

  it("the extras' warm-up and measurement: no extras, nothing saved", async () => {
    for (const [a, b] of [[0.9, 0.95], [0.95, 0.999]] as const) {
      const { ctx, calls } = fakeCtx(52, (on) => (on.length ? 7.2 : 6.5));
      const r = await runProbe(ctx, undefined, hideWithin(a, b), model);
      expect(calls[1]?.extras).toEqual(["normals", "water2"]); // it got that far
      expect(r).toMatchObject(invalid);
      expect(listeners.size).toBe(0);
    }
  });

  it("the High re-probe's warm-up and measurement: Medium for the session, not High", async () => {
    for (const [a, b] of [[0.7, 0.85], [0.85, 0.9]] as const) {
      const { ctx, tiers } = fakeCtx(52, () => 3); // Medium 3 ms → re-probe at High (3 ms → Ultra)
      const r = await runProbe(ctx, undefined, hideWithin(a, b), model);
      expect(tiers).toContain("high"); // it got that far
      expect(r).toMatchObject(invalid);
    }
  });

  it("a hidden tab between the High re-probe and the extras (High missed: Medium with extras)", async () => {
    let tier = "medium";
    const { ctx, calls } = fakeCtx(52, (on) => (tier === "high" ? 12 : on.length ? 5.6 : 5));
    const setTier = ctx.setTier.bind(ctx);
    (ctx as { setTier: typeof ctx.setTier }).setTier = (t, o) => {
      tier = t;
      if (calls.length === 2) hideForAMoment(); // as the extras go on
      setTier(t, o);
    };
    const r = await runProbe(ctx, undefined, undefined, model);
    expect(r).toMatchObject(invalid);
  });
});
