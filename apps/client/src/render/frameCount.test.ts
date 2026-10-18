import { describe, expect, it } from "vitest";
import { cellCentre, FRAME_BITS, FrameCount, frameBits, fromBits, STRIP_CELLS, stripLayout } from "./frameCount.ts";

describe("?framecount counter (#23)", () => {
  it("advances by one per drawn frame, from 1", () => {
    const c = new FrameCount();
    const seen = [c.drawn(), c.drawn(), c.drawn()];
    expect(seen).toEqual([1, 2, 3]);
    for (let i = 0; i < 1000; i++) c.drawn();
    expect(c.value).toBe(1003);
  });

  it("shows the count as FRAME_BITS cells, most significant first, and reads back from them", () => {
    expect(FRAME_BITS).toBe(20);
    expect(frameBits(0)).toEqual(new Array(20).fill(false));
    expect(frameBits(5).slice(-3)).toEqual([true, false, true]);
    expect(frameBits(2 ** 19)[0]).toBe(true);
    for (const n of [1, 2, 3, 255, 256, 4095, 65_537, 2 ** 20 - 1]) expect(fromBits(frameBits(n)), String(n)).toBe(n);
    // It wraps (2^20 frames: ~4.8 h at 60 fps): consecutive frames still differ by one modulo the wrap.
    expect(fromBits(frameBits(2 ** 20))).toBe(0);
    expect(fromBits(frameBits(2 ** 20 + 7))).toBe(7);
  });

  it("consecutive frames differ in their cells: a stale frame shows as a repeated number", () => {
    let prev = fromBits(frameBits(0));
    for (let n = 1; n < 3000; n++) {
      const v = fromBits(frameBits(n));
      expect(v - prev).toBe(1);
      prev = v;
    }
  });

  it("sits on the bottom edge at the left, cells about 1/96 of the height, every cell inside the buffer", () => {
    for (const h of [180, 720, 1080, 2078]) {
      const L = stripLayout(h);
      expect(L.cell).toBe(Math.max(3, Math.floor(h / 96)));
      expect(L.left).toBe(L.cell);
      expect(L.top + L.height).toBe(h);
      expect(L.width).toBe(STRIP_CELLS * L.cell);
      const [mx, my] = cellCentre(h, "marker");
      const [lx] = cellCentre(h, FRAME_BITS - 1);
      expect(mx).toBeGreaterThan(L.left);
      expect(lx).toBeLessThan(L.left + L.width);
      expect(my).toBeGreaterThan(L.top);
      expect(my).toBeLessThan(L.top + L.height);
    }
  });
});
