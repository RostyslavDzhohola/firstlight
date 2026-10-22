// Per-pass GPU cost (#52, `?bench=passes`). three's WebGPU timestamps add up overlapping passes on
// Apple GPUs (D29) and the frame rate stops at vsync, so neither tells which pass costs what. This
// renders a fixed view in batches of frames back to back, outside requestAnimationFrame, and waits
// for the GPU queue to go idle: wall time / frames = the GPU-bound cost of a frame. A pass costs the
// baseline minus the same view with that pass switched off. The method is vgpu's `gpuFrameTime`
// wall-clock fallback (https://vgpu.sh, #36), written here because three owns its command encoders.
//
// Each round alternates the baseline with every other configuration (B X1 B X2 B … B): a delta is
// the mean of the two baselines next to it minus the configuration, so slow thermal drift cancels
// locally. Each batch also reports the draw calls of its frames: a frame far below the batch's
// maximum skipped its passes (three schedules passes per node frame), and the run is invalid.
// Pure: no three or DOM, the host does the rendering (fake in tests).

import { percentile } from "./timing.ts";

/** One measured configuration: features switched off, and an optional GTAO override. */
export interface PassConfig {
  off: ReadonlySet<string>;
  ao?: { samples: number; scale: number } | null;
}

export interface PassCostHost {
  /** Candidate features, in report order before ranking. */
  readonly features: readonly string[];
  /** Whether the feature is on at the current tier (off ones are skipped, not measured). */
  isOn(feature: string): boolean;
  /** Apply a configuration for this session only (never persisted). */
  configure(config: PassConfig): Promise<void>;
  /** Let the configuration settle: pipeline rebuilds, shader builds, streaming. Not measured. */
  warm(): Promise<void>;
  /** Render `frames` frames back to back and wait for the GPU: wall time, and the CPU time of the loop. */
  renderBatch(frames: number): Promise<{ wallMs: number; cpuMs: number; draws?: { min: number; max: number } }>;
  /** Running count of shader (node) builds. */
  shaderBuilds(): number;
  visible(): boolean;
}

export interface PassCostOptions {
  rounds?: number;
  framesPerBatch?: number;
  /** Measure only these features (default: all the host's). */
  only?: readonly string[];
  /** Also sweep GTAO samples × resolution when AO is on. */
  gtao?: boolean;
}

export interface Stat {
  p50: number;
  p95: number;
}

export interface PassCost {
  feature: string;
  /** Saving per frame from switching the feature off (baseline − off), ms. */
  deltaMs: Stat;
  /** |delta p50| is within the baseline's noise floor. */
  belowNoise: boolean;
}

export interface GtaoCost {
  samples: number;
  /** GTAO resolution scale (1 = full, 0.5 = half). */
  scale: number;
  /** Cost per frame against AO off, ms. */
  costMs: Stat;
  belowNoise: boolean;
}

export interface PassCostReport {
  v: 1;
  method: "wall-clock-batch";
  valid: boolean;
  invalidReason: string | null;
  rounds: number;
  framesPerBatch: number;
  /** Baseline wall ms per frame, and the CPU time of the render loop per frame. */
  baseline: Stat & { cpuMs: number };
  /** The CPU loop takes ≥ 90% of the wall time: deltas may be CPU cost, not GPU. */
  cpuBound: boolean;
  /** p95 of |difference| between consecutive baseline batches, ms per frame. */
  noiseMs: number;
  /** Ranked by delta p50, largest first. */
  passes: PassCost[];
  sumOfDeltasMs: number;
  skipped: string[];
  gtao: GtaoCost[] | null;
  shaderBuildsDuringMeasure: number;
}

export const GTAO_SWEEP: readonly { samples: number; scale: number }[] = [
  { samples: 16, scale: 1 }, { samples: 16, scale: 0.5 },
  { samples: 8, scale: 1 }, { samples: 8, scale: 0.5 },
  { samples: 4, scale: 1 }, { samples: 4, scale: 0.5 },
];

const r3 = (v: number) => Math.round(v * 1000) / 1000;
const stat = (v: readonly number[]): Stat => ({ p50: r3(percentile(v, 0.5)), p95: r3(percentile(v, 0.95)) });
const NONE: ReadonlySet<string> = new Set();

export async function measurePassCosts(host: PassCostHost, opts: PassCostOptions = {}): Promise<PassCostReport> {
  const rounds = Math.max(1, opts.rounds ?? 8);
  const frames = Math.max(1, opts.framesPerBatch ?? 16);
  const wanted = opts.only ? host.features.filter((f) => opts.only!.includes(f)) : [...host.features];
  const measured = wanted.filter((f) => host.isOn(f));
  const skipped = wanted.filter((f) => !host.isOn(f));
  const sweep = !!opts.gtao && host.features.includes("ao") && host.isOn("ao");

  const baseWall: number[] = [];
  const baseCpu: number[] = [];
  const baseDiffs: number[] = [];
  const deltas = new Map<string, number[]>(measured.map((f) => [f, []]));
  const gtaoRaw = GTAO_SWEEP.map(() => [] as number[]);
  let builds = 0;
  let invalidReason: string | null = null;
  const fail = (why: string) => (invalidReason ??= why);

  const sample = async (config: PassConfig): Promise<{ wall: number; cpu: number }> => {
    await host.configure(config);
    await host.warm();
    const b0 = host.shaderBuilds();
    const { wallMs, cpuMs, draws } = await host.renderBatch(frames);
    const b = host.shaderBuilds() - b0;
    if (b > 0) {
      builds += b;
      fail(`${builds} shader build(s) during a measured batch`);
    }
    if (draws && draws.max > 0 && draws.min < draws.max * 0.5) fail(`frames in a batch skipped passes (draws ${draws.min}–${draws.max})`);
    if (!host.visible()) fail("the tab was hidden during the run");
    return { wall: wallMs / frames, cpu: cpuMs / frames };
  };

  try {
    for (let r = 0; r < rounds; r++) {
      let prev = await sample({ off: NONE });
      baseWall.push(prev.wall);
      baseCpu.push(prev.cpu);
      /** Measure a configuration between two baselines: baseline − configuration, drift-corrected. */
      const bracketed = async (config: PassConfig): Promise<number> => {
        const x = await sample(config);
        const next = await sample({ off: NONE });
        baseWall.push(next.wall);
        baseCpu.push(next.cpu);
        baseDiffs.push(Math.abs(next.wall - prev.wall));
        const base = (prev.wall + next.wall) / 2;
        prev = next;
        return base - x.wall;
      };
      const roundDelta = new Map<string, number>();
      for (const f of measured) {
        const d = await bracketed({ off: new Set([f]) });
        deltas.get(f)!.push(d);
        roundDelta.set(f, d);
      }
      if (sweep) {
        // GTAO cost against AO off = (base − AO off) − (base − override).
        const aoDelta = roundDelta.get("ao") ?? (await bracketed({ off: new Set(["ao"]) }));
        for (let i = 0; i < GTAO_SWEEP.length; i++) gtaoRaw[i]!.push(aoDelta - (await bracketed({ off: NONE, ao: GTAO_SWEEP[i]! })));
      }
    }
  } catch (e) {
    fail(`error: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    await host.configure({ off: NONE, ao: null });
  }

  const noise = r3(percentile(baseDiffs, 0.95));
  const passes: PassCost[] = measured
    .filter((f) => deltas.get(f)!.length > 0)
    .map((f) => {
      const d = stat(deltas.get(f)!);
      return { feature: f, deltaMs: d, belowNoise: Math.abs(d.p50) <= noise };
    })
    .sort((a, b) => b.deltaMs.p50 - a.deltaMs.p50);
  const baseline = { ...stat(baseWall), cpuMs: r3(percentile(baseCpu, 0.5)) };
  const gtao = sweep
    ? GTAO_SWEEP.map((g, i) => {
        const c = stat(gtaoRaw[i]!);
        return { samples: g.samples, scale: g.scale, costMs: c, belowNoise: Math.abs(c.p50) <= noise };
      })
    : null;
  if (baseWall.length === 0) fail("no batch was measured");
  return {
    v: 1,
    method: "wall-clock-batch",
    valid: invalidReason === null,
    invalidReason,
    rounds,
    framesPerBatch: frames,
    baseline,
    cpuBound: baseline.cpuMs >= baseline.p50 * 0.9,
    noiseMs: noise,
    passes,
    sumOfDeltasMs: r3(passes.reduce((s, p) => s + p.deltaMs.p50, 0)),
    skipped,
    gtao,
    shaderBuildsDuringMeasure: builds,
  };
}
