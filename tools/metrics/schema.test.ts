import { describe, expect, it } from "vitest";
import {
  compareOutcome, compareRuns, foldRepeats, mergeRuns, pickGroups, threshold, upgradeV1, validateMetric, validateRun,
  type Group, type GroupStatus, type Metric, type MetricsRun,
} from "./schema.ts";

const metric = (id: string, value: number, extra: Partial<Metric> = {}): Metric => ({ id, value, unit: "ms", better: "lower", group: "frame", noise: 0.1, ...extra });

const status = (extra: Partial<GroupStatus> = {}): GroupStatus => ({ ok: true, errors: [], missing: [], when: "2026-11-13T00:00:00.000Z", commit: "abc", dirty: false, tree: "", busy: false, load1: 1, repeat: 1, ...extra });

const run = (metrics: Metric[], extra: Partial<MetricsRun> = {}, st: Partial<GroupStatus> = {}): MetricsRun => {
  const groups = extra.groups ?? ([...new Set(metrics.map((m) => m.group))].length ? [...new Set(metrics.map((m) => m.group))] : ["frame"]) as Group[];
  return {
    v: 2,
    when: "2026-11-13T00:00:00.000Z",
    commit: "abc",
    branch: "night/metrics",
    dirty: false,
    tree: "",
    machine: { os: "Darwin", cpu: "M1", cores: 8, memGB: 16, node: "v24", busy: false, load1: 1 },
    groups,
    status: Object.fromEntries(groups.map((g) => [g, status(st)])),
    repeat: 1,
    metrics,
    notes: [],
    ...extra,
  };
};

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
    const r = { ...run([metric("a", 1), metric("a", 2)]), v: 3, groups: ["frame", "gpu"] };
    const errs = validateRun(r);
    expect(errs).toContain("v must be 2 (got 3)");
    expect(errs).toContain("groups must list known groups");
    expect(errs.some((e) => e.includes("duplicate id"))).toBe(true);
  });

  it("survives the JSON round trip unchanged", () => {
    const r = run([metric("frame.p95", 21.5, { floor: 1 })]);
    expect(JSON.parse(JSON.stringify(r))).toEqual(r);
    expect(validateRun(JSON.parse(JSON.stringify(r)))).toEqual([]);
  });

  // Review finding 1's probe: a run declaring every baseline group with `metrics: []` passed validation.
  it("refuses a group that claims success with no metrics, or with metrics it promised missing", () => {
    const groups: Group[] = ["static", "health", "frame", "server", "load"];
    const empty = run([], { groups });
    expect(validateRun(empty)).toEqual(expect.arrayContaining(groups.map((g) => `status.${g}: ok with no metrics`)));
    const missing = run([metric("frame.p50", 16)], {}, { missing: ["frame.p95"] });
    expect(validateRun(missing)).toContain("status.frame: ok with missing metrics");
    const noStatus = { ...run([metric("frame.p50", 16)]), status: {} };
    expect(validateRun(noStatus)).toContain("status.frame missing");
    const silent = run([metric("frame.p50", 16)], {}, { ok: false });
    expect(validateRun(silent)).toContain("status.frame: not ok must say why (errors)");
    const stray = run([metric("frame.p50", 16), metric("tests.client.count", 3, { group: "tests" })], { groups: ["frame"] });
    expect(validateRun(stray).some((e) => e.includes("group tests is not in groups"))).toBe(true);
  });

  it("refuses a gate that isn't a lower-is-better count", () => {
    expect(validateMetric(metric("x", 0, { better: "higher", gate: true }))).toContain("gate must be true, on a lower-is-better count");
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
    expect(compareOutcome(a, b, d).code).toBe(1);
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

  // Finding 1: a missing measurement became "gone" and the comparison still exited 0.
  it("fails when the after run lacks a metric of a group it measured, and leaves unmeasured groups alone", () => {
    const a = run([metric("old", 1), metric("bundle", 9, { group: "static", noise: 0 })]);
    const b = run([metric("fresh", 2)]);
    const d = compareRuns(a, b);
    expect(d.map((x) => [x.id, x.verdict])).toEqual([["old", "missing"], ["fresh", "new"]]);
    const o = compareOutcome(a, b, d);
    expect(o.code).toBe(1);
    expect(o.failures.join()).toContain("1 missing");
  });

  it("fails when the after run's group is incomplete, even if every compared metric is there", () => {
    const a = run([metric("x", 10)]);
    const b = run([metric("x", 10)], {}, { ok: false, errors: ["bots 80: 60/80 joined"] });
    const o = compareOutcome(a, b, compareRuns(a, b));
    expect(o.code).toBe(1);
    expect(o.failures[0]).toContain("60/80 joined");
  });

  // Finding 2: tests.*.failed had floor 1, so 0 → 1 failing test was "same".
  it("treats a gate with zero tolerance, and fails a run whose gate is not 0", () => {
    const a = run([metric("tests.client.failed", 0, { unit: "tests", group: "tests", noise: 0, gate: true })]);
    const b = run([metric("tests.client.failed", 1, { unit: "tests", group: "tests", noise: 0, gate: true })]);
    const d = compareRuns(a, b);
    expect(d[0]!.verdict).toBe("worse");
    expect(d[0]!.threshold).toBe(0);
    // Already failing before: not "worse", but the after run still fails its gate.
    const o = compareOutcome(b, b, compareRuns(b, b));
    expect(o.code).toBe(1);
    expect(o.failures.join()).toContain("tests.client.failed = 1");
  });

  // Finding 3: same id, different unit: 1000 ms → 2 s was called "better".
  it("refuses to compare a metric whose unit, direction or group changed", () => {
    const a = run([metric("load.ms", 1000), metric("fps", 60, { better: "higher", unit: "fps" })]);
    const b = run([metric("load.ms", 2, { unit: "s" }), metric("fps", 60, { better: "lower", unit: "fps" })]);
    const d = compareRuns(a, b);
    expect(d.map((x) => x.verdict)).toEqual(["incompatible", "incompatible"]);
    expect(d[0]!.why).toBe("unit ms → s");
    expect(compareOutcome(a, b, d).code).toBe(1);
  });

  it("threshold is the larger of relative noise and floor", () => {
    expect(threshold(-50, 0.1)).toBe(5);
    expect(threshold(1, 0.1, 0.5)).toBe(0.5);
  });

  it("can skip ids on both sides", () => {
    const a = run([metric("x", 1), metric("typecheck.ms", 1)]);
    const b = run([metric("x", 1)]);
    expect(compareOutcome(a, b, compareRuns(a, b, { skip: /^typecheck/ })).code).toBe(0);
    const g = run([metric("x", 1), metric("tests.client.failed", 2, { gate: true, noise: 0 })]);
    expect(compareOutcome(g, g, compareRuns(g, g, { skip: /^tests/ }), { skip: /^tests/ }).code).toBe(0);
  });
});

describe("busy machines (D-metrics-3)", () => {
  const timing = (v: number) => metric("gpu_busy.p50", v);
  const draws = (v: number) => metric("draws", v, { unit: "calls", noise: 0.02 });
  const quiet = (v: number, when = "2026-11-14T10:00:00.000Z") => run([timing(v), draws(100)], {}, { when });
  const busy = (v: number, when = "2026-11-13T22:00:00.000Z", d = 100) => run([timing(v), draws(d)], {}, { when, busy: true, load1: 300 });

  it("never calls a timing better or worse against a busy-machine baseline from another session", () => {
    const a = busy(9), b = quiet(3);
    const d = compareRuns(a, b);
    expect(d.map((x) => [x.id, x.verdict])).toEqual([["gpu_busy.p50", "noisy"], ["draws", "same"]]);
    expect(d[0]!.why).toContain("before was busy");
    const o = compareOutcome(a, b, d);
    expect(o.code).toBe(3);
  });

  it("judges counts that load can't move even across sessions", () => {
    const d = compareRuns(busy(9), busy(3, "2026-11-14T12:00:00.000Z", 80));
    expect(d.map((x) => x.verdict)).toEqual(["noisy", "better"]);
  });

  it("compares two busy runs taken in the same session", () => {
    const d = compareRuns(busy(9), busy(3, "2026-11-13T22:10:00.000Z"));
    expect(d[0]!.verdict).toBe("better");
    expect(compareRuns(busy(9), busy(3, "2026-11-13T22:10:00.000Z"), { sessionMinutes: 5 })[0]!.verdict).toBe("noisy");
  });

  it("never compares timings from different machines", () => {
    const b = { ...quiet(3), machine: { ...quiet(3).machine, cpu: "M3" } };
    expect(compareRuns(quiet(9), b)[0]!.verdict).toBe("noisy");
  });
});

describe("incomplete baselines (finding 8)", () => {
  it("a v1 file compares, but its groups are incomplete: metrics it lacks are unbaselined, never new", () => {
    const v1 = { v: 1, when: "2026-11-13T22:00:00.000Z", commit: "f9f", branch: "x", dirty: true, machine: { os: "", cpu: "M1", cores: 8, memGB: 16, node: "", busy: false, load1: 1 }, groups: ["frame", "health"], repeat: 1, notes: [], metrics: [metric("draws", 100, { noise: 0.02 }), { id: "balance.checks.failed", value: 0, unit: "checks", better: "lower", group: "health", noise: 0, floor: 1 }] };
    const a = upgradeV1(v1);
    expect(validateRun(a)).toEqual([]);
    expect(a.status.frame!.ok).toBe(false);
    expect(a.metrics[1]).toEqual({ id: "balance.checks.failed", value: 0, unit: "checks", better: "lower", group: "health", noise: 0, gate: true });
    const b = run([metric("draws", 100, { noise: 0.02 }), metric("pixel_ratio", 1, { noise: 0.02, unit: "ratio", better: "higher" })]);
    const d = compareRuns(a, b);
    expect(d.map((x) => [x.id, x.verdict])).toEqual([["draws", "same"], ["pixel_ratio", "unbaselined"]]);
    expect(compareOutcome(a, b, d).code).toBe(3);
  });

  it("an id the baseline declared missing is unbaselined even in an otherwise usable group", () => {
    const a = run([metric("x", 1)], {}, { ok: false, errors: ["warm visit timed out"], missing: ["y"] });
    const b = run([metric("x", 1), metric("y", 1)]);
    expect(compareRuns(a, b).map((x) => x.verdict)).toEqual(["same", "unbaselined"]);
  });
});

describe("repeats", () => {
  it("takes medians and raises noise to the observed half-spread", () => {
    const f = foldRepeats([[metric("p50", 10, { noise: 0.01 })], [metric("p50", 12, { noise: 0.01 })], [metric("p50", 11, { noise: 0.01 })]]);
    expect(f.metrics).toEqual([metric("p50", 11, { noise: 0.0909 })]);
    expect(f.partial).toEqual([]);
  });

  it("keeps the catalogue noise when runs agree, and sets a floor for a median of 0", () => {
    const f = foldRepeats([[metric("a", 5), metric("z", 0)], [metric("a", 5), metric("z", 2)], [metric("a", 5), metric("z", 0)]]);
    expect(f.metrics[0]).toEqual(metric("a", 5));
    expect(f.metrics[1]).toEqual(metric("z", 0, { floor: 1 }));
  });

  // Finding 2: medians hid intermittent failures ([0, 0, 2] folded to 0).
  it("keeps a gate's worst run", () => {
    const g = (v: number) => metric("tests.server.failed", v, { noise: 0, gate: true, group: "tests", unit: "tests" });
    expect(foldRepeats([[g(0)], [g(0)], [g(2)]]).metrics).toEqual([g(2)]);
  });

  // Finding 1: a metric missing from some runs kept the runs that had it.
  it("reports metrics some runs lack", () => {
    const f = foldRepeats([[metric("a", 1), metric("b", 1)], [metric("a", 1)], [metric("a", 1), metric("b", 2)]]);
    expect(f.partial).toEqual(["b"]);
  });
});

describe("merge (finding 9)", () => {
  const at = (group: Group, commit: string, extra: Partial<GroupStatus> = {}) => run([metric(`${group}.x`, 1, { group })], { commit }, { commit, ...extra });

  it("keeps each group's own provenance, and says the top level is mixed", () => {
    const m = mergeRuns([at("static", "aaa"), at("frame", "bbb", { busy: true, load1: 300, dirty: true, tree: "t1" })]);
    expect(validateRun(m)).toEqual([]);
    expect(m.commit).toBe("mixed");
    expect(m.status.static!.commit).toBe("aaa");
    expect(m.status.frame).toMatchObject({ commit: "bbb", busy: true, dirty: true, tree: "t1" });
    expect(m.dirty).toBe(true);
    expect(m.machine.busy).toBe(true);
    expect(m.machine.load1).toBe(300);
    expect(mergeRuns([at("static", "aaa"), at("frame", "aaa")]).commit).toBe("aaa");
  });

  it("refuses a group carried twice and runs from another machine", () => {
    expect(() => mergeRuns([at("frame", "aaa"), at("frame", "bbb")])).toThrow(/group frame is in run 1 and run 2/);
    const other = { ...at("static", "aaa"), machine: { ...at("static", "aaa").machine, cpu: "M3" } };
    expect(() => mergeRuns([at("frame", "aaa"), other])).toThrow(/another machine/);
  });

  it("can take some groups of a run", () => {
    const r = run([metric("a", 1), metric("b", 1, { group: "static" })]);
    const p = pickGroups(r, ["static"]);
    expect(p.groups).toEqual(["static"]);
    expect(p.metrics.map((x) => x.id)).toEqual(["b"]);
    expect(validateRun(p)).toEqual([]);
  });
});
