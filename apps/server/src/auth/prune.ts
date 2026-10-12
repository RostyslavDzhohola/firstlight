// Guest pruning (F12): guests who never got past level 1, earned nothing and haven't played for 30
// days are deleted from auth.db (user, sessions, accounts) and game.db (account, character, pads,
// stats, blocks), so the databases stay bounded and squatted display names are released. Run at
// boot and daily by createAccounts().
//
// Policy:
// - "Played" is the latest of the account's last sign-in (account.last_seen_at), its last character
//   save (character.updated_at: autosave every 30 s, logout, shutdown) and its play sessions
//   (session_log, an open session counting as now), so a long session that just ended, or was cut
//   by a restart, is recent. Anyone with a live, dropped or lingering actor is never touched.
// - A level-1 character's coins and inventory don't keep it: they come from a few minutes of play
//   and are lost on death anyway. Medals, the Hall of Firsts, a ban or the admin flag do.
// - Reports, bans, piles and the analytics log are kept (moderation history; the log has its own
//   90-day pruning).
//
// The two databases can't share a transaction, so deletion runs in phases whose partial failure is
// harmless, and each run first finishes half-done deletions:
//   1. tombstone the game account (last_seen_at = TOMBSTONE): nothing else changes, and a sign-in
//      before phase 2 clears it (ensureAccount stamps last_seen_at), so the player keeps everything;
//   2. delete the auth user, sessions and accounts: from here the player can't sign in;
//   3. delete the game rows. A failure here leaves tombstoned rows with no auth user, which the
//      next run deletes.

import type Database from "better-sqlite3";
import { stmt, tx, type Db } from "../db/game-db.ts";
import { hub } from "../world/hub.ts";

export const GUEST_PRUNE = {
  INACTIVE_DAYS: 30,
  /** Guests whose character never got above this level. */
  MAX_LEVEL: 1,
  /** Deletions per run, so a boot after a long gap stays quick (the daily run continues). */
  MAX_PER_RUN: 5000,
};

/** account.last_seen_at while a deletion is in progress (real values are epoch ms). */
export const TOMBSTONE = -1;

const PAGE = 500;

interface GameFacts {
  seen: number | null;
  saved: number | null;
  played: number | null;
  admin: number | null;
  banned: number | null;
  level: number | null;
  maxLevel: number | null;
  medals: number;
  hall: number;
}

export interface PruneOptions {
  now?: number;
  /** Extra live check (the session registry); live hub actors are always protected. */
  isLive?: (userId: string) => boolean;
  /** Test hooks: throw between phases to simulate a crash. */
  faults?: { afterTombstone?: () => void; afterAuth?: () => void };
}

/** Delete abandoned guests. Returns how many guests were deleted (including finished half-done ones). */
export function pruneGuests(authDb: Database.Database, db: Db, opts: PruneOptions = {}): number {
  const now = opts.now ?? Date.now();
  const cutoff = now - GUEST_PRUNE.INACTIVE_DAYS * 86_400_000;
  const cutoffIso = new Date(cutoff).toISOString();
  const authUser = authDb.prepare(`SELECT 1 FROM "user" WHERE id = ?`);

  const deleteGameRows = (ids: readonly string[]) =>
    tx(db, () => {
      for (const id of ids) {
        for (const table of ["character", "discovered_pad", "account_stat", "account"]) stmt(db, `DELETE FROM ${table} WHERE user_id = ?`).run(id);
        stmt(db, "DELETE FROM block WHERE user_id = ? OR blocked_user_id = ?").run(id, id);
      }
    });

  // Finish deletions that stopped after phase 2 (tombstoned, auth user already gone).
  const orphans = (stmt(db, "SELECT user_id FROM account WHERE last_seen_at = ?").all(TOMBSTONE) as { user_id: string }[])
    .map((r) => r.user_id)
    .filter((id) => !authUser.get(id));
  if (orphans.length) deleteGameRows(orphans);
  let deleted = orphans.length;

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
            (SELECT updated_at FROM character WHERE user_id = @id) AS saved,
            (SELECT MAX(COALESCE(ended_at, @now)) FROM session_log WHERE user_id = @id) AS played,
            (SELECT is_admin FROM account WHERE user_id = @id) AS admin,
            (SELECT banned_until FROM account WHERE user_id = @id) AS banned,
            (SELECT level FROM character WHERE user_id = @id) AS level,
            (SELECT MAX(max_level) FROM session_log WHERE user_id = @id) AS maxLevel,
            EXISTS (SELECT 1 FROM medal WHERE user_id = @id) AS medals,
            EXISTS (SELECT 1 FROM hall_of_firsts WHERE user_id = @id) AS hall`,
  );
  const prunable = (id: string): boolean => {
    if (hub.get(id) || opts.isLive?.(id)) return false;
    const f = facts.get({ id, now }) as GameFacts;
    if (Math.max(f.seen ?? 0, f.saved ?? 0, f.played ?? 0) >= cutoff) return false;
    if (f.admin || f.banned !== null || f.medals || f.hall) return false;
    return (f.level ?? 0) <= GUEST_PRUNE.MAX_LEVEL && (f.maxLevel ?? 0) <= GUEST_PRUNE.MAX_LEVEL;
  };

  const tombstone = (ids: readonly string[]) =>
    tx(db, () => {
      for (const id of ids) stmt(db, "UPDATE account SET last_seen_at = ? WHERE user_id = ?").run(TOMBSTONE, id);
    });
  const deleteAuth = authDb.transaction((ids: readonly string[]) => {
    const s = authDb.prepare(`DELETE FROM "session" WHERE "userId" = ?`);
    const a = authDb.prepare(`DELETE FROM "account" WHERE "userId" = ?`);
    const u = authDb.prepare(`DELETE FROM "user" WHERE id = ? AND "isAnonymous" = 1`);
    for (const id of ids) {
      s.run(id);
      a.run(id);
      u.run(id);
    }
  });

  let after = "";
  while (deleted < GUEST_PRUNE.MAX_PER_RUN) {
    const page = (candidates.all(after, cutoffIso, cutoffIso, cutoffIso, PAGE) as { id: string }[]).map((r) => r.id);
    if (!page.length) break;
    after = page[page.length - 1]!;
    const ids = page.filter(prunable).slice(0, GUEST_PRUNE.MAX_PER_RUN - deleted);
    if (!ids.length) continue;
    tombstone(ids);
    opts.faults?.afterTombstone?.();
    deleteAuth(ids);
    opts.faults?.afterAuth?.();
    deleteGameRows(ids);
    deleted += ids.length;
  }
  return deleted;
}
