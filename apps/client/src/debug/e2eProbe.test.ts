import { describe, expect, it } from "vitest";
import { detectFlaps, detectFlashes, frameStats, lumaWorkerSource, meanLuma, Ring, screenAim } from "./e2eProbe.ts";

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

describe("lumaWorkerSource", () => {
  // Runs the worker's source against a stand-in OffscreenCanvas: the readback that used to stall the
  // page's main thread now happens there, and it must answer the same luma the page computed.
  function runWorker(pixels: number[], data: { t: number; w: number; h: number; bmp?: unknown }) {
    const posted: unknown[] = [];
    const self: { onmessage?: (e: { data: unknown }) => void; postMessage(m: unknown): void } = { postMessage: (m) => posted.push(m) };
    let drawn: unknown = null;
    let closed = 0;
    class FakeOffscreenCanvas {
      constructor(readonly width: number, readonly height: number) {}
      getContext() {
        return { canvas: this, clearRect() {}, drawImage: (b: unknown) => (drawn = b), getImageData: () => ({ data: pixels }) };
      }
    }
    new Function("self", "OffscreenCanvas", lumaWorkerSource())(self, FakeOffscreenCanvas);
    const bmp = data.bmp ?? { close: () => closed++ };
    self.onmessage!({ data: { ...data, bmp } });
    return { posted, drawn, bmp, closed };
  }

  it("answers the mean luma of the bitmap with the sample's time and closes the bitmap", () => {
    const px = [0, 0, 0, 255, 255, 255, 255, 255, 0, 255, 0, 255];
    const r = runWorker(px, { t: 42, w: 3, h: 1 });
    expect(r.drawn).toBe(r.bmp);
    expect(r.closed).toBe(1);
    expect(r.posted).toEqual([{ t: 42, v: meanLuma(px) }]);
  });

  it("reports a failed draw as an error instead of throwing", () => {
    const r = runWorker([], { t: 7, w: 1, h: 1, bmp: { close: () => { throw new Error("detached"); } } });
    expect(r.posted).toEqual([{ t: 7, error: "Error: detached" }]);
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

  it("ignores a jump while the camera turned (a look-step at a dark wall and on, J1.2 on the castle street)", () => {
    const series = [110.7, 110.7, 54.8, 54.7, 54.7, 98].map((v, i) => ({ t: i, v, turn: i === 2 || i === 5 ? 30 : 0 }));
    expect(detectFlashes(series)).toEqual([]);
    // The same luma with a still camera is a blink.
    expect(detectFlashes(series.map((x) => ({ ...x, turn: 0 })))).toEqual([{ t: 2, jump: -56, samples: 3 }]);
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
