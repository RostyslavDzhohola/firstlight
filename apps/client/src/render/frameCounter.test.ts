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
    expect(m.withFrameCounter(out)).toBe(out);
    expect(m.frameCounterState()).toBeNull();
  });

  it("with the flag draws over the output, with one counter for every rebuild of the pipeline", async () => {
    const m = await load("?framecount");
    const out = vec4(0.2, 0.3, 0.4, 1) as unknown as THREE.Node;
    const a = m.withFrameCounter(out);
    expect(a).not.toBe(out);
    expect(m.frameCounterState()).toEqual({ count: 0, dom: false }); // no document in this test
    const b = m.withFrameCounter(vec4(1, 1, 1, 1) as unknown as THREE.Node);
    expect(b).not.toBe(a);
    expect(m.frameCounterState()?.count).toBe(0); // nothing drawn yet
    // One tick per drawn frame (RenderCtx.render calls it before drawing).
    for (let i = 0; i < 3; i++) m.frameCounterTick();
    expect(m.frameCounterState()?.count).toBe(3);
  });

  it("without the flag a tick does nothing", async () => {
    const m = await load("");
    m.frameCounterTick();
    expect(m.frameCounterState()).toBeNull();
  });
});
