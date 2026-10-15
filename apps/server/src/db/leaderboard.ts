// Public leaderboard reads for the home page (6a): display names only, no ids, emails or positions.
// Only accounts that picked a display name are listed; banned accounts and dead characters are not.

import { stmt, type Db } from "./game-db.ts";

export interface LevelRow {
  name: string;
  level: number;
  xp: number;
  /** Starter id as stored ("hexwick", "ash", …). */
  starter: string;
  titleMedal: string | null;
}

export interface MedalRow {
  name: string;
  medals: number;
  titleMedal: string | null;
}

const NOT_BANNED = "NOT EXISTS (SELECT 1 FROM ban b WHERE b.user_id = a.user_id AND (b.until IS NULL OR b.until > ?))";

/** Highest live characters: level, then XP, then whoever got there first. */
export function topLevels(db: Db, limit = 10, now = Date.now()): LevelRow[] {
  const rows = stmt(
    db,
    `SELECT a.display_name AS name, c.level, c.xp, c.starter, a.title_medal AS titleMedal
       FROM character c JOIN account a ON a.user_id = c.user_id
      WHERE a.display_name IS NOT NULL
        AND COALESCE(json_extract(c.inventory_json, '$.dead'), 0) = 0
        AND ${NOT_BANNED}
      ORDER BY c.level DESC, c.xp DESC, c.updated_at ASC
      LIMIT ?`,
  ).all(now, limit) as LevelRow[];
  return rows;
}

/** Most medals (account-bound, they survive death); ties go to whoever completed the set first. */
export function medalLeaders(db: Db, limit = 10, now = Date.now()): MedalRow[] {
  return stmt(
    db,
    `SELECT a.display_name AS name, COUNT(*) AS medals, a.title_medal AS titleMedal
       FROM medal m JOIN account a ON a.user_id = m.user_id
      WHERE a.display_name IS NOT NULL AND ${NOT_BANNED}
      GROUP BY m.user_id
      ORDER BY medals DESC, MAX(m.earned_at) ASC
      LIMIT ?`,
  ).all(now, limit) as MedalRow[];
}
