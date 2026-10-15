import { describe, expect, it, vi } from "vitest";
import * as THREE from "three/webgpu";
import { forceProperty, installShaderMonitor, keptSamples, shaderStats, warmup } from "./warmup.ts";
import type { RenderCtx } from "./renderer.ts";
import { watchDisposals } from "./disposeWatch.testutil.ts";

describe("warm-up forced properties", () => {
  it("restores the original value when nothing wrote during warm-up", () => {
    const o = new THREE.Object3D();
    o.visible = false;
    const restore = forceProperty(o, "visible", true);
    expect(o.visible).toBe(true);
    restore();
    expect(o.visible).toBe(false);
  });

  it("keeps a value written by another system during warm-up", () => {
    const o = new THREE.Object3D();
    o.visible = false;
    const restore = forceProperty(o, "visible", true);
    o.visible = true; // e.g. a grass cell got filled
    o.visible = false;
    o.visible = true;
    expect(o.visible).toBe(true);
    restore();
    expect(o.visible).toBe(true);
    // Back to a plain data property.
    o.visible = false;
    expect(o.visible).toBe(false);
    expect(Object.getOwnPropertyDescriptor(o, "visible")?.get).toBeUndefined();
  });

  it("works for instance counts", () => {
    const g = new THREE.InstancedBufferGeometry();
    g.instanceCount = 0;
    const restore = forceProperty(g, "instanceCount", 1);
    expect(g.instanceCount).toBe(1);
    g.instanceCount = 3000;
    expect(g.instanceCount).toBe(1); // still forced while warming
    restore();
    expect(g.instanceCount).toBe(3000);
  });
});

describe("session warm-up samples (T9)", () => {
  const mesh = () => new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicNodeMaterial());

  it("are built once and come back hidden, with nothing disposed", () => {
    let builds = 0;
    const build = () => {
      builds++;
      return [mesh(), mesh()];
    };
    const g = keptSamples("test-a", build)!;
    expect(g.visible).toBe(false); // drawn only while warmup() shows hidden objects
    expect(g.userData.noWarmup).toBeUndefined();
    expect(g.children).toHaveLength(2);
    const w = watchDisposals(g);
    expect(keptSamples("test-a", build)).toBe(g);
    expect(builds).toBe(1);
    expect(w.disposed.size).toBe(0);
  });

  it("retry a build that couldn't run yet; without a build they only look up", () => {
    expect(keptSamples("test-b")).toBeNull();
    expect(keptSamples("test-b", () => null)).toBeNull();
    const g = keptSamples("test-b", () => [mesh()])!;
    expect(g.children).toHaveLength(1);
    expect(keptSamples("test-b", () => [mesh(), mesh()])).toBe(g);
    expect(keptSamples("test-b")).toBe(g);
  });
});

describe("post-warm-up shader window", () => {
  it("doesn't count a later warm-up's own builds as builds after warm-up (first-visit probe, then the full warm-up)", async () => {
    vi.stubGlobal("window", {});
    vi.stubGlobal("requestAnimationFrame", (cb: () => void) => setTimeout(cb, 0));
    const debug: { onNodeBuilderCreated?: (builder: unknown, ro: unknown) => void } = {};
    const watchingDuringCompile: number[] = [];
    const ctx = {
      scene: new THREE.Scene(),
      camera: new THREE.PerspectiveCamera(),
      renderer: {
        debug,
        info: { frame: 0, reset() {} },
        compileAsync: async () => {
          watchingDuringCompile.push(shaderStats().watching);
          debug.onNodeBuilderCreated?.({}, { object: new THREE.Mesh(), material: new THREE.MeshBasicNodeMaterial() });
        },
      },
      render() {},
      gpu: { frame() {}, drain: () => [] },
    } as unknown as RenderCtx;
    installShaderMonitor(ctx);
    try {
      await warmup(ctx, { frames: 1 }); // the probe's warm-up opens a watch window
      expect(shaderStats().watching).toBe(120);
      await warmup(ctx, { frames: 1 }); // the full warm-up right after compiles what the probe didn't draw
      expect(watchingDuringCompile).toEqual([0, 0]);
      expect(shaderStats().afterWarmup).toBe(0);
      expect(shaderStats().watching).toBe(120);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
