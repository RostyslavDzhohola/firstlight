// Guest pruning (F12): guests who never got past level 1, earned nothing and haven't been seen for
// 30 days are deleted from auth.db (user, sessions, accounts) and game.db (account, character, pads,
// stats, blocks), so the databases stay bounded and squatted display names are released. Reports,
// bans, piles and the analytics session log are kept (moderation history; the log has its own
// 90-day pruning). Run at boot and daily by createAccounts().

import type Database from "better-sqlite3";
import { stmt, tx, type Db } from "../db/game-db.ts";

export const GUEST_PRUNE = {
  INACTIVE_DAYS: 30,
  /** Guests whose character never got above this level. */
  MAX_LEVEL: 1,
  /** Deletions per run, so a boot after a long gap stays quick (the daily run continues). */
  MAX_PER_RUN: 5000,
};

const PAGE = 500;

interface GameFacts {
  seen: number | null;
  admin: number | null;
  banned: number | null;
  level: number | null;
  maxLevel: number | null;
  medals: number;
  hall: number;
}

/**
 * Delete abandoned guests. `isLive(userId)` guards anyone holding a session right now.
 * Returns how many guests were deleted.
 */
export function pruneGuests(authDb: Database.Database, db: Db, opts: { now?: number; isLive?: (userId: string) => boolean } = {}): number {
  const now = opts.now ?? Date.now();
  const cutoff = now - GUEST_PRUNE.INACTIVE_DAYS * 86_400_000;
  const cutoffIso = new Date(cutoff).toISOString();
  // Anonymous users created before the cutoff with no session used since (Better Auth stores ISO dates).
  const candidates = authDb.prepare(
    `SELECT u.id FROM "user" u
     WHERE u."isAnonymous" = 1 AND u.id > ? AND u."createdAt" < ? AND u."updatedAt" < ?
       AND NOT EXISTS (SELECT 1 FROM "session" s WHERE s."userId" = u.id AND s."updatedAt" >= ?)
     ORDER BY u.id LIMIT ?`,
  );
  const facts = stmt(
    db,
    `SELECT (SELECT last_seen_at FROM account WHERE user_id = @id) AS seen,
            (SELECT is_admin FROM account WHERE user_id = @id) AS admin,
            (SELECT banned_until FROM account WHERE user_id = @id) AS banned,
            (SELECT level FROM character WHERE user_id = @id) AS level,
            (SELECT MAX(max_level) FROM session_log WHERE user_id = @id) AS maxLevel,
            EXISTS (SELECT 1 FROM medal WHERE user_id = @id) AS medals,
            EXISTS (SELECT 1 FROM hall_of_firsts WHERE user_id = @id) AS hall`,
  );
  const prunable = (id: string): boolean => {
    if (opts.isLive?.(id)) return false;
    const f = facts.get({ id }) as GameFacts;
    if (f.seen !== null && f.seen >= cutoff) return false;
    if (f.admin || f.banned !== null || f.medals || f.hall) return false;
    return (f.level ?? 0) <= GUEST_PRUNE.MAX_LEVEL && (f.maxLevel ?? 0) <= GUEST_PRUNE.MAX_LEVEL;
  };

  const delAuth = authDb.transaction((ids: string[]) => {
    const s = authDb.prepare(`DELETE FROM "session" WHERE "userId" = ?`);
    const a = authDb.prepare(`DELETE FROM "account" WHERE "userId" = ?`);
    const u = authDb.prepare(`DELETE FROM "user" WHERE id = ? AND "isAnonymous" = 1`);
    for (const id of ids) {
      s.run(id);
      a.run(id);
      u.run(id);
    }
  });
  const delGame = (ids: string[]) =>
    tx(db, () => {
      for (const id of ids) {
        for (const table of ["character", "discovered_pad", "account_stat", "account"]) stmt(db, `DELETE FROM ${table} WHERE user_id = ?`).run(id);
        stmt(db, "DELETE FROM block WHERE user_id = ? OR blocked_user_id = ?").run(id, id);
      }
    });

  let after = "";
  let deleted = 0;
  while (deleted < GUEST_PRUNE.MAX_PER_RUN) {
    const page = (candidates.all(after, cutoffIso, cutoffIso, cutoffIso, PAGE) as { id: string }[]).map((r) => r.id);
    if (!page.length) break;
    after = page[page.length - 1]!;
    const ids = page.filter(prunable).slice(0, GUEST_PRUNE.MAX_PER_RUN - deleted);
    if (!ids.length) continue;
    // Game rows first: a crash in between leaves an auth user without game rows, which the next
    // sign-in recreates, never game rows without their user.
    delGame(ids);
    delAuth(ids);
    deleted += ids.length;
  }
  return deleted;
}
