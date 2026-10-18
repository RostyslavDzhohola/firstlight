import { describe, expect, it } from "vitest";
import { emptyStored, parseStored, validAutoTier } from "./quality.ts";
import {
  beginManualFrame, decideProbe, decideUltra, GpuTimer, LADDER, maxOf, percentile, ResolutionLadder, type TimestampSource,
} from "./timing.ts";

/** Feed `seconds` of frames at `frameMs`, with one GPU sample per frame when `gpuMs` is set. */
function feed(l: ResolutionLadder, t0: number, seconds: number, frameMs: number, gpuMs: number | null, target = 12): number {
  let t = t0;
  const end = t0 + seconds * 1000;
  while (t < end) {
    t += frameMs;
    l.sample(t, frameMs, gpuMs === null ? null : [gpuMs], target);
  }
  return t;
}

const flush = () => new Promise((r) => setTimeout(r, 0));

/** A renderer stand-in whose resolve returns the last frame's GPU time, like three r186. */
function fakeRenderer(opts: { webgpu?: boolean; track?: boolean } = {}) {
  const queue: number[] = [];
  const src: TimestampSource & { push(ms: number): void; resolves: number } = {
    backend: { isWebGPUBackend: opts.webgpu ?? true, trackTimestamp: opts.track ?? true, disjoint: {} },
    info: { frame: 0, reset() {} },
    resolves: 0,
    push(ms) {
      queue.push(ms);
    },
    async resolveTimestampsAsync() {
      src.resolves++;
      return queue.length ? queue[queue.length - 1] : undefined;
    },
  };
  return src;
}

describe("GpuTimer", () => {
  it("records the resolved per-frame time as is (r186 returns the last frame)", async () => {
    const r = fakeRenderer();
    const t = new GpuTimer(r);
    expect(t.available).toBe(true);
    r.push(8);
    t.frame();
    t.frame(); // while a resolve is pending: no second request
    t.frame();
    expect(r.resolves).toBe(1);
    await flush();
    expect(t.last).toBe(8);
    r.push(9.5);
    t.frame();
    await flush();
    expect(t.last).toBe(9.5);
    expect(t.takeSamples()).toEqual([8, 9.5]);
    expect(t.takeSamples()).toEqual([]);
    expect(t.p50()).toBe(9.5);
  });

  it("is unavailable without timestamp tracking (or the WebGL2 extension)", () => {
    expect(new GpuTimer(fakeRenderer({ track: false })).available).toBe(false);
    const gl = fakeRenderer({ webgpu: false });
    (gl.backend as { disjoint: unknown }).disjoint = null;
    expect(new GpuTimer(gl).available).toBe(false);
  });

  it("ignores empty or invalid resolves", async () => {
    const r = fakeRenderer();
    const t = new GpuTimer(r);
    t.frame();
    await flush();
    expect(t.last).toBeNull();
    expect(t.takeSamples()).toEqual([]);
  });

  it("beginManualFrame advances the frame tag", () => {
    const r = fakeRenderer();
    beginManualFrame(r);
    beginManualFrame(r);
    expect(r.info.frame).toBe(2);
  });
});

describe("resolution ladder", () => {
  it("stops trusting a GPU timer that reads above the frame interval", () => {
    const l = new ResolutionLadder();
    l.hasGpuTimer = true;
    // 60 fps held, timer claims 48 ms: no down-steps, and the timer is marked untrusted.
    let t = feed(l, 1000, 30, 16.7, 48);
    expect(l.scale).toBe(1);
    expect(l.gpuUntrusted).toBe(true);
    // A real slowdown is still caught from frame times alone.
    t = feed(l, t, 30, 28, 48);
    expect(l.scale).toBeLessThan(1);
  });

  it("steps down when frames are slow, then asks to drop a tier at the floor", () => {
    const l = new ResolutionLadder();
    let floors = 0;
    l.onFloor = () => floors++;
    let t = feed(l, 1000, 60, 28, null);
    expect(l.scale).toBe(LADDER[LADDER.length - 1]);
    t = feed(l, t, 20, 28, null);
    expect(floors).toBeGreaterThan(0);
  });

  it("keeps adapting below 10 fps (slow windows aren't discarded)", () => {
    const l = new ResolutionLadder();
    let floors = 0;
    l.onFloor = () => floors++;
    feed(l, 1000, 120, 300, null); // ~3 fps
    expect(l.index).toBe(LADDER.length - 1);
    expect(floors).toBeGreaterThan(0);
  });

  it("holds steady at the vsync rate and never steps up without a GPU timer", () => {
    const l = new ResolutionLadder();
    let t = feed(l, 1000, 60, 16.7, null);
    expect(l.index).toBe(0);
    t = feed(l, t, 10, 30, null);
    expect(l.index).toBeGreaterThan(0);
    t = feed(l, t, 10, 16.7, null); // let the window that straddles the change close
    const after = l.index;
    feed(l, t, 600, 16.7, null);
    expect(l.index).toBe(after);
  });

  it("steps back up with GPU headroom after the hold-off", () => {
    const l = new ResolutionLadder();
    l.hasGpuTimer = true;
    let t = feed(l, 1000, 8, 30, 20);
    expect(l.index).toBeGreaterThan(0);
    const after = l.index;
    t = feed(l, t, 15, 16.7, 4);
    expect(l.index).toBe(after); // still held off
    feed(l, t, 120, 16.7, 4);
    expect(l.index).toBe(0);
  });

  it("backs off exponentially when up-steps don't hold", () => {
    const l = new ResolutionLadder();
    l.hasGpuTimer = true;
    const ups: number[] = [];
    let last = l.index;
    l.onChange = () => {
      if (l.index < last) ups.push(t);
      last = l.index;
    };
    let t = 1000;
    // Alternate: cheap at the lower resolution, expensive at full resolution.
    for (let k = 0; k < 400; k++) {
      const gpu = l.index === 0 ? 20 : 4;
      const frame = l.index === 0 ? 30 : 16.7;
      t = feed(l, t, 5, frame, gpu);
    }
    expect(ups.length).toBeGreaterThan(1);
    const gaps = ups.slice(1).map((u, i) => u - ups[i]!);
    expect(gaps[gaps.length - 1]!).toBeGreaterThan(gaps[0]!);
  });

  it("uses only the current window's GPU samples", () => {
    const l = new ResolutionLadder();
    l.hasGpuTimer = true;
    // A long expensive history followed by cheap frames: no down-step from stale samples.
    let t = feed(l, 1000, 1.9, 16.7, 40);
    t = feed(l, t, 30, 16.7, 4);
    expect(l.index).toBe(0);
  });

  it("takes a forced step (the e2e hook's) at the next sample, the way a natural step happens", () => {
    const l = new ResolutionLadder();
    const seen: number[] = [];
    l.onChange = () => seen.push(l.index);
    l.forceStep(1);
    expect(l.index).toBe(0); // nothing until the frame's bookkeeping samples
    let t = feed(l, 1000, 0.02, 16.7, null);
    expect(seen).toEqual([1]);
    l.forceStep(1);
    l.forceStep(1); // one step per request, not queued
    t = feed(l, t, 0.02, 16.7, null);
    expect(seen).toEqual([1, 2]);
    l.forceStep(-1);
    t = feed(l, t, 0.02, 16.7, null);
    l.forceStep(-1);
    t = feed(l, t, 0.02, 16.7, null);
    l.forceStep(-1); // already at the top: no change, no callback
    feed(l, t, 0.02, 16.7, null);
    expect(seen).toEqual([1, 2, 1, 0]);
    expect(l.index).toBe(0);
  });

  it("disabled ladder never changes", () => {
    const l = new ResolutionLadder();
    l.enabled = false;
    feed(l, 1000, 30, 40, null);
    expect(l.index).toBe(0);
  });
});

describe("probe decision", () => {
  const frames = (n: number, ms: number) => Array.from({ length: n }, () => ms);

  it("is invalid (Medium, not saved) with too few frames or a hidden tab", () => {
    expect(decideProbe({ raf: frames(10, 16), gpu: frames(10, 3), gpuAvailable: true, visible: true })).toMatchObject({ tier: "medium", valid: false });
    expect(decideProbe({ raf: frames(120, 16), gpu: frames(60, 3), gpuAvailable: true, visible: false })).toMatchObject({ tier: "medium", valid: false });
    expect(decideProbe({ raf: [], gpu: [], gpuAvailable: false, visible: true })).toMatchObject({ tier: "medium", valid: false });
  });

  it("ignores an implausible GPU timer (M1: overlapping passes summed to 48 ms at 60 fps)", () => {
    const d = decideProbe({ raf: frames(120, 16.7), gpu: frames(60, 48), gpuAvailable: true, visible: true });
    expect(d).toMatchObject({ tier: "medium", valid: true, method: "raf" });
  });

  it("uses the GPU timer thresholds", () => {
    const base = { raf: frames(120, 16.7), gpuAvailable: true, visible: true };
    expect(decideProbe({ ...base, gpu: frames(60, 16) })).toMatchObject({ tier: "low", valid: true, method: "gpu-timer" });
    expect(decideProbe({ ...base, gpu: frames(60, 9) })).toMatchObject({ tier: "medium", reprobeHigh: false });
    expect(decideProbe({ ...base, gpu: frames(60, 4) })).toMatchObject({ tier: "high", reprobeHigh: true });
  });

  it("falls back to frame time without enough GPU samples", () => {
    const base = { gpu: frames(5, 3), gpuAvailable: true, visible: true };
    expect(decideProbe({ ...base, raf: frames(120, 16.7) })).toMatchObject({ tier: "medium", method: "raf" });
    expect(decideProbe({ ...base, raf: frames(60, 33) })).toMatchObject({ tier: "low", method: "raf" });
    expect(decideProbe({ ...base, raf: frames(400, 4.2) })).toMatchObject({ tier: "high", method: "raf" });
  });

  it("picks Ultra only with clear headroom at High", () => {
    expect(decideUltra(frames(30, 3)).tier).toBe("ultra");
    expect(decideUltra(frames(30, 5)).tier).toBe("high");
    expect(decideUltra(frames(5, 1)).tier).toBe("high");
  });
});

describe("stored graphics settings", () => {
  it("reuses the auto tier only on the same backend and GPU", () => {
    const s = { ...emptyStored(), autoTier: "high" as const, autoBackend: "webgpu", autoGpu: "apple m1" };
    expect(validAutoTier(s, "webgpu", "apple m1")).toBe("high");
    expect(validAutoTier(s, "webgl2", "apple m1")).toBeNull();
    expect(validAutoTier(s, "webgpu", "google swiftshader")).toBeNull();
  });

  it("parses junk and old shapes safely", () => {
    expect(parseStored("not json")).toEqual(emptyStored());
    expect(parseStored(JSON.stringify({ v: 1, tier: "ultra", autoTier: "high", features: { bloom: false, nope: true } }))).toEqual({
      ...emptyStored(), tier: "ultra", autoTier: "high", features: { bloom: false },
    });
    expect(parseStored(JSON.stringify({ v: 2, tier: "low" }))).toEqual(emptyStored());
  });
});

describe("helpers", () => {
  it("percentile and maxOf", () => {
    expect(percentile([], 0.5)).toBe(0);
    expect(percentile([3, 1, 2], 0.5)).toBe(2);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.95)).toBe(10);
    expect(maxOf([])).toBe(0);
    expect(maxOf(Array.from({ length: 200_000 }, (_, i) => i))).toBe(199_999);
  });
});
