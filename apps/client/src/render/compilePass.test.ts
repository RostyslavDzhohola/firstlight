import { describe, expect, it } from "vitest";
import { compileForPass, passCallDepth, type PassCompileRenderer } from "./compilePass.ts";

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
