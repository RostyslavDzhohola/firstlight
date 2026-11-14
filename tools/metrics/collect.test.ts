import { describe, expect, it } from "vitest";
import type { BundleReport } from "./bundle.ts";
import { healthGroup, joinSummary, levelProblems, parseArgs, passesGroup, population, settleGroup, staticGroup, testsGroup, type Ctx, type ExecResult, type GroupResult } from "./collect.ts";
import { runComplete, validateRun, type MetricsRun } from "./schema.ts";

const DIST: BundleReport = {
  files: 3,
  totalBytes: 4096,
  kinds: { js: { files: 2, bytes: 3072 }, css: { files: 1, bytes: 1024 } },
  chunks: [{ name: "Game.js", file: "Game-x.js", raw: 30 * 1024, gzip: 9000, br: 8000 }, { name: "index.css", file: "index-x.css", raw: 1024, gzip: 400, br: 300 }],
  home: { requests: 3, raw: 2048, gzip: 900, br: 800 },
  world: { requests: 5, raw: 4096, gzip: 1800, br: 1600 },
};

/** A fake world: each command's result by its first matching key, files by name, a dist report. */
function fakeCtx(o: { argv?: string[]; exec?: Record<string, Partial<ExecResult>>; files?: Record<string, unknown>; dist?: BundleReport | null } = {}): Ctx & { ran: string[] } {
  const ran: string[] = [];
  return {
    ran,
    args: parseArgs(o.argv ?? []),
    exec(cmd, args) {
      const line = [cmd, ...args].join(" ");
      ran.push(line);
      const key = Object.keys(o.exec ?? {}).find((k) => line.includes(k));
      return { ms: 1000, ok: true, out: "", ...(key ? o.exec![key] : {}) };
    },
    readJson(file) {
      const key = Object.keys(o.files ?? {}).find((k) => file.includes(k));
      return key ? o.files![key] : null;
    },
    analyse: () => (o.dist === undefined ? DIST : o.dist),
    tmpFile: (name) => `/tmp/fake-${name}.json`,
    keepRaw: () => "raw kept",
  };
}

const PROV = { when: "2026-11-14T00:00:00.000Z", commit: "abc", dirty: false, tree: "", busy: false, load1: 1 };

/** The group's result as a one-group run file, to check what a reader would conclude. */
function asRun(group: MetricsRun["groups"][number], results: GroupResult[]): MetricsRun {
  const s = settleGroup(results, PROV);
  return { v: 2, when: PROV.when, commit: "abc", branch: "b", dirty: false, tree: "", machine: { os: "", cpu: "M1", cores: 8, memGB: 16, node: "", busy: false, load1: 1 }, groups: [group], status: { [group]: s.status }, repeat: results.length, metrics: s.metrics, notes: s.notes };
}

describe("static group (finding 1)", () => {
  it("a complete build and typecheck is a complete group", () => {
    const r = asRun("static", [staticGroup(fakeCtx())]);
    expect(validateRun(r)).toEqual([]);
    expect(runComplete(r)).toBe(true);
    expect(r.metrics.find((m) => m.id === "typecheck.errors")).toMatchObject({ value: 0, gate: true });
    expect(r.metrics.find((m) => m.id === "chunk.game.js.br")).toBeTruthy();
  });

  it("a failed build reports no sizes: the dist left behind belongs to another tree", () => {
    const ctx = fakeCtx({ exec: { build: { ok: false, out: "error during build" } } });
    const g = staticGroup(ctx);
    expect(g.metrics).toEqual([]);
    expect(g.errors[0]).toContain("client build failed");
    expect(ctx.ran.some((l) => l.includes("typecheck"))).toBe(false);
    const r = asRun("static", [g]);
    expect(validateRun(r)).toEqual([]);
    expect(runComplete(r)).toBe(false);
  });

  it("--no-build measures the dist but never calls the group complete", () => {
    const g = staticGroup(fakeCtx({ argv: ["--no-build"] }));
    expect(g.metrics.some((m) => m.id === "bundle.js.br")).toBe(true);
    expect(runComplete(asRun("static", [g]))).toBe(false);
  });

  it("type errors are a measured gate; a typecheck that fails without one is a collection error", () => {
    const counted = staticGroup(fakeCtx({ exec: { typecheck: { ok: false, out: "a.ts(1,1): error TS2322: x\nb.ts(2,2): error TS2345: y" } } }));
    expect(counted.errors).toEqual([]);
    expect(counted.metrics.find((m) => m.id === "typecheck.errors")!.value).toBe(2);
    const crashed = staticGroup(fakeCtx({ exec: { typecheck: { ok: false, out: "ENOMEM" } } }));
    expect(crashed.errors[0]).toContain("typecheck failed without a TypeScript error");
    expect(crashed.metrics.some((m) => m.id === "typecheck.errors")).toBe(false);
  });

  it("no dist at all is an error, not an empty success", () => {
    const g = staticGroup(fakeCtx({ dist: null }));
    expect(g.errors).toContain("no apps/client/dist to analyse");
    expect(asRun("static", [g]).status.static!.missing).toContain("bundle.js.br");
  });
});

describe("health group", () => {
  it("a crashed balance report is an error, a failing check a measured gate", () => {
    expect(healthGroup(fakeCtx({ exec: { balance: { ok: false, out: "TypeError: boom" } } })).errors[0]).toContain("unreadable");
    const failing = healthGroup(fakeCtx({ exec: { balance: { ok: false, out: JSON.stringify({ checks: [{ ok: true }, { ok: false }] }) } } }));
    expect(failing.errors).toEqual([]);
    expect(failing.metrics[0]).toMatchObject({ id: "balance.checks.failed", value: 1, gate: true });
  });
});

describe("tests group (findings 1 and 2)", () => {
  const ok = { numTotalTests: 10, numFailedTests: 0, numFailedTestSuites: 0 };

  it("failed tests are a zero-tolerance gate", () => {
    const g = testsGroup(fakeCtx({ argv: ["--projects", "client"], exec: { vitest: { ok: false } }, files: { "vitest-client": { ...ok, numFailedTests: 1, numFailedTestSuites: 1 } } }));
    expect(g.errors).toEqual([]);
    expect(g.metrics.find((m) => m.id === "tests.client.failed")).toEqual({ id: "tests.client.failed", value: 1, unit: "tests", better: "lower", group: "tests", noise: 0, gate: true });
  });

  it("a project that fails without a failing test (a file that won't load) or writes no report is incomplete", () => {
    const g = testsGroup(fakeCtx({ argv: ["--projects", "client,server"], exec: { "project client": { ok: false } }, files: { "vitest-client": { ...ok, numFailedTestSuites: 1 } } }));
    expect(g.errors.map((e) => e.split(":")[0])).toEqual(["vitest client", "vitest server"]);
    expect(runComplete(asRun("tests", [g]))).toBe(false);
  });
});

describe("passes group (finding 4)", () => {
  const report = (passes: object) => ({ passes });
  const exec = { playwright: { ok: true } };

  it("publishes no cost from an invalid report", () => {
    const ctx = fakeCtx({ exec, files: { "webgpu-passes-high-1": report({ valid: false, invalidReason: "a frame took 5 s", noiseMs: 3.9, baseline: { p50: 20.7 }, passes: [{ feature: "ao", deltaMs: { p50: 9.7 } }] }) } });
    const g = passesGroup(ctx);
    expect(g.errors).toEqual(["passes report invalid: a frame took 5 s"]);
    expect(g.metrics.map((m) => m.id)).toEqual(["passes.high.baseline.p50", "passes.high.noise_floor"]);
    expect(runComplete(asRun("passes", [g]))).toBe(false);
  });

  it("judges each cost no finer than the run's measured noise floor", () => {
    const ctx = fakeCtx({ exec, files: { "webgpu-passes-high-1": report({ valid: true, noiseMs: 0.8, baseline: { p50: 12 }, passes: [{ feature: "ao", deltaMs: { p50: 3 } }, { feature: "bloom", deltaMs: { p50: 1 } }], gtao: [{ samples: 8, scale: 0.5, costMs: { p50: 2 } }] }) } });
    const g = passesGroup(ctx);
    expect(g.errors).toEqual([]);
    expect(g.metrics.filter((m) => m.id !== "passes.high.baseline.p50" && m.id !== "passes.high.noise_floor").map((m) => [m.id, m.floor])).toEqual([["passes.high.ao", 0.8], ["passes.high.bloom", 0.8], ["passes.high.gtao.s8_x05", 0.8]]);
    const quiet = passesGroup(fakeCtx({ exec, files: { "webgpu-passes-high-1": report({ valid: true, noiseMs: 0.1, baseline: { p50: 12 }, passes: [{ feature: "ao", deltaMs: { p50: 3 } }] }) } }));
    expect(quiet.metrics.at(-1)!.floor).toBe(0.25);
  });
});

describe("server population (finding 5)", () => {
  it("reads the bots' join summary, partial or full", () => {
    expect(joinSummary("…\n60/80 bots joined portus in 150.2 s (20 failures)\n")).toEqual({ joined: 60, asked: 80 });
    expect(joinSummary("bot 3 failed to join")).toBeNull();
    expect(population({ rooms: [{ clients: 40 }, { clients: 39 }, { clients: 0 }] })).toBe(79);
  });

  it("a partial join, a population that drifts during sampling, or a RESULT short of n is not that level", () => {
    const full = { joined: 80, asked: 80 };
    expect(levelProblems(80, full, 80, 80, { bots: 80 })).toEqual([]);
    expect(levelProblems(80, { joined: 60, asked: 80 }, null, null, null)).toEqual(["bots 80: 60/80 joined", "bots 80: no RESULT line"]);
    expect(levelProblems(80, full, 80, 71, { bots: 80 })).toEqual(["bots 80: 71 players connected when sampling ended"]);
    expect(levelProblems(80, full, 76, 80, { bots: 80 })).toEqual(["bots 80: 76 players connected when sampling started"]);
    expect(levelProblems(80, full, 80, 80, { bots: 79 })).toEqual(["bots 80: RESULT counts 79 bots"]);
    expect(levelProblems(80, null, null, null, null)[0]).toBe("bots 80: the joins never finished");
  });
});

describe("settling a group (finding 1)", () => {
  const r = (ids: string[], errors: string[] = [], expected = ids): GroupResult => ({ metrics: ids.map((id) => ({ id, value: 1, unit: "ms", better: "lower" as const, group: "frame" as const, noise: 0.1 })), errors, expected, notes: [] });

  it("is complete only when every promised id is there and no run failed", () => {
    expect(settleGroup([r(["a", "b"])], PROV).status.ok).toBe(true);
    const short = settleGroup([r(["a"], [], ["a", "b"])], PROV).status;
    expect(short).toMatchObject({ ok: false, missing: ["b"], errors: ["1 expected metric(s) not produced"] });
    expect(settleGroup([r([], [], [])], PROV).status).toMatchObject({ ok: false, errors: ["no metrics"] });
  });

  it("rejects a repeat in which one run came back short or failed", () => {
    const s = settleGroup([r(["a", "b"]), r(["a"], [], ["a", "b"]), r(["a", "b"])], PROV).status;
    expect(s.ok).toBe(false);
    expect(s.errors[0]).toContain("missing from some of the 3 runs: b");
    expect(settleGroup([r(["a"]), r(["a"], ["browser crashed"])], PROV).status.errors).toEqual(["browser crashed"]);
  });
});
