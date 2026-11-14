import { describe, expect, it } from "vitest";
import { compareRuns, foldRepeats, threshold, validateMetric, validateRun, type Metric, type MetricsRun } from "./schema.ts";

const metric = (id: string, value: number, extra: Partial<Metric> = {}): Metric => ({ id, value, unit: "ms", better: "lower", group: "frame", noise: 0.1, ...extra });

const run = (metrics: Metric[]): MetricsRun => ({
  v: 1,
  when: "2026-11-13T00:00:00.000Z",
  commit: "abc",
  branch: "night/metrics",
  dirty: false,
  machine: { os: "Darwin", cpu: "M1", cores: 8, memGB: 16, node: "v24", busy: false, load1: 1 },
  groups: ["frame"],
  repeat: 1,
  metrics,
  notes: [],
});

describe("run schema", () => {
  it("accepts a well-formed run", () => {
    expect(validateRun(run([metric("frame.p50", 16.7), metric("bundle.js.br", 900, { unit: "KB", group: "static", noise: 0 })]))).toEqual([]);
  });

  it("names every broken field", () => {
    expect(validateMetric({ id: "Bad Id", value: NaN, unit: "", better: "up", group: "nope", noise: -1, floor: -2 })).toEqual([
      expect.stringContaining("id"),
      "value must be a finite number",
      "unit must be a non-empty string",
      "better must be lower|higher",
      expect.stringContaining("group"),
      "noise must be a number ≥ 0",
      "floor must be a number ≥ 0",
    ]);
  });

  it("rejects a wrong version, unknown groups and duplicate ids", () => {
    const r = { ...run([metric("a", 1), metric("a", 2)]), v: 2, groups: ["frame", "gpu"] };
    const errs = validateRun(r);
    expect(errs).toContain("v must be 1 (got 2)");
    expect(errs).toContain("groups must list known groups");
    expect(errs.some((e) => e.includes("duplicate id"))).toBe(true);
  });

  it("survives the JSON round trip unchanged", () => {
    const r = run([metric("frame.p95", 21.5, { floor: 1 })]);
    expect(JSON.parse(JSON.stringify(r))).toEqual(r);
    expect(validateRun(JSON.parse(JSON.stringify(r)))).toEqual([]);
  });
});

describe("compare", () => {
  it("calls a change inside the noise the same, and outside it better or worse by direction", () => {
    const a = run([metric("frame.p50", 20), metric("fps", 60, { better: "higher", unit: "fps" }), metric("draws", 100)]);
    const b = run([metric("frame.p50", 21.5), metric("fps", 50, { better: "higher", unit: "fps" }), metric("draws", 80)]);
    const d = compareRuns(a, b);
    expect(d.map((x) => [x.id, x.verdict])).toEqual([
      ["frame.p50", "same"], // +1.5 within ±2
      ["fps", "worse"], // −10 fps beyond ±6
      ["draws", "better"], // −20 beyond ±10
    ]);
    expect(d[0]!.delta).toBeCloseTo(1.5);
    expect(d[0]!.rel).toBeCloseTo(0.075);
    expect(d[0]!.threshold).toBeCloseTo(2);
  });

  it("flags any change of a deterministic metric", () => {
    const d = compareRuns(run([metric("bundle", 900, { noise: 0 })]), run([metric("bundle", 900.5, { noise: 0 })]));
    expect(d[0]!.verdict).toBe("worse");
  });

  it("uses the larger noise of the two runs and the floor near zero", () => {
    const d = compareRuns(run([metric("x", 10, { noise: 0.05 }), metric("hitches", 0, { noise: 0.5, floor: 2 })]), run([metric("x", 11, { noise: 0.2 }), metric("hitches", 2, { noise: 0.5 })]));
    expect(d[0]!.verdict).toBe("same"); // ±2 from the after run's noise
    expect(d[1]!.verdict).toBe("same"); // 0 → 2 is within the floor
    expect(d[1]!.rel).toBeNull();
  });

  it("lists metrics only one run has as new or gone", () => {
    const d = compareRuns(run([metric("old", 1)]), run([metric("fresh", 2)]));
    expect(d.map((x) => [x.id, x.verdict])).toEqual([["old", "gone"], ["fresh", "new"]]);
  });

  it("threshold is the larger of relative noise and floor", () => {
    expect(threshold(-50, 0.1)).toBe(5);
    expect(threshold(1, 0.1, 0.5)).toBe(0.5);
  });
});

describe("repeats", () => {
  it("takes medians and raises noise to the observed half-spread", () => {
    const f = foldRepeats([[metric("p50", 10, { noise: 0.01 })], [metric("p50", 12, { noise: 0.01 })], [metric("p50", 11, { noise: 0.01 })]]);
    expect(f).toEqual([metric("p50", 11, { noise: 0.0909 })]);
  });

  it("keeps the catalogue noise when runs agree, and sets a floor for a median of 0", () => {
    const f = foldRepeats([[metric("a", 5), metric("z", 0)], [metric("a", 5), metric("z", 2)], [metric("a", 5), metric("z", 0)]]);
    expect(f[0]).toEqual(metric("a", 5));
    expect(f[1]).toEqual(metric("z", 0, { floor: 1 }));
  });
});
