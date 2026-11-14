// The first-session funnel (#85) and client error reports, measured by our own server: no third-party
// service, no personal data beyond what game.db already holds. A funnel row is the first time one
// subject reached one step: a character's account (`u:<userId>`, steps the server decides) or a
// browser visit (`v:<visitId>`, a visit the server issued: auth/visitToken.ts). Rows are never
// updated: the first time wins. Test accounts and AI agents are counted apart (`kind`, and
// test_account for accounts our tools flagged later).
//
// Bounded by construction (D-ship-6): every write goes through a daily budget per side (visits,
// accounts, errors) and a bounded queue that one timer flushes in a single transaction, off the room
// tick and the request; raw rows are kept FUNNEL_LIMITS.retentionDays and then folded into
// `funnel_day` aggregates. The raw tables therefore never hold more than the caps × retention.

import { stmt, type Db } from "./game-db.ts";

const DAY = 86_400_000;

export type FunnelKind = "person" | "test" | "agent";

/** Steps the server records per account (world/funnel.ts hooks them where the server decides them). */
export const ACCOUNT_STEPS = {
  /** The character was created by this join (not one from before the funnel): the cohort's entry. */
  created: "new",
  /** First join of a world room. */
  join: "join",
  /** First mission accepted. */
  mission: "mission",
  /** First creature killed (killing blow or credited). */
  kill: "kill",
  level2: "level2",
  level5: "level5",
  /** The tutorial finished (the server pays it) or skipped. */
  tutorialDone: "tutorial_done",
  /** A guest saved: recorded on the account it became. */
  saved: "saved",
  /** The first play session ended; value = its length in ms. */
  firstSession: "first_session",
  /** A session on a later UTC day than the first join; value = days after it. */
  back: "back",
} as const;

/**
 * Visit steps the server records itself: the visit was issued (`page`), its page joined a world room
 * with the visit's token (`join`, from /api/play), it sent an error report (`crash`).
 */
export const VISIT_SERVER_STEPS = ["page", "join", "crash"] as const;
/** Visit steps only the page knows (client net/beacon.ts): claims, kept apart from the server's. */
export const PAGE_STEPS = ["play", "pick", "world", "tutorial_done", "fallback", "boot_fail", "lost", "webgl_none", "narrow", "removed", "version"] as const;
export type PageStep = (typeof PAGE_STEPS)[number];
const PAGE_STEP_SET: ReadonlySet<string> = new Set(PAGE_STEPS);

/**
 * Tutorial steps come from the client's step list (game/onboardingSteps.ts, which the play lane owns
 * and may change), so the server takes any short lowercase id and orders them by the index the
 * client sends (`value`). Bounded per visit by MAX_TUTORIAL_STEPS.
 */
export const TUTORIAL_PREFIX = "tutorial:";
export const MAX_TUTORIAL_STEPS = 16;
const TUTORIAL_ID = /^[a-z][a-z0-9_]{0,23}$/;

/** The most rows one visit can ever hold: each server step, each page step and the tutorial's. */
export const MAX_VISIT_ROWS = VISIT_SERVER_STEPS.length + PAGE_STEPS.length + MAX_TUTORIAL_STEPS;

/** Is `step` one a page may report? */
export function pageStepAllowed(step: string): boolean {
  if (PAGE_STEP_SET.has(step)) return true;
  return step.startsWith(TUTORIAL_PREFIX) && TUTORIAL_ID.test(step.slice(TUTORIAL_PREFIX.length));
}

/**
 * The funnel's hard limits (D-ship-6). Per UTC day: visits issued, raw rows on each side, error
 * reports; past a cap the write is dropped (and /stats says the day was capped). Raw rows are kept
 * `retentionDays` (enough for the 7-day return check), error reports `errorRetentionDays`. The
 * queue holds at most `maxPending` writes between flushes. Worst case under a sustained flood the
 * raw table holds (visitRowsPerDay + accountRowsPerDay) × (retentionDays + 1) rows (~1.8 M, a few
 * hundred MB at most) and client_error errorsPerDay × errorRetentionDays; `funnel_day` grows by about
 * a hundred small rows a day. Mutable for tests.
 */
export const FUNNEL_LIMITS = {
  visitsPerDay: 5_000,
  visitRowsPerDay: 40_000,
  accountRowsPerDay: 40_000,
  errorsPerDay: 1_000,
  retentionDays: 21,
  errorRetentionDays: 30,
  maxPending: 5_000,
  flushMs: 1_000,
};

export interface FunnelRow {
  subject: string;
  step: string;
  at?: number;
  value?: number | null;
  detail?: string | null;
  kind?: FunnelKind;
}

export interface ClientErrorRow {
  at?: number;
  sig: string;
  message: string;
  stack: string;
  build: string;
  tier?: string | null;
  backend?: string | null;
  kind?: FunnelKind;
}

// ---- the daily budget ---------------------------------------------------------------------------

type Budgeted = "visits" | "visitRows" | "accountRows" | "errors";
interface Budget {
  day: number;
  used: Record<Budgeted, number>;
}
const budgets = new WeakMap<Db, Budget>();
const capOf = (what: Budgeted) =>
  what === "visits" ? FUNNEL_LIMITS.visitsPerDay : what === "visitRows" ? FUNNEL_LIMITS.visitRowsPerDay : what === "accountRows" ? FUNNEL_LIMITS.accountRowsPerDay : FUNNEL_LIMITS.errorsPerDay;

function budget(db: Db, now: number): Budget {
  const day = Math.floor(now / DAY);
  let b = budgets.get(db);
  if (!b || b.day !== day) {
    // A new day (or a restart): count what today already holds, so a restart doesn't reset the cap.
    const since = day * DAY;
    const n = (sql: string) => (stmt(db, sql).get(since) as { n: number }).n;
    b = {
      day,
      used: {
        visits: n("SELECT COUNT(*) AS n FROM funnel_step WHERE at >= ? AND step = 'page' AND subject LIKE 'v:%'"),
        visitRows: n("SELECT COUNT(*) AS n FROM funnel_step WHERE at >= ? AND subject LIKE 'v:%'"),
        accountRows: n("SELECT COUNT(*) AS n FROM funnel_step WHERE at >= ? AND subject LIKE 'u:%'"),
        errors: n("SELECT COUNT(*) AS n FROM client_error WHERE at >= ?"),
      },
    };
    for (const p of pending) if (p.db === db) b.used[p.kind === "error" ? "errors" : p.row.subject.startsWith("v:") ? "visitRows" : "accountRows"]++;
    budgets.set(db, b);
  }
  return b;
}

/** Spend one unit of today's budget; false (nothing spent) when the cap is reached. */
export function takeBudget(db: Db, what: Budgeted, now = Date.now()): boolean {
  const b = budget(db, now);
  if (b.used[what] >= capOf(what)) return false;
  b.used[what]++;
  return true;
}

/** Which caps today has reached (shown on /stats). */
export function budgetState(db: Db, now = Date.now()): Record<Budgeted, { used: number; cap: number }> {
  const b = budget(db, now);
  const out = {} as Record<Budgeted, { used: number; cap: number }>;
  for (const k of ["visits", "visitRows", "accountRows", "errors"] as const) out[k] = { used: b.used[k], cap: capOf(k) };
  return out;
}

/** Forget the in-memory budgets (tests that change FUNNEL_LIMITS). */
export function resetFunnelBudgets(db?: Db): void {
  if (db) budgets.delete(db);
}

// ---- the write queue ----------------------------------------------------------------------------

type Pending =
  | { db: Db; kind: "step"; row: { subject: string; step: string; at: number; value: number | null; detail: string | null; kind: FunnelKind } }
  | { db: Db; kind: "error"; row: Required<ClientErrorRow> };
const pending: Pending[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
let droppedWrites = 0;

function schedule(): void {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    flushFunnel();
  }, FUNNEL_LIMITS.flushMs);
  timer.unref?.();
}

function enqueue(p: Pending): boolean {
  if (pending.length >= FUNNEL_LIMITS.maxPending) {
    droppedWrites++;
    return false;
  }
  pending.push(p);
  schedule();
  return true;
}

function normalise(r: FunnelRow, now: number): Extract<Pending, { kind: "step" }>["row"] {
  return {
    subject: r.subject.slice(0, 48),
    step: r.step.slice(0, 40),
    at: r.at ?? now,
    value: typeof r.value === "number" && Number.isFinite(r.value) ? r.value : null,
    detail: typeof r.detail === "string" && r.detail ? r.detail.slice(0, 64) : null,
    kind: r.kind ?? "person",
  };
}

const INSERT_STEP = "INSERT OR IGNORE INTO funnel_step (subject, step, at, value, detail, kind) VALUES (?, ?, ?, ?, ?, ?)";
const INSERT_ERROR = "INSERT INTO client_error (at, sig, message, stack, build, tier, backend, kind) VALUES (?, ?, ?, ?, ?, ?, ?, ?)";

/**
 * Queue the first time a subject reached a step (written on the next flush, within FUNNEL_LIMITS.flushMs).
 * False when today's budget for its side is spent or the queue is full: the row is dropped.
 */
export function queueStep(db: Db, r: FunnelRow, now = Date.now()): boolean {
  const row = normalise(r, now);
  if (pendingIndex(db, row.subject, row.step) >= 0) return true; // already on its way
  if (pending.length >= FUNNEL_LIMITS.maxPending) {
    droppedWrites++;
    return false;
  }
  if (!takeBudget(db, row.subject.startsWith("v:") ? "visitRows" : "accountRows", now)) return false;
  return enqueue({ db, kind: "step", row });
}

/** Write a step now, inside the caller's transaction (the account link). Budgeted like queueStep. */
export function recordStep(db: Db, r: FunnelRow, now = Date.now()): boolean {
  const row = normalise(r, now);
  if (!takeBudget(db, row.subject.startsWith("v:") ? "visitRows" : "accountRows", now)) return false;
  return stmt(db, INSERT_STEP).run(row.subject, row.step, row.at, row.value, row.detail, row.kind).changes === 1;
}

/** Queue a client error report (budgeted per day). */
export function queueClientError(db: Db, e: ClientErrorRow, now = Date.now()): boolean {
  if (pending.length >= FUNNEL_LIMITS.maxPending) {
    droppedWrites++;
    return false;
  }
  if (!takeBudget(db, "errors", now)) return false;
  return enqueue({
    db,
    kind: "error",
    row: {
      at: e.at ?? now,
      sig: e.sig.slice(0, 64),
      message: e.message.slice(0, 300),
      stack: e.stack.slice(0, 600),
      build: e.build.slice(0, 40),
      tier: e.tier?.slice(0, 16) ?? null,
      backend: e.backend?.slice(0, 16) ?? null,
      kind: e.kind ?? "person",
    },
  });
}

/** Write what is queued (for one database, or all), each database in one transaction. Never throws. */
export function flushFunnel(only?: Db): number {
  if (!only && timer) {
    clearTimeout(timer);
    timer = null;
  }
  if (!pending.length) return 0;
  const take = only ? pending.filter((p) => p.db === only) : pending.slice();
  if (!take.length) return 0;
  const left = only ? pending.filter((p) => p.db !== only) : [];
  pending.length = 0;
  pending.push(...left);
  const byDb = new Map<Db, Pending[]>();
  for (const p of take) {
    let list = byDb.get(p.db);
    if (!list) byDb.set(p.db, (list = []));
    list.push(p);
  }
  let written = 0;
  for (const [db, list] of byDb) {
    if (!db.open) continue;
    try {
      db.transaction(() => {
        for (const p of list) {
          if (p.kind === "step") written += stmt(db, INSERT_STEP).run(p.row.subject, p.row.step, p.row.at, p.row.value, p.row.detail, p.row.kind).changes;
          else written += stmt(db, INSERT_ERROR).run(p.row.at, p.row.sig, p.row.message, p.row.stack, p.row.build, p.row.tier, p.row.backend, p.row.kind).changes;
        }
      })();
    } catch (err) {
      console.warn(`funnel: ${list.length} queued write(s) lost: ${(err as Error).message}`);
    }
  }
  if (pending.length) schedule();
  return written;
}

/** Writes waiting for the next flush, and writes dropped because the queue was full (since start). */
export function funnelQueueState(): { pending: number; dropped: number } {
  return { pending: pending.length, dropped: droppedWrites };
}

function pendingIndex(db: Db, subject: string, step: string): number {
  return pending.findIndex((p) => p.db === db && p.kind === "step" && p.row.subject === subject && p.row.step === step);
}

export function hasStep(db: Db, subject: string, step: string): boolean {
  return pendingIndex(db, subject, step) >= 0 || !!stmt(db, "SELECT 1 FROM funnel_step WHERE subject = ? AND step = ?").get(subject, step);
}

export function stepAt(db: Db, subject: string, step: string): number | null {
  const i = pendingIndex(db, subject, step);
  if (i >= 0) return (pending[i] as Extract<Pending, { kind: "step" }>).row.at;
  const r = stmt(db, "SELECT at FROM funnel_step WHERE subject = ? AND step = ?").get(subject, step) as { at: number } | undefined;
  return r?.at ?? null;
}

/** Rows a subject holds (written and queued), and of them tutorial steps: the per-visit bounds. */
export function subjectRowCount(db: Db, subject: string): { rows: number; tutorial: number } {
  const r = stmt(db, "SELECT COUNT(*) AS rows, COALESCE(SUM(step LIKE 'tutorial:%'), 0) AS tutorial FROM funnel_step WHERE subject = ?").get(subject) as { rows: number; tutorial: number };
  for (const p of pending) {
    if (p.db !== db || p.kind !== "step" || p.row.subject !== subject) continue;
    r.rows++;
    if (p.row.step.startsWith(TUTORIAL_PREFIX)) r.tutorial++;
  }
  return r;
}

export const accountSubject = (userId: string) => `u:${userId}`;
export const visitSubject = (visitId: string) => `v:${visitId}`;

/**
 * A guest saved (or signed into an existing account): its funnel rows follow it to the account; where
 * the account already has a step, the account's earlier row stays. Queued rows are written first.
 */
export function moveFunnel(db: Db, fromUserId: string, toUserId: string): void {
  flushFunnel(db);
  const from = accountSubject(fromUserId);
  const to = accountSubject(toUserId);
  stmt(db, "UPDATE OR IGNORE funnel_step SET subject = ? WHERE subject = ?").run(to, from);
  stmt(db, "DELETE FROM funnel_step WHERE subject = ?").run(from);
}

// ---- the report behind /stats ------------------------------------------------------------------

/** The effective kind on read: an account our tools flagged after its rows were written is a test one. */
const KIND_SQL = `CASE WHEN f.subject LIKE 'u:%' AND EXISTS (SELECT 1 FROM test_account t WHERE t.user_id = substr(f.subject, 3)) THEN 'test' ELSE f.kind END`;

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

/**
 * The funnel for subjects whose first row falls in [since, until), people only. A visit counts from
 * its issue; an account only if its character was created under the funnel (`new`: returning
 * characters are not new ones). Every KPI counts subjects that reached both of its steps.
 */
export function funnelReport(db: Db, since = 0, now = Date.now(), until = Number.MAX_SAFE_INTEGER): FunnelReport {
  flushFunnel(db); // queued rows count too
  const rows = stmt(
    db,
    `WITH f AS (SELECT subject, step, at, value, detail, ${KIND_SQL} AS kind FROM funnel_step f),
          cohort AS (SELECT subject FROM f GROUP BY subject HAVING MIN(at) >= ? AND MIN(at) < ? AND MIN(kind = 'person') = 1)
     SELECT f.subject, f.step, f.at, f.value, f.detail FROM f JOIN cohort USING (subject)`,
  ).all(since, until) as { subject: string; step: string; at: number; value: number | null; detail: string | null }[];
  const apartRows = stmt(
    db,
    `WITH f AS (SELECT subject, at, ${KIND_SQL} AS kind FROM funnel_step f)
     SELECT kind, COUNT(DISTINCT subject) AS n FROM f WHERE at >= ? AND at < ? AND kind != 'person' GROUP BY kind`,
  ).all(since, until) as { kind: string; n: number }[];
  const out: FunnelReport = {
    since,
    visits: {},
    accounts: {},
    tutorial: [],
    pairs: Object.fromEntries(PAIR_IDS.map((id) => [id, { num: 0, den: 0 }])),
    medianWorldS: null,
    worldN: 0,
    medianFirstSessionMs: null,
    firstSessionN: 0,
    backend: {},
    tier: {},
    fallback: {},
    apart: { test: 0, agent: 0 },
  };
  for (const a of apartRows) if (a.kind === "test" || a.kind === "agent") out.apart[a.kind] = a.n;
  const bump = (m: Record<string, number>, k: string) => (m[k] = (m[k] ?? 0) + 1);
  const pair = (id: (typeof PAIR_IDS)[number], den: boolean, num: boolean) => {
    if (!den) return;
    out.pairs[id]!.den++;
    if (num) out.pairs[id]!.num++;
  };
  const bySubject = new Map<string, Map<string, { at: number; value: number | null; detail: string | null }>>();
  for (const r of rows) {
    let steps = bySubject.get(r.subject);
    if (!steps) bySubject.set(r.subject, (steps = new Map()));
    steps.set(r.step, { at: r.at, value: r.value, detail: r.detail });
  }
  const worldS: number[] = [];
  const firstSession: number[] = [];
  const tutorial = new Map<string, { n: number; orders: number[] }>();
  for (const [subject, steps] of bySubject) {
    const has = (s: string) => steps.has(s);
    if (subject.startsWith("v:")) {
      for (const step of steps.keys()) bump(out.visits, step);
      for (const [step, s] of steps) {
        if (!step.startsWith(TUTORIAL_PREFIX)) continue;
        const id = step.slice(TUTORIAL_PREFIX.length);
        let t = tutorial.get(id);
        if (!t) tutorial.set(id, (t = { n: 0, orders: [] }));
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
        if (play && join && world.value !== null) worldS.push(world.value);
        const [backend, tier] = (world.detail ?? "").split("/");
        bump(out.backend, backend || "unknown");
        bump(out.tier, tier || "unknown");
      }
      const fb = steps.get("fallback");
      if (fb) bump(out.fallback, fb.detail || "unknown");
      continue;
    }
    // Accounts: new characters only.
    if (!has(ACCOUNT_STEPS.created)) continue;
    for (const step of steps.keys()) bump(out.accounts, step);
    const join = steps.get(ACCOUNT_STEPS.join);
    pair("tutorial", !!join, has(ACCOUNT_STEPS.tutorialDone));
    pair("mission", !!join, has(ACCOUNT_STEPS.mission));
    pair("level5", !!join, has(ACCOUNT_STEPS.level5));
    const back = steps.get(ACCOUNT_STEPS.back);
    pair("back_week", !!join && now - join.at >= 7 * DAY, !!back && back.value !== null && back.value <= 7);
    pair("level2_saved", has(ACCOUNT_STEPS.level2), has(ACCOUNT_STEPS.saved));
    const fs = steps.get(ACCOUNT_STEPS.firstSession);
    if (join && fs && fs.value !== null) firstSession.push(fs.value);
  }
  out.tutorial = [...tutorial.entries()]
    .map(([step, t]) => ({ step, n: t.n, order: median(t.orders) }))
    .sort((a, b) => (a.order ?? 99) - (b.order ?? 99) || b.n - a.n);
  out.medianWorldS = median(worldS);
  out.worldN = worldS.length;
  out.medianFirstSessionMs = median(firstSession);
  out.firstSessionN = firstSession.length;
  return out;
}

// ---- retention: old cohort days folded into funnel_day ----------------------------------------------

const dayKey = (day: number) => new Date(day * DAY).toISOString().slice(0, 10);

/**
 * Fold every cohort day older than the retention into `funnel_day` and delete its raw rows (daily
 * housekeeping). A subject belongs to the day of its first row; its later rows go with it.
 */
export function rollupFunnel(db: Db, now = Date.now()): number {
  flushFunnel(db);
  const cutoff = Math.floor(now / DAY) * DAY - FUNNEL_LIMITS.retentionDays * DAY;
  const days = (stmt(db, "SELECT DISTINCT first / 86400000 AS d FROM (SELECT MIN(at) AS first FROM funnel_step GROUP BY subject) WHERE first < ? ORDER BY d").all(cutoff) as { d: number }[]).map((r) => Math.floor(r.d));
  const put = stmt(db, "INSERT INTO funnel_day (day, metric, num, den, value) VALUES (?, ?, ?, ?, ?) ON CONFLICT (day, metric) DO UPDATE SET num = num + excluded.num, den = den + excluded.den, value = COALESCE(excluded.value, value)");
  for (const d of days) {
    const since = d * DAY;
    const r = funnelReport(db, since, now, since + DAY);
    const key = dayKey(d);
    db.transaction(() => {
      for (const [id, p] of Object.entries(r.pairs)) if (p.den) put.run(key, `pair:${id}`, p.num, p.den, null);
      for (const [step, n] of Object.entries(r.visits)) put.run(key, `visit:${step}`, n, 0, null);
      for (const [step, n] of Object.entries(r.accounts)) put.run(key, `account:${step}`, n, 0, null);
      for (const t of r.tutorial) put.run(key, `tutorial:${t.step}`, t.n, 0, t.order);
      if (r.worldN) put.run(key, "median:world", r.worldN, 0, r.medianWorldS);
      if (r.firstSessionN) put.run(key, "median:first_session", r.firstSessionN, 0, r.medianFirstSessionMs);
      if (r.apart.test) put.run(key, "apart:test", r.apart.test, 0, null);
      if (r.apart.agent) put.run(key, "apart:agent", r.apart.agent, 0, null);
      stmt(db, "DELETE FROM funnel_step WHERE subject IN (SELECT subject FROM funnel_step GROUP BY subject HAVING MIN(at) >= ? AND MIN(at) < ?)").run(since, since + DAY);
    })();
  }
  return days.length;
}

/** The folded days as one report (everything before the retained raw rows). */
export function storedReport(db: Db): FunnelReport {
  const rows = stmt(db, "SELECT metric, num, den, value FROM funnel_day").all() as { metric: string; num: number; den: number; value: number | null }[];
  const out = funnelReportEmpty(0);
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

function funnelReportEmpty(since: number): FunnelReport {
  return { since, visits: {}, accounts: {}, tutorial: [], pairs: Object.fromEntries(PAIR_IDS.map((id) => [id, { num: 0, den: 0 }])), medianWorldS: null, worldN: 0, medianFirstSessionMs: null, firstSessionN: 0, backend: {}, tier: {}, fallback: {}, apart: { test: 0, agent: 0 } };
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

/** People's client errors since `since`, grouped by kind (newest first), and the reports kept apart. */
export function clientErrorReport(db: Db, since = 0, limit = 20): { total: number; kinds: ClientErrorSummary[]; apart: number } {
  const rows = stmt(
    db,
    `SELECT sig, message, stack, build, tier, backend, at FROM client_error WHERE at >= ? AND kind = 'person' ORDER BY at DESC`,
  ).all(since) as { sig: string; message: string; stack: string; build: string; tier: string | null; backend: string | null; at: number }[];
  const apart = (stmt(db, "SELECT COUNT(*) AS n FROM client_error WHERE at >= ? AND kind != 'person'").get(since) as { n: number }).n;
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

export function pruneClientErrors(db: Db, olderThanMs = FUNNEL_LIMITS.errorRetentionDays * DAY, now = Date.now()): number {
  flushFunnel(db);
  return stmt(db, "DELETE FROM client_error WHERE at < ?").run(now - olderThanMs).changes;
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

/** The funnel over the last day, 7 days and all time (retained rows plus folded days): what /stats shows and `pnpm metrics --funnel` reads. */
export function funnelWindows(db: Db, now = Date.now()) {
  flushFunnel(db);
  const windows = { day: funnelReport(db, now - DAY, now), week: funnelReport(db, now - 7 * DAY, now), all: mergeReports(funnelReport(db, 0, now), storedReport(db)) };
  return {
    windows,
    kpis: { day: funnelKpis(windows.day), week: funnelKpis(windows.week), all: funnelKpis(windows.all) },
    errors: { day: clientErrorReport(db, now - DAY), week: clientErrorReport(db, now - 7 * DAY), all: clientErrorReport(db, 0) },
    limits: { today: budgetState(db, now), queue: funnelQueueState(), retentionDays: FUNNEL_LIMITS.retentionDays, errorRetentionDays: FUNNEL_LIMITS.errorRetentionDays },
  };
}
export type FunnelWindows = ReturnType<typeof funnelWindows>;
