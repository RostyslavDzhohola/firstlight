// Which High extras a device on Medium gets (#49, D-framerate-3). Frame rate first: an extra goes on
// only where this device's own measurements say the frame stays inside Medium's budget with it.
//
// The probe measures Medium (GPU busy time, WebGPU only; main-thread time per frame). planExtras()
// adds extras in order of look per millisecond while the cost model (each extra's cost measured on
// the M1 as a fraction of Medium's own, so it scales with the device) predicts the GPU time stays
// within the budget (extrasBudget), and for extras that add draws the main thread's predicted tail too. The
// probe then measures again with the plan on; keepExtras() keeps the longest prefix of it that the
// second measurement, scaled both ways (the whole frame, and only the extras), still fits.

import type { Extra } from "./quality.ts";

export interface ExtraCost {
  /** What it adds on screen (1 small … 3 large): the planner's look per millisecond is value / gpu. */
  value: number;
  /** GPU busy time it adds, as a fraction of Medium's. */
  gpu: number;
  /** Main-thread time it adds (more draws), as a fraction of Medium's. */
  cpu: number;
}

export type CostModel = Partial<Record<Extra, ExtraCost>>;

/**
 * The busiest scenes' GPU tail over the probe's view (D-framerate-3): on the M1 (WebGPU, Medium)
 * `?bench=g1` sustained ran p99 14.4–15.1 ms of busy time where the probe's arrival view measured
 * p50 7.1–7.7 ms. The probe measures that view, so its reading times this factor is what the
 * busiest moments will take.
 */
export const TAIL_FACTOR = 2.0;
/** Share of the 60 Hz frame (or a slower display's) that the busiest scenes' tail may fill. */
const TAIL_SHARE = 0.95;

/**
 * The GPU busy time the probe's view may take with extras on: the tier's own budget, or the time
 * that keeps the busiest scenes' p99 inside 95% of the frame (at least the 60 Hz frame: SPEC's
 * target), whichever is lower. Frame rate first.
 */
export function extrasBudget(frameMs: number, tierBudgetMs: number): number {
  return Math.min(tierBudgetMs, (TAIL_SHARE * Math.max(frameMs, 1000 / 60)) / TAIL_FACTOR);
}

/**
 * The same for the main thread: the M1's busiest scene ran p99 14.3–14.9 ms of main-thread time per
 * frame (after D-framerate-2's fixes, at load 50–165) where the probe's frames took p50 2.5–3.4 ms
 * (no crowd, no game logic). Extras that add draws need the busiest scenes' p99, so predicted, inside
 * 90% of the frame.
 */
export const CPU_TAIL_FACTOR = 5.0;
const CPU_TAIL_SHARE = 0.9;

/** Extras that bring others with them (terrain normals need the 4 detail layers, quality.ts). */
const INCLUDES: Partial<Record<Extra, Extra[]>> = { normals: ["detail4"] };

/** GPU and CPU fractions of a set of extras: each counted once, an included one inside its includer. */
function costOf(list: readonly Extra[], model: CostModel): { gpu: number; cpu: number } {
  let gpu = 0;
  let cpu = 0;
  for (const e of list) {
    if (list.some((o) => INCLUDES[o]?.includes(e))) continue; // inside another one's cost
    gpu += model[e]?.gpu ?? 0;
    cpu += model[e]?.cpu ?? 0;
  }
  return { gpu, cpu };
}

export interface ExtrasPlan {
  extras: Extra[];
  /** Medium's measured GPU busy time the plan started from. */
  baseMs: number;
  /** Predicted GPU busy time with the plan's extras. */
  gpuMs: number;
}

/** The probe's Medium measurement: GPU busy p50, main-thread p50 (null: unknown), frame interval, budget. */
export interface MediumMeasure {
  gpuMs: number;
  cpuMs: number | null;
  frameMs: number;
  budgetMs: number;
}

export function planExtras(m: MediumMeasure, model: CostModel): ExtrasPlan {
  const ranked = (Object.entries(model) as [Extra, ExtraCost][])
    .filter(([, c]) => c.value > 0)
    .sort((a, b) => b[1].value / Math.max(1e-6, b[1].gpu) - a[1].value / Math.max(1e-6, a[1].gpu));
  const extras: Extra[] = [];
  const cpuBudget = (CPU_TAIL_SHARE * Math.max(m.frameMs, 1000 / 60)) / CPU_TAIL_FACTOR;
  for (const [e] of ranked) {
    if (extras.some((o) => INCLUDES[o]?.includes(e))) continue; // already in
    const next = costOf([...extras, e], model);
    if (m.gpuMs * (1 + next.gpu) > m.budgetMs) continue;
    if (next.cpu > costOf(extras, model).cpu && (m.cpuMs === null || m.cpuMs * (1 + next.cpu) > cpuBudget)) continue;
    extras.push(e);
  }
  return { extras, baseMs: m.gpuMs, gpuMs: m.gpuMs * (1 + costOf(extras, model).gpu) };
}

/**
 * After measuring `measuredMs` with the plan on: the longest prefix of the plan whose cost, scaled by
 * how far the measurement missed the prediction (as a slower frame, and as costlier extras), fits
 * the budget.
 */
export function keepExtras(plan: ExtrasPlan, measuredMs: number, budgetMs: number, model: CostModel): Extra[] {
  if (measuredMs <= budgetMs) return plan.extras;
  const frame = measuredMs / Math.max(1e-6, plan.gpuMs);
  const extra = (measuredMs - plan.baseMs) / Math.max(1e-6, plan.gpuMs - plan.baseMs);
  for (let n = plan.extras.length - 1; n > 0; n--) {
    const add = costOf(plan.extras.slice(0, n), model).gpu * plan.baseMs;
    if ((plan.baseMs + add) * frame <= budgetMs && plan.baseMs + add * extra <= budgetMs) return plan.extras.slice(0, n);
  }
  return [];
}

/**
 * Each extra's cost over Medium, measured on the M1 (D-framerate-3 has the numbers): GPU as a
 * fraction of Medium's busy time, CPU (more draws) as a fraction of its main-thread time, each in
 * the busiest scene (`?bench=g1`, sustained, both backends) and with the GPU near its limit (3.6×
 * Medium's pixels). Where an extra moved nothing beyond the measurements' ±2% resolution, its cost
 * is that resolution, an upper bound. `value` is what it adds on screen (1 small … 3 large).
 * `props` (trees full-detail to 40 m, drawn to 220 m) is left out: measured only in Portus, where it
 * adds 5 draws; on a forest planet its distance draws far more trees, unmeasured.
 */
export const EXTRA_COSTS: CostModel = {
  normals: { value: 3, gpu: 0.02, cpu: 0 }, // terrain normal maps on all 4 detail layers
  detail4: { value: 2, gpu: 0.02, cpu: 0 }, // 4 terrain detail layers instead of 2 (normals include them)
  atmospheres: { value: 1, gpu: 0.02, cpu: 0 }, // halos round the sky planets
  water2: { value: 1, gpu: 0.02, cpu: 0 }, // lake ripples
  shadows: { value: 2, gpu: 0.02, cpu: 0.15 }, // the map twice as far: +94 draws (+30%) in Portus
  grass: { value: 2, gpu: 0.12, cpu: 0.05 }, // 200k blades to 60 m
  ao: { value: 3, gpu: 2.0, cpu: 0.2 }, // GTAO with its denoise: +18.6 ms busy on the M1
};
