import { describe, expect, it } from "vitest";
import {
  deferPipelines, FIRST_DRAWS_MAX, FIRST_DRAWS_START, gateFirstDraws, nextDrawBudget, type DeferRenderer, type GateRenderer,
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

  it("does nothing without three's internals", () => {
    const gate = gateFirstDraws({} as GateRenderer);
    expect(gate.active).toBe(false);
    gate.frame(3);
    expect(gate.waiting()).toBe(0);
    gate.release();
  });
});

describe("nextDrawBudget", () => {
  it("doubles while frames are quick, halves when one is long, stays between 1 and the cap", () => {
    expect(nextDrawBudget(FIRST_DRAWS_START, 20)).toBe(FIRST_DRAWS_START * 2);
    expect(nextDrawBudget(8, 100)).toBe(8);
    expect(nextDrawBudget(8, 200)).toBe(4);
    expect(nextDrawBudget(1, 900)).toBe(1);
    expect(nextDrawBudget(FIRST_DRAWS_MAX, 10)).toBe(FIRST_DRAWS_MAX);
  });

  it("grows only after a frame that used its whole budget (quick frames that drew nothing new prove nothing)", () => {
    expect(nextDrawBudget(4, 10, 0)).toBe(4);
    expect(nextDrawBudget(4, 10, 3)).toBe(4);
    expect(nextDrawBudget(4, 10, 4)).toBe(8);
    expect(nextDrawBudget(4, 400, 0)).toBe(2); // a long frame still halves it
  });
});
