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
//   pnpm metrics --compare a.json b.json   deltas, flagging changes beyond each metric's noise (exit 1 on a regression)
//   pnpm metrics --merge a.json b.json --out c.json   several runs (one per group) into one file
//   pnpm metrics --markdown run.json [--skip <regex>]   a run as a markdown table
// Options: --gfx webgpu|webgl (browser groups, default webgpu), --tier <tier>, --bodies portus,arcadia,
//   --viewport 1920x1080 --dpr 2 (frame: a real window's size, #87), --heapprof (frame: allocation sites in the raw report), --flags a=b,c (extra URL flags),
//   --seconds N (frame run length, default 20), --bots 1,25,50,80, --out <file>, --no-build, --json.
// Browser groups use the journeys' stack on E2E_PORT/E2E_CLIENT_PORT (default 2612/5212); the server group
// runs its own server on METRICS_SERVER_PORT (default 2622). Headless and muted, like every test browser.

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { analyseDist } from "./bundle.ts";
import { compareRuns, foldRepeats, GROUPS, round, validateRun, type Better, type Delta, type Group, type Metric, type MetricsRun } from "./schema.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CLIENT = path.join(ROOT, "apps/client");
const RESULTS = path.join(ROOT, "tools/bench/results");

// ------------------------------------------------------------------------------------------ args

const argv = process.argv.slice(2);
const has = (f: string) => argv.includes(f);
const opt = (f: string, d = "") => {
  const i = argv.indexOf(f);
  return i >= 0 && argv[i + 1] && !argv[i + 1]!.startsWith("--") ? argv[i + 1]! : d;
};

// ------------------------------------------------------------------------------------------ helpers

/** A metric with its catalogue noise (fraction of the value) and optional absolute floor. */
function m(group: Group, id: string, value: number, unit: string, better: Better, noise: number, floor?: number): Metric {
  return { id, value: round(value), unit, better, group, noise, ...(floor !== undefined ? { floor } : {}) };
}

function timed(cmd: string, args: string[], cwd = ROOT, env: NodeJS.ProcessEnv = process.env): { ms: number; ok: boolean; out: string } {
  const t = performance.now();
  const r = spawnSync(cmd, args, { cwd, env, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  return { ms: performance.now() - t, ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

function git(args: string[]): string {
  try {
    return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

function machine(): MetricsRun["machine"] {
  const load1 = os.loadavg()[0] ?? 0;
  return {
    os: `${os.type()} ${os.release()} ${os.arch()}`,
    cpu: os.cpus()[0]?.model ?? "unknown",
    cores: os.cpus().length,
    memGB: Math.round(os.totalmem() / 1073741824),
    node: process.version,
    busy: load1 > os.cpus().length / 2,
    load1: round(load1, 2),
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const kb = (bytes: number) => bytes / 1024;

// ------------------------------------------------------------------------------------------ groups

/** Build time, every chunk's raw/gzip/brotli size, assets by kind, first-visit bytes, typecheck time. */
function staticGroup(notes: string[]): Metric[] {
  const out: Metric[] = [];
  const dist = path.join(CLIENT, "dist");
  if (!has("--no-build")) {
    const b = timed("pnpm", ["--filter", "@firstlight/client", "build"]);
    if (!b.ok) notes.push(`client build failed:\n${b.out.slice(-2000)}`);
    out.push(m("static", "build.client.ms", b.ms, "ms", "lower", 0.15));
  }
  if (!existsSync(dist)) {
    notes.push("no apps/client/dist: bundle metrics skipped");
    return out;
  }
  const r = analyseDist(dist);
  const js = r.chunks.filter((c) => c.name.endsWith(".js"));
  const css = r.chunks.filter((c) => c.name.endsWith(".css"));
  const tot = (cs: typeof js, k: "raw" | "gzip" | "br") => cs.reduce((a, c) => a + c[k], 0);
  out.push(
    m("static", "bundle.js.count", js.length, "files", "lower", 0),
    m("static", "bundle.js.raw", kb(tot(js, "raw")), "KB", "lower", 0),
    m("static", "bundle.js.gzip", kb(tot(js, "gzip")), "KB", "lower", 0),
    m("static", "bundle.js.br", kb(tot(js, "br")), "KB", "lower", 0),
    m("static", "bundle.css.raw", kb(tot(css, "raw")), "KB", "lower", 0),
    m("static", "bundle.css.br", kb(tot(css, "br")), "KB", "lower", 0),
  );
  // Per chunk, every JS/CSS chunk of 20 KB or more (the rest are in the totals).
  for (const c of r.chunks) {
    if (c.raw < 20 * 1024) continue;
    const id = `chunk.${c.name.replace(/[^A-Za-z0-9.]+/g, "_").toLowerCase()}`;
    out.push(m("static", `${id}.raw`, kb(c.raw), "KB", "lower", 0), m("static", `${id}.gzip`, kb(c.gzip), "KB", "lower", 0), m("static", `${id}.br`, kb(c.br), "KB", "lower", 0));
  }
  for (const [k, v] of Object.entries(r.kinds).sort()) {
    out.push(m("static", `dist.${k}.bytes`, kb(v.bytes), "KB", "lower", 0), m("static", `dist.${k}.files`, v.files, "files", "lower", 0));
  }
  out.push(
    m("static", "dist.total.bytes", kb(r.totalBytes), "KB", "lower", 0),
    m("static", "firstvisit.home.requests", r.home.requests, "requests", "lower", 0),
    m("static", "firstvisit.home.br", kb(r.home.br), "KB", "lower", 0),
    m("static", "firstvisit.home.raw", kb(r.home.raw), "KB", "lower", 0),
    m("static", "firstvisit.world.requests", r.world.requests, "requests", "lower", 0),
    m("static", "firstvisit.world.br", kb(r.world.br), "KB", "lower", 0),
    m("static", "firstvisit.world.raw", kb(r.world.raw), "KB", "lower", 0),
  );
  if (!has("--no-typecheck")) {
    const t = timed("pnpm", ["typecheck"]);
    if (!t.ok) notes.push(`typecheck failed:\n${t.out.slice(-2000)}`);
    out.push(m("static", "typecheck.ms", t.ms, "ms", "lower", 0.15), m("static", "typecheck.errors", t.ok ? 0 : (t.out.match(/error TS\d+/g) ?? [""]).length, "errors", "lower", 0));
  }
  return out;
}

/** The balance model's band checks (tools/balance): how many numbers sit outside their band. */
function healthGroup(notes: string[]): Metric[] {
  const r = timed("node", ["tools/balance/report.ts", "--json"]);
  try {
    const j = JSON.parse(r.out.slice(r.out.indexOf("{"))) as { checks: { ok: boolean }[] };
    return [m("health", "balance.checks.failed", j.checks.filter((c) => !c.ok).length, "checks", "lower", 0), m("health", "balance.checks.total", j.checks.length, "checks", "higher", 0)];
  } catch {
    notes.push("balance report unreadable");
    return [];
  }
}

/** Vitest per project: test count, failures, wall time. */
function testsGroup(notes: string[]): Metric[] {
  const out: Metric[] = [];
  const projects = opt("--projects", "shared,client,server").split(",");
  for (const p of projects) {
    const file = path.join(os.tmpdir(), `fl-metrics-vitest-${p}-${process.pid}.json`);
    const t = timed("pnpm", ["vitest", "run", "--project", p, "--reporter=json", `--outputFile=${file}`]);
    try {
      const j = JSON.parse(readFileSync(file, "utf8")) as { numTotalTests: number; numFailedTests: number };
      out.push(m("tests", `tests.${p}.count`, j.numTotalTests, "tests", "higher", 0), m("tests", `tests.${p}.failed`, j.numFailedTests, "tests", "lower", 0, 1), m("tests", `tests.${p}.ms`, t.ms, "ms", "lower", 0.2));
    } catch {
      notes.push(`vitest ${p}: no JSON report (${t.out.slice(-400)})`);
    }
    rmSync(file, { force: true });
  }
  return out;
}

/** Runs e2e/metrics.spec.ts in one browser project and returns its raw JSON. */
function browserRun(mode: "load" | "frame", gfx: string, env: Record<string, string>, notes: string[]): any {
  const file = path.join(os.tmpdir(), `fl-metrics-${mode}-${gfx}-${process.pid}.json`);
  rmSync(file, { force: true });
  const e2eOut = path.join(CLIENT, "e2e/.out/metrics");
  const r = timed(
    "pnpm",
    ["exec", "playwright", "test", "-c", "e2e/playwright.config.ts", "--project", gfx, "--grep", "@metrics", "--workers", "1", "--reporter", "line"],
    CLIENT,
    { ...process.env, E2E_PORT: process.env.E2E_PORT ?? "2612", E2E_CLIENT_PORT: process.env.E2E_CLIENT_PORT ?? "5212", E2E_OUT: e2eOut, METRICS_MODE: mode, METRICS_OUT: file, ...env },
  );
  if (!existsSync(file)) {
    notes.push(`${mode} (${gfx}) produced no result:\n${r.out.slice(-1500)}`);
    return null;
  }
  const j = JSON.parse(readFileSync(file, "utf8"));
  // Keep the raw browser report (largest requests, warm-up phases) next to the results for digging.
  mkdirSync(RESULTS, { recursive: true });
  const raw = path.join(RESULTS, `raw-${mode}-${gfx}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  writeFileSync(raw, JSON.stringify(j, null, 1));
  rmSync(file, { force: true });
  notes.push(`raw ${mode} report: ${path.relative(ROOT, raw)}`);
  return j;
}

function loadGroup(notes: string[]): Metric[] {
  const out: Metric[] = [];
  for (const gfx of opt("--gfx", "webgpu").split(",")) {
    const j = browserRun("load", gfx, { METRICS_TIER: opt("--tier", process.env.METRICS_TIER ?? "medium") }, notes);
    if (!j) continue;
    for (const cache of ["cold", "warm"] as const) {
      const v = j[cache];
      if (!v) continue;
      const p = `load.${gfx}.${cache}`;
      out.push(
        m("load", `${p}.fcp.ms`, v.fcpMs ?? 0, "ms", "lower", 0.25),
        m("load", `${p}.menu.ms`, v.menuMs, "ms", "lower", 0.25),
        m("load", `${p}.play_to_world.ms`, v.playToWorldMs, "ms", "lower", 0.2),
        m("load", `${p}.nav_to_world.ms`, v.navToWorldMs, "ms", "lower", 0.2),
        m("load", `${p}.menu.requests`, v.atMenu.requests, "requests", "lower", 0.02, 2),
        m("load", `${p}.menu.transfer`, v.atMenu.transferKB, "KB", "lower", 0.02),
        m("load", `${p}.world.requests`, v.atWorld.requests, "requests", "lower", 0.02, 2),
        m("load", `${p}.world.transfer`, v.atWorld.transferKB, "KB", "lower", 0.02),
        m("load", `${p}.world.decoded`, v.atWorld.decodedKB, "KB", "lower", 0.02),
        m("load", `${p}.shaders_after_warmup`, v.afterWarmup, "builds", "lower", 0, 1),
      );
      if (v.heapMB !== null) out.push(m("load", `${p}.heap`, v.heapMB, "MB", "lower", 0.1));
      const w = v.warm;
      if (w) {
        out.push(
          m("load", `${p}.warmup.ms`, w.ms, "ms", "lower", 0.25),
          m("load", `${p}.warmup.builds`, w.builds, "builds", "lower", 0.02, 2),
          m("load", `${p}.warmup.stages`, w.stages, "programs", "lower", 0.02, 2),
          m("load", `${p}.warmup.gap_max.ms`, w.gaps?.max ?? 0, "ms", "lower", 0.4),
          m("load", `${p}.warmup.gaps_over250`, w.gaps?.over250 ?? 0, "gaps", "lower", 0, 2),
          m("load", `${p}.warmup.longtasks`, w.longTasks?.count ?? 0, "tasks", "lower", 0.3, 2),
        );
      }
    }
  }
  return out;
}

function frameGroup(notes: string[]): Metric[] {
  const out: Metric[] = [];
  const tier = opt("--tier", process.env.METRICS_TIER ?? "medium");
  for (const gfx of opt("--gfx", "webgpu").split(",")) {
    const viewport = opt("--viewport"), dpr = opt("--dpr", "1");
    const j = browserRun("frame", gfx, { METRICS_TIER: tier, METRICS_BODIES: opt("--bodies", "portus,arcadia,hollowmere,meridian"), METRICS_SECONDS: opt("--seconds", "20"), METRICS_VIEWPORT: viewport, METRICS_DPR: dpr, METRICS_FLAGS: opt("--flags"), METRICS_HEAPPROF: has("--heapprof") ? "1" : "" }, notes);
    if (!j) continue;
    // The default window (1280×720 at DPR 1) keeps the plain id; another size is part of the id.
    const size = viewport || dpr !== "1" ? `.vp${viewport || "1280x720"}d${dpr}` : "";
    for (const [body, b] of Object.entries(j.bodies as Record<string, any>)) {
      const p = `frame.${gfx}.${tier}.${body}${size}`;
      out.push(
        m("frame", `${p}.fps`, b.fps.mean, "fps", "higher", 0.05),
        m("frame", `${p}.frame.p50`, b.frameMs.p50, "ms", "lower", 0.05),
        m("frame", `${p}.frame.p95`, b.frameMs.p95, "ms", "lower", 0.15),
        m("frame", `${p}.frame.p99`, b.frameMs.p99, "ms", "lower", 0.3),
        m("frame", `${p}.frame.max`, b.frameMs.max, "ms", "lower", 0.6),
        m("frame", `${p}.cpu.p50`, b.cpuMs.p50, "ms", "lower", 0.15),
        m("frame", `${p}.cpu.p95`, b.cpuMs.p95, "ms", "lower", 0.25),
        m("frame", `${p}.draws`, b.draws.mean, "calls", "lower", 0.02),
        m("frame", `${p}.triangles`, b.triangles.mean / 1000, "ktris", "lower", 0.02),
        m("frame", `${p}.shader_builds`, b.shaderBuildsDuringRun, "builds", "lower", 0, 1),
        // The drawing buffer after the resolution ladder (render/timing.ts) settled: it drops scale when frames run long.
        m("frame", `${p}.pixel_ratio`, b.pixelRatio, "ratio", "higher", 0.02),
        m("frame", `${p}.canvas_mpx`, (b.canvas[0] * b.canvas[1]) / 1e6, "Mpx", "higher", 0.02),
      );
      if (b.over) out.push(m("frame", `${p}.over33`, b.over[33], "frames", "lower", 0.5, 3), m("frame", `${p}.over50`, b.over[50], "frames", "lower", 0.5, 2), m("frame", `${p}.over100`, b.over[100], "frames", "lower", 0.5, 1));
      if (b.gpuBusyMs) out.push(m("frame", `${p}.gpu_busy.p50`, b.gpuBusyMs.p50, "ms", "lower", 0.1), m("frame", `${p}.gpu_busy.p95`, b.gpuBusyMs.p95, "ms", "lower", 0.2));
      if (b.heapMB) out.push(m("frame", `${p}.heap.end`, b.heapMB.end, "MB", "lower", 0.1), m("frame", `${p}.heap.growth`, b.heapMB.max - b.heapMB.start, "MB", "lower", 0.5, 5));
      if (b.memory) {
        out.push(
          m("frame", `${p}.gpu_mem.total`, b.memory.totalMB, "MB", "lower", 0.02),
          m("frame", `${p}.gpu_mem.textures`, b.memory.texturesMB, "MB", "lower", 0.02),
          m("frame", `${p}.geometries`, b.memory.geometries, "count", "lower", 0.02),
          m("frame", `${p}.textures`, b.memory.textures, "count", "lower", 0.02),
          m("frame", `${p}.programs`, b.memory.programs, "count", "lower", 0.02),
        );
      }
    }
  }
  return out;
}

/** `?bench=passes` through the existing spec (bench-passes.spec.ts): per-pass GPU ms at the fixed view. */
function passesGroup(notes: string[]): Metric[] {
  const tier = opt("--tier", "high");
  const benchOut = mkdtempSync(path.join(os.tmpdir(), "fl-metrics-passes-"));
  const r = timed(
    "pnpm",
    ["exec", "playwright", "test", "-c", "e2e/playwright.config.ts", "--project", "webgpu", "--grep", "@bench", "--workers", "1", "--reporter", "line", "bench-passes"],
    CLIENT,
    { ...process.env, E2E_PORT: process.env.E2E_PORT ?? "2612", E2E_CLIENT_PORT: process.env.E2E_CLIENT_PORT ?? "5212", E2E_OUT: path.join(CLIENT, "e2e/.out/metrics"), BENCH_MODE: "passes", BENCH_TIER: tier, BENCH_OUT: benchOut, BENCH_FLAGS: opt("--flags", process.env.BENCH_FLAGS ?? "") },
  );
  const file = path.join(benchOut, `webgpu-passes-${tier}-1.json`);
  if (!existsSync(file)) {
    notes.push(`passes produced no result:\n${r.out.slice(-1500)}`);
    return [];
  }
  const j = JSON.parse(readFileSync(file, "utf8"));
  rmSync(benchOut, { recursive: true, force: true });
  const out: Metric[] = [];
  const p = j.passes;
  if (!p) return out;
  out.push(m("passes", `passes.${tier}.baseline.p50`, p.baseline.p50, "ms", "lower", 0.08));
  out.push(m("passes", `passes.${tier}.noise_floor`, p.noiseMs, "ms", "lower", 0.5));
  out.push(m("passes", `passes.${tier}.valid`, p.valid ? 1 : 0, "bool", "higher", 0));
  for (const x of p.passes as { feature: string; deltaMs: { p50: number } }[]) out.push(m("passes", `passes.${tier}.${x.feature}`, x.deltaMs.p50, "ms", "lower", 0.3, 0.25));
  for (const g of (p.gtao ?? []) as { samples: number; scale: number; denoise?: string; costMs: { p50: number } }[]) {
    out.push(m("passes", `passes.${tier}.gtao.s${g.samples}_x${String(g.scale).replace(".", "")}${g.denoise ? `_dn_${g.denoise}` : ""}`, g.costMs.p50, "ms", "lower", 0.3, 0.25));
  }
  return out;
}

/** The game server under 1…N load-test bots: tick time, CPU, memory, bytes per client, join latency. */
async function serverGroup(notes: string[]): Promise<Metric[]> {
  const port = Number(process.env.METRICS_SERVER_PORT ?? 2622);
  const api = `http://127.0.0.1:${port}`;
  const secret = randomBytes(32).toString("base64url"); // a throwaway strong secret: the server refuses short ones
  const db = mkdtempSync(path.join(os.tmpdir(), "fl-metrics-db-"));
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
  const out: Metric[] = [];
  try {
    for (let i = 0; ; i++) {
      if (i > 120) throw new Error(`server did not come up:\n${log.slice(-1500)}`);
      if (await fetch(`${api}/healthz`).then((r) => r.ok, () => false)) break;
      await sleep(500);
    }
    await sleep(5000); // past the boot's allocation peak
    const idle = await metricsNow();
    out.push(m("server", "server.idle.rss", idle.rssMB, "MB", "lower", 0.15), m("server", "server.idle.heap", idle.heapMB, "MB", "lower", 0.15));
    const seconds = Number(opt("--server-seconds", "20"));
    const levels = opt("--bots", "1,25,50,80").split(",").map(Number);
    const rssAt = new Map<number, number>();
    const heapAt = new Map<number, number>();
    for (const n of levels) {
      const bots = spawn("node", ["src/load.ts", "--url", api, "--bots", String(n), "--body", "portus", "--seconds", String(seconds), "--dev"], { cwd: path.join(ROOT, "tools/bots"), env: { ...process.env, LOADTEST_SECRET: secret }, stdio: ["ignore", "pipe", "pipe"] });
      let bl = "";
      bots.stdout.on("data", (d) => (bl += d));
      bots.stderr.on("data", (d) => (bl += d));
      const exited = new Promise<void>((r) => bots.on("exit", () => r()));
      // A level whose bots never all get in (seen at 100 on a loaded machine) must not hang the run.
      const killer = setTimeout(() => bots.kill("SIGKILL"), (seconds + 180) * 1000);
      void exited.then(() => clearTimeout(killer));
      // Wait for every bot to join, then sample twice over the steady part of the run.
      for (let i = 0; i < 600 && !/bots joined/.test(bl); i++) await sleep(250);
      await sleep(3000);
      const a = await metricsNow();
      const ta = performance.now();
      await sleep(Math.max(4000, (seconds - 6) * 1000));
      const b = await metricsNow();
      const dt = (performance.now() - ta) / 1000;
      await exited;
      const res = /RESULT (\{.*\})/.exec(bl);
      if (!res) {
        const joined = /(\d+)\/\d+ bots joined/.exec(bl);
        notes.push(`bots ${n}: no RESULT (killed after ${seconds + 180} s; ${joined ? `${joined[1]} joined` : "the joins never finished"})\n${bl.slice(-600)}`);
        out.push(m("server", `server.bots${n}.joined`, joined ? Number(joined[1]) : 0, "bots", "higher", 0));
        continue;
      }
      const r = JSON.parse(res[1]!);
      const rooms = (b.rooms as any[]).filter((x) => x.clients > 0);
      const worst = rooms.reduce((w, x) => (x.tickP95 > (w?.tickP95 ?? -1) ? x : w), null as any);
      const p = `server.bots${n}`;
      const cpu = ((b.cpuUserS + b.cpuSystemS - a.cpuUserS - a.cpuSystemS) / dt) * 100;
      rssAt.set(n, b.rssMB);
      heapAt.set(n, b.heapMB);
      out.push(
        m("server", `${p}.joined`, r.bots, "bots", "higher", 0),
        m("server", `${p}.rooms`, rooms.length, "rooms", "lower", 0),
        m("server", `${p}.tick.p50`, worst?.tickP50 ?? 0, "ms", "lower", 0.25, 0.05),
        m("server", `${p}.tick.p95`, worst?.tickP95 ?? 0, "ms", "lower", 0.3, 0.1),
        m("server", `${p}.tick.p99`, worst?.tickP99 ?? 0, "ms", "lower", 0.4, 0.2),
        m("server", `${p}.cpu`, cpu, "%core", "lower", 0.15, 2),
        m("server", `${p}.rss`, b.rssMB, "MB", "lower", 0.1),
        m("server", `${p}.heap`, b.heapMB, "MB", "lower", 0.15),
        m("server", `${p}.rx_per_client`, r.rxPerBotKBs, "KB/s", "lower", 0.1),
        m("server", `${p}.msgs_per_client`, r.msgsPerBotS ?? 0, "msg/s", "lower", 0.05),
        m("server", `${p}.patch_bytes`, r.bytesPerMsg ?? 0, "B/msg", "lower", 0.1),
        m("server", `${p}.join.p50`, r.joinMs?.p50 ?? 0, "ms", "lower", 0.3, 20),
        m("server", `${p}.join.p95`, r.joinMs?.p95 ?? 0, "ms", "lower", 0.4, 30),
        m("server", `${p}.npcs`, worst?.npcs ?? 0, "npcs", "higher", 0.05, 2),
      );
      await sleep(2500); // let the room empty and dispose before the next level
    }
    const lo = Math.min(...rssAt.keys()), hi = Math.max(...rssAt.keys());
    // Per player: the slope between the smallest and largest load; per room: one bot's heap over the idle heap.
    if (rssAt.size >= 2 && hi > lo) {
      out.push(m("server", "server.rss_per_player", (rssAt.get(hi)! - rssAt.get(lo)!) / (hi - lo), "MB", "lower", 0.3, 0.1));
      out.push(m("server", "server.heap_per_player", (heapAt.get(hi)! - heapAt.get(lo)!) / (hi - lo), "MB", "lower", 0.3, 0.1));
    }
    if (heapAt.has(1)) out.push(m("server", "server.heap_per_room", heapAt.get(1)! - idle.heapMB, "MB", "lower", 0.3, 3));
  } catch (e) {
    notes.push(`server group failed: ${(e as Error).message}`);
  } finally {
    server.kill("SIGTERM");
    await sleep(500);
    rmSync(db, { recursive: true, force: true });
  }
  return out;
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

function printRun(run: MetricsRun) {
  console.log(`\n${run.commit.slice(0, 8)} ${run.branch}${run.dirty ? " (dirty)" : ""} · ${run.machine.cpu} · load ${run.machine.load1}${run.machine.busy ? " (busy: frame numbers are noisy)" : ""} · repeat ${run.repeat}\n`);
  table([["metric", "value", "unit", "better", "noise"], ...run.metrics.map((x) => [x.id, fmt(x.value), x.unit, x.better, x.noise ? `±${Math.round(x.noise * 100)}%` : "exact"])]);
  for (const n of run.notes) console.log(`\nnote: ${n}`);
}

export function printCompare(d: Delta[], showSame = false) {
  const rows = d.filter((x) => showSame || x.verdict !== "same");
  const mark = { better: "better", worse: "WORSE", same: "same", new: "new", gone: "gone" } as const;
  table([["metric", "before", "after", "delta", "%", "noise", "verdict"], ...rows.map((x) => [x.id, fmt(x.a), fmt(x.b), x.delta === null ? "—" : `${x.delta > 0 ? "+" : ""}${fmt(x.delta)}`, x.rel === null ? "—" : `${x.rel > 0 ? "+" : ""}${(x.rel * 100).toFixed(1)}`, fmt(x.threshold), mark[x.verdict]])]);
  const worse = d.filter((x) => x.verdict === "worse").length;
  const better = d.filter((x) => x.verdict === "better").length;
  console.log(`\n${better} better, ${worse} worse, ${d.filter((x) => x.verdict === "same").length} within noise, ${d.filter((x) => x.verdict === "new").length} new, ${d.filter((x) => x.verdict === "gone").length} gone`);
}

// ------------------------------------------------------------------------------------------ main

async function main() {
  if (has("--compare")) {
    const i = argv.indexOf("--compare");
    const [a, b] = [argv[i + 1], argv[i + 2]];
    if (!a || !b) throw new Error("usage: pnpm metrics --compare <before.json> <after.json>");
    const ra = JSON.parse(readFileSync(a, "utf8")) as MetricsRun, rb = JSON.parse(readFileSync(b, "utf8")) as MetricsRun;
    for (const [f, r] of [[a, ra], [b, rb]] as const) {
      const errs = validateRun(r);
      if (errs.length) throw new Error(`${f} is not a metrics run:\n${errs.slice(0, 10).join("\n")}`);
    }
    const d = compareRuns(ra, rb);
    if (has("--json")) console.log(JSON.stringify(d, null, 1));
    else printCompare(d, has("--all-rows"));
    process.exitCode = d.some((x) => x.verdict === "worse") ? 1 : 0;
    return;
  }

  if (has("--markdown")) {
    // A run file as a markdown table (docs/metrics.md's baseline): id, value, unit, better, noise.
    const r = JSON.parse(readFileSync(opt("--markdown"), "utf8")) as MetricsRun;
    const skip = new RegExp(opt("--skip", "^$"));
    console.log(`Commit \`${r.commit.slice(0, 8)}\` (${r.branch}), ${r.when.slice(0, 16)}Z, ${r.machine.cpu}, ${r.machine.cores} cores, load ${r.machine.load1}${r.machine.busy ? " (busy)" : ""}, ${r.repeat} run(s) per group.\n`);
    console.log("| id | value | unit | better | noise |\n|---|---:|---|---|---:|");
    for (const x of r.metrics) if (!skip.test(x.id)) console.log(`| \`${x.id}\` | ${fmt(x.value)} | ${x.unit} | ${x.better} | ${x.noise ? `±${Math.round(x.noise * 100)} %` : x.floor ? `±${x.floor}` : "exact"}${x.noise && x.floor ? ` (≥ ${x.floor})` : ""} |`);
    return;
  }

  if (has("--merge")) {
    // Several runs (e.g. one per group) into one file: metrics in order, the first run's machine and commit.
    const files = argv.slice(argv.indexOf("--merge") + 1).filter((a) => !a.startsWith("--") && a !== opt("--out"));
    const rs = files.map((f) => JSON.parse(readFileSync(f, "utf8")) as MetricsRun);
    const merged: MetricsRun = { ...rs[0]!, groups: [...new Set(rs.flatMap((r) => r.groups))], repeat: Math.min(...rs.map((r) => r.repeat)), metrics: rs.flatMap((r) => r.metrics), notes: rs.flatMap((r) => r.notes) };
    const errs = validateRun(merged);
    if (errs.length) throw new Error(errs.join("\n"));
    writeFileSync(opt("--out", "merged.json"), JSON.stringify(merged, null, 1) + "\n");
    console.log(`merged ${merged.metrics.length} metrics from ${files.length} runs into ${opt("--out", "merged.json")}`);
    return;
  }

  const only = opt("--only");
  let groups: Group[];
  if (only) groups = only.split(",").filter((g): g is Group => (GROUPS as readonly string[]).includes(g));
  else {
    groups = ["static", "health"];
    if (has("--tests") || has("--all")) groups.push("tests");
    if (has("--load") || has("--all")) groups.push("load");
    if (has("--frame") || has("--all")) groups.push("frame");
    if (has("--passes") || has("--all")) groups.push("passes");
    if (has("--server") || has("--all")) groups.push("server");
  }
  const repeat = Math.max(1, Number(opt("--repeat", "1")));
  const notes: string[] = [];
  const mach = machine();
  const runs: Metric[][] = [];
  for (let k = 0; k < repeat; k++) {
    const ms: Metric[] = [];
    for (const g of groups) {
      const t = performance.now();
      process.stderr.write(`[metrics] ${g}${repeat > 1 ? ` (run ${k + 1}/${repeat})` : ""}…`);
      if (g === "static") ms.push(...staticGroup(notes));
      else if (g === "health") ms.push(...healthGroup(notes));
      else if (g === "tests") ms.push(...testsGroup(notes));
      else if (g === "load") ms.push(...loadGroup(notes));
      else if (g === "frame") ms.push(...frameGroup(notes));
      else if (g === "passes") ms.push(...passesGroup(notes));
      else if (g === "server") ms.push(...(await serverGroup(notes)));
      process.stderr.write(` ${((performance.now() - t) / 1000).toFixed(0)} s\n`);
    }
    runs.push(ms);
  }
  const run: MetricsRun = {
    v: 1,
    when: new Date().toISOString(),
    commit: git(["rev-parse", "HEAD"]),
    branch: git(["branch", "--show-current"]),
    dirty: git(["status", "--porcelain"]) !== "",
    machine: mach,
    groups,
    repeat,
    metrics: repeat > 1 ? foldRepeats(runs) : runs[0]!,
    notes: [...new Set(notes)],
  };
  const errs = validateRun(run);
  if (errs.length) throw new Error(`collector produced an invalid run:\n${errs.join("\n")}`);
  mkdirSync(RESULTS, { recursive: true });
  const file = opt("--out") || path.join(RESULTS, `metrics-${run.when.replace(/[:.]/g, "-")}-${run.commit.slice(0, 8)}.json`);
  writeFileSync(file, JSON.stringify(run, null, 1) + "\n");
  if (has("--json")) console.log(JSON.stringify(run, null, 1));
  else printRun(run);
  console.log(`\nwrote ${path.relative(process.cwd(), file) || file}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(2);
  });
}
