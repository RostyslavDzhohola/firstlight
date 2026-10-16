import { describe, expect, it } from "vitest";
import * as THREE from "three/webgpu";
import { pass } from "three/tsl";
import { compileForPass, passCallDepth, saveRenderState, type GuardedRenderer, type PassCompileRenderer } from "./compilePass.ts";

/** A stand-in for three's Renderer: records the target, MRT and context depth compileAsync sees. */
function fakeRenderer(opts: { throws?: boolean } = {}) {
  const seen: { target: unknown; mrt: unknown; depth: number | undefined }[] = [];
  class Contexts {
    get(target?: unknown, mrt?: unknown, depth = 0) {
      return { target, mrt, depth };
    }
  }
  const r = {
    target: "canvas" as unknown,
    mrt: null as unknown,
    _renderContexts: new Contexts(),
    getRenderTarget() { return this.target; },
    setRenderTarget(t: unknown) { this.target = t; },
    getMRT() { return this.mrt; },
    setMRT(m: unknown) { this.mrt = m; },
    // Like three: the context is picked synchronously from the current target and MRT, at depth 0.
    compileAsync() {
      const ctx = this._renderContexts.get(this.target, this.mrt) as { target: unknown; mrt: unknown; depth: number };
      seen.push(ctx);
      if (opts.throws) throw new Error("boom");
      return Promise.resolve();
    },
  };
  return { r, seen };
}

describe("compileForPass", () => {
  it("compiles in the scene pass's context (its target, MRT and nested call depth), then restores the renderer", async () => {
    const { r, seen } = fakeRenderer();
    const pass = { renderTarget: "passRT", getMRT: () => "mrt" };
    await compileForPass(r as unknown as PassCompileRenderer, {}, {}, pass, 2);
    expect(seen).toEqual([{ target: "passRT", mrt: "mrt", depth: 2 }]);
    expect(r.target).toBe("canvas");
    expect(r.mrt).toBe(null);
    expect(Object.prototype.hasOwnProperty.call(r._renderContexts, "get")).toBe(false);
    expect((r._renderContexts.get() as { depth: number }).depth).toBe(0);
  });

  it("restores everything when compileAsync throws synchronously", () => {
    const { r } = fakeRenderer({ throws: true });
    expect(() => compileForPass(r as unknown as PassCompileRenderer, {}, {}, { renderTarget: "passRT", getMRT: () => null }, 2)).toThrow("boom");
    expect(r.target).toBe("canvas");
    expect(Object.prototype.hasOwnProperty.call(r._renderContexts, "get")).toBe(false);
  });

  it("falls back to a plain compileAsync without a pass, a depth or three's context table", async () => {
    const a = fakeRenderer();
    await compileForPass(a.r as unknown as PassCompileRenderer, {}, {}, null, 2);
    await compileForPass(a.r as unknown as PassCompileRenderer, {}, {}, { renderTarget: "passRT", getMRT: () => null }, null);
    expect(a.seen).toEqual([{ target: "canvas", mrt: null, depth: 0 }, { target: "canvas", mrt: null, depth: 0 }]);
    const b = fakeRenderer();
    delete (b.r as { _renderContexts?: unknown })._renderContexts;
    const calls: unknown[] = [];
    (b.r as { compileAsync: () => Promise<void> }).compileAsync = () => (calls.push(1), Promise.resolve());
    await compileForPass(b.r as unknown as PassCompileRenderer, {}, {}, { renderTarget: "passRT", getMRT: () => null }, 2);
    expect(calls).toEqual([1]);
    expect(b.r.target).toBe("canvas");
  });
});

describe("passCallDepth", () => {
  it("returns the call depth of the first lookup for the pass target, and unwraps three's lookup", () => {
    const { r } = fakeRenderer();
    const calls: number[] = [];
    const depth = passCallDepth(r as unknown as PassCompileRenderer, "passRT", () => {
      // Like RenderPipeline with FXAA: the quad (0), the FXAA render-to-texture (1), then the scene pass (2).
      r._renderContexts.get(null, null, 0);
      r._renderContexts.get("fxaaRT", null, 1);
      calls.push((r._renderContexts.get("passRT", "mrt", 2) as { depth: number }).depth);
      r._renderContexts.get("passRT", "mrt", 3);
    });
    expect(depth).toBe(2);
    expect(calls).toEqual([2]);
    expect(Object.prototype.hasOwnProperty.call(r._renderContexts, "get")).toBe(false);
  });

  it("is null when the render never draws the pass (or three has no context table)", () => {
    const { r } = fakeRenderer();
    expect(passCallDepth(r as unknown as PassCompileRenderer, "passRT", () => {})).toBe(null);
    delete (r as { _renderContexts?: unknown })._renderContexts;
    expect(passCallDepth(r as unknown as PassCompileRenderer, "passRT", () => {})).toBe(null);
  });
});

describe("saveRenderState (three's real RenderPipeline and PassNode, a stub renderer that fails mid-pass)", () => {
  /**
   * The pipeline's quad render runs the scene pass (as three's node update does), and the pass's
   * scene render throws after pushing three's render stack, the way Renderer._renderScene would.
   */
  function setup() {
    const scene = new THREE.Scene();
    scene.name = "world";
    const camera = new THREE.PerspectiveCamera();
    camera.layers.mask = 0b101;
    const scenePass = pass(scene, camera);
    const contextNode = { tag: "renderer context" };
    const lighting = { _cache: [[]] as unknown[][] };
    const r = {
      toneMapping: THREE.ACESFilmicToneMapping as THREE.ToneMapping,
      outputColorSpace: THREE.SRGBColorSpace as string,
      xr: { enabled: true, isPresenting: false },
      autoClear: false, autoClearColor: false, autoClearDepth: false, autoClearStencil: false,
      transparent: false, opaque: false,
      lighting: lighting as unknown,
      contextNode: contextNode as unknown,
      _callDepth: -1,
      _currentRenderContext: "outer context" as unknown,
      _currentRenderObjectFunction: "outer render object fn" as unknown,
      _handleObjectFunction: "outer handle fn" as unknown,
      _nodes: { nodeFrame: { renderId: 7 } },
      target: "canvas target" as unknown,
      mrt: null as unknown,
      getRenderTarget() { return this.target; },
      setRenderTarget(t: unknown) { this.target = t; },
      getMRT() { return this.mrt; },
      setMRT(m: unknown) { this.mrt = m; },
      getActiveCubeFace: () => 0,
      getActiveMipmapLevel: () => 0,
      getOutputRenderTarget: () => null,
      getDrawingBufferSize: (v: THREE.Vector2) => v.set(64, 32),
      render(what: { isQuadMesh?: boolean }) {
        this._callDepth++;
        lighting._cache.push([]);
        this._currentRenderContext = "nested context";
        this._currentRenderObjectFunction = "nested fn";
        this._nodes.nodeFrame.renderId++;
        if (what.isQuadMesh) scenePass.updateBefore({ renderer: this } as never);
        else throw new Error("draw failed");
      },
    };
    const pipeline = new THREE.RenderPipeline(r as unknown as THREE.WebGPURenderer, scenePass as never);
    pipeline.outputColorTransform = false;
    return { scene, camera, scenePass, r, lighting, contextNode, pipeline };
  }

  it("without it, a throw leaves the renderer half-switched (the bug)", () => {
    const { r, pipeline, scenePass } = setup();
    expect(() => pipeline.render()).toThrow("draw failed");
    expect(r.toneMapping).toBe(THREE.NoToneMapping);
    expect(r.xr.enabled).toBe(false);
    expect(r.target).toBe(scenePass.renderTarget);
    expect(r.autoClear).toBe(true);
    expect(r._callDepth).toBe(1);
  });

  it("puts back the public state, the scene and camera, and three's render stack after a throw", () => {
    const { scene, camera, r, lighting, contextNode, pipeline } = setup();
    const state = saveRenderState(r as unknown as GuardedRenderer, scene, camera);
    try {
      scene.visible = false;
      expect(() => pipeline.render()).toThrow("draw failed");
    } finally {
      state.restore(true);
    }
    expect(r.toneMapping).toBe(THREE.ACESFilmicToneMapping);
    expect(r.outputColorSpace).toBe(THREE.SRGBColorSpace);
    expect(r.xr.enabled).toBe(true);
    expect(r.target).toBe("canvas target");
    expect(r.mrt).toBe(null);
    expect([r.autoClear, r.autoClearColor, r.autoClearDepth, r.autoClearStencil, r.transparent, r.opaque]).toEqual([false, false, false, false, false, false]);
    expect(r.lighting).toBe(lighting);
    expect(r.contextNode).toBe(contextNode);
    expect(scene.visible).toBe(true);
    expect(scene.name).toBe("world");
    expect(scene.overrideMaterial).toBe(null);
    expect(camera.layers.mask).toBe(0b101);
    expect(r._callDepth).toBe(-1);
    expect(r._currentRenderContext).toBe("outer context");
    expect(r._currentRenderObjectFunction).toBe("outer render object fn");
    expect(r._handleObjectFunction).toBe("outer handle fn");
    expect(r._nodes.nodeFrame.renderId).toBe(7);
    expect(lighting._cache).toHaveLength(1);
  });

  it("after a normal render, restore(false) leaves three's own stack alone", () => {
    const { scene, camera, r } = setup();
    const state = saveRenderState(r as unknown as GuardedRenderer, scene, camera);
    r._callDepth = 3; // whatever a successful render left there is three's business
    r.toneMapping = THREE.NoToneMapping;
    state.restore(false);
    expect(r._callDepth).toBe(3);
    expect(r.toneMapping).toBe(THREE.ACESFilmicToneMapping);
  });
});
