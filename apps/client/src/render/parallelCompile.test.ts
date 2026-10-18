import { describe, expect, it } from "vitest";
import {
  BATCH_TARGET_MS, deferPipelines, FENCE_LATENCY_MS, FIRST_DRAWS_CAP, FIRST_DRAWS_START, FirstDrawPacer, gateFirstDraws, glFence,
  newStageCost, OLD_PACER, PACER, PIPELINE_OVERHEAD, pipelineCost, type DeferRenderer, type GateRenderer,
} from "./parallelCompile.ts";

/** three's Pipelines as the backend sees it: a new pipeline compiles in parallel only when given a list. */
function fakeRenderer() {
  const made: { ro: string; parallel: boolean; finish: () => void }[] = [];
  const pipelines = {
    /** A render object has a pipeline once getForRender has made one. */
    get(ro: unknown) {
      return { pipeline: made.some((m) => m.ro === String(ro)) ? { ro } : undefined };
    },
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

  it("with a cap on links in flight, a render object without a pipeline waits its turn; one with a pipeline always goes", async () => {
    const f = fakeRenderer();
    const d = deferPipelines(f.renderer, { maxPending: 2 });
    for (const ro of ["a", "b", "c", "d"]) f.pipelines.getForRender(ro);
    expect(f.made.map((m) => m.ro)).toEqual(["a", "b"]); // c and d are held: no link started, nothing to draw
    expect([d.pending(), d.held()]).toEqual([2, 2]);
    f.pipelines.getForRender("a"); // has its pipeline: three's own path (an update), never held
    expect(f.made).toHaveLength(3);
    d.frame(); // a new frame: what it holds is counted afresh
    expect(d.held()).toBe(0);
    f.made[0]!.finish();
    f.made[2]!.finish();
    await tick();
    for (const ro of ["c", "d"]) f.pipelines.getForRender(ro); // retried by the next frame: b still links
    expect(f.made.slice(3).map((m) => m.ro)).toEqual(["c"]);
    expect(d.held()).toBe(1);
    d.frame();
    f.made[1]!.finish();
    await tick();
    f.pipelines.getForRender("d");
    expect(f.made.slice(3).map((m) => m.ro)).toEqual(["c", "d"]);
    expect(d.held()).toBe(0);
    d.release();
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

  it("tracks the shader stages drawn: a first draw marks its stages, a refused one doesn't (diagnostics hear cost and new characters)", () => {
    // three shares a vertex or fragment stage between pipelines with the same source
    const vs = { code: "v".repeat(100) };
    const fsA = { code: "a".repeat(50) };
    const fsB = { code: "b".repeat(70) };
    const of: Record<string, object> = { a: { vertexProgram: vs, fragmentProgram: fsA }, b: { vertexProgram: vs, fragmentProgram: fsB }, c: { vertexProgram: vs, fragmentProgram: fsA } };
    const renderer = { _pipelines: { isReady: () => true, get: (ro: unknown) => ({ pipeline: of[String(ro)] }) } } as GateRenderer;
    const heard: [string, number, number][] = [];
    const seenByCost: boolean[][] = [];
    const gate = gateFirstDraws(renderer, (ro, _p, g) => heard.push([String(ro), g.cost, g.newChars]), (p, drawn) => {
      const q = p as { vertexProgram: object; fragmentProgram: object };
      seenByCost.push([drawn.has(q.vertexProgram), drawn.has(q.fragmentProgram)]);
      return 10;
    });
    const draw = (ro: string) => renderer._pipelines!.isReady(ro);
    gate.frame(10);
    expect([draw("a"), draw("b")]).toEqual([true, false]); // b refused: its fragment stage stays new
    gate.frame(30);
    expect([draw("b"), draw("c")]).toEqual([true, true]);
    expect(heard).toEqual([["a", 10, 150], ["b", 10, 70], ["c", 10, 0]]); // c's stages were both drawn already
    expect(seenByCost).toEqual([[false, false], [true, false], [true, false], [true, true]]);
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

describe("newStageCost (a first draw priced by the stages new to the GPU)", () => {
  it("charges the characters of stages not drawn yet plus a per-pipeline overhead; no floor for skinned shadow programs", () => {
    const vs = { code: "in vec4 skinIndex;" + "x".repeat(3000) };
    const fs = { code: "y".repeat(1900) };
    const p = { vertexProgram: vs, fragmentProgram: fs };
    const none = new WeakSet<object>();
    expect(PIPELINE_OVERHEAD).toBeGreaterThan(0);
    expect(newStageCost(p, none)).toBe(PIPELINE_OVERHEAD + 3018 + 1900); // a skinned shadow program: its size
    expect(newStageCost(p, new WeakSet([vs]))).toBe(PIPELINE_OVERHEAD + 1900);
    // both stages drawn already (three shares a stage per source): it still builds a pipeline state
    expect(newStageCost(p, new WeakSet([vs, fs]))).toBe(PIPELINE_OVERHEAD);
    expect(newStageCost({}, none)).toBe(PIPELINE_OVERHEAD);
  });
});

describe("FirstDrawPacer (one batch of first draws in flight, sized by the GPU's measured cost)", () => {
  /** A fenced batch of `used` units that the GPU took `ms` over (the fence's own latency included). */
  const batch = (p: FirstDrawPacer, used: number, ms: number, at = 0) => {
    p.sent(used, at, () => true);
    p.tick(at + ms);
  };
  const L = FENCE_LATENCY_MS;
  const work = BATCH_TARGET_MS - L; // what a batch may cost beyond the fence's latency

  it("sends no new first draws until the GPU has finished the last batch", () => {
    const p = new FirstDrawPacer();
    let done = false;
    expect(p.allowance()).toBe(FIRST_DRAWS_START);
    p.sent(FIRST_DRAWS_START, 0, () => done);
    p.tick(16);
    expect(p.allowance()).toBe(0);
    done = true;
    p.tick(50);
    expect(p.allowance()).toBeGreaterThan(0);
    expect(p.inFlight()).toBe(false);
  });

  it("sizes the next batch to the target at the measured rate, the fence's latency aside", () => {
    const p = new FirstDrawPacer();
    batch(p, 20_000, L + 100); // 5 ms per 1000 units
    expect(p.allowance()).toBe(Math.round(work / 0.005));
  });

  it("the rate rises at once and falls slowly", () => {
    const p = new FirstDrawPacer();
    batch(p, 20_000, L + 100); // 0.005 ms per unit
    batch(p, 20_000, L + 200); // 0.01: up at once
    expect(p.allowance()).toBe(Math.round(work / 0.01));
    batch(p, 20_000, L + 100); // 0.005 again: only a quarter of the way back down
    expect(p.allowance()).toBe(Math.round(work / (0.01 + (0.005 - 0.01) * PACER.fall)));
  });

  it("a quick batch doesn't make the next one bigger than 1.5x its own units (or the start budget)", () => {
    const p = new FirstDrawPacer();
    batch(p, 4000, L); // nothing to learn from beyond the fence: no rate limit
    expect(p.allowance()).toBe(1.5 * FIRST_DRAWS_START); // grows from the start budget, not from 4000
    expect(p.allowance()).toBeLessThanOrEqual(FIRST_DRAWS_CAP);
  });

  it("caps batches at FIRST_DRAWS_CAP units until full batches come back quick; a slow batch puts the cap back", () => {
    const p = new FirstDrawPacer();
    batch(p, 36_000, 100); // not slow (under the target), not quick: the cap holds
    expect(p.allowance()).toBe(FIRST_DRAWS_CAP);
    const sizes: number[] = [];
    for (let i = 0; i < 4; i++) {
      // a warm cache: a full batch takes ~2 frames
      const a = p.allowance();
      batch(p, a, 30);
      sizes.push(p.allowance());
    }
    // each quick full batch lifts the cap 1.5x, and the next batch grows at most 1.5x
    expect(sizes).toEqual([60_000, 90_000, 135_000, 202_500]);
    batch(p, p.allowance(), BATCH_TARGET_MS + 20); // over the target: back to the proven cap
    expect(p.allowance()).toBeLessThanOrEqual(FIRST_DRAWS_CAP);
  });

  it("learns only from fenced batches", () => {
    const p = new FirstDrawPacer();
    p.sent(30_000, 0, null);
    expect(p.inFlight()).toBe(false);
    p.tick(300, 300); // a slow frame without a fence says nothing about the batch
    expect(p.allowance()).toBe(FIRST_DRAWS_START);
  });

  it("a frame with no first draws leaves nothing in flight", () => {
    const p = new FirstDrawPacer();
    p.sent(0, 0, () => false);
    expect(p.inFlight()).toBe(false);
    expect(p.allowance()).toBe(FIRST_DRAWS_START);
  });

  it("tells a listener how long each batch took, with what it was sent with (diagnostics)", () => {
    const heard: [number, number, unknown][] = [];
    const p = new FirstDrawPacer((ms, used, tag) => heard.push([ms, used, tag]));
    p.sent(3, 10, () => true, ["terrain"]);
    p.tick(130);
    expect(heard).toEqual([[120, 3, ["terrain"]]]);
  });
});

describe("FirstDrawPacer with ?oldpacer (D-load-2: whole programs, a mean rate, no growth limit)", () => {
  it("sends no new first draws until the GPU has finished the last batch", () => {
    const p = new FirstDrawPacer(undefined, OLD_PACER);
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
    const p = new FirstDrawPacer(undefined, OLD_PACER);
    p.sent(40_000, 0, () => true); // 40k characters of GLSL took 200 ms: 5 ms per 1000
    p.tick(200);
    expect(p.allowance()).toBe(Math.round((BATCH_TARGET_MS / 200) * 40_000));
  });

  it("smooths the rate over batches, so one quick or slow batch doesn't swing it", () => {
    const p = new FirstDrawPacer(undefined, OLD_PACER);
    p.sent(20_000, 0, () => true);
    p.tick(100); // 5 ms per 1000
    p.sent(20_000, 100, () => true);
    p.tick(300); // 10 ms per 1000: the rate becomes 7.5
    expect(p.allowance()).toBe(Math.round(BATCH_TARGET_MS / 0.0075));
  });

  it("a warm cache (quick batches) grows the budget, up to a cap", () => {
    const p = new FirstDrawPacer(undefined, OLD_PACER);
    for (let i = 0; i < 10; i++) {
      p.sent(p.allowance(), i * 20, () => true);
      p.tick(i * 20 + 20);
    }
    expect(p.allowance()).toBeGreaterThan(FIRST_DRAWS_START * 4);
    expect(p.allowance()).toBeLessThanOrEqual(2_000_000);
  });

  it("a frame with no first draws leaves nothing in flight", () => {
    const p = new FirstDrawPacer(undefined, OLD_PACER);
    p.sent(0, 0, () => false);
    expect(p.inFlight()).toBe(false);
    expect(p.allowance()).toBe(FIRST_DRAWS_START);
  });

  it("without fences, takes the frame time as the batch's time", () => {
    const p = new FirstDrawPacer(undefined, OLD_PACER);
    p.sent(30_000, 0, null);
    expect(p.inFlight()).toBe(false);
    p.tick(300, 300); // 10 ms per 1000
    expect(p.allowance()).toBe(Math.round(BATCH_TARGET_MS / 0.01));
  });

  it("tells a listener how long each batch took, with what it was sent with (diagnostics)", () => {
    const heard: [number, number, unknown][] = [];
    const p = new FirstDrawPacer((ms, used, tag) => heard.push([ms, used, tag]), OLD_PACER);
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
