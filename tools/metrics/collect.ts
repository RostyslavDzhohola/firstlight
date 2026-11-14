// `pnpm metrics`: the measurement catalogue's collector (docs/metrics.md). Runs the cheap groups by
// default, the expensive ones behind flags, prints a table and writes one JSON per run to
// tools/bench/results/ (gitignored) in the schema of ./schema.ts.
//
//   pnpm metrics                       static (build, bundle, typecheck) + health (balance)
//   pnpm metrics --tests               + Vitest count and time per project
//   pnpm metrics --load                + first visit in a headless browser (cold and warm)
//   pnpm metrics --frame               + ?bench on every body at Medium (METRICS_TIER / --tier high)
//   pnpm metrics --passes              + ?bench=passes per-pass GPU cost (WebGPU, ~15 min)
//   pnpm metrics --server              + server tick time, CPU, memory, bytes at 1/25/50/80 bots
//   pnpm metrics --all                 everything above
//   pnpm metrics --only frame          just the named group(s), comma-separated
//   pnpm metrics --repeat 3            run each group 3 times: medians, and noise from the spread
//   pnpm metrics --compare a.json b.json [--skip <regex>] [--session-minutes 30]
//                                      deltas, exit 0 conclusive and nothing worse, 1 worse / missing /
//                                      incompatible / incomplete / a gate failing, 3 inconclusive
//   pnpm metrics --merge a.json b.json:frame,load --out c.json   runs (or some groups of a run) into one file
//   pnpm metrics --markdown run.json [--skip <regex>]   a run as a markdown table
// Options: --gfx webgpu|webgl (browser groups, default webgpu), --tier <tier>, --bodies portus,arcadia,
//   --viewport 1920x1080 --dpr 2 (frame: a real window's size, #87), --heapprof (frame: allocation sites in the raw report), --flags a=b,c (extra URL flags),
//   --seconds N (frame run length, default 20), --bots 1,25,50,80, --server-seconds N, --projects a,b,
//   --out <file>, --no-build, --no-typecheck, --json.
// A run exits 0 only when every group it ran is complete and every gate is 0; it still writes its file
// otherwise, with each group's errors and missing ids in `status` (D-metrics-3).
// Browser groups use the journeys' stack on E2E_PORT/E2E_CLIENT_PORT (default 2612/5212); the server group
// runs its own server on METRICS_SERVER_PORT (default 2622). Headless and muted, like every test browser.

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { analyseDist, type BundleReport } from "./bundle.ts";
import {
  compareOutcome, compareRuns, failedGates, foldRepeats, GROUPS, mergeRuns, pickGroups, round, runComplete, upgradeV1, validateRun,
  type Better, type Delta, type Group, type GroupStatus, type Metric, type MetricsRun, type Outcome,
} from "./schema.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CLIENT = path.join(ROOT, "apps/client");
const RESULTS = path.join(ROOT, "tools/bench/results");

// ------------------------------------------------------------------------------------------ args

export interface Args {
  has(flag: string): boolean;
  opt(flag: string, fallback?: string): string;
}

export function parseArgs(argv: string[]): Args {
  return {
    has: (f) => argv.includes(f),
    opt: (f, d = "") => {
      const i = argv.indexOf(f);
      return i >= 0 && argv[i + 1] && !argv[i + 1]!.startsWith("--") ? argv[i + 1]! : d;
    },
  };
}

// ------------------------------------------------------------------------------------------ context

export interface ExecResult {
  ms: number;
  ok: boolean;
  out: string;
}

/** Everything a group does to the outside world, so a test can stand in for it. */
export interface Ctx {
  args: Args;
  exec(cmd: string, args: string[], o?: { cwd?: string; env?: NodeJS.ProcessEnv }): ExecResult;
  /** Parsed JSON at `file`, or null when there is none or it doesn't parse. */
  readJson(file: string): any;
  /** The bundle report of `dist`, or null when there is no build there. */
  analyse(dist: string): BundleReport | null;
  /** A fresh temporary path for a report file. */
  tmpFile(name: string): string;
  /** Keep a raw browser report next to the results; returns a note. */
  keepRaw(mode: string, gfx: string, j: unknown): string;
}

export function realCtx(args: Args): Ctx {
  return {
    args,
    exec(cmd, a, o = {}) {
      const t = performance.now();
      const r = spawnSync(cmd, a, { cwd: o.cwd ?? ROOT, env: o.env ?? process.env, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
      return { ms: performance.now() - t, ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
    },
    readJson(file) {
      try {
        return JSON.parse(readFileSync(file, "utf8"));
      } catch {
        return null;
      }
    },
    analyse: (dist) => (existsSync(dist) ? analyseDist(dist) : null),
    tmpFile: (name) => {
      const f = path.join(os.tmpdir(), `fl-metrics-${name}-${process.pid}.json`);
      rmSync(f, { force: true });
      return f;
    },
    keepRaw(mode, gfx, j) {
      mkdirSync(RESULTS, { recursive: true });
      const raw = path.join(RESULTS, `raw-${mode}-${gfx}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
      writeFileSync(raw, JSON.stringify(j, null, 1));
      return `raw ${mode} report: ${path.relative(ROOT, raw)}`;
    },
  };
}

// ------------------------------------------------------------------------------------------ helpers

/** A metric with its catalogue noise (fraction of the value) and optional absolute floor. */
function m(group: Group, id: string, value: number, unit: string, better: Better, noise: number, floor?: number): Metric {
  return { id, value: round(value), unit, better, group, noise, ...(floor !== undefined ? { floor } : {}) };
}

/** A correctness gate: a count that must be 0, with no tolerance (schema.ts). */
function gate(group: Group, id: string, value: number, unit: string): Metric {
  return { id, value: round(value), unit, better: "lower", group, noise: 0, gate: true };
}

/** What one run of a group produced: its metrics, why it fell short, and every id it promised. */
export interface GroupResult {
  metrics: Metric[];
  errors: string[];
  expected: string[];
  notes: string[];
}

/** Collects metrics, skipping any value that isn't a finite number (a missing field is missing, never 0). */
class Out {
  readonly metrics: Metric[] = [];
  readonly errors: string[] = [];
  readonly expected: string[] = [];
  readonly notes: string[] = [];
  push(x: Metric) {
    if (Number.isFinite(x.value)) this.metrics.push(x);
  }
  expect(...ids: string[]) {
    this.expected.push(...ids);
  }
  result(): GroupResult {
    return { metrics: this.metrics, errors: this.errors, expected: this.expected, notes: this.notes };
  }
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : NaN);
const kb = (bytes: number) => bytes / 1024;
const tail = (s: string, n: number) => s.slice(-n).trim();

function git(args: string[]): string {
  try {
    return execFileSync("git", args, { cwd: ROOT, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 }).trim();
  } catch {
    return "";
  }
}

/** The source tree a run measures: commit, dirty, and a hash of the uncommitted changes ("" when clean). */
function sourceTree(): { commit: string; dirty: boolean; tree: string } {
  const commit = git(["rev-parse", "HEAD"]);
  const status = git(["status", "--porcelain"]);
  if (!status) return { commit, dirty: false, tree: "" };
  const h = createHash("sha1").update(git(["diff", "HEAD", "--binary"]));
  for (const f of git(["ls-files", "--others", "--exclude-standard"]).split("\n").filter(Boolean)) {
    h.update(`\0${f}\0`);
    try {
      if (statSync(path.join(ROOT, f)).size < 8 * 1024 * 1024) h.update(readFileSync(path.join(ROOT, f)));
    } catch {
      /* removed meanwhile */
    }
  }
  return { commit, dirty: true, tree: h.digest("hex").slice(0, 12) };
}

const load1 = () => os.loadavg()[0] ?? 0;
const busyAt = (l: number) => l > os.cpus().length / 2;

function machine(): MetricsRun["machine"] {
  const l = load1();
  return { os: `${os.type()} ${os.release()} ${os.arch()}`, cpu: os.cpus()[0]?.model ?? "unknown", cores: os.cpus().length, memGB: Math.round(os.totalmem() / 1073741824), node: process.version, busy: busyAt(l), load1: round(l, 2) };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------------------------------ groups

/** Build time, every chunk's raw/gzip/brotli size, assets by kind, first-visit bytes, typecheck time. */
export function staticGroup(ctx: Ctx): GroupResult {
  const o = new Out();
  const dist = path.join(CLIENT, "dist");
  if (ctx.args.has("--no-build")) {
    o.errors.push("--no-build: apps/client/dist was not built by this run, so its sizes may belong to another tree");
  } else {
    o.expect("build.client.ms");
    const b = ctx.exec("pnpm", ["--filter", "@firstlight/client", "build"]);
    if (!b.ok) {
      // A failed build leaves the last good dist behind: its sizes would pass for this tree's.
      o.errors.push(`client build failed:\n${tail(b.out, 2000)}`);
      return o.result();
    }
    o.push(m("static", "build.client.ms", b.ms, "ms", "lower", 0.15));
  }
  o.expect("bundle.js.count", "bundle.js.raw", "bundle.js.gzip", "bundle.js.br", "bundle.css.raw", "bundle.css.br", "dist.total.bytes");
  o.expect(...["home", "world"].flatMap((w) => ["requests", "br", "raw"].map((k) => `firstvisit.${w}.${k}`)));
  const r = ctx.analyse(dist);
  if (!r) o.errors.push("no apps/client/dist to analyse");
  else {
    const js = r.chunks.filter((c) => c.name.endsWith(".js"));
    const css = r.chunks.filter((c) => c.name.endsWith(".css"));
    const tot = (cs: typeof js, k: "raw" | "gzip" | "br") => cs.reduce((a, c) => a + c[k], 0);
    o.push(m("static", "bundle.js.count", js.length, "files", "lower", 0));
    o.push(m("static", "bundle.js.raw", kb(tot(js, "raw")), "KB", "lower", 0));
    o.push(m("static", "bundle.js.gzip", kb(tot(js, "gzip")), "KB", "lower", 0));
    o.push(m("static", "bundle.js.br", kb(tot(js, "br")), "KB", "lower", 0));
    o.push(m("static", "bundle.css.raw", kb(tot(css, "raw")), "KB", "lower", 0));
    o.push(m("static", "bundle.css.br", kb(tot(css, "br")), "KB", "lower", 0));
    // Per chunk, every JS/CSS chunk of 20 KB or more (the rest are in the totals).
    for (const c of r.chunks) {
      if (c.raw < 20 * 1024) continue;
      const id = `chunk.${c.name.replace(/[^A-Za-z0-9.]+/g, "_").toLowerCase()}`;
      o.push(m("static", `${id}.raw`, kb(c.raw), "KB", "lower", 0));
      o.push(m("static", `${id}.gzip`, kb(c.gzip), "KB", "lower", 0));
      o.push(m("static", `${id}.br`, kb(c.br), "KB", "lower", 0));
    }
    for (const [k, v] of Object.entries(r.kinds).sort()) {
      o.push(m("static", `dist.${k}.bytes`, kb(v.bytes), "KB", "lower", 0));
      o.push(m("static", `dist.${k}.files`, v.files, "files", "lower", 0));
    }
    o.push(m("static", "dist.total.bytes", kb(r.totalBytes), "KB", "lower", 0));
    for (const w of ["home", "world"] as const) {
      o.push(m("static", `firstvisit.${w}.requests`, r[w].requests, "requests", "lower", 0));
      o.push(m("static", `firstvisit.${w}.br`, kb(r[w].br), "KB", "lower", 0));
      o.push(m("static", `firstvisit.${w}.raw`, kb(r[w].raw), "KB", "lower", 0));
    }
  }
  if (!ctx.args.has("--no-typecheck")) {
    o.expect("typecheck.ms", "typecheck.errors");
    const t = ctx.exec("pnpm", ["typecheck"]);
    const count = (t.out.match(/error TS\d+/g) ?? []).length;
    if (!t.ok && count === 0) o.errors.push(`typecheck failed without a TypeScript error to count:\n${tail(t.out, 1500)}`);
    else {
      o.push(m("static", "typecheck.ms", t.ms, "ms", "lower", 0.15));
      o.push(gate("static", "typecheck.errors", t.ok ? 0 : count, "errors"));
    }
  }
  return o.result();
}

/** The balance model's band checks (tools/balance): how many numbers sit outside their band. */
export function healthGroup(ctx: Ctx): GroupResult {
  const o = new Out();
  o.expect("balance.checks.failed", "balance.checks.total");
  const r = ctx.exec("node", ["tools/balance/report.ts", "--json"]);
  let j: { checks: { ok: boolean }[] } | null = null;
  try {
    j = JSON.parse(r.out.slice(r.out.indexOf("{")));
  } catch {
    /* below */
  }
  if (!j || !Array.isArray(j.checks) || !j.checks.length) {
    o.errors.push(`balance report unreadable:\n${tail(r.out, 800)}`);
    return o.result();
  }
  const failed = j.checks.filter((c) => !c.ok).length;
  // The report exits 1 when a check fails; exiting non-zero with every check passing is a crash.
  if (!r.ok && failed === 0) o.errors.push(`balance report exited non-zero with every check passing:\n${tail(r.out, 800)}`);
  o.push(gate("health", "balance.checks.failed", failed, "checks"));
  o.push(m("health", "balance.checks.total", j.checks.length, "checks", "higher", 0));
  return o.result();
}

/** Vitest per project: test count, failures, wall time. */
export function testsGroup(ctx: Ctx): GroupResult {
  const o = new Out();
  for (const p of ctx.args.opt("--projects", "shared,client,server").split(",").filter(Boolean)) {
    o.expect(`tests.${p}.count`, `tests.${p}.failed`, `tests.${p}.ms`);
    const file = ctx.tmpFile(`vitest-${p}`);
    const t = ctx.exec("pnpm", ["vitest", "run", "--project", p, "--reporter=json", `--outputFile=${file}`]);
    const j = ctx.readJson(file) as { numTotalTests?: number; numFailedTests?: number; numFailedTestSuites?: number } | null;
    rmSync(file, { force: true });
    if (!j || typeof j.numTotalTests !== "number" || typeof j.numFailedTests !== "number") {
      o.errors.push(`vitest ${p}: no JSON report (${tail(t.out, 400)})`);
      continue;
    }
    if (j.numTotalTests === 0) o.errors.push(`vitest ${p}: no tests ran`);
    // A file that fails to load counts no failed test: the exit code and the failed suites say so.
    if ((!t.ok || (j.numFailedTestSuites ?? 0) > 0) && j.numFailedTests === 0) o.errors.push(`vitest ${p}: failed with no failing test (a file failed to load or an unhandled error):\n${tail(t.out, 600)}`);
    o.push(m("tests", `tests.${p}.count`, j.numTotalTests, "tests", "higher", 0));
    o.push(gate("tests", `tests.${p}.failed`, j.numFailedTests, "tests"));
    o.push(m("tests", `tests.${p}.ms`, t.ms, "ms", "lower", 0.2));
  }
  return o.result();
}

/** Runs e2e/metrics.spec.ts in one browser project and returns its raw JSON, or null with an error. */
function browserRun(ctx: Ctx, o: Out, mode: "load" | "frame", gfx: string, env: Record<string, string>): any {
  const file = ctx.tmpFile(`${mode}-${gfx}`);
  const r = ctx.exec(
    "pnpm",
    ["exec", "playwright", "test", "-c", "e2e/playwright.config.ts", "--project", gfx, "--grep", "@metrics", "--workers", "1", "--reporter", "line"],
    { cwd: CLIENT, env: { ...process.env, E2E_PORT: process.env.E2E_PORT ?? "2612", E2E_CLIENT_PORT: process.env.E2E_CLIENT_PORT ?? "5212", E2E_OUT: path.join(CLIENT, "e2e/.out/metrics"), METRICS_MODE: mode, METRICS_OUT: file, ...env } },
  );
  const j = ctx.readJson(file);
  rmSync(file, { force: true });
  if (!j) {
    o.errors.push(`${mode} (${gfx}) produced no result:\n${tail(r.out, 1500)}`);
    return null;
  }
  if (!r.ok) o.errors.push(`${mode} (${gfx}): the browser run failed after writing its report:\n${tail(r.out, 1500)}`);
  o.notes.push(ctx.keepRaw(mode, gfx, j));
  return j;
}

const LOAD_IDS = ["fcp.ms", "menu.ms", "play_to_world.ms", "nav_to_world.ms", "menu.requests", "menu.transfer", "world.requests", "world.transfer", "world.decoded", "shaders_after_warmup", "warmup.ms", "warmup.builds", "warmup.stages", "warmup.gap_max.ms", "warmup.gaps_over250", "warmup.longtasks"];

export function loadGroup(ctx: Ctx): GroupResult {
  const o = new Out();
  for (const gfx of ctx.args.opt("--gfx", "webgpu").split(",")) {
    for (const cache of ["cold", "warm"]) o.expect(...LOAD_IDS.map((s) => `load.${gfx}.${cache}.${s}`));
    const j = browserRun(ctx, o, "load", gfx, { METRICS_TIER: ctx.args.opt("--tier", process.env.METRICS_TIER ?? "medium") });
    if (!j) continue;
    for (const cache of ["cold", "warm"] as const) {
      const v = j[cache];
      if (!v) continue;
      const p = `load.${gfx}.${cache}`;
      o.push(m("load", `${p}.fcp.ms`, num(v.fcpMs), "ms", "lower", 0.25));
      o.push(m("load", `${p}.menu.ms`, num(v.menuMs), "ms", "lower", 0.25));
      o.push(m("load", `${p}.play_to_world.ms`, num(v.playToWorldMs), "ms", "lower", 0.2));
      o.push(m("load", `${p}.nav_to_world.ms`, num(v.navToWorldMs), "ms", "lower", 0.2));
      o.push(m("load", `${p}.menu.requests`, num(v.atMenu?.requests), "requests", "lower", 0.02, 2));
      o.push(m("load", `${p}.menu.transfer`, num(v.atMenu?.transferKB), "KB", "lower", 0.02));
      o.push(m("load", `${p}.world.requests`, num(v.atWorld?.requests), "requests", "lower", 0.02, 2));
      o.push(m("load", `${p}.world.transfer`, num(v.atWorld?.transferKB), "KB", "lower", 0.02));
      o.push(m("load", `${p}.world.decoded`, num(v.atWorld?.decodedKB), "KB", "lower", 0.02));
      o.push(gate("load", `${p}.shaders_after_warmup`, num(v.afterWarmup), "builds"));
      o.push(m("load", `${p}.heap`, num(v.heapMB), "MB", "lower", 0.1));
      const w = v.warm;
      o.push(m("load", `${p}.warmup.ms`, num(w?.ms), "ms", "lower", 0.25));
      o.push(m("load", `${p}.warmup.builds`, num(w?.builds), "builds", "lower", 0.02, 2));
      o.push(m("load", `${p}.warmup.stages`, num(w?.stages), "programs", "lower", 0.02, 2));
      o.push(m("load", `${p}.warmup.gap_max.ms`, num(w?.gaps?.max), "ms", "lower", 0.4));
      o.push(m("load", `${p}.warmup.gaps_over250`, num(w?.gaps?.over250), "gaps", "lower", 0, 2));
      o.push(m("load", `${p}.warmup.longtasks`, num(w?.longTasks?.count), "tasks", "lower", 0.3, 2));
    }
  }
  return o.result();
}

const FRAME_IDS = ["fps", "frame.p50", "frame.p95", "frame.p99", "frame.max", "cpu.p50", "cpu.p95", "draws", "triangles", "shader_builds", "pixel_ratio", "canvas_mpx", "over33", "over50", "over100"];

export function frameGroup(ctx: Ctx): GroupResult {
  const o = new Out();
  const tier = ctx.args.opt("--tier", process.env.METRICS_TIER ?? "medium");
  const bodies = ctx.args.opt("--bodies", "portus,arcadia,hollowmere,meridian");
  const viewport = ctx.args.opt("--viewport"), dpr = ctx.args.opt("--dpr", "1");
  // The default window (1280×720 at DPR 1) keeps the plain id; another size is part of the id.
  const size = viewport || dpr !== "1" ? `.vp${viewport || "1280x720"}d${dpr}` : "";
  for (const gfx of ctx.args.opt("--gfx", "webgpu").split(",")) {
    for (const body of bodies.split(",").filter(Boolean)) o.expect(...FRAME_IDS.map((s) => `frame.${gfx}.${tier}.${body}${size}.${s}`));
    const j = browserRun(ctx, o, "frame", gfx, { METRICS_TIER: tier, METRICS_BODIES: bodies, METRICS_SECONDS: ctx.args.opt("--seconds", "20"), METRICS_VIEWPORT: viewport, METRICS_DPR: dpr, METRICS_FLAGS: ctx.args.opt("--flags"), METRICS_HEAPPROF: ctx.args.has("--heapprof") ? "1" : "" });
    if (!j) continue;
    for (const [body, b] of Object.entries((j.bodies ?? {}) as Record<string, any>)) {
      const p = `frame.${gfx}.${tier}.${body}${size}`;
      o.push(m("frame", `${p}.fps`, num(b.fps?.mean), "fps", "higher", 0.05));
      o.push(m("frame", `${p}.frame.p50`, num(b.frameMs?.p50), "ms", "lower", 0.05));
      o.push(m("frame", `${p}.frame.p95`, num(b.frameMs?.p95), "ms", "lower", 0.15));
      o.push(m("frame", `${p}.frame.p99`, num(b.frameMs?.p99), "ms", "lower", 0.3));
      o.push(m("frame", `${p}.frame.max`, num(b.frameMs?.max), "ms", "lower", 0.6));
      o.push(m("frame", `${p}.cpu.p50`, num(b.cpuMs?.p50), "ms", "lower", 0.15));
      o.push(m("frame", `${p}.cpu.p95`, num(b.cpuMs?.p95), "ms", "lower", 0.25));
      o.push(m("frame", `${p}.draws`, num(b.draws?.mean), "calls", "lower", 0.02));
      o.push(m("frame", `${p}.triangles`, num(b.triangles?.mean) / 1000, "ktris", "lower", 0.02));
      o.push(gate("frame", `${p}.shader_builds`, num(b.shaderBuildsDuringRun), "builds"));
      // The drawing buffer after the resolution ladder (render/timing.ts) settled: it drops scale when frames run long.
      o.push(m("frame", `${p}.pixel_ratio`, num(b.pixelRatio), "ratio", "higher", 0.02));
      o.push(m("frame", `${p}.canvas_mpx`, Array.isArray(b.canvas) ? (num(b.canvas[0]) * num(b.canvas[1])) / 1e6 : NaN, "Mpx", "higher", 0.02));
      o.push(m("frame", `${p}.over33`, num(b.over?.[33]), "frames", "lower", 0.5, 3));
      o.push(m("frame", `${p}.over50`, num(b.over?.[50]), "frames", "lower", 0.5, 2));
      o.push(m("frame", `${p}.over100`, num(b.over?.[100]), "frames", "lower", 0.5, 1));
      // Optional: the GPU timer (WebGPU with timestamp queries), Chrome's heap, three's memory estimate.
      if (b.gpuBusyMs) {
        o.push(m("frame", `${p}.gpu_busy.p50`, num(b.gpuBusyMs.p50), "ms", "lower", 0.1));
        o.push(m("frame", `${p}.gpu_busy.p95`, num(b.gpuBusyMs.p95), "ms", "lower", 0.2));
      }
      if (b.heapMB) {
        o.push(m("frame", `${p}.heap.end`, num(b.heapMB.end), "MB", "lower", 0.1));
        o.push(m("frame", `${p}.heap.growth`, num(b.heapMB.max) - num(b.heapMB.start), "MB", "lower", 0.5, 5));
      }
      if (b.memory) {
        o.push(m("frame", `${p}.gpu_mem.total`, num(b.memory.totalMB), "MB", "lower", 0.02));
        o.push(m("frame", `${p}.gpu_mem.textures`, num(b.memory.texturesMB), "MB", "lower", 0.02));
        o.push(m("frame", `${p}.geometries`, num(b.memory.geometries), "count", "lower", 0.02));
        o.push(m("frame", `${p}.textures`, num(b.memory.textures), "count", "lower", 0.02));
        o.push(m("frame", `${p}.programs`, num(b.memory.programs), "count", "lower", 0.02));
      }
    }
  }
  return o.result();
}

/** The per-pass cost floor (ms): a cost is never judged finer than this, nor than the run's own noise. */
export const PASS_FLOOR_MS = 0.25;

/** `?bench=passes` through the existing spec (bench-passes.spec.ts): per-pass GPU ms at the fixed view. */
export function passesGroup(ctx: Ctx): GroupResult {
  const o = new Out();
  const tier = ctx.args.opt("--tier", "high");
  const benchOut = mkdtempSync(path.join(os.tmpdir(), "fl-metrics-passes-"));
  o.expect(`passes.${tier}.baseline.p50`, `passes.${tier}.noise_floor`);
  const r = ctx.exec(
    "pnpm",
    ["exec", "playwright", "test", "-c", "e2e/playwright.config.ts", "--project", "webgpu", "--grep", "@bench", "--workers", "1", "--reporter", "line", "bench-passes"],
    { cwd: CLIENT, env: { ...process.env, E2E_PORT: process.env.E2E_PORT ?? "2612", E2E_CLIENT_PORT: process.env.E2E_CLIENT_PORT ?? "5212", E2E_OUT: path.join(CLIENT, "e2e/.out/metrics"), BENCH_MODE: "passes", BENCH_TIER: tier, BENCH_OUT: benchOut, BENCH_FLAGS: ctx.args.opt("--flags", process.env.BENCH_FLAGS ?? "") } },
  );
  const j = ctx.readJson(path.join(benchOut, `webgpu-passes-${tier}-1.json`));
  rmSync(benchOut, { recursive: true, force: true });
  const p = j?.passes;
  if (!p) {
    o.errors.push(`passes produced no result:\n${tail(r.out, 1500)}`);
    return o.result();
  }
  const noise = num(p.noiseMs);
  o.push(m("passes", `passes.${tier}.baseline.p50`, num(p.baseline?.p50), "ms", "lower", 0.08));
  o.push(m("passes", `passes.${tier}.noise_floor`, noise, "ms", "lower", 0.5));
  // An invalid run (the bench's own check: a frame too slow, noise above the costs) prices nothing.
  if (p.valid !== true) {
    o.errors.push(`passes report invalid: ${p.invalidReason ?? "no reason given"}`);
    return o.result();
  }
  // Each cost is judged no finer than the run's measured noise floor.
  const floor = round(Math.max(PASS_FLOOR_MS, Number.isFinite(noise) ? noise : Infinity));
  if (!Number.isFinite(floor)) o.errors.push("passes report has no noise floor");
  const costs = (p.passes ?? []) as { feature: string; deltaMs?: { p50: number } }[];
  if (!costs.length) o.errors.push("passes report priced no pass");
  for (const x of costs) {
    o.expect(`passes.${tier}.${x.feature}`);
    o.push(m("passes", `passes.${tier}.${x.feature}`, num(x.deltaMs?.p50), "ms", "lower", 0.3, floor));
  }
  for (const g of (p.gtao ?? []) as { samples: number; scale: number; denoise?: string; costMs?: { p50: number } }[]) {
    const id = `passes.${tier}.gtao.s${g.samples}_x${String(g.scale).replace(".", "")}${g.denoise ? `_dn_${g.denoise}` : ""}`;
    o.expect(id);
    o.push(m("passes", id, num(g.costMs?.p50), "ms", "lower", 0.3, floor));
  }
  return o.result();
}

// ---------------------------------------------------------------------- server: population checks

/** The bots' join summary (`<joined>/<asked> bots joined …`), printed once when their joins end. */
export function joinSummary(log: string): { joined: number; asked: number } | null {
  const j = /(\d+)\/(\d+) bots joined/.exec(log);
  return j ? { joined: Number(j[1]), asked: Number(j[2]) } : null;
}

/** Players connected to the server's body rooms in one /api/metrics snapshot. */
export function population(snapshot: { rooms?: { clients?: number }[] } | null): number {
  return (snapshot?.rooms ?? []).reduce((a, r) => a + (r.clients ?? 0), 0);
}

/**
 * Why one load level's numbers are not at the requested load (empty: they are). The population must
 * be `n` when sampling starts and still `n` when it ends, and the bots' own result must count `n`.
 */
export function levelProblems(n: number, joined: { joined: number; asked: number } | null, before: number | null, after: number | null, result: { bots?: number } | null): string[] {
  const p: string[] = [];
  if (!joined) p.push(`bots ${n}: the joins never finished`);
  else if (joined.joined !== n || joined.asked !== n) p.push(`bots ${n}: ${joined.joined}/${joined.asked} joined`);
  if (before !== null && before !== n) p.push(`bots ${n}: ${before} players connected when sampling started`);
  if (after !== null && after !== n) p.push(`bots ${n}: ${after} players connected when sampling ended`);
  if (joined?.joined === n && (before === null || after === null)) p.push(`bots ${n}: not sampled`);
  if (!result) p.push(`bots ${n}: no RESULT line`);
  else if (result.bots !== n) p.push(`bots ${n}: RESULT counts ${String(result.bots)} bots`);
  return p;
}

const LEVEL_IDS = ["joined", "population", "rooms", "tick.p50", "tick.p95", "tick.p99", "cpu", "rss", "heap", "rx_per_client", "msgs_per_client", "patch_bytes", "join.p50", "join.p95", "npcs"];

/** The game server under 1…N load-test bots: tick time, CPU, memory, bytes per client, join latency. */
export async function serverGroup(ctx: Ctx): Promise<GroupResult> {
  const o = new Out();
  const port = Number(process.env.METRICS_SERVER_PORT ?? 2622);
  const api = `http://127.0.0.1:${port}`;
  const secret = randomBytes(32).toString("base64url"); // a throwaway strong secret: the server refuses short ones
  const db = mkdtempSync(path.join(os.tmpdir(), "fl-metrics-db-"));
  const seconds = Number(ctx.args.opt("--server-seconds", "20"));
  const levels = ctx.args.opt("--bots", "1,25,50,80").split(",").map(Number).filter((n) => n > 0);
  o.expect("server.idle.rss", "server.idle.heap");
  for (const n of levels) o.expect(...LEVEL_IDS.map((s) => `server.bots${n}.${s}`));
  const lo = Math.min(...levels), hi = Math.max(...levels);
  if (hi > lo) o.expect("server.rss_per_player", "server.heap_per_player");
  if (levels.includes(1)) o.expect("server.heap_per_room");
  const env = {
    ...process.env,
    PORT: String(port), CLIENT_ORIGIN: "http://127.0.0.1:5222", BETTER_AUTH_URL: "http://127.0.0.1:5222",
    AUTH_DB_PATH: path.join(db, "auth.db"), GAME_DB_PATH: path.join(db, "game.db"),
    ALLOW_DEV_GUESTS: "1", LOADTEST_SECRET: secret, LOADTEST_ENABLED: "1", RESEND_API_KEY: "", NODE_ENV: "development",
  };
  const server = spawn("node", ["src/main.ts"], { cwd: path.join(ROOT, "apps/server"), env, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  server.stdout.on("data", (d) => (log += d));
  server.stderr.on("data", (d) => (log += d));
  const metricsNow = async () => {
    const r = await fetch(`${api}/api/metrics`, { headers: { "x-loadtest-secret": secret } });
    if (!r.ok) throw new Error(`/api/metrics answered ${r.status}`);
    return (await r.json()) as any;
  };
  try {
    for (let i = 0; ; i++) {
      if (i > 120) throw new Error(`server did not come up:\n${tail(log, 1500)}`);
      if (await fetch(`${api}/healthz`).then((r) => r.ok, () => false)) break;
      await sleep(500);
    }
    await sleep(5000); // past the boot's allocation peak
    const idle = await metricsNow();
    o.push(m("server", "server.idle.rss", num(idle.rssMB), "MB", "lower", 0.15));
    o.push(m("server", "server.idle.heap", num(idle.heapMB), "MB", "lower", 0.15));
    const rssAt = new Map<number, number>();
    const heapAt = new Map<number, number>();
    for (const n of levels) {
      const bots = spawn("node", ["src/load.ts", "--url", api, "--bots", String(n), "--body", "portus", "--seconds", String(seconds), "--dev"], { cwd: path.join(ROOT, "tools/bots"), env: { ...process.env, LOADTEST_SECRET: secret }, stdio: ["ignore", "pipe", "pipe"] });
      let bl = "";
      bots.stdout.on("data", (d) => (bl += d));
      bots.stderr.on("data", (d) => (bl += d));
      let done = false;
      const exited = new Promise<void>((r) => bots.on("exit", () => ((done = true), r())));
      // A level whose bots never all get in (seen at 100 on a loaded machine) must not hang the run.
      const killer = setTimeout(() => bots.kill("SIGKILL"), (seconds + 180) * 1000);
      void exited.then(() => clearTimeout(killer));
      // The summary line prints once, when every join has succeeded or failed; the run timer starts then.
      while (!done && !joinSummary(bl)) await sleep(250);
      const joined = joinSummary(bl);
      let before: number | null = null, after: number | null = null;
      let a: any = null, b: any = null, dt = 0;
      if (joined && joined.joined === n) {
        await sleep(3000);
        a = await metricsNow();
        before = population(a);
        const ta = performance.now();
        await sleep(Math.max(4000, (seconds - 6) * 1000));
        b = await metricsNow();
        after = population(b);
        dt = (performance.now() - ta) / 1000;
      } else bots.kill("SIGKILL"); // short of the requested load: its numbers would describe a smaller one
      await exited;
      const res = /RESULT (\{.*\})/.exec(bl);
      const r = res ? JSON.parse(res[1]!) : null;
      const p = `server.bots${n}`;
      const problems = levelProblems(n, joined, before, after, r);
      o.push(m("server", `${p}.joined`, joined?.joined ?? 0, "bots", "higher", 0));
      if (before !== null && after !== null) o.push(m("server", `${p}.population`, Math.min(before, after), "players", "higher", 0));
      if (problems.length) {
        o.errors.push(`${problems.join("; ")}\n${tail(bl, 600)}`);
        await sleep(2500);
        continue;
      }
      const rooms = (b.rooms as any[]).filter((x) => x.clients > 0);
      const worst = rooms.reduce((w, x) => (x.tickP95 > (w?.tickP95 ?? -1) ? x : w), null as any);
      const cpu = ((b.cpuUserS + b.cpuSystemS - a.cpuUserS - a.cpuSystemS) / dt) * 100;
      rssAt.set(n, b.rssMB);
      heapAt.set(n, b.heapMB);
      o.push(m("server", `${p}.rooms`, rooms.length, "rooms", "lower", 0));
      o.push(m("server", `${p}.tick.p50`, num(worst?.tickP50), "ms", "lower", 0.25, 0.05));
      o.push(m("server", `${p}.tick.p95`, num(worst?.tickP95), "ms", "lower", 0.3, 0.1));
      o.push(m("server", `${p}.tick.p99`, num(worst?.tickP99), "ms", "lower", 0.4, 0.2));
      o.push(m("server", `${p}.cpu`, cpu, "%core", "lower", 0.15, 2));
      o.push(m("server", `${p}.rss`, num(b.rssMB), "MB", "lower", 0.1));
      o.push(m("server", `${p}.heap`, num(b.heapMB), "MB", "lower", 0.15));
      o.push(m("server", `${p}.rx_per_client`, num(r.rxPerBotKBs), "KB/s", "lower", 0.1));
      o.push(m("server", `${p}.msgs_per_client`, num(r.msgsPerBotS), "msg/s", "lower", 0.05));
      o.push(m("server", `${p}.patch_bytes`, num(r.bytesPerMsg), "B/msg", "lower", 0.1));
      o.push(m("server", `${p}.join.p50`, num(r.joinMs?.p50), "ms", "lower", 0.3, 20));
      o.push(m("server", `${p}.join.p95`, num(r.joinMs?.p95), "ms", "lower", 0.4, 30));
      o.push(m("server", `${p}.npcs`, num(worst?.npcs), "npcs", "higher", 0.05, 2));
      await sleep(2500); // let the room empty and dispose before the next level
    }
    // Per player: the slope between the smallest and largest load; per room: one bot's heap over the idle heap.
    if (hi > lo && rssAt.has(lo) && rssAt.has(hi)) {
      o.push(m("server", "server.rss_per_player", (rssAt.get(hi)! - rssAt.get(lo)!) / (hi - lo), "MB", "lower", 0.3, 0.1));
      o.push(m("server", "server.heap_per_player", (heapAt.get(hi)! - heapAt.get(lo)!) / (hi - lo), "MB", "lower", 0.3, 0.1));
    }
    if (heapAt.has(1)) o.push(m("server", "server.heap_per_room", heapAt.get(1)! - num(idle.heapMB), "MB", "lower", 0.3, 3));
  } catch (e) {
    o.errors.push(`server group failed: ${(e as Error).message}`);
  } finally {
    server.kill("SIGTERM");
    await sleep(500);
    rmSync(db, { recursive: true, force: true });
  }
  return o.result();
}

// ------------------------------------------------------------------------------------------ a run

/**
 * Fold one group's runs into its metrics and status. The group is ok only when no run had an error,
 * every run measured every metric, and every promised id is there.
 */
export function settleGroup(results: GroupResult[], provenance: Omit<GroupStatus, "ok" | "errors" | "missing" | "repeat">): { metrics: Metric[]; status: GroupStatus; notes: string[] } {
  const folded = results.length > 1 ? foldRepeats(results.map((r) => r.metrics)) : { metrics: results[0]?.metrics ?? [], partial: [] };
  const errors = [...new Set(results.flatMap((r) => r.errors))];
  if (folded.partial.length) errors.push(`${folded.partial.length} metric(s) missing from some of the ${results.length} runs: ${folded.partial.slice(0, 10).join(", ")}`);
  const have = new Set(folded.metrics.map((x) => x.id));
  const missing = [...new Set(results.flatMap((r) => r.expected))].filter((id) => !have.has(id));
  if (missing.length && !errors.length) errors.push(`${missing.length} expected metric(s) not produced`);
  if (!folded.metrics.length && !errors.length) errors.push("no metrics");
  return { metrics: folded.metrics, status: { ok: errors.length === 0, errors, missing, repeat: results.length, ...provenance }, notes: [...new Set(results.flatMap((r) => r.notes))] };
}

async function runGroup(g: Group, ctx: Ctx): Promise<GroupResult> {
  if (g === "static") return staticGroup(ctx);
  if (g === "health") return healthGroup(ctx);
  if (g === "tests") return testsGroup(ctx);
  if (g === "load") return loadGroup(ctx);
  if (g === "frame") return frameGroup(ctx);
  if (g === "passes") return passesGroup(ctx);
  return serverGroup(ctx);
}

// ------------------------------------------------------------------------------------------ output

function table(rows: string[][]) {
  const w = rows[0]!.map((_, i) => Math.max(...rows.map((r) => (r[i] ?? "").length)));
  rows.forEach((r, k) => {
    console.log(r.map((c, i) => (i === 0 ? c.padEnd(w[i]!) : c.padStart(w[i]!))).join("  "));
    if (k === 0) console.log(w.map((n) => "-".repeat(n)).join("  "));
  });
}

const fmt = (v: number | null) => (v === null ? "—" : Number.isInteger(v) ? String(v) : Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2));
const noiseText = (x: Metric) => (x.gate ? "gate" : x.noise ? `±${Math.round(x.noise * 100)}%` : "exact");

function printStatus(run: MetricsRun) {
  for (const g of run.groups) {
    const s = run.status[g]!;
    const where = `${s.commit.slice(0, 8)}${s.dirty ? `+${s.tree.slice(0, 6)}` : ""}, load ${s.load1}${s.busy ? " (busy)" : ""}, ${s.repeat}×`;
    console.log(`${s.ok ? "ok        " : "INCOMPLETE"} ${g.padEnd(7)} ${where}`);
    for (const e of s.errors) console.log(`             ${e.split("\n")[0]}`);
    if (s.missing.length) console.log(`             missing: ${s.missing.slice(0, 12).join(", ")}${s.missing.length > 12 ? ` and ${s.missing.length - 12} more` : ""}`);
  }
}

function printRun(run: MetricsRun) {
  console.log(`\n${run.commit.slice(0, 8)} ${run.branch}${run.dirty ? " (dirty)" : ""} · ${run.machine.cpu} · load ${run.machine.load1}${run.machine.busy ? " (busy: timings are noisy)" : ""} · repeat ${run.repeat}\n`);
  table([["metric", "value", "unit", "better", "noise"], ...run.metrics.map((x) => [x.id, fmt(x.value), x.unit, x.better, noiseText(x)])]);
  for (const n of run.notes) console.log(`\nnote: ${n}`);
  console.log("");
  printStatus(run);
}

export function printCompare(d: Delta[], outcome: Outcome, showSame = false) {
  const rows = d.filter((x) => showSame || x.verdict !== "same");
  const mark = { better: "better", worse: "WORSE", same: "same", new: "new", missing: "MISSING", incompatible: "INCOMPATIBLE", noisy: "noisy (busy)", unbaselined: "no baseline" } as const;
  table([["metric", "before", "after", "delta", "%", "noise", "verdict"], ...rows.map((x) => [x.id, fmt(x.a), fmt(x.b), x.delta === null ? "—" : `${x.delta > 0 ? "+" : ""}${fmt(x.delta)}`, x.rel === null ? "—" : `${x.rel > 0 ? "+" : ""}${(x.rel * 100).toFixed(1)}`, fmt(x.threshold), mark[x.verdict]])]);
  const n = (v: Delta["verdict"]) => d.filter((x) => x.verdict === v).length;
  console.log(`\n${n("better")} better, ${n("worse")} worse, ${n("same")} within noise, ${n("noisy")} not judged (busy), ${n("missing")} missing, ${n("incompatible")} incompatible, ${n("new")} new, ${n("unbaselined")} without a baseline`);
  for (const f of outcome.failures) console.log(`FAIL: ${f}`);
  for (const f of outcome.inconclusive) console.log(`INCONCLUSIVE: ${f}`);
  console.log(outcome.code === 0 ? "\nverdict: conclusive, nothing worse (exit 0)" : outcome.code === 1 ? "\nverdict: FAILED (exit 1)" : "\nverdict: inconclusive, nothing can be claimed (exit 3)");
}

/** A run file of either schema version, as v2 (v1 files come back with every group marked incomplete). */
function readRun(file: string): MetricsRun {
  const r = upgradeV1(JSON.parse(readFileSync(file, "utf8")));
  const errs = validateRun(r);
  if (errs.length) throw new Error(`${file} is not a metrics run:\n${errs.slice(0, 10).join("\n")}`);
  return r;
}

// ------------------------------------------------------------------------------------------ main

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { has, opt } = args;
  const argv = process.argv.slice(2);
  if (has("--compare")) {
    const i = argv.indexOf("--compare");
    const [a, b] = [argv[i + 1], argv[i + 2]];
    if (!a || !b) throw new Error("usage: pnpm metrics --compare <before.json> <after.json>");
    const ra = readRun(a), rb = readRun(b);
    const skip = opt("--skip") ? new RegExp(opt("--skip")) : undefined;
    const d = compareRuns(ra, rb, { skip, sessionMinutes: opt("--session-minutes") ? Number(opt("--session-minutes")) : undefined });
    const outcome = compareOutcome(ra, rb, d);
    if (has("--json")) console.log(JSON.stringify({ outcome, deltas: d }, null, 1));
    else printCompare(d, outcome, has("--all-rows"));
    process.exitCode = outcome.code;
    return;
  }

  if (has("--markdown")) {
    // A run file as a markdown table (docs/metrics.md's baseline): id, value, unit, better, noise.
    const r = readRun(opt("--markdown"));
    const skip = new RegExp(opt("--skip", "^$"));
    console.log(`Commit \`${r.commit.slice(0, 8)}\` (${r.branch}), ${r.when.slice(0, 16)}Z, ${r.machine.cpu}, ${r.machine.cores} cores.\n`);
    console.log("| group | complete | commit | load | runs |\n|---|---|---|---:|---:|");
    for (const g of r.groups) {
      const s = r.status[g]!;
      console.log(`| ${g} | ${s.ok ? "yes" : `no: ${s.errors.join("; ").replace(/\n.*/gs, "")}`} | \`${s.commit.slice(0, 8)}\`${s.dirty ? " (dirty)" : ""} | ${s.load1}${s.busy ? " (busy)" : ""} | ${s.repeat} |`);
    }
    console.log("\n| id | value | unit | better | noise |\n|---|---:|---|---|---:|");
    for (const x of r.metrics) if (!skip.test(x.id)) console.log(`| \`${x.id}\` | ${fmt(x.value)} | ${x.unit} | ${x.better} | ${x.gate ? "gate (must be 0)" : x.noise ? `±${Math.round(x.noise * 100)} %` : x.floor ? `±${x.floor}` : "exact"}${!x.gate && x.noise && x.floor ? ` (≥ ${x.floor})` : ""} |`);
    return;
  }

  if (has("--merge")) {
    // Several runs into one file; `file.json:frame,load` takes only those groups of a run.
    const out = opt("--out", "merged.json");
    const files = argv.slice(argv.indexOf("--merge") + 1).filter((a, k, all) => !a.startsWith("--") && all[k - 1] !== "--out");
    const rs = files.map((f) => {
      const [file, groups] = f.split(/:(?=[a-z,]+$)/);
      const r = readRun(file!);
      return groups ? pickGroups(r, groups.split(",") as Group[]) : r;
    });
    const merged = mergeRuns(rs);
    writeFileSync(out, JSON.stringify(merged, null, 1) + "\n");
    console.log(`merged ${merged.metrics.length} metrics (${merged.groups.join(", ")}) from ${files.length} runs into ${out}${runComplete(merged) ? "" : " (some groups incomplete)"}`);
    return;
  }

  const only = opt("--only");
  let groups: Group[];
  if (only) {
    groups = only.split(",").filter((g): g is Group => (GROUPS as readonly string[]).includes(g));
    const unknown = only.split(",").filter((g) => !(GROUPS as readonly string[]).includes(g));
    if (unknown.length || !groups.length) throw new Error(`unknown group(s) ${unknown.join(", ")}: groups are ${GROUPS.join(", ")}`);
  } else {
    groups = ["static", "health"];
    if (has("--tests") || has("--all")) groups.push("tests");
    if (has("--load") || has("--all")) groups.push("load");
    if (has("--frame") || has("--all")) groups.push("frame");
    if (has("--passes") || has("--all")) groups.push("passes");
    if (has("--server") || has("--all")) groups.push("server");
  }
  const repeat = Math.max(1, Number(opt("--repeat", "1")));
  const ctx = realCtx(args);
  const src = sourceTree();
  const mach = machine();
  const notes: string[] = [];
  const metrics: Metric[] = [];
  const status: MetricsRun["status"] = {};
  for (const g of groups) {
    const when = new Date().toISOString();
    let peak = load1();
    const results: GroupResult[] = [];
    for (let k = 0; k < repeat; k++) {
      const t = performance.now();
      process.stderr.write(`[metrics] ${g}${repeat > 1 ? ` (run ${k + 1}/${repeat})` : ""}…`);
      results.push(await runGroup(g, ctx));
      peak = Math.max(peak, load1());
      process.stderr.write(` ${((performance.now() - t) / 1000).toFixed(0)} s\n`);
    }
    const s = settleGroup(results, { when, ...src, busy: busyAt(peak), load1: round(peak, 2) });
    metrics.push(...s.metrics);
    status[g] = s.status;
    notes.push(...s.notes);
  }
  // The tree must be the one every group measured: an edit during the run would mix two trees.
  const after = sourceTree();
  if (after.commit !== src.commit || after.tree !== src.tree) {
    for (const g of groups) {
      const s = status[g]!;
      status[g] = { ...s, ok: false, errors: [...s.errors, "the source tree changed during the run"] };
    }
  }
  const all = Object.values(status) as GroupStatus[];
  const run: MetricsRun = {
    v: 2,
    when: new Date().toISOString(),
    ...src,
    branch: git(["branch", "--show-current"]),
    machine: { ...mach, busy: all.some((s) => s.busy), load1: round(Math.max(mach.load1, ...all.map((s) => s.load1)), 2) },
    groups,
    status,
    repeat,
    metrics,
    notes: [...new Set(notes)],
  };
  const errs = validateRun(run);
  if (errs.length) throw new Error(`collector produced an invalid run:\n${errs.join("\n")}`);
  mkdirSync(RESULTS, { recursive: true });
  const file = opt("--out") || path.join(RESULTS, `metrics-${run.when.replace(/[:.]/g, "-")}-${run.commit.slice(0, 8)}.json`);
  writeFileSync(file, JSON.stringify(run, null, 1) + "\n");
  if (has("--json")) console.log(JSON.stringify(run, null, 1));
  else printRun(run);
  const gates = failedGates(run);
  if (gates.length) console.log(`\nGATE FAILED: ${gates.join(", ")}`);
  const complete = runComplete(run);
  console.log(`\nwrote ${path.relative(process.cwd(), file) || file}${complete && !gates.length ? "" : complete ? " (a gate failed: exit 1)" : " (INCOMPLETE: exit 1; never use it as a result)"}`);
  process.exitCode = complete && !gates.length ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(2);
  });
}
