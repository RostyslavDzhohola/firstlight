import { describe, expect, it } from "vitest";
import { detectFlaps, detectFlashes, frameStats, meanLuma, Ring, screenAim } from "./e2eProbe.ts";

describe("Ring", () => {
  it("keeps the newest `size` entries, oldest first", () => {
    const r = new Ring(3);
    for (let i = 1; i <= 5; i++) r.push(i * 10, i);
    expect(r.length).toBe(3);
    expect(r.since().map((e) => e.v)).toEqual([3, 4, 5]);
    expect(r.since(45).map((e) => e.v)).toEqual([5]);
    r.clear();
    expect(r.since()).toEqual([]);
  });
});

describe("frameStats", () => {
  it("counts long frames and reports the worst", () => {
    const frames = [16, 17, 16, 120, 16, 300, 17].map((v, i) => ({ t: i * 20, v }));
    const s = frameStats(frames);
    expect(s.frames).toBe(7);
    expect(s.over50).toBe(2);
    expect(s.over100).toBe(2);
    expect(s.over250).toBe(1);
    expect(s.max).toBe(300);
    expect(s.p50).toBe(17);
    expect(s.worst[0]).toEqual({ t: 100, ms: 300 });
  });

  it("is safe on an empty buffer", () => {
    expect(frameStats([])).toMatchObject({ frames: 0, max: 0, p99: 0, spanMs: 0 });
  });
});

describe("meanLuma", () => {
  it("weights RGB like Rec. 601", () => {
    expect(meanLuma([255, 255, 255, 255])).toBeCloseTo(255);
    expect(meanLuma([0, 0, 0, 255, 255, 255, 255, 255])).toBeCloseTo(127.5);
    expect(meanLuma([0, 255, 0, 255])).toBeCloseTo(0.587 * 255);
  });
});

describe("detectFlashes", () => {
  const s = (vals: number[]) => vals.map((v, i) => ({ t: i, v }));

  it("finds a one-frame flash like the owner's recording (+72 then back)", () => {
    expect(detectFlashes(s([100, 101, 173, 100, 99]))).toEqual([{ t: 2, jump: 72, samples: 1 }]);
  });

  it("finds a dark blink lasting two samples", () => {
    expect(detectFlashes(s([90, 90, 5, 6, 91, 90]))).toEqual([{ t: 2, jump: -85, samples: 2 }]);
  });

  it("ignores a lasting change and gentle drift", () => {
    expect(detectFlashes(s([100, 150, 151, 152, 150, 149]))).toEqual([]);
    expect(detectFlashes(s([100, 110, 120, 130, 140, 150]))).toEqual([]);
  });
});

describe("detectFlaps", () => {
  it("reports an element that hid and showed again quickly", () => {
    const flaps = detectFlaps([
      { t: 0, key: "callout" },
      { t: 100, key: "callout" },
      { t: 1000, key: "toast" },
      { t: 2000, key: "toast" },
    ]);
    expect(flaps).toEqual([{ key: "callout", t: 100, gapMs: 100 }]);
  });
});

describe("screenAim", () => {
  // Camera at the origin looking down −Z (identity view), simple perspective (fov 90°, aspect 1).
  const view = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const n = 0.1, f = 100;
  const proj = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -(f + n) / (f - n), -1, 0, 0, (-2 * f * n) / (f - n), 0];

  it("a point straight ahead needs no turn and is on screen", () => {
    const a = screenAim(view, proj, 0, 0, -10);
    expect(a.onScreen).toBe(true);
    expect(a.yaw).toBeCloseTo(0);
    expect(a.pitch).toBeCloseTo(0);
    expect(a.ndc![0]).toBeCloseTo(0);
  });

  it("a point to the right and up asks for a right turn and an upward look", () => {
    const a = screenAim(view, proj, 5, 5, -10);
    expect(a.yaw).toBeGreaterThan(0);
    expect(a.pitch).toBeGreaterThan(0);
    expect(a.ndc![0]).toBeGreaterThan(0);
  });

  it("a point behind is off screen", () => {
    const a = screenAim(view, proj, 0, 0, 10);
    expect(a.onScreen).toBe(false);
    expect(a.ndc).toBeNull();
    expect(Math.abs(a.yaw)).toBeCloseTo(Math.PI);
  });
});
