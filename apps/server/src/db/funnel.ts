// The first-session funnel (#85) and client error reports, measured by our own server: no third-party
// service, no personal data beyond what game.db already holds. A funnel row is the first time one
// subject reached one step: a character's account (`u:<userId>`, steps the server decides) or a
// browser visit (`v:<visitId>`, a random id the page keeps; steps only the client knows, sent to
// /api/funnel). Rows are never updated: the first time wins. Test accounts and AI agents are counted
// apart (`kind`, and test_account for accounts our tools flagged later).

import { stmt, type Db } from "./game-db.ts";

const DAY = 86_400_000;

export type FunnelKind = "person" | "test" | "agent";

/** Steps the server records per account (world/funnel.ts hooks them where the server decides them). */
export const ACCOUNT_STEPS = {
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

/** Steps a visit's page reports (client net/beacon.ts). `tutorial:<step id>` is open-ended (below). */
export const VISIT_STEPS = ["page", "play", "pick", "world", "tutorial_done", "fallback", "boot_fail", "lost", "crash", "webgl_none", "narrow", "removed", "version"] as const;
export type VisitStep = (typeof VISIT_STEPS)[number];
const VISIT_STEP_SET: ReadonlySet<string> = new Set(VISIT_STEPS);

/**
 * Tutorial steps come from the client's step list (game/onboardingSteps.ts, which the play lane owns
 * and may change), so the server takes any short lowercase id and orders them by the index the
 * client sends (`value`). Bounded per visit by MAX_TUTORIAL_STEPS.
 */
export const TUTORIAL_PREFIX = "tutorial:";
export const MAX_TUTORIAL_STEPS = 24;
const TUTORIAL_ID = /^[a-z][a-z0-9_]{0,23}$/;

/** Is `step` one a visit may report? */
export function visitStepAllowed(step: string): boolean {
  if (VISIT_STEP_SET.has(step)) return true;
  return step.startsWith(TUTORIAL_PREFIX) && TUTORIAL_ID.test(step.slice(TUTORIAL_PREFIX.length));
}

export interface FunnelRow {
  subject: string;
  step: string;
  at?: number;
  value?: number | null;
  detail?: string | null;
  kind?: FunnelKind;
}

/** Record the first time a subject reached a step. True if this was the first time. */
export function recordStep(db: Db, r: FunnelRow): boolean {
  const value = typeof r.value === "number" && Number.isFinite(r.value) ? r.value : null;
  const detail = typeof r.detail === "string" && r.detail ? r.detail.slice(0, 64) : null;
  return (
    stmt(db, "INSERT OR IGNORE INTO funnel_step (subject, step, at, value, detail, kind) VALUES (?, ?, ?, ?, ?, ?)").run(
      r.subject,
      r.step.slice(0, 40),
      r.at ?? Date.now(),
      value,
      detail,
      r.kind ?? "person",
    ).changes === 1
  );
}

export function hasStep(db: Db, subject: string, step: string): boolean {
  return !!stmt(db, "SELECT 1 FROM funnel_step WHERE subject = ? AND step = ?").get(subject, step);
}

export function stepAt(db: Db, subject: string, step: string): number | null {
  const r = stmt(db, "SELECT at FROM funnel_step WHERE subject = ? AND step = ?").get(subject, step) as { at: number } | undefined;
  return r?.at ?? null;
}

/** How many tutorial steps a visit has recorded (the per-visit bound). */
export function tutorialStepCount(db: Db, subject: string): number {
  return (stmt(db, "SELECT COUNT(*) AS n FROM funnel_step WHERE subject = ? AND step LIKE 'tutorial:%'").get(subject) as { n: number }).n;
}

export const accountSubject = (userId: string) => `u:${userId}`;
export const visitSubject = (visitId: string) => `v:${visitId}`;

/**
 * A guest saved (or signed into an existing account): its funnel rows follow it to the account; where
 * the account already has a step, the account's earlier row stays.
 */
export function moveFunnel(db: Db, fromUserId: string, toUserId: string): void {
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

export interface FunnelReport {
  since: number;
  /** Visits (browsers) whose first row is in the window, by step. */
  visits: Record<string, number>;
  /** Accounts whose first row is in the window, by step. */
  accounts: Record<string, number>;
  /** Tutorial steps in the tutorial's order (visits). */
  tutorial: FunnelStepCount[];
  /** Median seconds from Play to the world on screen (visits that got in). */
  medianWorldS: number | null;
  /** Median length of the first play session (accounts). */
  medianFirstSessionMs: number | null;
  /** Accounts that joined at least 7 days ago, and those of them back within 7 days. */
  weekOld: number;
  weekBack: number;
  /** Accounts that reached level 2, and those of them that saved. */
  level2: number;
  level2Saved: number;
  /** Renderer backend / tier the visits that got in picked (`world` detail, "webgpu/medium"). */
  backend: Record<string, number>;
  tier: Record<string, number>;
  /** Renderer fallbacks by reason. */
  fallback: Record<string, number>;
  /** Rows by kind in the window: people's are the figures, the others are counted apart. */
  apart: { test: number; agent: number };
}

const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
};

/** The funnel for subjects whose first row falls in [since, now], people only. */
export function funnelReport(db: Db, since = 0, now = Date.now()): FunnelReport {
  const rows = stmt(
    db,
    `WITH f AS (SELECT subject, step, at, value, detail, ${KIND_SQL} AS kind FROM funnel_step f),
          cohort AS (SELECT subject FROM f GROUP BY subject HAVING MIN(at) >= ? AND MAX(kind = 'person') = 1 AND MIN(kind = 'person') = 1)
     SELECT f.subject, f.step, f.at, f.value, f.detail FROM f JOIN cohort USING (subject)`,
  ).all(since) as { subject: string; step: string; at: number; value: number | null; detail: string | null }[];
  const apartRows = stmt(
    db,
    `WITH f AS (SELECT subject, at, ${KIND_SQL} AS kind FROM funnel_step f)
     SELECT kind, COUNT(DISTINCT subject) AS n FROM f WHERE at >= ? AND kind != 'person' GROUP BY kind`,
  ).all(since) as { kind: string; n: number }[];
  const out: FunnelReport = {
    since,
    visits: {},
    accounts: {},
    tutorial: [],
    medianWorldS: null,
    medianFirstSessionMs: null,
    weekOld: 0,
    weekBack: 0,
    level2: 0,
    level2Saved: 0,
    backend: {},
    tier: {},
    fallback: {},
    apart: { test: 0, agent: 0 },
  };
  for (const a of apartRows) if (a.kind === "test" || a.kind === "agent") out.apart[a.kind] = a.n;
  const bump = (m: Record<string, number>, k: string) => (m[k] = (m[k] ?? 0) + 1);
  const worldS: number[] = [];
  const firstSession: number[] = [];
  const tutorial = new Map<string, { n: number; orders: number[] }>();
  const bySubject = new Map<string, Map<string, { at: number; value: number | null }>>();
  for (const r of rows) {
    const visit = r.subject.startsWith("v:");
    bump(visit ? out.visits : out.accounts, r.step);
    let steps = bySubject.get(r.subject);
    if (!steps) bySubject.set(r.subject, (steps = new Map()));
    steps.set(r.step, { at: r.at, value: r.value });
    if (visit && r.step.startsWith(TUTORIAL_PREFIX)) {
      const id = r.step.slice(TUTORIAL_PREFIX.length);
      let t = tutorial.get(id);
      if (!t) tutorial.set(id, (t = { n: 0, orders: [] }));
      t.n++;
      if (r.value !== null) t.orders.push(r.value);
    }
    if (visit && r.step === "world") {
      if (r.value !== null) worldS.push(r.value);
      const [backend, tier] = (r.detail ?? "").split("/");
      bump(out.backend, backend || "unknown");
      bump(out.tier, tier || "unknown");
    }
    if (visit && r.step === "fallback") bump(out.fallback, r.detail || "unknown");
    if (!visit && r.step === ACCOUNT_STEPS.firstSession && r.value !== null) firstSession.push(r.value);
  }
  for (const steps of bySubject.values()) {
    const join = steps.get(ACCOUNT_STEPS.join);
    if (join && now - join.at >= 7 * DAY) {
      out.weekOld++;
      const back = steps.get(ACCOUNT_STEPS.back);
      if (back && back.value !== null && back.value <= 7) out.weekBack++;
    }
    if (steps.has(ACCOUNT_STEPS.level2)) {
      out.level2++;
      if (steps.has(ACCOUNT_STEPS.saved)) out.level2Saved++;
    }
  }
  out.tutorial = [...tutorial.entries()]
    .map(([step, t]) => ({ step, n: t.n, order: median(t.orders) }))
    .sort((a, b) => (a.order ?? 99) - (b.order ?? 99) || b.n - a.n);
  out.medianWorldS = median(worldS);
  out.medianFirstSessionMs = median(firstSession);
  return out;
}

// ---- client errors ------------------------------------------------------------------------------

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

export function recordClientError(db: Db, e: ClientErrorRow): void {
  stmt(db, "INSERT INTO client_error (at, sig, message, stack, build, tier, backend, kind) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
    e.at ?? Date.now(),
    e.sig.slice(0, 64),
    e.message.slice(0, 300),
    e.stack.slice(0, 600),
    e.build.slice(0, 40),
    e.tier?.slice(0, 16) ?? null,
    e.backend?.slice(0, 16) ?? null,
    e.kind ?? "person",
  );
}

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

export function pruneClientErrors(db: Db, olderThanMs = 90 * DAY, now = Date.now()): number {
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
  /** The figure (a share 0–1, seconds or ms), null with no data. */
  value: number | null;
  num?: number;
  den?: number;
  /** Target met (null: no data). */
  ok: boolean | null;
}

export function funnelKpis(r: FunnelReport): FunnelKpi[] {
  const share = (id: string, label: string, target: number, num: number, den: number, below = false): FunnelKpi => {
    const value = den ? num / den : null;
    return { id, label, target: below ? `${Math.round(target * 100)}% or less` : `${Math.round(target * 100)}%`, unit: "share", value, num, den, ok: value === null ? null : below ? value <= target : value >= target };
  };
  const v = (k: string) => r.visits[k] ?? 0;
  const a = (k: string) => r.accounts[k] ?? 0;
  const joined = a(ACCOUNT_STEPS.join);
  return [
    share("gets_in", "Play presses that reach the world", 0.8, v("world"), v("play")),
    { id: "gets_in_s", label: "Median Play → world", target: "under 30 s", unit: "s", value: r.medianWorldS, ok: r.medianWorldS === null ? null : r.medianWorldS < 30 },
    share("tutorial", "New characters that finish the tutorial", 0.6, a(ACCOUNT_STEPS.tutorialDone), joined),
    share("mission", "New characters that take a mission", 0.4, a(ACCOUNT_STEPS.mission), joined),
    { id: "first_session_ms", label: "Median first session", target: "over 10 min", unit: "ms", value: r.medianFirstSessionMs, ok: r.medianFirstSessionMs === null ? null : r.medianFirstSessionMs > 600_000 },
    share("level5", "New characters that reach level 5", 0.25, a(ACCOUNT_STEPS.level5), joined),
    share("back_week", "Back within a week (accounts at least 7 days old)", 0.15, r.weekBack, r.weekOld),
    share("level2_saved", "Level-2 players who save", 0.3, r.level2Saved, r.level2),
    share("crash_free", "Visits in the world that hit a client error", 0, v("crash"), v("world"), true),
  ];
}

/** The funnel's steps in their order, for the step tables (visits, then accounts). */
export const VISIT_FUNNEL: readonly string[] = ["page", "play", "pick", "world", "tutorial_done"];
export const ACCOUNT_FUNNEL: readonly string[] = [ACCOUNT_STEPS.join, ACCOUNT_STEPS.kill, ACCOUNT_STEPS.mission, ACCOUNT_STEPS.level2, ACCOUNT_STEPS.tutorialDone, ACCOUNT_STEPS.level5, ACCOUNT_STEPS.saved, ACCOUNT_STEPS.firstSession, ACCOUNT_STEPS.back];
