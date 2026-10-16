// Public leaderboard reads for the home page (6a): display names only, no ids, emails or positions.
// Only accounts that picked a display name are listed, never banned or test accounts (D-home-6); the levels board also
// leaves out dead characters (medals survive death, so that board doesn't).

import { stmt, type Db } from "./game-db.ts";
import { IS_TEST } from "./testAccounts.ts";

export interface LevelRow {
  name: string;
  level: number;
  xp: number;
  /** Starter id as stored ("hexwick", "ash", …). */
  starter: string;
  /** The look index from the inventory record (null on older rows). */
  look: number | null;
  titleMedal: string | null;
}

export interface MedalRow {
  name: string;
  medals: number;
  titleMedal: string | null;
}

const NOT_BANNED = "NOT EXISTS (SELECT 1 FROM ban b WHERE b.user_id = a.user_id AND (b.until IS NULL OR b.until > ?))";
/** Our own automation never ranks (D-home-6). */
const NOT_TEST = `NOT ${IS_TEST("a.user_id")}`;

/** Highest live characters (level, XP, then first there), walking `character_rank` (migration 6). */
const TOP_LEVELS_SQL = `SELECT a.display_name AS name, c.level, c.xp, c.starter, json_extract(c.inventory_json, '$.look') AS look, a.title_medal AS titleMedal
   FROM character c CROSS JOIN account a ON a.user_id = c.user_id
  WHERE a.display_name IS NOT NULL
    AND COALESCE(json_extract(c.inventory_json, '$.dead'), 0) = 0
    AND ${NOT_BANNED} AND ${NOT_TEST}
  ORDER BY c.level DESC, c.xp DESC, c.updated_at ASC
  LIMIT ?`;

/** Most medals (ties: first to that count), walking `medal_count_rank` (migration 6). */
const MEDAL_LEADERS_SQL = `SELECT a.display_name AS name, m.n AS medals, a.title_medal AS titleMedal
   FROM medal_count m CROSS JOIN account a ON a.user_id = m.user_id
  WHERE m.n > 0 AND a.display_name IS NOT NULL AND ${NOT_BANNED} AND ${NOT_TEST}
  ORDER BY m.n DESC, m.last_at ASC
  LIMIT ?`;

/**
 * The top live characters. The rank index is read from the top and the scan stops after `limit`
 * listed rows (CROSS JOIN keeps characters as the outer loop), so it costs the same at any size.
 */
export function topLevels(db: Db, limit = 10, now = Date.now()): LevelRow[] {
  return stmt(db, TOP_LEVELS_SQL).all(now, limit) as LevelRow[];
}

/**
 * The most medals. Medals are account-bound, so an account whose character is dead (between lives)
 * keeps its place here; only the levels board needs a live character.
 */
export function medalLeaders(db: Db, limit = 10, now = Date.now()): MedalRow[] {
  return stmt(db, MEDAL_LEADERS_SQL).all(now, limit) as MedalRow[];
}

/** EXPLAIN QUERY PLAN details for both boards (tests check they read an index, never sort). */
export function leaderboardPlans(db: Db): { levels: string[]; medals: string[] } {
  const plan = (sql: string) => (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(0, 10) as { detail: string }[]).map((r) => r.detail);
  return { levels: plan(TOP_LEVELS_SQL), medals: plan(MEDAL_LEADERS_SQL) };
}
