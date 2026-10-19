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

  it("on WebGPU also takes each frame's busy time from three's pass timestamps (D-framerate-2)", async () => {
    const r = fakeRenderer();
    const t = new GpuTimer(r);
    expect(t.busyLast).toBeNull();
    t.frame(); // no timestamp pool yet (three makes it on the first timed pass)
    await flush();
    // three's pool: two overlapping passes in frame 1 (sum 7 ms, busy 5 ms), resolved the way three does
    const times = new BigUint64Array([0n, 4_000_000n, 2_000_000n, 5_000_000n]);
    const pool = {
      queryOffsets: new Map([["1:f1", 0], ["2:f1", 2]]),
      resultBuffer: { getMappedRange: () => times.buffer as ArrayBuffer },
      async _resolveQueries(this: { queryOffsets: Map<string, number>; resultBuffer: { getMappedRange(): ArrayBuffer } }) {
        this.queryOffsets.clear();
        this.resultBuffer.getMappedRange();
        return 7;
      },
    };
    (r.backend as { timestampQueryPool?: unknown }).timestampQueryPool = { render: pool };
    r.push(7);
    t.frame(); // finds the pool
    await pool._resolveQueries();
    await flush();
    expect(t.busyLast).toBeCloseTo(5, 6);
    expect(t.busyP50()).toBeCloseTo(5, 6);
    expect(t.takeBusySamples()).toHaveLength(1);
    expect(t.busyP50()).toBeCloseTo(5, 6); // taking keeps the display window
    expect(t.drainBusy()).toEqual([]);
    expect(t.busyP50()).toBeNull(); // draining starts a fresh one
    expect(t.last).toBe(7); // three's sum is still recorded as before
  });

  it("has no busy time on WebGL2", async () => {
    const r = fakeRenderer({ webgpu: false });
    const t = new GpuTimer(r);
    (r.backend as { timestampQueryPool?: unknown }).timestampQueryPool = { render: { queryOffsets: new Map(), resultBuffer: { getMappedRange: () => new ArrayBuffer(0) }, _resolveQueries: async () => 0 } };
    t.frame();
    await flush();
    expect(t.busyLast).toBeNull();
    expect(t.drainBusy()).toEqual([]);
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

describe("resolution ladder under full-screen overlays (D-view-4)", () => {
  /** A ladder walked down to rung `rung` by slow frames; returns it and the time. */
  function stepped(rung: number) {
    const l = new ResolutionLadder();
    let t = 1000;
    while (l.index < rung) t = feed(l, t, 0.5, 28, null);
    return { l, t };
  }

  it("takes no step while suspended, however slow the frames", () => {
    const l = new ResolutionLadder();
    let changes = 0;
    let floors = 0;
    l.onChange = () => changes++;
    l.onFloor = () => floors++;
    let t = feed(l, 1000, 1.5, 28, null); // a slow partial window before the menu opens
    l.setSuspended(true);
    expect(l.suspended).toBe(true);
    t = feed(l, t, 60, 300, null); // ~3 fps
    t = feed(l, t, 60, 40, null);
    feed(l, t, 60, 28, 48);
    expect(l.index).toBe(0);
    expect(changes).toBe(0);
    expect(floors).toBe(0);
  });

  it("resumes at the rung held when the suspension began", () => {
    const { l, t: t0 } = stepped(2);
    let t = t0;
    l.setSuspended(true);
    t = feed(l, t, 30, 120, null);
    l.forceStep(1); // e2e hook: an explicit step under the menu is the new rung to come back to
    t = feed(l, t, 0.1, 120, null);
    expect(l.index).toBe(3);
    l.setSuspended(false);
    expect(l.index).toBe(3);
    l.setSuspended(true);
    l.reset(); // a tier change from the menu's settings: full resolution, also after the menu
    l.setSuspended(false);
    expect(l.index).toBe(0);
    feed(l, t, 30, 16.7, null);
    expect(l.index).toBe(0);
  });

  it("puts a rung changed under the menu back when the menu closes", () => {
    const { l } = stepped(1);
    const seen: number[] = [];
    l.onChange = () => seen.push(l.index);
    l.setSuspended(true);
    l.index = 3; // whatever moved it while suspended (nothing in the game does today)
    l.setSuspended(false);
    expect(l.index).toBe(1);
    expect(seen).toEqual([1]); // the size follows
  });

  it("ignores samples from the first second after resuming", () => {
    const { l, t: t0 } = stepped(1);
    // Let the step's cooldown and windows settle at the vsync rate, then open and close the menu.
    let t = feed(l, t0, 10, 16.7, null);
    l.setSuspended(true);
    t = feed(l, t, 5, 40, null);
    l.setSuspended(false);
    const resumedAt = t;
    // Slow from the moment the menu closes. Counting from the resume, two ≥ 2 s windows would end at
    // +4 s; with the first second ignored they end at +3 s and +5 s.
    t = feed(l, t, 4.5, 28, null);
    expect(l.index, "only one slow window 4.5 s after resuming").toBe(1);
    while (l.index === 1 && t < resumedAt + 8000) t = feed(l, t, 0.05, 28, null);
    expect(l.index).toBe(2);
    expect(t - resumedAt).toBeGreaterThanOrEqual(5000);
    expect(t - resumedAt).toBeLessThan(5200);
  });

  it("starts fresh after resuming: a slow window from before the menu doesn't count", () => {
    const l = new ResolutionLadder();
    let t = feed(l, 1000, 2.1, 28, null); // one slow window: one more would step
    l.setSuspended(true);
    l.setSuspended(false);
    t = feed(l, t, 0.05, 16.7, null);
    const resumedAt = t;
    t = feed(l, t, 3.1, 28, null); // grace + one slow window
    expect(l.index).toBe(0);
    while (l.index === 0 && t < resumedAt + 8000) t = feed(l, t, 0.05, 28, null);
    expect(t - resumedAt).toBeGreaterThanOrEqual(4500); // carried over, it would step ~3 s after resuming
  });

  it("keeps the floor's cooldown when a short menu overlaps it", () => {
    const { l, t: t0 } = stepped(3);
    const floors: number[] = [];
    let t = t0;
    l.onFloor = () => floors.push(t);
    while (floors.length === 0 && t < t0 + 30_000) t = feed(l, t, 0.05, 28, null);
    const floorAt = floors[0]!;
    t = feed(l, t, 0.2, 28, null);
    l.setSuspended(true);
    t = feed(l, t, 0.2, 28, null);
    l.setSuspended(false); // the grace ends ~1.5 s after the floor call, inside its 6 s cooldown
    while (floors.length === 1 && t < floorAt + 30_000) t = feed(l, t, 0.05, 28, null);
    // Windows that end inside the cooldown don't count; two slow ones after it call the floor again
    // (a suspension that dropped the cooldown would call it ~5.5 s after the first).
    expect(floors[1]! - floorAt).toBeGreaterThanOrEqual(8000);
  });

  it("starts over after a menu that outlasts a step's cooldown", () => {
    const { l, t: stepAt } = stepped(1);
    const steps: number[] = [];
    let t = stepAt;
    l.onChange = () => steps.push(t);
    t = feed(l, t, 0.5, 28, null);
    l.setSuspended(true);
    t = feed(l, t, 10, 28, null);
    l.setSuspended(false);
    const resumedAt = t;
    while (steps.length === 0 && t < resumedAt + 20_000) t = feed(l, t, 0.05, 28, null);
    // Grace (1 s) and two fresh ≥ 2 s windows: the old cooldown neither blocks nor shortens it.
    expect(steps[0]! - resumedAt).toBeGreaterThanOrEqual(4900);
    expect(steps[0]! - resumedAt).toBeLessThan(5200);
  });
});

describe("trial up-steps with an untrusted GPU timer (D-view-4)", () => {
  /**
   * The M1 case: a GPU timer whose readings (48 ms at 60 fps) get it marked untrusted, then slow frames
   * walk the ladder down to `rung`. `clock.t` is the time of the frame being sampled; `ups` and `downs`
   * record when the rung changed from then on, `downAt` when the last down-step to `rung` happened.
   */
  function untrustedAt(rung: number, vsyncMs = 16.7) {
    const l = new ResolutionLadder();
    l.hasGpuTimer = true;
    const clock = { t: 1000 };
    let downAt = 0;
    l.onChange = () => (downAt = clock.t);
    run(l, clock, 4, () => vsyncMs);
    expect(l.gpuUntrusted).toBe(true);
    while (l.index < rung) run(l, clock, 0.05, () => 28);
    const ups: number[] = [];
    const downs: number[] = [];
    let last = l.index;
    l.onChange = () => {
      (l.index < last ? ups : downs).push(clock.t);
      last = l.index;
    };
    return { l, clock, downAt, ups, downs };
  }

  /** `seconds` of frames whose interval depends on the rung (a capped 60 Hz display: 16.7 ms when it holds vsync). */
  function run(l: ResolutionLadder, clock: { t: number }, seconds: number, frameAt: (rung: number) => number) {
    const end = clock.t + seconds * 1000;
    while (clock.t < end) {
      const ms = frameAt(l.index);
      clock.t += ms;
      l.sample(clock.t, ms, [48], 12);
    }
  }

  it("trial-steps up after the hold when frames stay at vsync", () => {
    const { l, clock, downAt, ups } = untrustedAt(1);
    run(l, clock, 25, () => 16.7);
    expect(l.index, "held at the lowered rung for the up-step hold-off").toBe(1);
    run(l, clock, 30, () => 16.7);
    expect(l.index).toBe(0);
    expect(ups).toHaveLength(1);
    expect(ups[0]! - downAt).toBeGreaterThanOrEqual(30_000);
    expect(ups[0]! - downAt).toBeLessThan(33_000);
    expect(l.trials.taken).toBe(1);
  });

  it("keeps the step when the following windows stay fast, and climbs on", () => {
    const { l, clock, ups, downs } = untrustedAt(2);
    run(l, clock, 600, () => 16.7);
    expect(l.index).toBe(0);
    expect(ups).toHaveLength(2);
    expect(downs).toEqual([]);
    expect(l.trials).toEqual({ taken: 2, kept: 2, reverted: 0 });
  });

  it("steps back down when the next windows miss vsync, and backs off exponentially", () => {
    // A capped 60 Hz display for 10 minutes where rung 1 holds vsync and full resolution doesn't (45 fps).
    const { l, clock, ups, downs } = untrustedAt(1);
    run(l, clock, 600, (rung) => (rung === 0 ? 22 : 16.7));
    expect(l.index).toBe(1);
    // Each trial is reverted by the first window after its cooldown.
    expect(downs).toHaveLength(ups.length);
    for (let i = 0; i < ups.length; i++) expect(downs[i]! - ups[i]!).toBeLessThan(6500);
    // Few and bounded: the hold doubles after each failed trial (30 s, 60 s, 120 s, 240 s…).
    expect(ups.length).toBeGreaterThanOrEqual(3);
    expect(ups.length).toBeLessThanOrEqual(5);
    const gaps = ups.slice(1).map((u, i) => u - ups[i]!);
    for (let i = 1; i < gaps.length; i++) expect(gaps[i]!).toBeGreaterThan(gaps[i - 1]! * 1.7);
    expect(l.trials).toEqual({ taken: ups.length, kept: 0, reverted: ups.length });
  });

  it("never trial-steps while suspended, and counts steady windows afresh after the menu", () => {
    const { l, clock, ups } = untrustedAt(1);
    run(l, clock, 25, () => 16.7); // steady, inside the hold-off
    l.setSuspended(true);
    run(l, clock, 300, () => 16.7); // the hold-off passes under the menu
    expect(ups).toEqual([]);
    l.setSuspended(false);
    const resumedAt = clock.t;
    run(l, clock, 8.5, () => 16.7); // the 1 s grace and three steady windows: not yet
    expect(ups).toEqual([]);
    run(l, clock, 4, () => 16.7);
    expect(ups).toHaveLength(1);
    expect(ups[0]! - resumedAt).toBeGreaterThanOrEqual(9000);
  });

  it("holds after a forced down-step (the e2e hook's) like after a natural one", () => {
    const { l, clock, ups } = untrustedAt(0);
    l.forceStep(1);
    run(l, clock, 0.02, () => 16.7);
    const forcedAt = clock.t;
    expect(l.index).toBe(1);
    run(l, clock, 60, () => 16.7);
    expect(ups).toHaveLength(1);
    expect(ups[0]! - forcedAt).toBeGreaterThanOrEqual(30_000);
  });

  it("judges vsync by the display's own frame interval: 50, 60 and 120 Hz", () => {
    for (const hz of [50, 60, 120]) {
      const vsync = 1000 / hz;
      const { l, clock, ups } = untrustedAt(1, vsync);
      // A steady display at its own rate: trial, kept.
      run(l, clock, 60, () => vsync);
      expect(ups, `${hz} Hz: a trial after the hold`).toHaveLength(1);
      expect(l.index, `${hz} Hz: kept`).toBe(0);
      expect(l.trials.kept, `${hz} Hz`).toBe(1);
    }
  });

  it("on a 120 Hz display, 60 fps isn't vsync-limited: no trial", () => {
    const { l, clock, ups } = untrustedAt(1, 1000 / 120);
    run(l, clock, 120, () => 16.7);
    expect(ups).toEqual([]);
    run(l, clock, 60, () => 1000 / 120);
    expect(ups).toHaveLength(1);
  });

  it("doubles the hold-off when a trial fails after a long pause under the menu", () => {
    // Trial up, the menu opens for longer than the hold-off, then slow windows after it.
    const { l, clock, ups, downs } = untrustedAt(1);
    while (ups.length === 0 && clock.t < 120_000) run(l, clock, 0.05, () => 16.7);
    expect(ups).toHaveLength(1);
    expect(l.trials.kept, "still on probation when the menu opens").toBe(0);
    l.setSuspended(true);
    run(l, clock, 45, () => 16.7);
    l.setSuspended(false);
    while (downs.length === 0 && clock.t < ups[0]! + 120_000) run(l, clock, 0.05, (rung) => (rung === 0 ? 22 : 16.7));
    expect(l.trials.reverted).toBe(1);
    // The next trial waits twice the first hold-off (60 s), not 30 s again.
    run(l, clock, 300, (rung) => (rung === 0 ? 22 : 16.7));
    expect(ups.length).toBeGreaterThanOrEqual(2);
    expect(ups[1]! - downs[0]!).toBeGreaterThanOrEqual(60_000);
  });

  it("with a trusted timer, vsync-steady frames alone never step up", () => {
    const l = new ResolutionLadder();
    l.hasGpuTimer = true;
    let t = feed(l, 1000, 8, 30, 20); // GPU over budget: steps down
    const after = l.index;
    expect(after).toBeGreaterThan(0);
    // 60 fps, the GPU at 9 ms: inside the budget but no clear headroom (not under 0.6× of 12 ms).
    t = feed(l, t, 600, 16.7, 9);
    expect(l.gpuUntrusted).toBe(false);
    expect(l.index).toBe(after);
    expect(l.trials.taken).toBe(0);
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
    expect(decideProbe({ ...base, raf: frames(120, 20), gpu: frames(60, 16) })).toMatchObject({ tier: "low", valid: true, method: "gpu-timer" });
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

  it("goes to Low on the GPU timer only while Medium's frames also miss the display (frame rate first, D-framerate-2)", () => {
    // the M1 on WebGL2: three's timer reads 13–14 ms at Medium, frames hold 60 Hz
    const base = { gpuAvailable: true, visible: true, gpu: frames(60, 14.03) };
    expect(decideProbe({ ...base, raf: frames(120, 16.7) })).toMatchObject({ tier: "medium", valid: true, method: "gpu-timer" });
    expect(decideProbe({ ...base, raf: frames(120, 18) })).toMatchObject({ tier: "low", method: "gpu-timer" });
  });

  it("decides on the GPU's busy time where there is one (M1: three's sum 52 ms, busy 8.8 ms, D-framerate-2)", () => {
    const base = { raf: frames(120, 16.7), gpu: frames(60, 52), gpuAvailable: true, visible: true };
    expect(decideProbe({ ...base, busy: frames(60, 8.8) })).toMatchObject({ tier: "medium", valid: true, method: "gpu-busy", gpuP50: 8.8 });
    expect(decideProbe({ ...base, busy: frames(60, 4.5) })).toMatchObject({ tier: "high", method: "gpu-busy", reprobeHigh: true });
    expect(decideProbe({ ...base, raf: frames(120, 19), busy: frames(60, 15) })).toMatchObject({ tier: "low", method: "gpu-busy" });
    // too few busy samples: as before (three's sum, here implausible: frame time)
    expect(decideProbe({ ...base, busy: frames(5, 4) })).toMatchObject({ tier: "medium", method: "raf" });
    expect(decideUltra(frames(30, 9), frames(30, 3)).tier).toBe("ultra");
    expect(decideUltra(frames(30, 3), frames(30, 6)).tier).toBe("high");
  });

  it("goes back to Medium when High itself misses High's GPU budget at the re-probe (frame rate first, D-framerate-1)", () => {
    // a cheap arrival view put Medium under 6 ms, but High's own pixels and features cost 12 ms here
    expect(decideUltra(frames(30, 52), frames(30, 12))).toEqual({ tier: "medium", gpuP50: 12 });
    expect(decideUltra(frames(30, 10)).tier).toBe("high"); // exactly at the budget still fits
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
