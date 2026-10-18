import { describe, expect, it } from "vitest";
import {
  deferPipelines, FIRST_DRAWS_MAX, FIRST_DRAWS_START, FirstDrawPacer, gateFirstDraws, glFence, nextDrawBudget,
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

describe("FirstDrawPacer (one batch of first draws in flight; its size follows the GPU's time for the last)", () => {
  it("sends no new first draws until the GPU has finished the last batch", () => {
    const p = new FirstDrawPacer();
    let done = false;
    expect(p.allowance()).toBe(FIRST_DRAWS_START);
    p.sent(FIRST_DRAWS_START, 0, () => done);
    p.tick(16);
    expect(p.allowance()).toBe(0); // still compiling Metal pipelines in the GPU process
    p.tick(33);
    expect(p.allowance()).toBe(0);
    done = true;
    p.tick(50); // finished in 50 ms: quick, and the batch was full
    expect(p.allowance()).toBe(FIRST_DRAWS_START * 2);
  });

  it("allows a fenced batch the few frames Chrome takes to report its fence", () => {
    const p = new FirstDrawPacer();
    p.sent(FIRST_DRAWS_START, 0, () => true);
    p.tick(100); // 100 ms: still quick for a fenced batch
    expect(p.allowance()).toBe(FIRST_DRAWS_START * 2);
    p.sent(FIRST_DRAWS_START * 2, 100, () => true);
    p.tick(300); // 200 ms: hold
    expect(p.allowance()).toBe(FIRST_DRAWS_START * 2);
  });

  it("halves after a batch the GPU took long over, never below one", () => {
    const p = new FirstDrawPacer();
    p.sent(2, 0, () => true);
    p.tick(400);
    expect(p.allowance()).toBe(1);
    p.sent(1, 400, () => true);
    p.tick(900);
    expect(p.allowance()).toBe(1);
    expect(p.inFlight()).toBe(false);
    expect(p.batches()).toEqual({ batches: 2, p50: 500, max: 500 });
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

  it("without fences, paces by the frame times instead", () => {
    const p = new FirstDrawPacer();
    p.sent(FIRST_DRAWS_START, 0, null);
    expect(p.inFlight()).toBe(false);
    p.tick(20, 20);
    expect(p.allowance()).toBe(FIRST_DRAWS_START * 2);
    p.sent(FIRST_DRAWS_START * 2, 20, null);
    p.tick(400, 380);
    expect(p.allowance()).toBe(FIRST_DRAWS_START);
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
