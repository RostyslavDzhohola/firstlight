// The funnel's reports and housekeeping (#85): everything that reads or rewrites funnel storage in
// bulk. On the game server this runs only in the funnel's worker thread (db/funnelWorker.ts, its own
// connection to game.db; D-sec3-1), never on the thread that runs the rooms; tools (`pnpm metrics
// --funnel`) and tests call it directly.
//
// Linear by construction (review round three, #1): one pass over funnel_step in key order hands each
// subject to every window it belongs to (the old cohort join was quadratic: 49 s for 160,000 rows),
// and every write is a small transaction (FUNNEL_LIMITS.workerSliceRows rows) followed by a pause, so
// the game's own writers never wait on one for longer than a slice.
//
// Folding (retention): cohort days older than the retention go into `funnel_day`. A day's totals and
// its marker row (`meta:folded`) are written in one transaction, so the newest marked day is the
// watermark: a subject whose first row is on or before it is folded, whatever is left of its raw rows.
// Removing those rows (visits) or marking them (accounts) happens after, in slices, and can stop and
// resume anywhere: nothing is counted twice and nothing is lost.

import type Database from "better-sqlite3";
import { ACCOUNT_STEPS, DAY, FUNNEL_LIMITS, TUTORIAL_PREFIX, VISIT_LIFE_DAYS, type FunnelKind } from "./funnelRules.ts";

type Db = Database.Database;

const statements = new WeakMap<Db, Map<string, Database.Statement>>();
/** A cached prepared statement (this module's own: the worker has no game-db.ts state). */
function q(db: Db, sql: string): Database.Statement {
  let m = statements.get(db);
  if (!m) statements.set(db, (m = new Map()));
  let s = m.get(sql);
  if (!s) m.set(sql, (s = db.prepare(sql)));
  return s;
}

const hasTable = (db: Db, name: string) => !!q(db, "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
/** Migration 13's `folded` column (a game.db from before it is read by `pnpm metrics --funnel-db`). */
const hasFolded = (db: Db) => !!q(db, "SELECT 1 FROM pragma_table_info('funnel_step') WHERE name = 'folded'").get();

export interface FunnelStepCount {
  step: string;
  n: number;
  /** For tutorial steps: the client's index of the step (its order in the tutorial). */
  order: number | null;
}

/** A KPI's numerator and denominator: subjects that reached both steps, over those that reached the first. */
export interface Pair {
  num: number;
  den: number;
}

export interface FunnelReport {
  since: number;
  /** Visits (browsers) whose first row is in the window, by step. */
  visits: Record<string, number>;
  /** New characters (accounts with a `new` row) whose first row is in the window, by step. */
  accounts: Record<string, number>;
  /** Tutorial steps in the tutorial's order (visits). */
  tutorial: FunnelStepCount[];
  /** The KPIs' pairs by KPI id (funnelKpis). */
  pairs: Record<string, Pair>;
  /** Median seconds from Play to the world on screen (the page's timing, visits the server saw join), and how many. */
  medianWorldS: number | null;
  worldN: number;
  /** Median length of the first play session (new characters), and how many. */
  medianFirstSessionMs: number | null;
  firstSessionN: number;
  /** Renderer backend / tier the visits that got in picked (`world` detail, "webgpu/medium"). */
  backend: Record<string, number>;
  tier: Record<string, number>;
  /** Renderer fallbacks by reason. */
  fallback: Record<string, number>;
  /** Subjects by kind in the window: people's are the figures, the others are counted apart. */
  apart: { test: number; agent: number };
}

const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
};

/** The KPIs' pair ids, in funnelKpis' order. */
const PAIR_IDS = ["gets_in", "gets_in_page", "tutorial", "mission", "level5", "back_week", "level2_saved", "crash_free"] as const;

export function emptyReport(since: number): FunnelReport {
  return { since, visits: {}, accounts: {}, tutorial: [], pairs: Object.fromEntries(PAIR_IDS.map((id) => [id, { num: 0, den: 0 }])), medianWorldS: null, worldN: 0, medianFirstSessionMs: null, firstSessionN: 0, backend: {}, tier: {}, fallback: {}, apart: { test: 0, agent: 0 } };
}

// ---- one subject at a time ----------------------------------------------------------------------

type Steps = Map<string, { at: number; value: number | null; detail: string | null }>;

/** One subject's rows, read in key order. */
interface Subject {
  subject: string;
  steps: Steps;
  /** Its first row: the cohort day it belongs to. */
  first: number;
  /** test: one of our accounts or a test visit; agent: an AI agent took part; else a person. */
  kind: FunnelKind;
  rows: number;
  /** Some row is marked folded (migration 13), or some row is not. */
  folded: boolean;
  unfolded: boolean;
}

/**
 * Every subject in funnel_step, one at a time, in one pass (the primary key's order, so a subject's
 * rows arrive together and memory holds one subject). An account our tools flagged after its rows
 * were written is a test one.
 */
function eachSubject(db: Db, fn: (s: Subject) => void): void {
  const tests = new Set(hasTable(db, "test_account") ? (q(db, "SELECT user_id AS id FROM test_account").all() as { id: string }[]).map((r) => r.id) : []);
  const rows = q(db, `SELECT subject, step, at, value, detail, kind, ${hasFolded(db) ? "folded" : "0"} AS folded FROM funnel_step ORDER BY subject`).iterate() as IterableIterator<{ subject: string; step: string; at: number; value: number | null; detail: string | null; kind: string; folded: number }>;
  let cur = null as Subject | null;
  for (const r of rows) {
    if (cur?.subject !== r.subject) {
      if (cur) fn(cur);
      cur = { subject: r.subject, steps: new Map(), first: r.at, kind: r.subject.startsWith("u:") && tests.has(r.subject.slice(2)) ? "test" : "person", rows: 0, folded: false, unfolded: false };
    }
    cur.steps.set(r.step, { at: r.at, value: r.value, detail: r.detail });
    cur.rows++;
    if (r.at < cur.first) cur.first = r.at;
    if (r.kind === "test") cur.kind = "test";
    else if (r.kind === "agent" && cur.kind === "person") cur.kind = "agent";
    if (r.folded) cur.folded = true;
    else cur.unfolded = true;
  }
  if (cur) fn(cur);
}

/** The newest cohort day folded into funnel_day (its `meta:folded` marker, or any older day's totals), as a day number. */
function foldedThrough(db: Db): number {
  if (!hasTable(db, "funnel_day")) return -Infinity;
  const d = (q(db, "SELECT MAX(day) AS d FROM funnel_day").get() as { d: string | null }).d;
  const t = d ? Date.parse(`${d}T00:00:00Z`) : NaN;
  return Number.isFinite(t) ? Math.floor(t / DAY) : -Infinity;
}

/** Is this subject's cohort day folded already (its figures live in funnel_day)? */
const isFolded = (s: Subject, through: number) => s.folded || Math.floor(s.first / DAY) <= through;

/** A report being built: subjects are added one by one, then finish() gives the report. */
interface Acc {
  out: FunnelReport;
  now: number;
  worldS: number[];
  firstSession: number[];
  tutorial: Map<string, { n: number; orders: number[] }>;
  subjects: number;
}

const newAcc = (since: number, now: number): Acc => ({ out: emptyReport(since), now, worldS: [], firstSession: [], tutorial: new Map(), subjects: 0 });

const bump = (m: Record<string, number>, k: string) => (m[k] = (m[k] ?? 0) + 1);

/**
 * One subject into a report: people only (test visits and accounts and AI agents are counted apart).
 * A visit counts from its issue; an account only if its character was created under the funnel
 * (`new`: returning characters are not new ones). Every KPI counts subjects that reached both of its steps.
 */
function addSubject(acc: Acc, subject: string, steps: Steps, kind: FunnelKind): void {
  const out = acc.out;
  acc.subjects++;
  if (kind !== "person") {
    out.apart[kind]++;
    return;
  }
  const pair = (id: (typeof PAIR_IDS)[number], den: boolean, num: boolean) => {
    if (!den) return;
    out.pairs[id]!.den++;
    if (num) out.pairs[id]!.num++;
  };
  const has = (s: string) => steps.has(s);
  if (subject.startsWith("v:")) {
    for (const [step, s] of steps) {
      bump(out.visits, step);
      if (!step.startsWith(TUTORIAL_PREFIX)) continue;
      const id = step.slice(TUTORIAL_PREFIX.length);
      let t = acc.tutorial.get(id);
      if (!t) acc.tutorial.set(id, (t = { n: 0, orders: [] }));
      t.n++;
      if (s.value !== null) t.orders.push(s.value);
    }
    const play = has("play");
    const join = has("join");
    pair("gets_in", play, join); // the headline: the server saw the visit join a world
    pair("gets_in_page", play, has("world")); // the page's own report of the world on screen
    pair("crash_free", join, has("crash"));
    const world = steps.get("world");
    if (world) {
      if (play && join && world.value !== null) acc.worldS.push(world.value);
      const [backend, tier] = (world.detail ?? "").split("/");
      bump(out.backend, backend || "unknown");
      bump(out.tier, tier || "unknown");
    }
    const fb = steps.get("fallback");
    if (fb) bump(out.fallback, fb.detail || "unknown");
    return;
  }
  // Accounts: new characters only.
  if (!has(ACCOUNT_STEPS.created)) return;
  for (const step of steps.keys()) bump(out.accounts, step);
  const join = steps.get(ACCOUNT_STEPS.join);
  pair("tutorial", !!join, has(ACCOUNT_STEPS.tutorialDone));
  pair("mission", !!join, has(ACCOUNT_STEPS.mission));
  pair("level5", !!join, has(ACCOUNT_STEPS.level5));
  const back = steps.get(ACCOUNT_STEPS.back);
  pair("back_week", !!join && acc.now - join.at >= 7 * DAY, !!back && back.value !== null && back.value <= 7);
  pair("level2_saved", has(ACCOUNT_STEPS.level2), has(ACCOUNT_STEPS.saved));
  const fs = steps.get(ACCOUNT_STEPS.firstSession);
  if (join && fs && fs.value !== null) acc.firstSession.push(fs.value);
}

function finish(acc: Acc): FunnelReport {
  const out = acc.out;
  out.tutorial = [...acc.tutorial.entries()].map(([step, t]) => ({ step, n: t.n, order: median(t.orders) })).sort((a, b) => (a.order ?? 99) - (b.order ?? 99) || b.n - a.n);
  out.medianWorldS = median(acc.worldS);
  out.worldN = acc.worldS.length;
  out.medianFirstSessionMs = median(acc.firstSession);
  out.firstSessionN = acc.firstSession.length;
  return out;
}

// ---- reports --------------------------------------------------------------------------------------

/** A window of cohorts: subjects whose first row falls in [since, until). */
export interface CohortWindow {
  since: number;
  until?: number;
}

/** The funnel for several windows at once, in one pass over the raw rows (folded days are left out: storedReport has them). */
export function cohortReports(db: Db, windows: readonly CohortWindow[], now = Date.now()): FunnelReport[] {
  const through = foldedThrough(db);
  const accs = windows.map((w) => newAcc(w.since, now));
  eachSubject(db, (s) => {
    if (isFolded(s, through)) return;
    for (let i = 0; i < windows.length; i++) {
      const w = windows[i]!;
      if (s.first >= w.since && s.first < (w.until ?? Number.MAX_SAFE_INTEGER)) addSubject(accs[i]!, s.subject, s.steps, s.kind);
    }
  });
  return accs.map(finish);
}

/** The funnel for subjects whose first row falls in [since, until), people only (see addSubject). */
export function cohortReport(db: Db, since = 0, now = Date.now(), until = Number.MAX_SAFE_INTEGER): FunnelReport {
  return cohortReports(db, [{ since, until }], now)[0]!;
}

/** Retention settings a report states and housekeeping uses (the game thread's FUNNEL_LIMITS, passed to the worker). */
export interface RetentionLimits {
  retentionDays: number;
  errorRetentionDays: number;
}

const retentionNow = (): RetentionLimits => ({ retentionDays: FUNNEL_LIMITS.retentionDays, errorRetentionDays: FUNNEL_LIMITS.errorRetentionDays });

/** The funnel over the last day, 7 days and all time (retained rows plus folded days), the KPIs and the client errors: what /stats shows. */
export function reportWindows(db: Db, now = Date.now(), limits: RetentionLimits = retentionNow()) {
  const [day, week, all] = cohortReports(db, [{ since: now - DAY }, { since: now - 7 * DAY }, { since: 0 }], now);
  const windows = { day: day!, week: week!, all: mergeReports(all!, storedReport(db)) };
  return {
    windows,
    kpis: { day: funnelKpis(windows.day), week: funnelKpis(windows.week), all: funnelKpis(windows.all) },
    errors: { day: clientErrorReport(db, now - DAY), week: clientErrorReport(db, now - 7 * DAY), all: clientErrorReport(db, 0) },
    limits: { retentionDays: limits.retentionDays, errorRetentionDays: limits.errorRetentionDays },
  };
}
export type ReportWindows = ReturnType<typeof reportWindows>;

/** Today's stored counts behind the daily caps (the worker, once at boot: auth/accounts.ts primes the budget with them). */
export function todayCounts(db: Db, now = Date.now()): { day: number; visits: number; visitRows: number; accountRows: number; errors: number } {
  const day = Math.floor(now / DAY);
  const since = day * DAY;
  const n = (sql: string) => (q(db, sql).get(since) as { n: number }).n;
  return {
    day,
    visits: n("SELECT COUNT(*) AS n FROM funnel_step WHERE at >= ? AND step = 'page' AND subject LIKE 'v:%'"),
    visitRows: n("SELECT COUNT(*) AS n FROM funnel_step WHERE at >= ? AND subject LIKE 'v:%'"),
    accountRows: n("SELECT COUNT(*) AS n FROM funnel_step WHERE at >= ? AND subject LIKE 'u:%'"),
    errors: n("SELECT COUNT(*) AS n FROM client_error WHERE at >= ?"),
  };
}

// ---- housekeeping: small transactions -----------------------------------------------------------

/** How housekeeping writes: rows per transaction and the pause after each (the worker passes FUNNEL_LIMITS'; direct calls write without pausing). */
export interface SliceOpts {
  sliceRows?: number;
  pauseMs?: number;
}

const sleeper = new Int32Array(new SharedArrayBuffer(4));
/** A synchronous pause (the worker has nothing else to do; never used on the game's thread: pauseMs is 0 there). */
function pause(ms: number | undefined): void {
  if (ms && ms > 0) Atomics.wait(sleeper, 0, 0, ms);
}

/**
 * Run `fn` on each item in IMMEDIATE transactions of at most `sliceRows` rows (each item says how
 * many rows it touches; one item per transaction at least), pausing after each, and asking for a
 * passive checkpoint now and then so the WAL stays small for the game's own commits.
 */
function sliced<T>(db: Db, items: readonly (readonly [T, number])[], fn: (item: T) => void, opts: SliceOpts): number {
  const max = Math.max(1, opts.sliceRows ?? FUNNEL_LIMITS.workerSliceRows);
  let i = 0;
  let slices = 0;
  while (i < items.length) {
    const start = i;
    let rows = 0;
    while (i < items.length && (i === start || rows + items[i]![1] <= max)) rows += items[i++]![1];
    db.transaction(() => {
      for (let k = start; k < i; k++) fn(items[k]![0]);
    }).immediate();
    if (++slices % 25 === 0) db.pragma("wal_checkpoint(PASSIVE)");
    pause(opts.pauseMs);
  }
  return i;
}

/** Delete client error reports older than `olderThanMs`, in slices. Returns how many. */
export function pruneErrors(db: Db, olderThanMs = FUNNEL_LIMITS.errorRetentionDays * DAY, now = Date.now(), opts: SliceOpts = {}): number {
  const ids = (q(db, "SELECT id FROM client_error WHERE at < ?").all(now - olderThanMs) as { id: number }[]).map((r) => [r.id, 1] as const);
  const del = q(db, "DELETE FROM client_error WHERE id = ?");
  return sliced(db, ids, (id) => del.run(id), opts);
}

const dayKey = (day: number) => new Date(day * DAY).toISOString().slice(0, 10);

/**
 * Fold every cohort day older than the retention into `funnel_day`; returns the days folded. A
 * subject belongs to the day of its first row; its later rows go with it. A subject that can still
 * act is never forgotten (review round two, #8), by construction: raw rows are kept longer than a
 * visit can take steps (VISIT_LIFE_DAYS, whatever the limits say), so a folded visit's rows are
 * deleted; an account can come back any time, so a folded account's rows stay, marked `folded` (its
 * first join and steps stay known; reports leave it out: its day is in funnel_day), until the account
 * no longer exists. One read pass, then each day's totals and marker in one small transaction, then
 * the clean-up in slices (see the file's head: it can stop anywhere and resume).
 */
export function foldFunnel(db: Db, now = Date.now(), opts: SliceOpts & { retentionDays?: number } = {}): number {
  const keepDays = Math.max(opts.retentionDays ?? FUNNEL_LIMITS.retentionDays, VISIT_LIFE_DAYS);
  const cutoff = Math.floor(now / DAY) - keepDays; // cohort days before this one are folded
  const through = foldedThrough(db);
  const days = new Map<number, Acc>();
  const visits: [string, number][] = [];
  const accounts: [string, number, boolean][] = [];
  eachSubject(db, (s) => {
    const day = Math.floor(s.first / DAY);
    const folded = isFolded(s, through);
    if (!folded && day >= cutoff) return; // still kept raw
    if (!folded) {
      let acc = days.get(day);
      if (!acc) days.set(day, (acc = newAcc(day * DAY, now)));
      addSubject(acc, s.subject, s.steps, s.kind);
    }
    if (s.subject.startsWith("v:")) visits.push([s.subject, s.rows]);
    else accounts.push([s.subject, s.rows, s.unfolded]);
  });
  const put = q(db, "INSERT INTO funnel_day (day, metric, num, den, value) VALUES (?, ?, ?, ?, ?) ON CONFLICT (day, metric) DO UPDATE SET num = num + excluded.num, den = den + excluded.den, value = COALESCE(excluded.value, value)");
  const folded: number[] = [];
  for (const d of [...days.keys()].sort((a, b) => a - b)) {
    const acc = days.get(d)!;
    const r = finish(acc);
    const key = dayKey(d);
    db.transaction(() => {
      // Under the write lock: another folder (a tool, a test) may have folded this day since the read.
      if (foldedThrough(db) >= d) return;
      folded.push(d);
      for (const [id, p] of Object.entries(r.pairs)) if (p.den) put.run(key, `pair:${id}`, p.num, p.den, null);
      for (const [step, n] of Object.entries(r.visits)) put.run(key, `visit:${step}`, n, 0, null);
      for (const [step, n] of Object.entries(r.accounts)) put.run(key, `account:${step}`, n, 0, null);
      for (const t of r.tutorial) put.run(key, `tutorial:${t.step}`, t.n, 0, t.order);
      if (r.worldN) put.run(key, "median:world", r.worldN, 0, r.medianWorldS);
      if (r.firstSessionN) put.run(key, "median:first_session", r.firstSessionN, 0, r.medianFirstSessionMs);
      if (r.apart.test) put.run(key, "apart:test", r.apart.test, 0, null);
      if (r.apart.agent) put.run(key, "apart:agent", r.apart.agent, 0, null);
      put.run(key, "meta:folded", acc.subjects, 0, null); // the watermark: this day is folded
    }).immediate();
    pause(opts.pauseMs);
  }
  // Clean-up: a folded visit's rows go; a folded account's are marked, and go once the account is gone.
  const del = q(db, "DELETE FROM funnel_step WHERE subject = ?");
  sliced(db, visits, (subject) => del.run(subject), opts);
  const exists = q(db, "SELECT 1 FROM account WHERE user_id = ?");
  const gone: [string, number][] = [];
  const live: [string, number][] = [];
  for (const [subject, rows, unmarked] of accounts) {
    if (!exists.get(subject.slice(2))) gone.push([subject, rows]);
    else if (unmarked) live.push([subject, rows]);
  }
  sliced(db, gone, (subject) => del.run(subject), opts);
  if (hasFolded(db)) {
    const mark = q(db, "UPDATE funnel_step SET folded = 1 WHERE subject = ? AND folded = 0");
    sliced(db, live, (subject) => mark.run(subject), opts);
  }
  return folded.length;
}

// ---- the folded days, and two reports as one ------------------------------------------------------

/** The folded days as one report (everything before the retained raw rows). */
export function storedReport(db: Db): FunnelReport {
  // A game.db opened read-only from before migration 12 (`pnpm metrics --funnel-db`) has no folded days.
  if (!hasTable(db, "funnel_day")) return emptyReport(0);
  const rows = q(db, "SELECT metric, num, den, value FROM funnel_day").all() as { metric: string; num: number; den: number; value: number | null }[];
  const out = emptyReport(0); // `meta:` rows (the fold watermark) are bookkeeping, not figures
  const worlds: [number, number][] = [];
  const sessions: [number, number][] = [];
  const tutorial = new Map<string, { n: number; orders: [number, number][] }>();
  for (const r of rows) {
    const [kind, name] = [r.metric.slice(0, r.metric.indexOf(":")), r.metric.slice(r.metric.indexOf(":") + 1)];
    if (kind === "pair") {
      const p = (out.pairs[name] ??= { num: 0, den: 0 });
      p.num += r.num;
      p.den += r.den;
    } else if (kind === "visit") out.visits[name] = (out.visits[name] ?? 0) + r.num;
    else if (kind === "account") out.accounts[name] = (out.accounts[name] ?? 0) + r.num;
    else if (kind === "tutorial") {
      let t = tutorial.get(name);
      if (!t) tutorial.set(name, (t = { n: 0, orders: [] }));
      t.n += r.num;
      if (r.value !== null) t.orders.push([r.value, r.num]);
    } else if (kind === "median" && r.value !== null) (name === "world" ? worlds : sessions).push([r.value, r.num]);
    else if (kind === "apart" && (name === "test" || name === "agent")) out.apart[name] += r.num;
  }
  out.tutorial = [...tutorial].map(([step, t]) => ({ step, n: t.n, order: weightedMedian(t.orders) }));
  out.medianWorldS = weightedMedian(worlds);
  out.worldN = worlds.reduce((a, w) => a + w[1], 0);
  out.medianFirstSessionMs = weightedMedian(sessions);
  out.firstSessionN = sessions.reduce((a, w) => a + w[1], 0);
  return out;
}

/** The median of values each standing for `weight` subjects (folded days keep their medians, not every value). */
function weightedMedian(xs: [number, number][]): number | null {
  const total = xs.reduce((a, x) => a + x[1], 0);
  if (!total) return null;
  const s = [...xs].sort((a, b) => a[0] - b[0]);
  let seen = 0;
  for (const [v, w] of s) {
    seen += w;
    if (seen > total / 2) return v;
  }
  return s[s.length - 1]![0];
}

/** Two reports over disjoint cohorts as one (the retained raw rows and the folded days). Medians are weighted medians. */
export function mergeReports(a: FunnelReport, b: FunnelReport): FunnelReport {
  const add = (x: Record<string, number>, y: Record<string, number>) => {
    const o = { ...x };
    for (const [k, n] of Object.entries(y)) o[k] = (o[k] ?? 0) + n;
    return o;
  };
  const pairs: Record<string, Pair> = {};
  for (const id of new Set([...Object.keys(a.pairs), ...Object.keys(b.pairs)])) pairs[id] = { num: (a.pairs[id]?.num ?? 0) + (b.pairs[id]?.num ?? 0), den: (a.pairs[id]?.den ?? 0) + (b.pairs[id]?.den ?? 0) };
  const tut = new Map<string, { n: number; orders: [number, number][] }>();
  for (const t of [...a.tutorial, ...b.tutorial]) {
    let m = tut.get(t.step);
    if (!m) tut.set(t.step, (m = { n: 0, orders: [] }));
    m.n += t.n;
    if (t.order !== null) m.orders.push([t.order, t.n]);
  }
  const med = (x: number | null, xn: number, y: number | null, yn: number) => weightedMedian([...(x === null ? [] : [[x, xn] as [number, number]]), ...(y === null ? [] : [[y, yn] as [number, number]])]);
  return {
    since: Math.min(a.since, b.since),
    visits: add(a.visits, b.visits),
    accounts: add(a.accounts, b.accounts),
    tutorial: [...tut].map(([step, t]) => ({ step, n: t.n, order: weightedMedian(t.orders) })).sort((x, y) => (x.order ?? 99) - (y.order ?? 99) || y.n - x.n),
    pairs,
    medianWorldS: med(a.medianWorldS, a.worldN, b.medianWorldS, b.worldN),
    worldN: a.worldN + b.worldN,
    medianFirstSessionMs: med(a.medianFirstSessionMs, a.firstSessionN, b.medianFirstSessionMs, b.firstSessionN),
    firstSessionN: a.firstSessionN + b.firstSessionN,
    backend: add(a.backend, b.backend),
    tier: add(a.tier, b.tier),
    fallback: add(a.fallback, b.fallback),
    apart: { test: a.apart.test + b.apart.test, agent: a.apart.agent + b.apart.agent },
  };
}

// ---- client errors ------------------------------------------------------------------------------

export interface ClientErrorSummary {
  sig: string;
  message: string;
  stack: string;
  build: string;
  count: number;
  lastAt: number;
  /** "webgpu/medium: 3, webgl2/low: 1" */
  where: string;
}

// ---- client errors ------------------------------------------------------------------------------

export interface ClientErrorSummary {
  sig: string;
  message: string;
  stack: string;
  build: string;
  count: number;
  lastAt: number;
  /** "webgpu/medium: 3, webgl2/low: 1" */
  where: string;
}

/** People's client errors since `since`, grouped by kind (newest first), and the reports kept apart. */
export function clientErrorReport(db: Db, since = 0, limit = 20): { total: number; kinds: ClientErrorSummary[]; apart: number } {
  const rows = q(
    db,
    `SELECT sig, message, stack, build, tier, backend, at FROM client_error WHERE at >= ? AND kind = 'person' ORDER BY at DESC`,
  ).all(since) as { sig: string; message: string; stack: string; build: string; tier: string | null; backend: string | null; at: number }[];
  const apart = (q(db, "SELECT COUNT(*) AS n FROM client_error WHERE at >= ? AND kind != 'person'").get(since) as { n: number }).n;
  const by = new Map<string, ClientErrorSummary & { places: Map<string, number> }>();
  for (const r of rows) {
    let s = by.get(r.sig);
    if (!s) by.set(r.sig, (s = { sig: r.sig, message: r.message, stack: r.stack, build: r.build, count: 0, lastAt: r.at, where: "", places: new Map() }));
    s.count++;
    const place = `${r.backend ?? "?"}/${r.tier ?? "?"}`;
    s.places.set(place, (s.places.get(place) ?? 0) + 1);
  }
  const kinds = [...by.values()]
    .sort((a, b) => b.count - a.count || b.lastAt - a.lastAt)
    .slice(0, limit)
    .map(({ places, ...s }) => ({ ...s, where: [...places].map(([k, n]) => `${k}: ${n}`).join(", ") }));
  return { total: rows.length, kinds, apart };
}

// ---- the #85 launch KPIs from a report (shared by /stats and `pnpm metrics`) ------------------------

export interface FunnelKpi {
  id: string;
  /** #85's wording. */
  label: string;
  /** "80%", "under 30 s" … */
  target: string;
  unit: "share" | "s" | "ms";
  /** Who vouches for the figure: the server decided both steps, or the numerator is the page's report. */
  source: "server" | "page";
  /** The figure (a share 0–1, seconds or ms), null with no data. */
  value: number | null;
  num?: number;
  den?: number;
  /** Target met (null: no data). */
  ok: boolean | null;
}

export function funnelKpis(r: FunnelReport): FunnelKpi[] {
  const share = (id: (typeof PAIR_IDS)[number], label: string, target: number, source: FunnelKpi["source"], below = false): FunnelKpi => {
    const { num, den } = r.pairs[id] ?? { num: 0, den: 0 };
    const value = den ? num / den : null;
    return { id, label, target: below ? (target === 0 ? "none" : `${Math.round(target * 100)}% or less`) : `${Math.round(target * 100)}%`, unit: "share", source, value, num, den, ok: value === null ? null : below ? value <= target : value >= target };
  };
  return [
    share("gets_in", "Play presses that reach the world", 0.8, "server"),
    share("gets_in_page", "Play presses that show the world (the page's report)", 0.8, "page"),
    { id: "gets_in_s", label: "Median Play → world (the page's timing)", target: "under 30 s", unit: "s", source: "page", value: r.medianWorldS, num: r.worldN, ok: r.medianWorldS === null ? null : r.medianWorldS < 30 },
    share("tutorial", "New characters that finish the tutorial", 0.6, "server"),
    share("mission", "New characters that take a mission", 0.4, "server"),
    { id: "first_session_ms", label: "Median first session", target: "over 10 min", unit: "ms", source: "server", value: r.medianFirstSessionMs, num: r.firstSessionN, ok: r.medianFirstSessionMs === null ? null : r.medianFirstSessionMs > 600_000 },
    share("level5", "New characters that reach level 5", 0.25, "server"),
    share("back_week", "Back within a week (characters at least 7 days old)", 0.15, "server"),
    share("level2_saved", "Level-2 players who save", 0.3, "server"),
    share("crash_free", "Visits in the world that hit a client error", 0, "page", true),
  ];
}

/** The funnel's steps in their order, for the step tables (visits, then accounts). */
export const VISIT_FUNNEL: readonly string[] = ["page", "play", "pick", "join", "world", "tutorial_done"];
export const ACCOUNT_FUNNEL: readonly string[] = [ACCOUNT_STEPS.join, ACCOUNT_STEPS.kill, ACCOUNT_STEPS.mission, ACCOUNT_STEPS.level2, ACCOUNT_STEPS.tutorialDone, ACCOUNT_STEPS.level5, ACCOUNT_STEPS.saved, ACCOUNT_STEPS.firstSession, ACCOUNT_STEPS.back];

