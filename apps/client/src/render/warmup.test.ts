import { describe, expect, it, vi } from "vitest";
import * as THREE from "three/webgpu";
import { forceProperty, installShaderMonitor, keptSamples, lastWarmup, predictShadowBuilds, shadowBuildCost, shaderStats, warmShadowCasters, warmup } from "./warmup.ts";
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

describe("warmShadowCasters", () => {
  const mat = new THREE.MeshStandardNodeMaterial();
  const geo = new THREE.BoxGeometry();
  function sceneWith(parts: THREE.Mesh[], others = 2) {
    const scene = new THREE.Scene();
    for (const m of parts) {
      m.castShadow = true;
      scene.add(m);
    }
    for (let i = 0; i < others; i++) scene.add(new THREE.Mesh(geo, mat));
    return scene;
  }
  const casting = (ms: THREE.Mesh[]) => ms.filter((m) => m.castShadow).length;

  it("adds casters a batch of predicted new builds per frame; casters sharing a build ride along", async () => {
    // 10 instanced meshes (a build each), then 20 plain meshes that share one material and layout.
    const inst = Array.from({ length: 10 }, () => new THREE.InstancedMesh(geo, mat, 4));
    const plain = Array.from({ length: 20 }, () => new THREE.Mesh(geo, mat));
    const all = [...inst, ...plain];
    const scene = sceneWith(all);
    const seen: number[] = [];
    const frames = await warmShadowCasters(scene, () => seen.push(casting(all)), async () => {});
    // 4 + 4 + (2 instanced + the first plain: a new build; then the other 19 plain cost nothing)
    expect(seen).toEqual([4, 8, 30]);
    expect(frames).toBe(3);
    expect(casting(all)).toBe(30);
  });

  it("predicts builds: instanced and skinned always, plain meshes once per material and layout", () => {
    const seen = new Set<string>();
    expect(shadowBuildCost(new THREE.InstancedMesh(geo, mat, 2), seen)).toBe(1);
    expect(shadowBuildCost(new THREE.Mesh(geo, mat), seen)).toBe(1);
    expect(shadowBuildCost(new THREE.Mesh(geo, mat), seen)).toBe(0);
    expect(shadowBuildCost(new THREE.Mesh(new THREE.PlaneGeometry(), mat), seen)).toBe(0); // same attributes
    const other = new THREE.BufferGeometry();
    other.setAttribute("position", new THREE.Float32BufferAttribute([0, 0, 0], 3));
    expect(shadowBuildCost(new THREE.Mesh(other, mat), seen)).toBe(1); // no normals/uvs: another layout
    expect(shadowBuildCost(new THREE.Mesh(geo, new THREE.MeshStandardNodeMaterial()), seen)).toBe(1);
  });

  it("puts every caster back, keeps non-casters off, even when a frame throws", async () => {
    const parts = Array.from({ length: 10 }, () => new THREE.InstancedMesh(geo, mat, 2));
    const scene = sceneWith(parts, 3);
    await expect(warmShadowCasters(scene, () => {
      throw new Error("frame failed");
    }, async () => {})).rejects.toThrow("frame failed");
    expect(casting(parts)).toBe(10);
    const others = scene.children.filter((o) => !(parts as THREE.Object3D[]).includes(o));
    expect(others.every((o) => !o.castShadow)).toBe(true);
  });
});

describe("warm-up report (per-phase times and shader counts) and progress", () => {
  /** A fake renderer on a hand-moved clock: compile items cost 10 ms and one build each, frames 5 ms. */
  function fakeCtx(opts: { items: number; webgpu: boolean; shadows: boolean; frameBuilds?: number }) {
    let clock = 1000;
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    vi.stubGlobal("window", {});
    vi.stubGlobal("requestAnimationFrame", (cb: () => void) => setTimeout(cb, 0));
    const debug: { onNodeBuilderCreated?: (builder: unknown, ro: unknown) => void } = {};
    const build = () => debug.onNodeBuilderCreated?.({}, { object: new THREE.Mesh(), material: new THREE.MeshBasicNodeMaterial() });
    const scene = new THREE.Scene();
    const geo = new THREE.BoxGeometry();
    const mat = new THREE.MeshStandardNodeMaterial();
    for (let i = 0; i < 6; i++) {
      const m = new THREE.InstancedMesh(geo, mat, 2); // a shadow build each
      m.castShadow = true;
      scene.add(m);
    }
    let frameBuilds = opts.frameBuilds ?? 0;
    const ctx = {
      scene,
      camera: new THREE.PerspectiveCamera(),
      webgpu: opts.webgpu,
      tier: "medium",
      settings: { on: { shadows: opts.shadows }, shadows: { mode: "map" } },
      renderer: {
        debug,
        info: { frame: 0, reset() {} },
        compileAsync: async (_s: unknown, _c: unknown, _t: unknown, onProgress?: (e: { loaded: number; total: number }) => void) => {
          for (let i = 1; i <= opts.items; i++) {
            await Promise.resolve();
            clock += 10;
            build();
            onProgress?.({ loaded: i, total: opts.items });
          }
        },
      },
      render() {
        clock += 5;
        if (frameBuilds > 0) {
          frameBuilds--;
          build();
        }
      },
      gpu: { frame() {}, drain: () => [] },
    } as unknown as RenderCtx;
    installShaderMonitor(ctx);
    return ctx;
  }

  it("times the scene-pass compile, compute compile, shadow frames and real frames, with the shaders built in each", async () => {
    try {
      const ctx = fakeCtx({ items: 5, webgpu: false, shadows: true, frameBuilds: 1 });
      const before = shaderStats().total;
      await warmup(ctx, { frames: 2, label: "arrival" });
      const r = lastWarmup()!;
      expect(r.label).toBe("arrival");
      expect(r.backend).toBe("webgl2");
      expect(r.tier).toBe("medium");
      expect(r.phases.compile).toEqual({ ms: 50, builds: 5, items: 5 });
      expect(r.phases.compute).toEqual({ ms: 0, builds: 0, nodes: 0 }); // no compute nodes yet
      // 6 predicted shadow builds in batches of 4: two frames (the first frame's own build lands here)
      expect(r.phases.shadows).toEqual({ ms: 10, builds: 1, frames: 2, predicted: 6 });
      expect(r.phases.frames).toEqual({ ms: 15, builds: 0, frames: 3 }); // 2 + the settle frame
      expect(r.ms).toBe(75);
      expect(r.end - r.start).toBe(75);
      expect(r.builds).toBe(6);
      expect(r.shaders).toBe(before + 6);
      expect(shaderStats().warmups.at(-1)).toBe(r); // what the e2e hook reads
    } finally {
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    }
  });

  it("reports progress as done/total work units, monotonic, ending at total/total", async () => {
    try {
      const ctx = fakeCtx({ items: 5, webgpu: true, shadows: true });
      const events: [number, number][] = [];
      await warmup(ctx, { frames: 2, onProgress: (done, total) => events.push([done, total]) });
      // 5 compile items + 6 predicted shadow builds + 2 frames + the settle frame
      expect(events[0]).toEqual([1, 14]);
      expect(events.at(-1)).toEqual([14, 14]);
      for (let i = 1; i < events.length; i++) {
        expect(events[i]![0]).toBeGreaterThanOrEqual(events[i - 1]![0]);
        expect(events[i]![0]).toBeLessThanOrEqual(events[i]![1]);
      }
      expect(events.map((e) => e[0])).toEqual([1, 2, 3, 4, 5, 9, 11, 12, 13, 14]);
      expect(lastWarmup()!.backend).toBe("webgpu");
    } finally {
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    }
  });

  it("still ends at total/total without shadows or compile items", async () => {
    try {
      const ctx = fakeCtx({ items: 0, webgpu: false, shadows: false });
      const events: [number, number][] = [];
      await warmup(ctx, { frames: 1, onProgress: (done, total) => events.push([done, total]) });
      expect(events).toEqual([[1, 2], [2, 2]]);
      expect(lastWarmup()!.phases.shadows).toEqual({ ms: 0, builds: 0, frames: 0, predicted: 0 });
    } finally {
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    }
  });

  it("predicts the shadow phase's builds the way the batching counts them", () => {
    const scene = new THREE.Scene();
    const geo = new THREE.BoxGeometry();
    const mat = new THREE.MeshStandardNodeMaterial();
    for (let i = 0; i < 3; i++) {
      const m = new THREE.InstancedMesh(geo, mat, 2);
      m.castShadow = true;
      scene.add(m);
    }
    for (let i = 0; i < 4; i++) {
      const m = new THREE.Mesh(geo, mat);
      m.castShadow = true;
      scene.add(m);
    }
    scene.add(new THREE.Mesh(geo, new THREE.MeshStandardNodeMaterial())); // not a caster
    expect(predictShadowBuilds(scene)).toBe(4);
  });
});
