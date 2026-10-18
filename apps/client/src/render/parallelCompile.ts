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

/**
 * Put `fn` in place of `obj[key]` and return an idempotent restore that puts back what was there:
 * the instance's own method, or (by deleting the override) the prototype's.
 */
function overrideMethod<T extends object, K extends keyof T>(obj: T, key: K, fn: T[K]): () => void {
  const own = Object.prototype.hasOwnProperty.call(obj, key);
  const original = obj[key];
  obj[key] = fn;
  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    if (own) obj[key] = original;
    else delete obj[key];
  };
}

export function deferPipelines(renderer: DeferRenderer): DeferredPipelines {
  const pipelines = renderer._pipelines;
  if (!pipelines || typeof pipelines.getForRender !== "function") {
    return { active: false, pending: () => 0, started: () => 0, finished: () => 0, settle: async () => {}, release() {} };
  }
  const original = pipelines.getForRender;
  let list: Promise<unknown>[] = [];
  let started = 0;
  let finished = 0;
  const done = () => void finished++;
  const release = overrideMethod(pipelines, "getForRender", function (this: unknown, renderObject: unknown) {
    const before = list.length;
    const out = original.call(this, renderObject, list);
    for (let i = before; i < list.length; i++) {
      started++;
      list[i] = list[i]!.then(done, done); // three's never reject; count either way
    }
    return out;
  });
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
    release,
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
/** A fenced batch's time includes a few frames before Chrome reports the fence: looser bounds. */
const QUICK_BATCH_MS = 120;
const LONG_BATCH_MS = 250;

/**
 * The next first-draw budget from how long a batch of `used` first draws took (or a frame, without
 * fences): halve after a long one (from what was actually sent); double after a quick one that used
 * the whole budget.
 */
export function nextDrawBudget(budget: number, ms: number, used = budget, quick = QUICK_FRAME_MS, long = LONG_FRAME_MS): number {
  if (ms > long) return Math.max(1, Math.floor((used > 0 ? Math.min(used, budget) : budget) / 2));
  if (ms < quick && used >= budget) return Math.min(FIRST_DRAWS_MAX, budget * 2);
  return budget;
}

/**
 * Paces WebGL2 first draws. A frame's GPU work shows up in later frames' times, not its own, so
 * pacing by frame times doubled the budget just before the cost arrived. With a fence after each
 * frame that drew something new, one batch is in flight at a time: no new first draws until the GPU
 * has finished it, and the next batch's size follows how long that took.
 */
export class FirstDrawPacer {
  private budget = FIRST_DRAWS_START;
  private batch: { done: () => boolean; at: number; used: number } | null = null;
  private lastUsed = 0;
  private readonly latencies: number[] = [];

  /** First draws the frame about to be drawn may make. */
  allowance(): number {
    return this.batch ? 0 : this.budget;
  }

  inFlight(): boolean {
    return this.batch !== null;
  }

  /** After a frame: it made `used` first draws; `fence` says when the GPU finished them (null: no fences). */
  sent(used: number, now: number, fence: (() => boolean) | null): void {
    this.lastUsed = used;
    if (used > 0 && fence) this.batch = { done: fence, at: now, used };
  }

  /** Each new frame: settle the batch in flight, or (without fences) pace by `frameMs`. */
  tick(now: number, frameMs?: number): void {
    if (this.batch) {
      if (!this.batch.done()) return;
      const ms = now - this.batch.at;
      this.latencies.push(ms);
      this.budget = nextDrawBudget(this.budget, ms, this.batch.used, QUICK_BATCH_MS, LONG_BATCH_MS);
      this.batch = null;
    } else if (frameMs !== undefined) {
      this.budget = nextDrawBudget(this.budget, frameMs, this.lastUsed);
    }
  }

  /** Fenced batches so far and how long the GPU took over them (ms, rounded). */
  batches(): { batches: number; p50: number; max: number } {
    const l = [...this.latencies].sort((a, b) => a - b);
    return { batches: l.length, p50: Math.round(l[Math.floor(l.length / 2)] ?? 0), max: Math.round(l.at(-1) ?? 0) };
  }
}

/** The WebGL2 calls a fence needs. */
export interface FenceGL {
  SYNC_GPU_COMMANDS_COMPLETE: number;
  SYNC_STATUS: number;
  SIGNALED: number;
  fenceSync(condition: number, flags: number): unknown;
  getSyncParameter(sync: unknown, pname: number): unknown;
  deleteSync(sync: unknown): void;
  flush(): void;
}

/** A fence after the commands so far: done() polls it without waiting (null: no fences here). */
export function glFence(gl: FenceGL | null | undefined): (() => boolean) | null {
  if (!gl || typeof gl.fenceSync !== "function") return null;
  const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
  if (!sync) return null;
  gl.flush();
  let done = false;
  return () => {
    if (!done && gl.getSyncParameter(sync, gl.SYNC_STATUS) === gl.SIGNALED) {
      done = true;
      gl.deleteSync(sync);
    }
    return done;
  };
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
  const original = pipelines.isReady;
  let budget = 0;
  let granted = 0;
  let waiting = new Set<object>();
  const release = overrideMethod(pipelines, "isReady", function (this: NonNullable<GateRenderer["_pipelines"]>, renderObject: unknown) {
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
  });
  return {
    active: true,
    frame(b) {
      budget = b;
      waiting = new Set();
    },
    waiting: () => waiting.size,
    granted: () => granted,
    release,
  };
}
