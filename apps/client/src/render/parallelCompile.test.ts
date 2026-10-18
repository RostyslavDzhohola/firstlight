import { describe, expect, it } from "vitest";
import {
  BATCH_TARGET_MS, deferPipelines, FIRST_DRAWS_START, FirstDrawPacer, gateFirstDraws, glFence, pipelineCost,
  type DeferRenderer, type GateRenderer,
} from "./parallelCompile.ts";

/** three's Pipelines as the backend sees it: a new pipeline compiles in parallel only when given a list. */
function fakeRenderer() {
  const made: { ro: string; parallel: boolean; finish: () => void }[] = [];
  const pipelines = {
    getForRender(ro: unknown, promises: Promise<unknown>[] | null = null) {
      if (promises) {
        let finish!: () => void;
        promises.push(new Promise<void>((r) => (finish = r)));
        made.push({ ro: String(ro), parallel: true, finish });
      } else {
        made.push({ ro: String(ro), parallel: false, finish: () => {} });
      }
      return ro;
    },
  };
  return { renderer: { _pipelines: pipelines } as DeferRenderer, pipelines, made };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("deferPipelines", () => {
  it("compiles every new pipeline in parallel, from compileAsync's per-object list or a real frame", () => {
    const f = fakeRenderer();
    const d = deferPipelines(f.renderer);
    const perObject: Promise<unknown>[] = [];
    f.pipelines.getForRender("tree", perObject); // compileAsync would await this list per object
    f.pipelines.getForRender("shadow:tree"); // a real frame: three links synchronously here
    expect(perObject).toHaveLength(0); // nothing for compileAsync to wait on: it moves to the next object
    expect(f.made.map((m) => m.parallel)).toEqual([true, true]);
    expect(d.pending()).toBe(2);
    d.release();
  });

  it("counts pipelines started, finished and still compiling", async () => {
    const f = fakeRenderer();
    const d = deferPipelines(f.renderer);
    f.pipelines.getForRender("a");
    f.pipelines.getForRender("b");
    expect([d.started(), d.finished(), d.pending()]).toEqual([2, 0, 2]);
    f.made[0]!.finish();
    await tick();
    expect([d.started(), d.finished(), d.pending()]).toEqual([2, 1, 1]);
    d.release();
  });

  it("settle() waits for all of them, including ones started while it waits", async () => {
    const f = fakeRenderer();
    const d = deferPipelines(f.renderer);
    f.pipelines.getForRender("a");
    f.pipelines.getForRender("b");
    let settled = false;
    const s = d.settle().then(() => (settled = true));
    f.made[0]!.finish();
    await tick();
    expect(settled).toBe(false);
    f.pipelines.getForRender("c"); // e.g. a settle frame's straggler
    f.made[1]!.finish();
    await tick();
    expect(settled).toBe(false);
    f.made[2]!.finish();
    await s;
    expect(settled).toBe(true);
    expect(d.pending()).toBe(0);
    d.release();
  });

  it("release() puts three's own method back (nothing left on the instance)", () => {
    const f = fakeRenderer();
    const own = f.pipelines.getForRender;
    const d = deferPipelines(f.renderer);
    expect(f.pipelines.getForRender).not.toBe(own);
    d.release();
    expect(f.pipelines.getForRender).toBe(own);
    d.release(); // twice is harmless
    f.pipelines.getForRender("late");
    expect(f.made.at(-1)!.parallel).toBe(false);
  });

  it("restores a prototype method by deleting the instance override", () => {
    class Pipelines {
      getForRender(_ro: unknown, _p: Promise<unknown>[] | null = null) {
        return "proto";
      }
    }
    const p = new Pipelines();
    const d = deferPipelines({ _pipelines: p } as DeferRenderer);
    expect(Object.prototype.hasOwnProperty.call(p, "getForRender")).toBe(true);
    d.release();
    expect(Object.prototype.hasOwnProperty.call(p, "getForRender")).toBe(false);
  });

  it("does nothing on a renderer without three's internals (another three version, a test fake)", async () => {
    const d = deferPipelines({} as DeferRenderer);
    expect(d.active).toBe(false);
    expect(d.pending()).toBe(0);
    await d.settle();
    d.release();
  });
});

/** three's Pipelines.isReady / get: a render object draws once its pipeline is compiled. */
function gateRenderer() {
  const compiled = new Set<string>();
  const pipelineOf = new Map<string, object>();
  const pipelines = {
    get(ro: unknown) {
      const k = String(ro).split("#")[0]!; // "tree#2": another render object sharing tree's pipeline
      if (!pipelineOf.has(k)) pipelineOf.set(k, { k });
      return { pipeline: pipelineOf.get(k) };
    },
    isReady(ro: unknown) {
      return compiled.has(String(ro).split("#")[0]!);
    },
  };
  /** One frame over these render objects: the ones that drew. */
  const frame = (ros: string[]) => ros.filter((ro) => pipelines.isReady(ro));
  return { renderer: { _pipelines: pipelines } as GateRenderer, pipelines, compiled, frame };
}

describe("gateFirstDraws (WebGL2: a program's first draw compiles its Metal pipeline in the GPU process)", () => {
  it("spends a cost budget per frame (always one first draw), with a pipeline's cost from its GLSL size", () => {
    const g = gateRenderer();
    const cost: Record<string, number> = { a: 10, b: 30, c: 5, d: 50 };
    const gate = gateFirstDraws(g.renderer, undefined, (p) => cost[(p as { k: string }).k]!);
    for (const k of ["a", "b", "c", "d"]) g.compiled.add(k);
    gate.frame(40);
    expect(g.frame(["a", "b", "c", "d"])).toEqual(["a", "b"]); // 10 + 30 = 40; c would go over
    gate.frame(40);
    expect(g.frame(["a", "b", "c", "d"])).toEqual(["a", "b", "c"]); // 5; then d (50) won't fit
    gate.frame(40);
    expect(g.frame(["a", "b", "c", "d"])).toEqual(["a", "b", "c", "d"]); // over budget alone: still one per frame
    expect(gate.granted()).toBe(4);
    gate.release();
    expect(pipelineCost({ vertexProgram: { code: "x".repeat(300) }, fragmentProgram: { code: "y".repeat(700) } })).toBe(1000);
    expect(pipelineCost({})).toBe(1);
    // skinned shadow-pass programs (characters, horses) cost far more than their size: always alone
    const skinnedShadow = { vertexProgram: { code: "in vec4 skinIndex;" + "x".repeat(3000) }, fragmentProgram: { code: "y".repeat(1900) } };
    expect(pipelineCost(skinnedShadow)).toBeGreaterThan(FIRST_DRAWS_START);
    const skinnedToon = { vertexProgram: { code: "in vec4 skinIndex;" + "x".repeat(4600) }, fragmentProgram: { code: "y".repeat(16000) } };
    expect(pipelineCost(skinnedToon)).toBe(4618 + 16000); // the main-pass skinned toon follows its size
  });

  it("lets a budget of never-drawn pipelines draw per frame; drawn ones always draw, uncompiled ones never", () => {
    const g = gateRenderer();
    const gate = gateFirstDraws(g.renderer);
    for (const k of ["a", "b", "c", "d", "e"]) g.compiled.add(k);
    const all = ["a", "a#2", "b", "c", "d", "e", "f"];
    gate.frame(2);
    expect(g.frame(all)).toEqual(["a", "a#2", "b"]); // a's second object shares a's pipeline
    expect(gate.waiting()).toBe(3); // c, d, e are compiled and wait their turn; f isn't compiled
    gate.frame(2);
    expect(g.frame(all)).toEqual(["a", "a#2", "b", "c", "d"]);
    gate.frame(2);
    expect(g.frame(all)).toEqual(["a", "a#2", "b", "c", "d", "e"]);
    expect(gate.waiting()).toBe(0);
    expect(gate.granted()).toBe(5);
    gate.release();
  });

  it("remembers what this renderer has drawn across warm-ups, and release() restores three's method", () => {
    const g = gateRenderer();
    const own = g.pipelines.isReady;
    g.compiled.add("a");
    const first = gateFirstDraws(g.renderer);
    first.frame(1);
    expect(g.frame(["a"])).toEqual(["a"]);
    first.release();
    expect(g.pipelines.isReady).toBe(own);
    const again = gateFirstDraws(g.renderer);
    again.frame(0);
    expect(g.frame(["a"])).toEqual(["a"]); // already drawn once: no budget needed
    again.release();
    again.release();
  });

  it("tells a listener about each first draw it allows (diagnostics)", () => {
    const g = gateRenderer();
    const heard: string[] = [];
    const gate = gateFirstDraws(g.renderer, (ro, p) => heard.push(`${String(ro)}:${(p as { k: string }).k}`));
    for (const k of ["a", "b"]) g.compiled.add(k);
    gate.frame(5);
    g.frame(["a", "a#2", "b"]);
    gate.frame(5);
    g.frame(["a", "b"]);
    expect(heard).toEqual(["a:a", "b:b"]);
    gate.release();
  });

  it("does nothing without three's internals", () => {
    const gate = gateFirstDraws({} as GateRenderer);
    expect(gate.active).toBe(false);
    gate.frame(3);
    expect(gate.waiting()).toBe(0);
    gate.release();
  });
});

describe("FirstDrawPacer (one batch of first draws in flight, sized by the GPU's measured cost)", () => {
  it("sends no new first draws until the GPU has finished the last batch", () => {
    const p = new FirstDrawPacer();
    let done = false;
    expect(p.allowance()).toBe(FIRST_DRAWS_START);
    p.sent(FIRST_DRAWS_START, 0, () => done);
    p.tick(16);
    expect(p.allowance()).toBe(0); // the GPU process is still building Metal pipelines
    p.tick(33);
    expect(p.allowance()).toBe(0);
    done = true;
    p.tick(50);
    expect(p.allowance()).toBeGreaterThan(0);
    expect(p.inFlight()).toBe(false);
  });

  it("sizes the next batch to take about BATCH_TARGET_MS at the cost rate it measured", () => {
    const p = new FirstDrawPacer();
    p.sent(40_000, 0, () => true); // 40k characters of GLSL took 200 ms: 5 ms per 1000
    p.tick(200);
    expect(p.allowance()).toBe(Math.round((BATCH_TARGET_MS / 200) * 40_000));
  });

  it("smooths the rate over batches, so one quick or slow batch doesn't swing it", () => {
    const p = new FirstDrawPacer();
    p.sent(20_000, 0, () => true);
    p.tick(100); // 5 ms per 1000
    p.sent(20_000, 100, () => true);
    p.tick(300); // 10 ms per 1000: the rate becomes 7.5
    expect(p.allowance()).toBe(Math.round(BATCH_TARGET_MS / 0.0075));
  });

  it("a warm cache (quick batches) grows the budget, up to a cap", () => {
    const p = new FirstDrawPacer();
    for (let i = 0; i < 10; i++) {
      p.sent(p.allowance(), i * 20, () => true);
      p.tick(i * 20 + 20);
    }
    expect(p.allowance()).toBeGreaterThan(FIRST_DRAWS_START * 4);
    expect(p.allowance()).toBeLessThanOrEqual(2_000_000);
  });

  it("a frame with no first draws leaves nothing in flight", () => {
    const p = new FirstDrawPacer();
    p.sent(0, 0, () => false);
    expect(p.inFlight()).toBe(false);
    expect(p.allowance()).toBe(FIRST_DRAWS_START);
  });

  it("without fences, takes the frame time as the batch's time", () => {
    const p = new FirstDrawPacer();
    p.sent(30_000, 0, null);
    expect(p.inFlight()).toBe(false);
    p.tick(300, 300); // 10 ms per 1000
    expect(p.allowance()).toBe(Math.round(BATCH_TARGET_MS / 0.01));
  });

  it("tells a listener how long each batch took, with what it was sent with (diagnostics)", () => {
    const heard: [number, number, unknown][] = [];
    const p = new FirstDrawPacer((ms, used, tag) => heard.push([ms, used, tag]));
    p.sent(3, 10, () => true, ["terrain"]);
    p.tick(130);
    expect(heard).toEqual([[120, 3, ["terrain"]]]);
  });
});

describe("glFence", () => {
  it("reads a WebGL2 fence without waiting, and deletes it once signalled", () => {
    let status = 0;
    const deleted: unknown[] = [];
    const gl = {
      SYNC_GPU_COMMANDS_COMPLETE: 1, SYNC_STATUS: 2, SIGNALED: 3,
      fenceSync: () => ({ id: 1 }),
      getSyncParameter: () => status,
      deleteSync: (s: unknown) => void deleted.push(s),
      flush() {},
    };
    const done = glFence(gl)!;
    expect(done()).toBe(false);
    status = 3;
    expect(done()).toBe(true);
    expect(done()).toBe(true);
    expect(deleted).toHaveLength(1);
    expect(glFence(null)).toBeNull();
    expect(glFence({} as never)).toBeNull();
  });
});
