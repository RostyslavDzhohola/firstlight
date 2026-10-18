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
  /** The warm-up's own frames over 100 ms, longest first (at most 12): what each was made of. */
  slow: SlowFrame[];
  /** `?warmdiag`: the slowest fenced first-draw batches (GPU ms) and the pipelines in each. */
  batches?: FirstDrawBatch[];
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

/** One long warm-up frame: `ms` from the previous frame, `cpu` the draw itself on the main thread. */
export interface SlowFrame {
  phase: "shadows" | "frames" | "drain";
  ms: number;
  cpu: number;
  builds: number;
  /** Pipelines drawn for the first time in it, and its first-draw budget (GLSL characters, WebGL2). */
  firstDraws: number;
  budget: number;
}

/** One pipeline drawn for the first time: its material, object and GLSL source sizes (characters). */
export interface FirstDrawItem {
  material: string;
  object: string;
  vs: number;
  fs: number;
}

export interface FirstDrawBatch {
  ms: number;
  items: FirstDrawItem[];
}
