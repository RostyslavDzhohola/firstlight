// The first-session funnel's rules (#85, db/funnel.ts): its steps, subjects and hard limits. Shared by
// the game server's thread (the ingest and the write queue, db/funnel.ts) and the funnel's worker
// (reports and housekeeping, db/funnelReport.ts via db/funnelWorker.ts), so it holds no state.

import { VISIT_TOKEN } from "../auth/visitToken.ts";

export const DAY = 86_400_000;

/**
 * The longest a visit can still take steps after its first row (review round two, #8): renewable for
 * RENEW_MS after it began, each token live for TOKEN_TTL_MS, plus the minute of clock slack visitLive
 * allows. Raw rows are kept at least this long, so a visit whose rows are folded can never act again.
 */
export const VISIT_LIFE_DAYS = Math.ceil((VISIT_TOKEN.RENEW_MS + VISIT_TOKEN.TOKEN_TTL_MS + 60_000) / DAY);

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
 * `retentionDays` (longer than a visit can act, VISIT_LIFE_DAYS), error reports `errorRetentionDays`.
 * The queue holds at most `maxPending` writes between flushes. Worst case under a sustained flood the
 * raw table holds visitRowsPerDay × (retentionDays + 1) visit rows (~1.3 M) plus the account rows,
 * which stay while the account exists (at most one per account and step, ~10 per account), and
 * client_error errorsPerDay × errorRetentionDays; `funnel_day` grows by about a hundred small rows a
 * day. Mutable for tests.
 */
export const FUNNEL_LIMITS = {
  visitsPerDay: 5_000,
  visitRowsPerDay: 40_000,
  accountRowsPerDay: 40_000,
  errorsPerDay: 1_000,
  /** Longer than a visit lives (VISIT_LIFE_DAYS); rollupFunnel never uses less whatever this says. */
  retentionDays: VISIT_LIFE_DAYS + 1,
  errorRetentionDays: 30,
  maxPending: 5_000,
  flushMs: 1_000,
  /** Rows per write transaction, and the time one flush may hold the event loop before it yields. */
  flushSlice: 200,
  flushBudgetMs: 4,
  /** Flush attempts a queued row gets (each failed one waits twice as long) before it is dropped. */
  flushTries: 12,
  /** Shutdown: the whole final flush gets this long (slices as above, never a lock wait), then what is left is lost (review round three, #3). */
  closeDeadlineMs: 2_000,
  /** How long /stats waits for the worker's report before it says so (the worker keeps going). */
  reportTimeoutMs: 60_000,
  /** The worker's write transactions (housekeeping): at most this many rows each, a pause after each (at least 4× the time it held the lock), and how long one may wait for the lock. */
  workerSliceRows: 200,
  workerPauseMs: 10,
  workerBusyMs: 5_000,
};

/** The on/off switch (FUNNEL_ENABLED, default on): off, nothing is taken, queued or stored and no timer or worker starts. Set at boot (auth/accounts.ts). */
export const funnelConfig = { enabled: true };

export const accountSubject = (userId: string) => `u:${userId}`;
export const visitSubject = (visitId: string) => `v:${visitId}`;

