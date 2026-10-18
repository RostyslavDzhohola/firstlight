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
// gateFirstDraws() lets only a budget of never-drawn pipelines draw per frame, priced by the GLSL of
// their stages the GPU hasn't drawn yet plus a per-pipeline overhead (newStageCost, #39);
// FirstDrawPacer sizes the budget from the GPU's measured rate, one fenced batch in flight at a time.
// The warm-up renders frames until every program is compiled and drawn once. `?oldpacer` keeps
// D-load-2's pricing (whole programs, a floor for skinned shadow programs) and pacing (OLD_PACER).

/** The private part of three's Renderer this touches (three is pinned, SPEC §3). */
export interface DeferRenderer {
  _pipelines?: {
    getForRender(renderObject: unknown, promises?: Promise<unknown>[] | null): unknown;
    get?(renderObject: unknown): { pipeline?: unknown } | undefined;
  };
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
  /** With a link cap: render objects turned away since the last frame() (no pipeline started for them). */
  held(): number;
  /** A new frame: count held render objects afresh. */
  frame(): void;
  /** Back to three's own behaviour (idempotent). Call settle() first. */
  release(): void;
}

export interface DeferOptions {
  /**
   * `?linkcap=N` (#39 A/B): at most this many programs compiling at once. A render object that has
   * no pipeline yet waits (nothing drawn) while that many are linking; frames ask again. 0: no cap.
   */
  maxPending?: number;
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

export function deferPipelines(renderer: DeferRenderer, opts: DeferOptions = {}): DeferredPipelines {
  const pipelines = renderer._pipelines;
  if (!pipelines || typeof pipelines.getForRender !== "function") {
    return { active: false, pending: () => 0, started: () => 0, finished: () => 0, settle: async () => {}, held: () => 0, frame() {}, release() {} };
  }
  const original = pipelines.getForRender;
  const cap = opts.maxPending ?? 0;
  const canHold = cap > 0 && typeof pipelines.get === "function";
  let list: Promise<unknown>[] = [];
  let started = 0;
  let finished = 0;
  let held = 0;
  const done = () => void finished++;
  const release = overrideMethod(pipelines, "getForRender", function (this: NonNullable<DeferRenderer["_pipelines"]>, renderObject: unknown) {
    if (canHold && started - finished >= cap && this.get!(renderObject)?.pipeline === undefined) {
      held++; // no pipeline, so nothing drawn: a later frame asks again
      return undefined;
    }
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
    held: () => held,
    frame() {
      held = 0;
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
  /** A new frame: never-drawn pipelines may draw in it up to `budget` cost (always at least one). */
  frame(budget: number): void;
  /** Compiled pipelines refused a first draw in the current frame (waiting their turn). */
  waiting(): number;
  /** First draws allowed so far, and their summed cost. */
  granted(): number;
  cost(): number;
  /** Back to three's own isReady (idempotent). */
  release(): void;
}

/**
 * Target GPU time for one fenced batch of first draws (ms). The fence reports a few frames late,
 * so the frames themselves stay well under 250 ms.
 */
export const BATCH_TARGET_MS = 160;
/** The first batch's budget, in GLSL characters: ~5 ms per 1000 on a cold M1 cache, so ~120 ms. */
export const FIRST_DRAWS_START = 24_000;
/**
 * The most a batch may cost (units: GLSL characters of new stages) until full batches have come back
 * quick (a warm cache); a batch over the target puts it back. ~5 ms per 1000 on a cold M1: ~200 ms.
 */
export const FIRST_DRAWS_CAP = 40_000;
/**
 * What a first draw costs on top of its new stages' characters: a pipeline whose stages were all
 * drawn before still builds its own pipeline state. Fitted on a cold M1 (#39, D-load-3): a lone first
 * draw took about 75 ms + 6.5 ms per 1000 new characters, the fence's latency included.
 */
export const PIPELINE_OVERHEAD = 6_000;
/**
 * The part of a batch's measured time that isn't the GPU's work on it: the fence is read once a
 * frame, so even an empty batch takes a frame or two.
 */
export const FENCE_LATENCY_MS = 33;
/**
 * Skinned shadow-pass programs (characters, horses: ~5k characters) took ~270 ms each to build on a
 * cold M1, far over their size: price them so they always go alone (`?oldpacer` only).
 */
const SKINNED_SHADOW_COST = 60_000;
const BUDGET_MAX = 2_000_000;

/**
 * A pipeline's first-draw cost estimate under `?oldpacer`: its GLSL size (vertex + fragment
 * characters). On a cold M1 cache the Metal build took about 5–6 ms per 1000 characters (D-load-2).
 */
export function pipelineCost(pipeline: object): number {
  const p = pipeline as { vertexProgram?: { code?: string }; fragmentProgram?: { code?: string } };
  const vs = p.vertexProgram?.code ?? "";
  const fs = p.fragmentProgram?.code ?? "";
  const size = Math.max(1, vs.length + fs.length);
  // a shadow pass's fragment is a few lines; a skinned vertex stage reads skinIndex
  return fs.length > 0 && fs.length < 4000 && vs.includes("skinIndex") ? Math.max(size, SKINNED_SHADOW_COST) : size;
}

/**
 * A first draw's price (#39): the characters of its vertex and fragment stages that this renderer
 * hasn't drawn yet (three shares a stage between pipelines with the same source), plus
 * PIPELINE_OVERHEAD. No floor: skinned shadow programs cost their size like everything else.
 */
export function newStageCost(pipeline: object, drawn: DrawnStages): number {
  return PIPELINE_OVERHEAD + newStageChars(pipeline, drawn);
}

/** How FirstDrawPacer learns and sizes batches. */
export interface PacerTuning {
  /** The first batch's budget, and the ceiling until full batches come back quick (cost units). */
  start: number;
  cap: number;
  /** Raise the ceiling by `growth` after a batch that used most of it within half the target. */
  liftCap: boolean;
  /** A batch's budget is at most `growth` × the last batch's units (or the start budget). */
  growth: number;
  /** ms of each batch's time that is the fence's latency, not GPU work. */
  latency: number;
  /** How far a higher / lower measured rate moves the smoothed one (1: all the way). */
  rise: number;
  fall: number;
  /** Learn from frame times when there are no fences. */
  unfenced: boolean;
}

/** #39: rate up at once and down slowly, growth ≤ 1.5× per batch, a ceiling lifted only by quick full batches. */
export const PACER: Readonly<PacerTuning> = {
  start: FIRST_DRAWS_START, cap: FIRST_DRAWS_CAP, liftCap: true, growth: 1.5, latency: FENCE_LATENCY_MS, rise: 1, fall: 0.25, unfenced: false,
};
/** D-load-2's pacer (`?oldpacer`): the mean of the last rate and the new one, no growth limit, no ceiling. */
export const OLD_PACER: Readonly<PacerTuning> = {
  start: FIRST_DRAWS_START, cap: BUDGET_MAX, liftCap: false, growth: Infinity, latency: 0, rise: 0.5, fall: 0.5, unfenced: true,
};

/**
 * Paces WebGL2 first draws. A frame's GPU work shows up in later frames' times, not its own, so
 * pacing by frame times doubled the budget just before the cost arrived. With a fence after each
 * frame that drew something new, one batch is in flight at a time: no new first draws until the GPU
 * has finished it. Budgets are in cost units (newStageCost): each finished batch measures the GPU's
 * ms per unit (rising at once, falling slowly), and the next batch gets what should take
 * BATCH_TARGET_MS, at most 1.5× the last batch and at most the ceiling.
 */
export class FirstDrawPacer {
  private readonly onBatch?: (ms: number, used: number, tag: unknown) => void;
  private readonly tune: Readonly<PacerTuning>;
  /** `onBatch` (diagnostics) hears each finished batch: the GPU's ms for it and the tag it was sent with. */
  constructor(onBatch?: (ms: number, used: number, tag: unknown) => void, tuning: Readonly<PacerTuning> = PACER) {
    this.onBatch = onBatch;
    this.tune = tuning;
    this.budget = tuning.start;
    this.cap = tuning.cap;
  }

  private budget: number;
  /** The current ceiling on a batch's budget. */
  private cap: number;
  private batch: { done: () => boolean; at: number; used: number; tag: unknown } | null = null;
  private lastUsed = 0;
  /** ms of GPU time per cost unit, smoothed over batches (null: nothing measured yet). */
  private rate: number | null = null;
  private readonly latencies: number[] = [];

  /** The cost the frame about to be drawn may spend on first draws. */
  allowance(): number {
    return this.batch ? 0 : this.budget;
  }

  inFlight(): boolean {
    return this.batch !== null;
  }

  /** After a frame: it spent `used` on first draws; `fence` says when the GPU finished them (null: no fences). */
  sent(used: number, now: number, fence: (() => boolean) | null, tag?: unknown): void {
    this.lastUsed = used;
    if (used > 0 && fence) this.batch = { done: fence, at: now, used, tag };
  }

  /** Each new frame: settle the batch in flight, or (without fences) pace by `frameMs`. */
  tick(now: number, frameMs?: number): void {
    if (this.batch) {
      if (!this.batch.done()) return;
      const ms = now - this.batch.at;
      this.latencies.push(ms);
      this.onBatch?.(ms, this.batch.used, this.batch.tag);
      this.learn(ms, this.batch.used);
      this.batch = null;
    } else if (this.tune.unfenced && frameMs !== undefined && this.lastUsed > 0) {
      this.learn(frameMs, this.lastUsed);
      this.lastUsed = 0;
    }
  }

  private learn(ms: number, used: number): void {
    const t = this.tune;
    const r = Math.max(0, ms - t.latency) / used;
    if (this.rate === null) this.rate = r;
    else this.rate += (r - this.rate) * (r > this.rate ? t.rise : t.fall);
    if (t.liftCap) {
      // a warm cache: a batch that used most of the ceiling came back within half the target
      if (ms <= BATCH_TARGET_MS / 2 && used >= 0.75 * this.cap) this.cap = Math.min(BUDGET_MAX, this.cap * t.growth);
      else if (ms > BATCH_TARGET_MS) this.cap = t.cap;
    }
    const work = BATCH_TARGET_MS - t.latency;
    const byRate = this.rate > 0 ? work / this.rate : Infinity;
    const byGrowth = t.growth * Math.max(used, t.start);
    this.budget = Math.round(Math.max(1, Math.min(this.cap, byRate, byGrowth)));
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
/**
 * The shader stages each renderer has drawn at least once: three's ProgrammableStage objects, one per
 * distinct vertex or fragment source, shared by every pipeline built from that source.
 */
const stagesDrawnBy = new WeakMap<object, WeakSet<object>>();

/** What a pipeline is made of: its vertex and fragment stages (three's ProgrammableStage). */
interface Staged {
  vertexProgram?: { code?: string };
  fragmentProgram?: { code?: string };
}

/** Which stages a renderer has drawn already (read-only view for pricing). */
export type DrawnStages = Pick<WeakSet<object>, "has">;

/** Characters of `pipeline`'s stages that `drawn` doesn't hold yet. */
export function newStageChars(pipeline: object, drawn: DrawnStages): number {
  const p = pipeline as Staged;
  const v = p.vertexProgram && !drawn.has(p.vertexProgram) ? (p.vertexProgram.code?.length ?? 0) : 0;
  const f = p.fragmentProgram && !drawn.has(p.fragmentProgram) ? (p.fragmentProgram.code?.length ?? 0) : 0;
  return v + f;
}

/** A first draw the gate allowed: what it was charged and the characters of its stages new to the GPU. */
export interface Grant {
  cost: number;
  newChars: number;
}

/**
 * `onGrant` (diagnostics) hears each first draw allowed, with the render object, its pipeline and
 * the grant; `costOf` prices a pipeline, given the stages drawn so far (pipelineCost in the warm-up;
 * 1 each by default). A first draw marks its stages drawn; one turned away doesn't.
 */
export function gateFirstDraws(
  renderer: GateRenderer,
  onGrant?: (renderObject: unknown, pipeline: object, grant: Grant) => void,
  costOf: (pipeline: object, drawn: DrawnStages) => number = () => 1,
): FirstDrawGate {
  const pipelines = renderer._pipelines;
  if (!pipelines || typeof pipelines.isReady !== "function" || typeof pipelines.get !== "function") {
    return { active: false, frame() {}, waiting: () => 0, granted: () => 0, cost: () => 0, release() {} };
  }
  let drawn = drawnBy.get(pipelines);
  if (!drawn) drawnBy.set(pipelines, (drawn = new WeakSet()));
  const seen = drawn;
  let stageSet = stagesDrawnBy.get(pipelines);
  if (!stageSet) stagesDrawnBy.set(pipelines, (stageSet = new WeakSet()));
  const stages = stageSet;
  const original = pipelines.isReady;
  let budget = 0;
  let spent = 0;
  let inFrame = 0;
  let granted = 0;
  let cost = 0;
  let waiting = new Set<object>();
  const release = overrideMethod(pipelines, "isReady", function (this: NonNullable<GateRenderer["_pipelines"]>, renderObject: unknown) {
    if (!original.call(this, renderObject)) return false;
    const p = this.get(renderObject).pipeline;
    if (!p || seen.has(p)) return true;
    const c = costOf(p, stages);
    if (budget > 0 && (inFrame === 0 || spent + c <= budget)) {
      spent += c;
      inFrame++;
      granted++;
      cost += c;
      seen.add(p);
      if (onGrant) onGrant(renderObject, p, { cost: c, newChars: newStageChars(p, stages) });
      const st = p as Staged;
      if (st.vertexProgram) stages.add(st.vertexProgram);
      if (st.fragmentProgram) stages.add(st.fragmentProgram);
      return true;
    }
    waiting.add(p);
    return false;
  });
  return {
    active: true,
    frame(b) {
      budget = b;
      spent = 0;
      inFrame = 0;
      waiting = new Set();
    },
    waiting: () => waiting.size,
    granted: () => granted,
    cost: () => cost,
    release,
  };
}
