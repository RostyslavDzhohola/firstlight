// Which High extras a device on Medium gets (#49, D-framerate-3). Frame rate first: an extra goes on
// only where this device's own measurements say the frame stays inside Medium's budget with it.
//
// The probe measures Medium (GPU busy time, WebGPU only; main-thread time per frame). planExtras()
// adds extras in order of look per millisecond while the cost model (each extra's cost measured on
// the M1 as a fraction of Medium's own, so it scales with the device) predicts the GPU time stays
// within Medium's budget, and the main thread within 75% of the frame for extras that add draws. The
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

/** The main thread's share of the frame interval that CPU-costly extras may fill. */
const CPU_SHARE = 0.75;

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
  let gpu = 0;
  let cpu = 0;
  const cpuBudget = CPU_SHARE * m.frameMs;
  for (const [e, c] of ranked) {
    if (m.gpuMs * (1 + gpu + c.gpu) > m.budgetMs) continue;
    if (c.cpu > 0 && (m.cpuMs === null || m.cpuMs * (1 + cpu + c.cpu) > cpuBudget)) continue;
    extras.push(e);
    gpu += c.gpu;
    cpu += c.cpu;
  }
  return { extras, baseMs: m.gpuMs, gpuMs: m.gpuMs * (1 + gpu) };
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
    const add = plan.extras.slice(0, n).reduce((s, e) => s + (model[e]?.gpu ?? 0), 0) * plan.baseMs;
    if ((plan.baseMs + add) * frame <= budgetMs && plan.baseMs + add * extra <= budgetMs) return plan.extras.slice(0, n);
  }
  return [];
}

/**
 * Each extra's cost over Medium on the M1 (WebGPU busy time and main-thread time, `?bench=g1` path,
 * sustained; docs/DECISIONS.md D-framerate-3 has the measurements), as fractions of Medium's own.
 * Extras left out cost more than any Medium device's headroom, or showed nothing to buy.
 */
export const EXTRA_COSTS: CostModel = {};
