import { afterEach, describe, expect, it, vi } from "vitest";
import * as THREE from "three/webgpu";
import { vec4 } from "three/tsl";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

async function load(search: string) {
  vi.stubGlobal("location", { search, hostname: "localhost" });
  return import("./frameCounter.ts");
}

describe("?framecount overlay (#23)", () => {
  it("without the flag creates nothing: the output node is handed back as it is", async () => {
    const m = await load("");
    const out = vec4(0.2, 0.3, 0.4, 1) as unknown as THREE.Node;
    expect(m.frameCounterOn()).toBe(false);
    expect(m.withFrameCounter(out, true)).toBe(out);
    expect(m.frameCounterState()).toBeNull();
  });

  it("with the flag draws over the output, with one counter for every rebuild of the pipeline", async () => {
    const m = await load("?framecount");
    const out = vec4(0.2, 0.3, 0.4, 1) as unknown as THREE.Node;
    const a = m.withFrameCounter(out, true);
    expect(a).not.toBe(out); // WebGPU: drawn as the output's last step
    expect(m.withFrameCounter(out, false)).toBe(out); // WebGL2: frameCounterDraw clears it into the canvas
    expect(m.frameCounterState()).toEqual({ count: 0, dom: false }); // no document in this test
    const b = m.withFrameCounter(vec4(1, 1, 1, 1) as unknown as THREE.Node, true);
    expect(b).not.toBe(a);
    expect(m.frameCounterState()?.count).toBe(0); // nothing drawn yet
    // One tick per drawn frame (RenderCtx.render calls it before drawing).
    for (let i = 0; i < 3; i++) m.frameCounterTick();
    expect(m.frameCounterState()?.count).toBe(3);
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
    m.withFrameCounter(vec4(0, 0, 0, 1) as unknown as THREE.Node, false);
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

  it("without the flag a tick does nothing", async () => {
    const m = await load("");
    m.frameCounterTick();
    expect(m.frameCounterState()).toBeNull();
  });
});
