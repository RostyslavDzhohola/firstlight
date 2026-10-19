import { describe, expect, it } from "vitest";
import { gridToLayers } from "./gridLayers.ts";

/** An RGBA grid image (rows top-down) whose every texel holds its layer index, x and y within the layer. */
function grid(size: number, layers: number, cols: number) {
  const rows = Math.ceil(layers / cols);
  const w = size * cols, h = size * rows;
  const px = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const layer = Math.floor(y / size) * cols + Math.floor(x / size);
      px.set([layer, x % size, y % size, 255], (y * w + x) * 4);
    }
  return { px, w, h };
}

describe("gridToLayers", () => {
  it("lays a grid strip (layer i at column i % cols, row ⌊i / cols⌋) out as consecutive layers", () => {
    for (const [layers, cols] of [[16, 2], [9, 1], [5, 3]] as const) {
      const size = 4;
      const { px, w, h } = grid(size, layers, cols);
      const out = gridToLayers(px, w, h, size, layers, cols);
      expect(out.length).toBe(size * size * layers * 4);
      for (let l = 0; l < layers; l++)
        for (let y = 0; y < size; y++)
          for (let x = 0; x < size; x++) {
            const o = ((l * size + y) * size + x) * 4;
            expect([out[o], out[o + 1], out[o + 2]], `layer ${l} (${x}, ${y})`).toEqual([l, x, y]);
          }
    }
  });

  it("passes a one-column strip through without copying", () => {
    const { px, w, h } = grid(4, 3, 1);
    expect(gridToLayers(px, w, h, 4, 3, 1)).toBe(px);
  });

  it("refuses an image that isn't that grid", () => {
    const { px, w, h } = grid(4, 4, 2);
    expect(() => gridToLayers(px, w, h, 8, 4, 2)).toThrow(/not a 2-column grid/);
    expect(() => gridToLayers(px, w, h, 4, 6, 2)).toThrow(/not a 2-column grid/);
  });
});
