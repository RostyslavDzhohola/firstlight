// Play-session log and the analytics behind /stats (SPEC §6.11): sessions, playtime distribution,
// deaths, levels, backend/tier split, D1/D7 return. Analytics older than 90 days are pruned.

import { parseJson, stmt, type Db } from "./game-db.ts";
import { IS_TEST } from "./testAccounts.ts";

const DAY = 86_400_000;

export interface SessionStart {
  userId: string;
  startedAt?: number;
  /** Renderer backend reported by the client, e.g. "webgpu" | "webgl2". */
  backend?: string | null;
  /** Quality tier, e.g. "low" | "medium" | "high". */
  tier?: string | null;
}

export interface SessionProgress {
  /** Milliseconds spent on each body during this session (replaces the stored map). */
  bodyTime?: Record<string, number>;
  deaths?: number;
  maxLevel?: number;
}

export function startSession(db: Db, s: SessionStart): number {
  const r = stmt(db, "INSERT INTO session_log (user_id, started_at, backend, tier) VALUES (?, ?, ?, ?)").run(
    s.userId,
    s.startedAt ?? Date.now(),
    s.backend ?? null,
    s.tier ?? null,
  );
  return Number(r.lastInsertRowid);
}

export function updateSession(db: Db, id: number, p: SessionProgress): void {
  stmt(
    db,
    `UPDATE session_log SET
       body_time_json = COALESCE(?, body_time_json),
       deaths = COALESCE(?, deaths),
       max_level = MAX(max_level, COALESCE(?, max_level))
     WHERE id = ?`,
  ).run(p.bodyTime ? JSON.stringify(p.bodyTime) : null, p.deaths ?? null, p.maxLevel ?? null, id);
}

export function endSession(db: Db, id: number, p: SessionProgress & { endedAt?: number } = {}): void {
  updateSession(db, id, p);
  stmt(db, "UPDATE session_log SET ended_at = COALESCE(ended_at, ?) WHERE id = ?").run(p.endedAt ?? Date.now(), id);
}

/** Close sessions left open by a crash (call at boot). */
export function closeDanglingSessions(db: Db, now = Date.now()): number {
  return stmt(db, "UPDATE session_log SET ended_at = ? WHERE ended_at IS NULL").run(now).changes;
}

export function pruneSessionLog(db: Db, olderThanMs = 90 * DAY, now = Date.now()): number {
  return stmt(db, "DELETE FROM session_log WHERE started_at < ?").run(now - olderThanMs).changes;
}

export interface RetentionRow {
  /** UTC day (YYYY-MM-DD) of the cohort's first session. */
  day: string;
  cohort: number;
  /** Players of the cohort who played again on the next UTC day (null: day not reached yet). */
  d1: number | null;
  /** ...on the 7th day after. */
  d7: number | null;
}

export interface Retention {
  cohorts: RetentionRow[];
  /** Share of players (over cohorts that reached day 1 / day 7) who returned. */
  d1Rate: number | null;
  d7Rate: number | null;
}

/** D1/D7 return by first-session cohort over the last `days` days (real players only, D-home-6). */
export function retention(db: Db, now = Date.now(), days = 30): Retention {
  const today = Math.floor(now / DAY);
  const rows = stmt(
    db,
    `WITH real AS (SELECT user_id, started_at FROM session_log s WHERE NOT ${IS_TEST("s.user_id")}),
          first AS (SELECT user_id, MIN(started_at) / ${DAY} AS d0 FROM real GROUP BY user_id),
          days AS (SELECT DISTINCT user_id, started_at / ${DAY} AS d FROM real)
     SELECT f.d0 AS d0, COUNT(*) AS cohort,
       SUM(EXISTS (SELECT 1 FROM days x WHERE x.user_id = f.user_id AND x.d = f.d0 + 1)) AS d1,
       SUM(EXISTS (SELECT 1 FROM days x WHERE x.user_id = f.user_id AND x.d = f.d0 + 7)) AS d7
     FROM first f WHERE f.d0 >= ? GROUP BY f.d0 ORDER BY f.d0`,
  ).all(today - days) as { d0: number; cohort: number; d1: number; d7: number }[];
  let c1 = 0, r1 = 0, c7 = 0, r7 = 0;
  const cohorts = rows.map((r) => {
    const has1 = r.d0 + 1 <= today;
    const has7 = r.d0 + 7 <= today;
    if (has1) (c1 += r.cohort), (r1 += r.d1);
    if (has7) (c7 += r.cohort), (r7 += r.d7);
    return {
      day: new Date(r.d0 * DAY).toISOString().slice(0, 10),
      cohort: r.cohort,
      d1: has1 ? r.d1 : null,
      d7: has7 ? r.d7 : null,
    };
  });
  return { cohorts, d1Rate: c1 ? r1 / c1 : null, d7Rate: c7 ? r7 / c7 : null };
}

export interface SessionStats {
  sessions: number;
  players: number;
  open: number;
  totalPlayMs: number;
  medianSessionMs: number | null;
  /** Ended sessions by length. */
  playtime: Record<"<1m" | "1-5m" | "5-15m" | "15-30m" | "30-60m" | "60m+", number>;
  deaths: number;
  /** Highest level reached per session → number of sessions. */
  maxLevel: Record<string, number>;
  backend: Record<string, number>;
  tier: Record<string, number>;
  bodyTimeMs: Record<string, number>;
}

/** Our test accounts' sessions since `since` (shown apart on /stats, never in the figures above it). */
export function testSessionCount(db: Db, since = 0): { sessions: number; players: number } {
  return stmt(db, `SELECT COUNT(*) AS sessions, COUNT(DISTINCT user_id) AS players FROM session_log s WHERE started_at >= ? AND ${IS_TEST("s.user_id")}`).get(since) as { sessions: number; players: number };
}

/** Aggregates over real players' sessions started since `since` (test accounts excluded, D-home-6). */
export function sessionStats(db: Db, since = 0): SessionStats {
  const rows = stmt(
    db,
    `SELECT user_id, started_at, ended_at, body_time_json, deaths, max_level, backend, tier FROM session_log s WHERE started_at >= ? AND NOT ${IS_TEST("s.user_id")}`,
  ).all(since) as {
    user_id: string;
    started_at: number;
    ended_at: number | null;
    body_time_json: string;
    deaths: number;
    max_level: number;
    backend: string | null;
    tier: string | null;
  }[];
  const out: SessionStats = {
    sessions: rows.length,
    players: new Set(rows.map((r) => r.user_id)).size,
    open: 0,
    totalPlayMs: 0,
    medianSessionMs: null,
    playtime: { "<1m": 0, "1-5m": 0, "5-15m": 0, "15-30m": 0, "30-60m": 0, "60m+": 0 },
    deaths: 0,
    maxLevel: {},
    backend: {},
    tier: {},
    bodyTimeMs: {},
  };
  const lengths: number[] = [];
  const bump = (m: Record<string, number>, k: string, by = 1) => (m[k] = (m[k] ?? 0) + by);
  for (const r of rows) {
    out.deaths += r.deaths;
    bump(out.maxLevel, String(r.max_level));
    bump(out.backend, r.backend ?? "unknown");
    bump(out.tier, r.tier ?? "unknown");
    for (const [body, ms] of Object.entries(parseJson<Record<string, number>>(r.body_time_json, {}))) {
      if (typeof ms === "number" && Number.isFinite(ms)) bump(out.bodyTimeMs, body, ms);
    }
    if (r.ended_at === null) {
      out.open++;
      continue;
    }
    const len = Math.max(0, r.ended_at - r.started_at);
    lengths.push(len);
    out.totalPlayMs += len;
    const min = len / 60_000;
    const bucket = min < 1 ? "<1m" : min < 5 ? "1-5m" : min < 15 ? "5-15m" : min < 30 ? "15-30m" : min < 60 ? "30-60m" : "60m+";
    out.playtime[bucket]++;
  }
  if (lengths.length) {
    lengths.sort((a, b) => a - b);
    out.medianSessionMs = lengths[Math.floor(lengths.length / 2)]!;
  }
  return out;
}
