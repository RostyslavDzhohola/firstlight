// Review round three, #1 and #3, measured: nothing the funnel does may hold the game server's thread
// for more than a few milliseconds, at the documented row caps, whether the database is idle, busy or
// locked. The game runs every room on that thread.
//
// A temporary game.db is filled to the caps (FUNNEL_LIMITS: 40,000 visit rows and 40,000 account
// rows a day for retention + 3 days, about 2.7 M rows, and 1,000 error reports a day for 30 days)
// behind a running in-process server. Then, while a probe on the main thread wakes every 2 ms and
// writes a row the way a room's save does (the normal 5 s lock wait), so it measures both the
// event loop's longest stall and the longest wait the funnel's worker caused a game write, we run:
// the day's first write (the budget), the /stats report over HTTP, the daily housekeeping (pruning
// and the fold), and the shutdown flush of a full queue; free, and with another connection holding
// the write lock.
//
// (With the lock held the report is asked of the funnel's worker directly, as /stats does: the admin
// check in front of /stats writes the account's last visit, which is not the funnel's and waits for
// any lock like every other game write.)
//
// The bound (STALL_MS, 50 ms) is on CPU time: the most this thread computed between two ticks of the
// probe, and the most the worker computed while holding the write lock, so the OS not running us on a
// loaded machine (an idle process here saw 140 ms gaps at a load average of 236) can't fail it and a
// funnel that held the thread can't pass it. Quiet, both are a few milliseconds; the old code held
// the thread for seconds (a report), tens of seconds (a fold) or hours (a locked shutdown). The wall-
// clock figures (the event loop's longest delay, the longest gap between ticks, the longest game
// write) are logged beside an idle run of the same probe, for reading.
//
// FUNNEL_BENCH_SCALE (0 < s ≤ 1, default 1) scales the rows per day for a loaded machine. It stays
// meaningful only while the work itself is far above the bound, so the test checks that too: the
// same report run synchronously (what /stats did before) and each worker job must take at least
// 4 × STALL_MS, or the test says the scale is too small to prove anything.

import { rmSync } from "node:fs";
import { join } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { mountOps } from "../src/ops/admin.ts";
import { DAY, FUNNEL_LIMITS, budgetState, closeFunnel, funnelQueueState, queueStep, reportWindows, resetFunnelBudgets } from "../src/db/funnel.ts";
import { Browser, ORIGIN, startAuthServer, tempDir, type AuthServer } from "./auth-helpers.ts";

const STALL_MS = 50;
const SCALE = Math.min(1, Math.max(0.01, Number(process.env.FUNNEL_BENCH_SCALE ?? 1) || 1));
const CLAIM_TOKEN = "Kq3vX9pLw2TzR8mN5bYc7HfJ1sDgA4eU6iOoVxWyZtQ=";
const saved = { ...FUNNEL_LIMITS };
let server: AuthServer | null = null;

afterEach(async () => {
  Object.assign(FUNNEL_LIMITS, saved);
  await server?.close();
  server = null;
});

const VISIT_STEPS: [string, string, string][] = [
  ["page", "NULL", "NULL"],
  ["play", "NULL", "NULL"],
  ["pick", "NULL", "NULL"],
  ["join", "NULL", "NULL"],
  ["world", "12.5", "'webgpu/high'"],
  ["tutorial:move", "0", "NULL"],
  ["tutorial:look", "1", "NULL"],
  ["tutorial_done", "NULL", "NULL"],
];
const ACCOUNT_STEPS = ["new", "join", "kill", "mission", "level2", "level5", "tutorial_done", "saved", "first_session", "back"];

/** game.db at the caps: `days` cohort days ending today, through a connection of its own. */
function fill(path: string, now: number, days: number): { visitRows: number; accountRows: number; errors: number } {
  const db = new Database(path);
  db.pragma("busy_timeout = 30000");
  const visitsPerDay = Math.round((FUNNEL_LIMITS.visitRowsPerDay / VISIT_STEPS.length) * SCALE);
  const accountsPerDay = Math.round((FUNNEL_LIMITS.accountRowsPerDay / ACCOUNT_STEPS.length) * SCALE);
  const errorsPerDay = Math.round(FUNNEL_LIMITS.errorsPerDay * SCALE);
  const steps = (list: [string, string, string][]) => list.map(([s, v, d], k) => `SELECT '${s}' AS step, ${k} AS k, ${v} AS value, ${d} AS detail`).join(" UNION ALL ");
  const today = Math.floor(now / DAY);
  for (let d = today - days + 1; d <= today; d++) {
    const base = d * DAY;
    // Today's rows stay before `now` (they are today's, the budget counts them).
    const span = d === today ? Math.max(1, now - base - 60_000) : DAY - 60_000;
    db.transaction(() => {
      db.prepare(
        `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ? - 1)
         INSERT INTO funnel_step (subject, step, at, value, detail, kind)
         SELECT 'v:b' || ? || '-' || i, s.step, ? + (i * ?) / ? + s.k, s.value, s.detail, 'person' FROM n CROSS JOIN (${steps(VISIT_STEPS)}) s`,
      ).run(visitsPerDay, d, base, span, visitsPerDay);
      db.prepare(
        `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ? - 1)
         INSERT INTO funnel_step (subject, step, at, value, detail, kind)
         SELECT 'u:b' || ? || '-' || i, s.step, ? + (i * ?) / ? + s.k, s.value, NULL, 'person' FROM n CROSS JOIN (${steps(ACCOUNT_STEPS.map((s) => [s, s === "first_session" ? "900000" : s === "back" ? "2" : "NULL", "NULL"]))}) s`,
      ).run(accountsPerDay, d, base, span, accountsPerDay);
      // Half the accounts still exist (the fold keeps their rows, marked); the rest were pruned.
      db.prepare(
        `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ? - 1)
         INSERT INTO account (user_id, created_at, last_seen_at) SELECT 'b' || ? || '-' || i, ?, ? FROM n WHERE i % 2 = 0`,
      ).run(accountsPerDay, d, base, base);
      if (d > today - FUNNEL_LIMITS.errorRetentionDays - 2)
        db.prepare(
          `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ? - 1)
           INSERT INTO client_error (at, sig, message, stack, build, tier, backend, kind)
           SELECT ? + (i * ?) / ?, printf('%016x', i % 40), 'TypeError: x is undefined ' || (i % 40), 'at f (https://firstlight.test/a.js:1:2)', 'b1', 'high', 'webgpu', 'person' FROM n`,
        ).run(errorsPerDay, base, span, errorsPerDay);
    })();
  }
  const n = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
  const out = { visitRows: n("SELECT COUNT(*) AS n FROM funnel_step WHERE subject LIKE 'v:%'"), accountRows: n("SELECT COUNT(*) AS n FROM funnel_step WHERE subject LIKE 'u:%'"), errors: n("SELECT COUNT(*) AS n FROM client_error") };
  db.pragma("wal_checkpoint(TRUNCATE)");
  db.close();
  return out;
}

/** This thread's CPU time (user + system), ms. */
const cpuNow = () => {
  const u = process.threadCpuUsage();
  return (u.user + u.system) / 1000;
};

/**
 * The game's thread, as a room sees it: a timer every 2 ms writes one row on the server's own
 * connection (busy_timeout 5 s, like a character save). Measures, between two ticks, the CPU time
 * this thread spent (`cpuMs`: something held it, whatever the OS did; the asserted figure) and the
 * wall time (`gapMs`, and the event loop's longest delay `loopMs`: these include the OS not running
 * us at all on a loaded machine); and the longest of those writes (`writeMs`, wall).
 */
function probe(db: Database.Database) {
  db.exec("CREATE TABLE IF NOT EXISTS bench_tick (n INTEGER)");
  const put = db.prepare("INSERT INTO bench_tick (n) VALUES (?)");
  const loop = monitorEventLoopDelay({ resolution: 1 });
  let write = 0;
  let gap = 0;
  let cpu = 0;
  let last = performance.now();
  let lastCpu = cpuNow();
  let ticks = 0;
  let stop = false;
  let skipWrites = false;
  const tick = () => {
    if (stop) return;
    const t = performance.now();
    const c = cpuNow();
    gap = Math.max(gap, t - last - 2);
    cpu = Math.max(cpu, c - lastCpu);
    if (process.env.BENCH_DEBUG && c - lastCpu > 10) console.log(`busy ${(c - lastCpu).toFixed(1)} ms cpu (${(t - last).toFixed(0)} ms wall) ending at ${t.toFixed(0)}`);
    if (!skipWrites) {
      put.run(ticks);
      write = Math.max(write, performance.now() - t);
    }
    ticks++;
    last = performance.now();
    lastCpu = cpuNow();
    setTimeout(tick, 2);
  };
  loop.enable();
  setTimeout(tick, 2);
  return {
    /** While another connection holds the write lock, a game write would wait for it whatever the funnel does: measure the loop only. */
    set locked(v: boolean) {
      skipWrites = v;
    },
    end() {
      stop = true;
      loop.disable();
      return { cpuMs: cpu, loopMs: loop.max / 1e6, writeMs: write, gapMs: gap, ticks };
    },
  };
}

type Probe = ReturnType<ReturnType<typeof probe>["end"]>;
const fmt = (p: Probe) => `busy ${p.cpuMs.toFixed(1)} ms CPU at most between ticks; wall: loop ${p.loopMs.toFixed(1)} ms, tick gap ${p.gapMs.toFixed(1)} ms, game write ${p.writeMs.toFixed(1)} ms (${p.ticks} ticks)`;

describe("the funnel never holds the game's thread, at the caps (review round three #1, #3)", () => {
  it("first write of the day, /stats, housekeeping and shutdown: free and with the database locked", { timeout: 600_000 }, async () => {
    Object.assign(FUNNEL_LIMITS, { workerBusyMs: 1_000, closeDeadlineMs: 1_500 });
    const dir = tempDir();
    server = await startAuthServer({ dir, adminClaimToken: CLAIM_TOKEN, extraRoutes: (app, a) => mountOps(app, { db: a.db, requireAdmin: a.requireAdmin, allowedOrigins: [ORIGIN] }) });
    const s = server;
    const db = s.accounts.db;
    const funnel = s.accounts.funnel!;
    expect(funnel).toBeTruthy();
    await s.accounts.housekeep(); // the boot housekeeping, on the empty database
    const owner = new Browser(s, "198.51.100.1");
    await owner.playToken();
    await owner.saveWithEmail("bench-owner@example.test");
    expect((await owner.fetch("/admin/claim", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: CLAIM_TOKEN }).toString() })).status).toBeLessThan(400);

    const now = Date.now();
    const days = FUNNEL_LIMITS.retentionDays + 3; // two cohort days are past the retention: the fold has work
    const t0 = performance.now();
    const filled = fill(join(dir, "game.db"), now, days);
    console.log(`filled game.db at scale ${SCALE}: ${filled.visitRows} visit rows, ${filled.accountRows} account rows, ${filled.errors} error reports in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
    const report: string[] = [];
    const push = report.push.bind(report);
    report.push = (...lines: string[]) => (lines.forEach((l) => console.log(`funnel bench: ${l}`)), push(...lines)); // as it goes, so a failure still shows what came before
    /** Every measured stall, checked at the end (so one run shows them all). */
    const stalls: [string, number][] = [];
    const stats = async () => {
      const res = await owner.fetch("/stats?format=json");
      const text = await res.text();
      expect(res.status, text.slice(0, 400)).toBe(200);
      return JSON.parse(text) as { funnel: { windows?: { all: { visits: Record<string, number> } }; error?: string } };
    };
    const visits = filled.visitRows / VISIT_STEPS.length;
    let t = 0;
    // The machine's own noise, for reading the wall-clock figures: the probe with nothing else running.
    let p = probe(db);
    await new Promise((ok) => setTimeout(ok, 3_000));
    let r = p.end();
    report.push(`idle (the machine's noise): ${fmt(r)}`);

    // 1. The day's first write: the budget starts from memory (old code: four COUNTs over today's rows).
    resetFunnelBudgets(db);
    t = performance.now();
    queueStep(db, { subject: "u:bench-first", step: "join" });
    const firstMs = performance.now() - t;
    report.push(`the day's first write: ${firstMs.toFixed(2)} ms`);
    stalls.push(["the day's first write", firstMs]);
    // ...and the worker's count, at boot, keeps a restart from resetting the caps.
    resetFunnelBudgets(db);
    await funnel.prime(now);
    expect(budgetState(db, now).visitRows.used).toBeGreaterThanOrEqual(Math.round(FUNNEL_LIMITS.visitRowsPerDay * SCALE * 0.9));

    // 2. /stats, the database free.
    p = probe(db);
    const free = await stats();
    r = p.end();
    report.push(`/stats, free: ${fmt(r)}; the worker's job ${funnel.lastJobMs.windows!.toFixed(0)} ms`);
    expect(free.funnel.windows?.all.visits.page).toBe(visits);
    expect(funnel.lastJobMs.windows!).toBeGreaterThan(4 * STALL_MS);
    stalls.push(["/stats free", r.cpuMs]);

    // 3. /stats and housekeeping with the write lock held by someone else (a backup, the metrics tool).
    const other = new Database(join(dir, "game.db"));
    other.pragma("busy_timeout = 0");
    other.exec("BEGIN IMMEDIATE");
    try {
      p = probe(db);
      p.locked = true;
      // The report /stats awaits, asked directly: the admin check in front of /stats records the
      // account's visit (db/accounts.ts ensureAccount, not the funnel), a write that waits for this lock.
      const locked = await funnel.windows(now);
      expect(locked.windows.all.visits.page).toBe(visits); // readers never wait in WAL
      const hk = await funnel.housekeep(now).catch((e: Error) => e);
      r = p.end();
      report.push(`/stats and housekeeping, locked: ${fmt(r)}; housekeeping ${hk instanceof Error ? `gave up: ${hk.message}` : "ran"}`);
      expect(hk).toBeInstanceOf(Error); // the worker waited workerBusyMs for the lock, then gave up until the next day
      stalls.push(["/stats and housekeeping locked", r.cpuMs]);
    } finally {
      other.exec("ROLLBACK");
    }

    // 4. Housekeeping, the database free: two cohort days folded, a month of error reports pruned.
    p = probe(db);
    const done = await funnel.housekeep(now);
    r = p.end();
    report.push(`housekeeping, free: ${fmt(r)}; the worker's job ${funnel.lastJobMs.housekeep!.toFixed(0)} ms (folded ${done.folded} day(s), pruned ${done.pruned} report(s); ${done.slices} write transactions, the longest held the lock ${done.maxHoldMs.toFixed(1)} ms CPU / ${done.maxHoldWallMs.toFixed(1)} ms wall)`);
    expect(done.folded).toBe(2);
    expect(done.pruned).toBeGreaterThan(0);
    expect(funnel.lastJobMs.housekeep!).toBeGreaterThan(4 * STALL_MS);
    stalls.push(["housekeeping free", r.cpuMs], ["housekeeping: the worker's longest hold of the write lock (CPU)", done.maxHoldMs]);
    const after = await stats();
    expect(after.funnel.windows?.all.visits.page).toBe(visits); // folded days still count, once

    // 5. Shutdown's flush of a full queue, free: written in slices.
    await closeFunnel(db); // nothing left over from the steps above
    Object.assign(FUNNEL_LIMITS, { accountRowsPerDay: 1e9, flushMs: 60_000 });
    resetFunnelBudgets(db);
    for (let i = 0; i < FUNNEL_LIMITS.maxPending; i++) queueStep(db, { subject: `u:close${i}`, step: "join" });
    p = probe(db);
    const flushed = await closeFunnel(db, 60_000); // free: everything is written, however loaded the machine
    r = p.end();
    report.push(`shutdown flush of ${FUNNEL_LIMITS.maxPending} rows, free: ${fmt(r)}; written ${flushed.written}, lost ${flushed.lost}`);
    expect(flushed).toEqual({ written: FUNNEL_LIMITS.maxPending, lost: 0 });
    stalls.push(["shutdown flush free", r.cpuMs]);

    // 6. The real shutdown with a full queue and the database locked: one deadline, the rest lost and logged once.
    for (let i = 0; i < FUNNEL_LIMITS.maxPending; i++) queueStep(db, { subject: `u:closelocked${i}`, step: "join" });
    const lostBefore = funnelQueueState().lost;
    const blocker = new Database(join(dir, "game.db"));
    blocker.exec("BEGIN IMMEDIATE");
    const warn = console.warn;
    const warnings: string[] = [];
    console.warn = (...a: unknown[]) => void warnings.push(a.join(" "));
    try {
      p = probe(db);
      p.locked = true;
      t = performance.now();
      server = null;
      await s.close(true);
      const closeMs = performance.now() - t;
      r = p.end();
      report.push(`shutdown with ${FUNNEL_LIMITS.maxPending} rows queued, locked: ${fmt(r)}; took ${closeMs.toFixed(0)} ms (deadline ${FUNNEL_LIMITS.closeDeadlineMs} ms)`);
      stalls.push(["shutdown locked", r.cpuMs]);
      expect(closeMs).toBeLessThan(FUNNEL_LIMITS.closeDeadlineMs + 3_000);
      expect(funnelQueueState().lost - lostBefore).toBe(FUNNEL_LIMITS.maxPending);
      expect(warnings.filter((w) => /not written at shutdown/.test(w))).toHaveLength(1);
    } finally {
      console.warn = warn;
      blocker.exec("ROLLBACK");
      blocker.close();
      other.close();
    }
    // What the old /stats did on this thread, for scale: the same report, synchronously (on a
    // connection of its own, after everything else, so its garbage can't land in a measurement).
    const ro = new Database(join(dir, "game.db"), { readonly: true });
    t = performance.now();
    const sync = reportWindows(ro, now);
    const syncMs = performance.now() - t;
    ro.close();
    rmSync(dir, { recursive: true, force: true });
    report.push(`the same report synchronously (what /stats did on this thread before): ${syncMs.toFixed(0)} ms`);
    console.log(`funnel at the caps (scale ${SCALE}), the game's thread:\n  ${report.join("\n  ")}`);
    expect(sync.windows.all.visits.page).toBe(visits);
    expect(syncMs, `FUNNEL_BENCH_SCALE=${SCALE} is too small to prove anything: the work itself must be far above the bound`).toBeGreaterThan(4 * STALL_MS);
    expect(stalls.filter(([, ms]) => ms >= STALL_MS)).toEqual([]);
  });
});
