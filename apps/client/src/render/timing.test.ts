import { describe, expect, it } from "vitest";
import { LADDER, percentile, ResolutionLadder } from "./timing.ts";

/** Feed `seconds` of frames at `frameMs` (and optional GPU ms) starting at time `t0`. */
function feed(l: ResolutionLadder, t0: number, seconds: number, frameMs: number, gpuMs: number | null, target = 12): number {
  let t = t0;
  const end = t0 + seconds * 1000;
  while (t < end) {
    t += frameMs;
    l.sample(t, frameMs, gpuMs, target);
  }
  return t;
}

describe("resolution ladder", () => {
  it("steps down when frames are slow, then asks to drop a tier at the floor", () => {
    const l = new ResolutionLadder();
    let floors = 0;
    l.onFloor = () => floors++;
    let t = feed(l, 1000, 60, 28, null);
    expect(l.scale).toBe(LADDER[LADDER.length - 1]);
    t = feed(l, t, 20, 28, null);
    expect(floors).toBeGreaterThan(0);
  });

  it("holds steady at the vsync rate without a GPU timer", () => {
    const l = new ResolutionLadder();
    feed(l, 1000, 60, 16.7, null);
    expect(l.index).toBe(0);
  });

  it("steps back up with GPU headroom, but not right after a down-step", () => {
    const l = new ResolutionLadder();
    let t = feed(l, 1000, 6, 30, 20);
    expect(l.index).toBeGreaterThan(0);
    const after = l.index;
    t = feed(l, t, 15, 16.7, 4);
    expect(l.index).toBe(after); // hold-off
    feed(l, t, 60, 16.7, 4);
    expect(l.index).toBe(0);
  });

  it("disabled ladder never changes", () => {
    const l = new ResolutionLadder();
    l.enabled = false;
    feed(l, 1000, 30, 40, null);
    expect(l.index).toBe(0);
  });
});

describe("percentile", () => {
  it("handles empty and simple inputs", () => {
    expect(percentile([], 0.5)).toBe(0);
    expect(percentile([3, 1, 2], 0.5)).toBe(2);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.95)).toBe(10);
  });
});
