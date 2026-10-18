// The shader warm-up's report (D-load-1): what warmup() returns and keeps in window.__shaders.warmups.
// Types only, with no imports, so the Playwright journeys (e2e/player.ts) share them with the client.

/** One warm-up phase: how long it took and how many node builds (shaders) it made. */
export interface WarmupPhase {
  ms: number;
  builds: number;
}

/** A finished warm-up, per phase (D-load-1). Times are performance.now() milliseconds. */
export interface WarmupReport {
  /** Who ran it: "arrival", "probe", "graphics", … ("" when the caller didn't say). */
  label: string;
  backend: "webgpu" | "webgl2";
  tier: string | null;
  start: number;
  end: number;
  ms: number;
  /** Node builds during this warm-up, and the session's total after it (the overlay's "shaders"). */
  builds: number;
  shaders: number;
  /** New GPU shader stages (vertex + fragment programs; three shares one per distinct source). */
  stages: number;
  /**
   * The warm-up's frames over 100 ms, in every phase: the longest 12, longest first; with `?warmdiag`
   * all of them, in time order.
   */
  slow: SlowFrame[];
  /** `?warmdiag`: every fenced first-draw batch in the order it was sent, and the pipelines in each. */
  batches?: FirstDrawBatch[];
  /** `?warmdiag`: the pipelines drawn for the first time, counted (from `batches`). */
  census?: FirstDrawCensus;
  /** WebGL2's paced first draws: how many, in how many fenced batches, and the GPU's time per batch. */
  firstDraws: { granted: number; batches: number; p50: number; max: number };
  phases: {
    /** compileAsync for the scene pass's context; `items`: the render objects it prepared. */
    compile: WarmupPhase & { items: number; wait: number };
    /** compileComputeAsync (WebGPU): no compute nodes yet. */
    compute: WarmupPhase & { nodes: number };
    /** Shadow casters joining a few per frame; `predicted`: the builds expected (predictShadowBuilds). */
    shadows: WarmupPhase & { frames: number; predicted: number; wait: number };
    /** Real frames behind the loader, the settle frame after the restore included; `drain`: the
     *  extra frames until every program was compiled and drawn once, `wait` their ms. */
    frames: WarmupPhase & { frames: number; wait: number; drain: number };
  };
}

/**
 * One long warm-up frame: `ms` from the previous frame, `cpu` the draw itself on the main thread (0 in
 * the compile phase, where the warm-up draws nothing), `t` when it ended (performance.now()).
 */
export interface SlowFrame {
  phase: "compile" | "shadows" | "frames" | "drain";
  t: number;
  ms: number;
  cpu: number;
  builds: number;
  /** Pipelines drawn for the first time in it, and its first-draw budget (cost units, WebGL2). */
  firstDraws: number;
  budget: number;
  /** A fenced first-draw batch was in flight (WebGL2), and which one (1 = the first sent; null: none). */
  inFlight: boolean;
  batch: number | null;
  /** Programs still compiling (links pending) at the time. */
  pending: number;
}

/** One pipeline drawn for the first time: its material, object and GLSL source sizes (characters). */
export interface FirstDrawItem {
  material: string;
  object: string;
  vs: number;
  fs: number;
  /** 32-bit FNV-1a hashes of the vertex and fragment sources (equal hash: the same stage). */
  vh: number;
  fh: number;
  /** What the pacer charged for it, and the characters of its stages not drawn before. */
  cost: number;
  newChars: number;
  /** A skinned vertex stage (characters, horses), and drawn in a shadow pass. */
  skinned: boolean;
  shadow: boolean;
}

/** One fenced batch of first draws (`?warmdiag`), sent at `t`; `ms` the GPU's time for it (null: never finished). */
export interface FirstDrawBatch {
  /** 1 = the first batch sent. */
  seq: number;
  t: number;
  ms: number | null;
  /** Charged cost units, GLSL characters (all, and of stages not drawn before), pipelines. */
  used: number;
  chars: number;
  newChars: number;
  n: number;
  /** Skinned shadow-pass pipelines in it. */
  skinnedShadow: number;
  /** Programs still compiling (links pending) when it was sent. */
  pending: number;
  items: FirstDrawItem[];
}

/** First-drawn pipelines by kind, and the distinct stage sources among them (by hash). */
export interface FirstDrawCensus {
  pipelines: number;
  skinnedShadow: number;
  skinnedMain: number;
  vertexStages: number;
  fragmentStages: number;
  skinnedVertexStages: number;
}
