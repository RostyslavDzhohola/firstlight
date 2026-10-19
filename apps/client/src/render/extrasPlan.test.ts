// Which High extras a Medium device gets (#49, D-framerate-3): planned from the probe's GPU busy time
// and main-thread time against a measured cost model, then kept only as far as a second measurement
// with them on stays within Medium's budget.

import { describe, expect, it } from "vitest";
import { EXTRA_COSTS, extrasBudget, keepExtras, planExtras, TAIL_FACTOR, type CostModel } from "./extrasPlan.ts";

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
    const p = planExtras({ gpuMs: 8, cpuMs: 2, frameMs: 16.7, budgetMs: 12 }, MODEL);
    expect(p.extras).toEqual(["water2", "normals", "shadows"]); // value/cost: 50, 30, 13.3; grass (2.5) would pass 12 ms
    expect(p.gpuMs).toBeCloseTo(8 * (1 + 0.02 + 0.1 + 0.15), 6);
  });

  it("takes nothing without headroom, and nothing that would cross the budget", () => {
    expect(planExtras({ gpuMs: 12, cpuMs: 6, frameMs: 16.7, budgetMs: 12 }, MODEL).extras).toEqual([]);
    expect(planExtras({ gpuMs: 11.5, cpuMs: 6, frameMs: 16.7, budgetMs: 12 }, MODEL).extras).toEqual(["water2"]);
  });

  it("skips extras that add main-thread work when the busiest scenes' main thread would pass the frame", () => {
    // the M1's probe frames: 2.8 ms of main thread, ×5 in the busiest scene, +10% passes 90% of 16.7 ms
    expect(planExtras({ gpuMs: 6.5, cpuMs: 2.8, frameMs: 16.7, budgetMs: 12 }, MODEL).extras).toEqual(["water2", "normals", "grass"]);
    expect(planExtras({ gpuMs: 6.5, cpuMs: 2, frameMs: 16.7, budgetMs: 12 }, MODEL).extras).toContain("shadows"); // a faster CPU
    expect(planExtras({ gpuMs: 6.5, cpuMs: 12, frameMs: 16.7, budgetMs: 12 }, MODEL).extras).toEqual(["water2", "normals", "grass"]);
    // no CPU figure: only the GPU-only ones
    expect(planExtras({ gpuMs: 6.5, cpuMs: null, frameMs: 16.7, budgetMs: 12 }, MODEL).extras).not.toContain("shadows");
  });
});

describe("planExtras with an extra that includes another", () => {
  it("counts terrain normals (which bring the 4 detail layers) only for what they add over the layers", () => {
    const m: CostModel = { detail4: { value: 2, gpu: 0.05, cpu: 0 }, normals: { value: 3, gpu: 0.12, cpu: 0 } };
    const p = planExtras({ gpuMs: 10, cpuMs: 5, frameMs: 16.7, budgetMs: 12 }, m);
    expect(p.extras).toEqual(["detail4", "normals"]); // 40, then 25 per unit
    expect(p.gpuMs).toBeCloseTo(10 * 1.12, 6); // not 1.17
    // normals first: the layers come with them
    const q = planExtras({ gpuMs: 10, cpuMs: 5, frameMs: 16.7, budgetMs: 12 }, { detail4: { value: 1, gpu: 0.05, cpu: 0 }, normals: { value: 3, gpu: 0.12, cpu: 0 } });
    expect(q.extras).toEqual(["normals"]);
    expect(q.gpuMs).toBeCloseTo(11.2, 6);
  });
});

describe("keepExtras", () => {
  const plan = planExtras({ gpuMs: 8, cpuMs: 2, frameMs: 16.7, budgetMs: 12 }, MODEL);

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

describe("extrasBudget (the probe view's GPU time that keeps the busiest scenes' tail inside the frame)", () => {
  it("is the tier's budget or the 60 Hz frame's tail share over the busiest-scene factor, whichever is lower", () => {
    expect(TAIL_FACTOR).toBeGreaterThan(1);
    expect(extrasBudget(16.7, 12)).toBeCloseTo(Math.min(12, (0.95 * 16.7) / TAIL_FACTOR), 6);
    expect(extrasBudget(8.3, 12)).toBeCloseTo(Math.min(12, (0.95 * (1000 / 60)) / TAIL_FACTOR), 6); // 120 Hz: still the 60 Hz target
    expect(extrasBudget(20, 12)).toBeCloseTo(Math.min(12, (0.95 * 20) / TAIL_FACTOR), 6); // a 50 Hz display
    expect(extrasBudget(16.7, 5)).toBe(5);
  });
});

describe("EXTRA_COSTS on the M1's own probe readings (WebGPU, Portus arrival view)", () => {
  it("never plans GTAO or the extras that add draws, and plans the GPU-only ones only while they fit the tail", () => {
    for (const gpuMs of [7.1, 7.4, 7.7]) {
      const p = planExtras({ gpuMs, cpuMs: 2.8, frameMs: 16.7, budgetMs: extrasBudget(16.7, 12) }, EXTRA_COSTS);
      for (const e of ["ao", "shadows", "grass", "props"] as const) expect(p.extras).not.toContain(e);
      expect(p.gpuMs).toBeLessThanOrEqual(extrasBudget(16.7, 12) + 1e-9);
    }
    // a faster GPU and CPU (Medium under the M1's), and a slower GPU (no room left)
    expect(planExtras({ gpuMs: 6.2, cpuMs: 1.2, frameMs: 16.7, budgetMs: extrasBudget(16.7, 12) }, EXTRA_COSTS).extras).toContain("shadows");
    expect(planExtras({ gpuMs: 7.95, cpuMs: 2.8, frameMs: 16.7, budgetMs: extrasBudget(16.7, 12) }, EXTRA_COSTS).extras).toEqual([]);
  });
});
