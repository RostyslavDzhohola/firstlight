// Which High extras a Medium device gets (#49, D-framerate-3): planned from the probe's GPU busy time
// and main-thread time against a measured cost model, then kept only as far as a second measurement
// with them on stays within Medium's budget.

import { describe, expect, it } from "vitest";
import { keepExtras, planExtras, type CostModel } from "./extrasPlan.ts";

/** A made-up model: GPU cost as a fraction of Medium's busy time, CPU as a fraction of its main-thread time. */
const MODEL: CostModel = {
  normals: { value: 3, gpu: 0.1, cpu: 0 },
  shadows: { value: 2, gpu: 0.15, cpu: 0.1 },
  water2: { value: 1, gpu: 0.02, cpu: 0 },
  grass: { value: 1, gpu: 0.4, cpu: 0 },
};

describe("planExtras", () => {
  it("adds the best look per millisecond first while the predicted GPU time fits the budget", () => {
    // 8 ms at Medium, 12 ms budget: 4 ms of headroom
    const p = planExtras({ gpuMs: 8, cpuMs: 6, frameMs: 16.7, budgetMs: 12 }, MODEL);
    expect(p.extras).toEqual(["water2", "normals", "shadows"]); // value/cost: 50, 30, 13.3; grass (2.5) would pass 12 ms
    expect(p.gpuMs).toBeCloseTo(8 * (1 + 0.02 + 0.1 + 0.15), 6);
  });

  it("takes nothing without headroom, and nothing that would cross the budget", () => {
    expect(planExtras({ gpuMs: 12, cpuMs: 6, frameMs: 16.7, budgetMs: 12 }, MODEL).extras).toEqual([]);
    expect(planExtras({ gpuMs: 11.5, cpuMs: 6, frameMs: 16.7, budgetMs: 12 }, MODEL).extras).toEqual(["water2"]);
  });

  it("skips extras that add main-thread work when the frame's CPU time is already near the frame", () => {
    // 12 ms of main thread at 60 Hz: +10% would pass 0.75 × 16.7 ms
    expect(planExtras({ gpuMs: 6.5, cpuMs: 12, frameMs: 16.7, budgetMs: 12 }, MODEL).extras).toEqual(["water2", "normals", "grass"]);
    // no CPU figure: only the GPU-only ones
    expect(planExtras({ gpuMs: 6.5, cpuMs: null, frameMs: 16.7, budgetMs: 12 }, MODEL).extras).not.toContain("shadows");
  });
});

describe("keepExtras", () => {
  const plan = planExtras({ gpuMs: 8, cpuMs: 6, frameMs: 16.7, budgetMs: 12 }, MODEL);

  it("keeps the plan when the measurement with it fits", () => {
    expect(keepExtras(plan, 11.2, 12, MODEL)).toEqual(plan.extras);
  });

  it("drops the last-added extras until the measured time, scaled, fits", () => {
    // measured 13.5 ms with all three (predicted 10.16): every cost was 1.33× the model's
    const kept = keepExtras(plan, 13.5, 12, MODEL);
    expect(kept).toEqual(["water2", "normals"]);
    expect(keepExtras(plan, 30, 12, MODEL)).toEqual([]);
  });
});
