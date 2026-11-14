// The first-session funnel (#85) and client error reports, measured by our own server: no third-party
// service, no personal data beyond what game.db already holds. A funnel row is the first time one
// subject reached one step: a character's account (`u:<userId>`, steps the server decides) or a
// browser visit (`v:<visitId>`, a visit the server issued: auth/visitToken.ts). Rows are never
// updated: the first time wins. Test accounts and AI agents are counted apart (`kind`, and
// test_account for accounts our tools flagged later).
//
// Bounded by construction (D-ship-6): every write goes through a daily budget per side (visits,
// accounts, errors) and a bounded queue that one timer flushes in small transactions, off the room
// tick and the request; raw rows are kept FUNNEL_LIMITS.retentionDays (longer than a visit lives) and
// then folded into `funnel_day` aggregates: a visit's rows are deleted, an account's are kept and
// marked `folded` (a character can come back any time; their number is bounded by accounts, and a
// deleted account's go). The raw tables therefore never hold more than the caps × retention plus a
// few rows per existing account.
//
// The game server's thread (D-sec3-1, review round three): this file is everything the funnel does
// there, and none of it scans: the budget is counted in memory, the queue writes in slices that never
// wait for a lock, the ingest's checks are primary-key lookups, shutdown has one deadline. Reports
// (/stats), the daily fold and the error pruning read and rewrite whole tables, so they run in the
// funnel's worker thread on its own connection (db/funnelService.ts, db/funnelWorker.ts,
// db/funnelReport.ts). The synchronous funnelWindows / funnelReport / rollupFunnel /
// pruneClientErrors below are for tools (`pnpm metrics --funnel`) and tests only.
//
// FUNNEL_ENABLED=0 (funnelConfig) turns all of it off: nothing is queued or stored, no timer starts.

import { stmt, type Db } from "./game-db.ts";
import { DAY, FUNNEL_LIMITS, TUTORIAL_PREFIX, accountSubject, funnelConfig, type FunnelKind } from "./funnelRules.ts";
import { cohortReport, foldFunnel, pruneErrors, reportWindows, type FunnelReport } from "./funnelReport.ts";

export * from "./funnelRules.ts";
export * from "./funnelReport.ts";

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

/**
 * Today's budget. Never a query (it may run inside a room tick; review round three): a day this
 * process starts (a new day, the first write, a test's reset) starts from what it has queued, and at
 * boot the worker's count of what today already holds is added (primeFunnelBudget), so a restart
 * doesn't reset the cap.
 */
function budget(db: Db, now: number): Budget {
  const day = Math.floor(now / DAY);
  let b = budgets.get(db);
  if (!b || b.day !== day) {
    b = { day, used: { visits: 0, visitRows: 0, accountRows: 0, errors: 0 } };
    for (const p of pending) if (p.db === db) b.used[p.kind === "error" ? "errors" : p.row.subject.startsWith("v:") ? "visitRows" : "accountRows"]++;
    budgets.set(db, b);
  }
  return b;
}

/** Add what today already holds in storage (counted by the worker at boot: db/funnelService.ts) to today's budget. */
export function primeFunnelBudget(db: Db, stored: { day: number } & Record<Budgeted, number>, now = Date.now()): void {
  const b = budget(db, now);
  if (b.day !== stored.day) return; // counted yesterday: today starts from the queue
  for (const k of ["visits", "visitRows", "accountRows", "errors"] as const) b.used[k] += stored[k];
}

/** Spend one unit of today's budget; false (nothing spent) when the cap is reached. */
export function takeBudget(db: Db, what: Budgeted, now = Date.now()): boolean {
  if (!funnelConfig.enabled) return false;
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
//
// The room tick and the requests only queue (memory). One timer writes the queue in small
// transactions (FUNNEL_LIMITS.flushSlice rows) on a connection told not to wait for a lock
// (busy_timeout 0), and yields after flushBudgetMs: a locked or slow database makes it stop at once
// and try again later (backoff doubling from flushMs), so the simulation never waits on funnel storage
// for more than a slice (review round two, finding 5). A row that can't be written stays queued; after
// flushTries attempts (about four minutes of backoff) it is dropped. Every retry and drop is counted
// (funnelQueueState, /stats), so an accepted step is never lost without a trace (finding 7). Shutdown
// (closeFunnel) writes the same way, never waiting for a lock, until one overall deadline; what is
// left then is counted lost and logged once (review round three, #3).

type Pending = (
  | { db: Db; kind: "step"; row: { subject: string; step: string; at: number; value: number | null; detail: string | null; kind: FunnelKind } }
  | { db: Db; kind: "error"; row: Required<ClientErrorRow> }
) & { tries: number };
const pending: Pending[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
/** Writes refused because the queue was full (the caller was told), retried attempts, dropped rows. */
const queueStats = { dropped: 0, retries: 0, lost: 0, lastError: "" };
/** Consecutive failed flush attempts (the backoff). */
let failures = 0;

function schedule(ms = FUNNEL_LIMITS.flushMs): void {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    flushFunnel();
  }, ms);
  timer.unref?.();
}

function enqueue(p: Omit<Pending, "tries">): boolean {
  if (pending.length >= FUNNEL_LIMITS.maxPending) {
    queueStats.dropped++;
    return false;
  }
  pending.push({ ...p, tries: 0 } as Pending);
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
  if (!funnelConfig.enabled) return false;
  const row = normalise(r, now);
  if (pendingIndex(db, row.subject, row.step) >= 0) return true; // already on its way
  if (pending.length >= FUNNEL_LIMITS.maxPending) {
    queueStats.dropped++;
    return false;
  }
  if (!takeBudget(db, row.subject.startsWith("v:") ? "visitRows" : "accountRows", now)) return false;
  return enqueue({ db, kind: "step", row });
}

/** Write a step now, inside the caller's transaction (the account link). Budgeted like queueStep. */
export function recordStep(db: Db, r: FunnelRow, now = Date.now()): boolean {
  if (!funnelConfig.enabled) return false;
  const row = normalise(r, now);
  if (!takeBudget(db, row.subject.startsWith("v:") ? "visitRows" : "accountRows", now)) return false;
  return stmt(db, INSERT_STEP).run(row.subject, row.step, row.at, row.value, row.detail, row.kind).changes === 1;
}

/** Queue a client error report (budgeted per day). */
export function queueClientError(db: Db, e: ClientErrorRow, now = Date.now()): boolean {
  if (!funnelConfig.enabled) return false;
  if (pending.length >= FUNNEL_LIMITS.maxPending) {
    queueStats.dropped++;
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

function writeRow(db: Db, p: Pending): number {
  if (p.kind === "step") return stmt(db, INSERT_STEP).run(p.row.subject, p.row.step, p.row.at, p.row.value, p.row.detail, p.row.kind).changes;
  return stmt(db, INSERT_ERROR).run(p.row.at, p.row.sig, p.row.message, p.row.stack, p.row.build, p.row.tier, p.row.backend, p.row.kind).changes;
}

/** A lock held by another connection (or this one's open transaction): try again later, nothing is wrong with the rows. */
const locked = (err: unknown) => /^SQLITE_(BUSY|LOCKED)/.test(String((err as { code?: unknown }).code ?? ""));

/** Rows that can't be written any more: counted as lost (with the reason) and logged (unless the caller logs once for all: shutdown). */
function drop(rows: Pending[], err: unknown, gone: Set<Pending>, quiet = false): void {
  if (!rows.length) return;
  queueStats.lastError = String((err as Error)?.message ?? err).slice(0, 120);
  queueStats.lost += rows.length;
  for (const p of rows) gone.add(p);
  if (!quiet) console.warn(`funnel: ${rows.length} queued write(s) dropped: ${queueStats.lastError}`);
}

/** One failed attempt for `rows`: each spends a try; out of tries it is dropped, else it waits (a retry). */
function attemptFailed(rows: Pending[], err: unknown, gone: Set<Pending>): void {
  queueStats.lastError = String((err as Error)?.message ?? err).slice(0, 120);
  const out: Pending[] = [];
  for (const p of rows) if (++p.tries >= FUNNEL_LIMITS.flushTries) out.push(p);
  if (out.length < rows.length) queueStats.retries++;
  drop(out, err, gone);
}

/** Take `gone` out of the queue in one pass. */
function forget(gone: Set<Pending>): void {
  if (!gone.size) return;
  const keep = pending.filter((p) => !gone.has(p));
  pending.length = 0;
  pending.push(...keep);
}

/**
 * Write what is queued (for one database, or all) in slices of FUNNEL_LIMITS.flushSlice rows, each
 * its own transaction, without ever waiting for a lock: a lock stops the attempt at once (every
 * waiting row of that database spends one of its flushTries and the next attempt backs off), and
 * after flushBudgetMs it stops and goes on after the event loop had its turn. `final` (shutdown's
 * attempts, closeFunnel): the same, but no try is spent and nothing is scheduled; a row that fails
 * for another reason than a lock is lost quietly (closeFunnel logs once). Never throws. Returns the
 * rows written.
 */
export function flushFunnel(only?: Db, opts: { final?: boolean } = {}): number {
  if (!only && timer) {
    clearTimeout(timer);
    timer = null;
  }
  if (!pending.length) {
    failures = 0;
    return 0;
  }
  const final = !!opts.final;
  const started = performance.now();
  const gone = new Set<Pending>();
  let written = 0;
  let stalled = false;
  let outOfTime = false;
  const dbs = only ? [only] : [...new Set(pending.map((p) => p.db))];
  for (const db of dbs) {
    const mine = pending.filter((p) => p.db === db);
    if (!mine.length) continue;
    if (!db.open) {
      drop(mine, new Error("database closed"), gone, final);
      continue;
    }
    const wait = db.pragma("busy_timeout", { simple: true }) as number;
    db.pragma("busy_timeout = 0");
    try {
      for (let i = 0; i < mine.length; i += FUNNEL_LIMITS.flushSlice) {
        // At least one slice per attempt, however slow the machine is; then the time budget.
        if (written + gone.size > 0 && performance.now() - started >= FUNNEL_LIMITS.flushBudgetMs) {
          outOfTime = true;
          break;
        }
        const part = mine.slice(i, i + FUNNEL_LIMITS.flushSlice);
        try {
          let n = 0;
          db.transaction(() => {
            for (const p of part) n += writeRow(db, p);
          })();
          written += n;
          for (const p of part) gone.add(p);
        } catch (err) {
          if (locked(err)) {
            if (final) queueStats.lastError = String((err as Error)?.message ?? err).slice(0, 120);
            else attemptFailed(mine.slice(i), err, gone);
            stalled = true;
            break; // this database is busy: the rest waits for the next attempt
          }
          // Not a lock: write row by row; a row that fails spends a try (at shutdown it is lost).
          for (const p of part) {
            try {
              written += writeRow(db, p);
              gone.add(p);
            } catch (e) {
              if (final) drop([p], e, gone, true);
              else attemptFailed([p], e, gone);
            }
          }
          if (part.some((p) => !gone.has(p))) stalled = true;
        }
      }
    } finally {
      if (db.open) db.pragma(`busy_timeout = ${wait}`);
    }
    if (outOfTime) break;
  }
  forget(gone);
  if (final) return written;
  failures = stalled ? failures + 1 : 0;
  if (pending.length) schedule(stalled ? Math.min(FUNNEL_LIMITS.flushMs * 2 ** (failures - 1), 30_000) : outOfTime ? 0 : FUNNEL_LIMITS.flushMs);
  return written;
}

/**
 * Shutdown (review round three, #3): write what is queued for `db` the way the timer does (slices,
 * no lock wait, never more than flushBudgetMs at a time), trying again every few milliseconds, until
 * the queue is empty or `deadlineMs` has passed overall. What is left then can't be written: counted
 * as lost and logged once. The game's thread is never held longer than one attempt.
 */
export async function closeFunnel(db: Db, deadlineMs = FUNNEL_LIMITS.closeDeadlineMs): Promise<{ written: number; lost: number }> {
  const end = performance.now() + deadlineMs;
  const lostBefore = queueStats.lost;
  const mine = () => pending.some((p) => p.db === db);
  let written = 0;
  while (mine() && db.open) {
    written += flushFunnel(db, { final: true });
    const left = end - performance.now();
    if (!mine() || left <= 0) break;
    await new Promise((ok) => setTimeout(ok, Math.min(20, left)));
  }
  const left = pending.filter((p) => p.db === db);
  if (left.length) {
    const gone = new Set<Pending>();
    drop(left, new Error(queueStats.lastError || "not written by the shutdown deadline"), gone, true);
    forget(gone);
  }
  const lost = queueStats.lost - lostBefore;
  if (lost) console.warn(`funnel: ${lost} queued write(s) not written at shutdown (deadline ${deadlineMs} ms), counted lost: ${queueStats.lastError}`);
  return { written, lost };
}

/**
 * The queue since start: writes waiting, refused because the queue was full (the caller knew),
 * flush attempts that found the database locked or failing and kept their rows (retries), and
 * accepted rows dropped after FUNNEL_LIMITS.flushTries attempts (lost), with the last error.
 */
export function funnelQueueState(): { pending: number; dropped: number; retries: number; lost: number; lastError: string } {
  return { pending: pending.length, ...queueStats };
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


/**
 * A guest saved (or signed into an existing account): its funnel rows follow it to the account; where
 * the account already has a step, the account's earlier row stays. Queued rows are written first.
 */
export function moveFunnel(db: Db, fromUserId: string, toUserId: string): void {
  const from = accountSubject(fromUserId);
  const to = accountSubject(toUserId);
  // Queued rows move in memory (no flush: the queue never waits for a lock); a step the account
  // already has keeps its row (INSERT OR IGNORE, and the duplicate in the queue goes).
  for (let i = pending.length - 1; i >= 0; i--) {
    const p = pending[i]!;
    if (p.db !== db || p.kind !== "step" || p.row.subject !== from) continue;
    if (pendingIndex(db, to, p.row.step) >= 0) pending.splice(i, 1);
    else p.row.subject = to;
  }
  stmt(db, "UPDATE OR IGNORE funnel_step SET subject = ? WHERE subject = ?").run(to, from);
  stmt(db, "DELETE FROM funnel_step WHERE subject = ?").run(from);
}


// ---- for tools and tests: the reports on the caller's thread ---------------------------------------

/** Today's caps and the queue, added to a report on the game's thread (cheap: memory only). */
export function withLimits<T extends { limits: { retentionDays: number; errorRetentionDays: number } }>(r: T, db: Db, now = Date.now()) {
  return { ...r, limits: { ...r.limits, today: budgetState(db, now), queue: funnelQueueState() } };
}

/** The funnel over the last day, 7 days and all time, synchronously. Tools and tests only: the server's /stats asks the worker (db/funnelService.ts). */
export function funnelWindows(db: Db, now = Date.now()) {
  flushFunnel(db); // queued rows count too
  return withLimits(reportWindows(db, now), db, now);
}
export type FunnelWindows = ReturnType<typeof funnelWindows>;

/** One cohort window, synchronously (tests). */
export function funnelReport(db: Db, since = 0, now = Date.now(), until = Number.MAX_SAFE_INTEGER): FunnelReport {
  flushFunnel(db);
  return cohortReport(db, since, now, until);
}

/** Fold old cohort days, synchronously (tests; the server's daily housekeeping runs it in the worker). */
export function rollupFunnel(db: Db, now = Date.now()): number {
  flushFunnel(db);
  return foldFunnel(db, now, { retentionDays: FUNNEL_LIMITS.retentionDays });
}

/** Delete old client error reports, synchronously (tests; the server's housekeeping runs it in the worker). */
export function pruneClientErrors(db: Db, olderThanMs = FUNNEL_LIMITS.errorRetentionDays * DAY, now = Date.now()): number {
  flushFunnel(db);
  return pruneErrors(db, olderThanMs, now);
}
