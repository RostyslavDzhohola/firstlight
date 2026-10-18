// Parallel program compiles for the shader warm-up (D-load-2).
//
// three r186 compiles a new render pipeline in parallel only when it is handed a promise list: WebGL2
// then links without waiting (KHR_parallel_shader_compile, polled each frame) and WebGPU uses
// createRenderPipelineAsync. compileAsync hands it one list per render object and awaits it before
// building the next object, so the GPU compiled one program at a time; and a real frame hands it
// none, so WebGL2 links every new program on the spot (the shadow frames behind the loader).
//
// deferPipelines() routes every new pipeline, from compileAsync or from a frame, into one shared list
// while the warm-up runs: compileAsync finds nothing to wait for and builds the next object's nodes
// while the GPU compiles, and a frame skips drawing an object whose program isn't ready yet (three
// checks Pipelines.isReady before each draw; the loader hides it). settle() waits for the whole list.
// Without the extension WebGL2 links synchronously as before; without three's internals (another
// version) nothing changes.
//
// On WebGL2 a compiled program still costs on its first draw: ANGLE's Metal backend builds the Metal
// pipeline for it there, in the GPU process, which also draws the page. The first real warm-up frame
// drew every object at once and froze the loader for ~5 s on a cold shader cache (M1, D-load-2).
// gateFirstDraws() lets only a budget of never-drawn pipelines draw per frame (nextDrawBudget adapts
// it to the frame times); the warm-up renders frames until every program is compiled and drawn once.

/** The private part of three's Renderer this touches (three is pinned, SPEC §3). */
export interface DeferRenderer {
  _pipelines?: { getForRender(renderObject: unknown, promises?: Promise<unknown>[] | null): unknown };
}

export interface DeferredPipelines {
  /** False when three's internals weren't there: compiles stay as three does them. */
  readonly active: boolean;
  /** Pipelines still compiling. */
  pending(): number;
  /** Pipelines started since the deferral began, and those finished. */
  started(): number;
  finished(): number;
  /** Wait until every pipeline started so far, and any started meanwhile, is ready. */
  settle(): Promise<void>;
  /** Back to three's own behaviour (idempotent). Call settle() first. */
  release(): void;
}

export function deferPipelines(renderer: DeferRenderer): DeferredPipelines {
  const pipelines = renderer._pipelines;
  if (!pipelines || typeof pipelines.getForRender !== "function") {
    return { active: false, pending: () => 0, started: () => 0, finished: () => 0, settle: async () => {}, release() {} };
  }
  const own = Object.prototype.hasOwnProperty.call(pipelines, "getForRender");
  const original = pipelines.getForRender;
  let list: Promise<unknown>[] = [];
  let released = false;
  let started = 0;
  let finished = 0;
  const done = () => void finished++;
  pipelines.getForRender = function (this: unknown, renderObject: unknown) {
    const before = list.length;
    const out = original.call(this, renderObject, list);
    for (let i = before; i < list.length; i++) {
      started++;
      list[i] = list[i]!.then(done, done); // three's never reject; count either way
    }
    return out;
  };
  return {
    active: true,
    pending: () => started - finished,
    started: () => started,
    finished: () => finished,
    async settle() {
      while (list.length) {
        const batch = list;
        list = [];
        await Promise.all(batch);
      }
    },
    release() {
      if (released) return;
      released = true;
      if (own) pipelines.getForRender = original;
      else delete (pipelines as { getForRender?: unknown }).getForRender;
    },
  };
}

/** The private part of three's Pipelines the first-draw gate touches. */
export interface GateRenderer {
  _pipelines?: { isReady(renderObject: unknown): boolean; get(renderObject: unknown): { pipeline?: object } };
}

export interface FirstDrawGate {
  readonly active: boolean;
  /** A new frame: up to `budget` never-drawn pipelines may draw in it. */
  frame(budget: number): void;
  /** Compiled pipelines refused a first draw in the current frame (waiting their turn). */
  waiting(): number;
  /** First draws allowed so far. */
  granted(): number;
  /** Back to three's own isReady (idempotent). */
  release(): void;
}

/** First warm-up frame's budget, the cap, and the frame times that move it (ms). */
export const FIRST_DRAWS_START = 4;
export const FIRST_DRAWS_MAX = 64;
const QUICK_FRAME_MS = 60;
const LONG_FRAME_MS = 150;

/**
 * Next frame's first-draw budget from the last frame's time and how many first draws it made:
 * halve after a long frame; double after a quick one that used the whole budget.
 */
export function nextDrawBudget(budget: number, frameMs: number, used = budget): number {
  if (frameMs > LONG_FRAME_MS) return Math.max(1, Math.floor(budget / 2));
  if (frameMs < QUICK_FRAME_MS && used >= budget) return Math.min(FIRST_DRAWS_MAX, budget * 2);
  return budget;
}

/** Pipelines each renderer has drawn at least once (kept across warm-ups). */
const drawnBy = new WeakMap<object, WeakSet<object>>();

export function gateFirstDraws(renderer: GateRenderer): FirstDrawGate {
  const pipelines = renderer._pipelines;
  if (!pipelines || typeof pipelines.isReady !== "function" || typeof pipelines.get !== "function") {
    return { active: false, frame() {}, waiting: () => 0, granted: () => 0, release() {} };
  }
  let drawn = drawnBy.get(pipelines);
  if (!drawn) drawnBy.set(pipelines, (drawn = new WeakSet()));
  const seen = drawn;
  const own = Object.prototype.hasOwnProperty.call(pipelines, "isReady");
  const original = pipelines.isReady;
  let budget = 0;
  let granted = 0;
  let waiting = new Set<object>();
  let released = false;
  pipelines.isReady = function (this: NonNullable<GateRenderer["_pipelines"]>, renderObject: unknown) {
    if (!original.call(this, renderObject)) return false;
    const p = this.get(renderObject).pipeline;
    if (!p || seen.has(p)) return true;
    if (budget > 0) {
      budget--;
      granted++;
      seen.add(p);
      return true;
    }
    waiting.add(p);
    return false;
  };
  return {
    active: true,
    frame(b) {
      budget = b;
      waiting = new Set();
    },
    waiting: () => waiting.size,
    granted: () => granted,
    release() {
      if (released) return;
      released = true;
      if (own) pipelines.isReady = original;
      else delete (pipelines as { isReady?: unknown }).isReady;
    },
  };
}
