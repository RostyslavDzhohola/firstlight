import { afterEach, describe, expect, it, vi } from "vitest";
import * as THREE from "three/webgpu";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

async function load(search: string) {
  vi.stubGlobal("location", { search, hostname: "localhost" });
  return import("./frameCounter.ts");
}

describe("?framecount canvas counter (#23)", () => {
  it("without the flag creates nothing: a tick and a draw return at once", async () => {
    const m = await load("");
    expect(m.frameCounterOn()).toBe(false);
    m.frameCounterTick();
    m.frameCounterDraw({ backend: {} } as unknown as THREE.WebGPURenderer);
    expect(m.frameCounterState()).toBeNull();
  });

  it("with the flag counts one per drawn frame, from the first tick", async () => {
    const m = await load("?framecount");
    expect(m.frameCounterState()).toBeNull(); // nothing until a frame is drawn
    for (let i = 0; i < 3; i++) m.frameCounterTick();
    expect(m.frameCounterState()).toEqual({ count: 3, dom: false }); // no document in this test
  });

  it("on WebGL2 clears this frame's number into the canvas after the frame, and leaves the GL state as it was", async () => {
    const m = await load("?framecount");
    const { cellCentre, FRAME_BITS, fromBits, stripLayout } = await import("./frameCount.ts");
    const H = 720;
    const fills: { x: number; y: number; w: number; h: number; c: number[] }[] = [];
    let scissor = [0, 0, 1280, 720], color = [0.5, 0.25, 0.125, 1], fb: unknown = "three's fb", on = false;
    const gl = {
      SCISSOR_TEST: 1, SCISSOR_BOX: 2, COLOR_CLEAR_VALUE: 3, COLOR_WRITEMASK: 4, DRAW_FRAMEBUFFER: 5, DRAW_FRAMEBUFFER_BINDING: 6, COLOR_BUFFER_BIT: 7,
      drawingBufferHeight: H,
      isEnabled: () => on,
      enable: () => void (on = true),
      disable: () => void (on = false),
      getParameter: (p: number) => (p === 2 ? Int32Array.from(scissor) : p === 3 ? Float32Array.from(color) : p === 4 ? [true, true, true, false] : fb),
      bindFramebuffer: (_t: number, f: unknown) => void (fb = f),
      scissor: (x: number, y: number, w: number, h: number) => void (scissor = [x, y, w, h]),
      colorMask: () => {},
      clearColor: (r: number, g: number, b: number, a: number) => void (color = [r, g, b, a]),
      clear: () => void fills.push({ x: scissor[0]!, y: scissor[1]!, w: scissor[2]!, h: scissor[3]!, c: [...color] }),
    };
    const renderer = { backend: { gl } } as unknown as THREE.WebGPURenderer;
    for (const n of [1, 2, 3]) {
      fills.length = 0;
      m.frameCounterTick();
      m.frameCounterDraw(renderer);
      // The colour last cleared at a cell's centre (GL y from the bottom).
      const at = ([x, y]: [number, number]) => [...fills].reverse().find((f) => x >= f.x && x < f.x + f.w && H - y >= f.y && H - y < f.y + f.h)!.c;
      expect(at(cellCentre(H, "marker"))).toEqual([1, 0, 0, 1]);
      const bits = Array.from({ length: FRAME_BITS }, (_, i) => at(cellCentre(H, i))[0] === 1);
      expect(fromBits(bits), `frame ${n}`).toBe(n);
      const L = stripLayout(H);
      expect(fills[0]).toEqual({ x: L.left, y: H - L.top - L.height, w: L.width, h: L.height, c: [0, 0, 0, 1] }); // the plate
    }
    expect(fb).toBe("three's fb");
    expect(scissor).toEqual([0, 0, 1280, 720]);
    expect(color).toEqual([0.5, 0.25, 0.125, 1]);
    expect(on).toBe(false);
  });
});
