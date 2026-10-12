// Guest → saved account (SPEC §5.4.2). Better Auth gives the saved account a new user id, so every
// game.db row moves from the guest id to the new id in one idempotent transaction. If the target
// already has data (signing in on a second browser that was playing as a guest), the merge rule is:
// keep the higher-level live character (ties: more XP, then the account's), union medals, blocks
// and discovered pads; Hall of Firsts entries, piles, reports, bans and session history follow the player.

import { getAccount } from "./accounts.ts";
import { loadCharacter } from "./characters.ts";
import { stmt, tx, type Db } from "./game-db.ts";

export interface LinkResult {
  /** Whose live character survived: the guest's, the account's, or none existed. */
  character: "guest" | "account" | "none";
  /** Display name the account ends up with (null if neither had picked one). */
  displayName: string | null;
  /** True if the target already had game data (a merge rather than a move). */
  merged: boolean;
}

export function linkAccounts(db: Db, fromUserId: string, toUserId: string, now = Date.now()): LinkResult {
  if (fromUserId === toUserId) {
    const acc = getAccount(db, toUserId);
    return { character: loadCharacter(db, toUserId) ? "account" : "none", displayName: acc?.displayName ?? null, merged: false };
  }
  return tx(db, () => {
    const from = getAccount(db, fromUserId);
    const to = getAccount(db, toUserId);
    const fromChar = loadCharacter(db, fromUserId);
    const toChar = loadCharacter(db, toUserId);
    const merged = !!(to || toChar);

    // account: delete the guest row first so its display name is free for the target.
    let displayName = to?.displayName ?? null;
    if (from) {
      stmt(db, "DELETE FROM account WHERE user_id = ?").run(fromUserId);
      if (!to) {
        stmt(
          db,
          `INSERT INTO account (user_id, display_name, is_admin, title_medal, created_at, last_seen_at, banned_until, last_ip_hash)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(toUserId, from.displayName, from.isAdmin ? 1 : 0, from.titleMedal, from.createdAt, Math.max(from.lastSeenAt, now), from.bannedUntil, from.lastIpHash);
        displayName = from.displayName;
      } else {
        displayName = to.displayName ?? from.displayName;
        const bannedUntil = to.bannedUntil === null ? from.bannedUntil : from.bannedUntil === null ? to.bannedUntil : Math.max(to.bannedUntil, from.bannedUntil);
        stmt(
          db,
          `UPDATE account SET display_name = ?, is_admin = ?, title_medal = COALESCE(title_medal, ?),
             created_at = MIN(created_at, ?), last_seen_at = MAX(last_seen_at, ?), banned_until = ?,
             last_ip_hash = COALESCE(?, last_ip_hash)
           WHERE user_id = ?`,
        ).run(displayName, to.isAdmin || from.isAdmin ? 1 : 0, from.titleMedal, from.createdAt, Math.max(from.lastSeenAt, now), bannedUntil, from.lastIpHash, toUserId);
      }
    }

    // character: one live character per account.
    let character: LinkResult["character"] = "none";
    if (fromChar && !toChar) {
      stmt(db, "UPDATE character SET user_id = ? WHERE user_id = ?").run(toUserId, fromUserId);
      character = "guest";
    } else if (fromChar && toChar) {
      const guestWins = fromChar.level > toChar.level || (fromChar.level === toChar.level && fromChar.xp > toChar.xp);
      if (guestWins) {
        stmt(db, "DELETE FROM character WHERE user_id = ?").run(toUserId);
        stmt(db, "UPDATE character SET user_id = ? WHERE user_id = ?").run(toUserId, fromUserId);
        character = "guest";
      } else {
        stmt(db, "DELETE FROM character WHERE user_id = ?").run(fromUserId);
        character = "account";
      }
    } else if (toChar) {
      character = "account";
    }

    // unions (keep the target's row on conflict, drop the guest's)
    stmt(db, "INSERT OR IGNORE INTO discovered_pad (user_id, body, pad_id, discovered_at) SELECT ?, body, pad_id, discovered_at FROM discovered_pad WHERE user_id = ?").run(toUserId, fromUserId);
    stmt(db, "DELETE FROM discovered_pad WHERE user_id = ?").run(fromUserId);
    stmt(db, "INSERT OR IGNORE INTO medal (user_id, medal_id, earned_at) SELECT ?, medal_id, earned_at FROM medal WHERE user_id = ?").run(toUserId, fromUserId);
    stmt(db, "DELETE FROM medal WHERE user_id = ?").run(fromUserId);
    stmt(db, "INSERT OR IGNORE INTO block (user_id, blocked_user_id, created_at) SELECT ?, blocked_user_id, created_at FROM block WHERE user_id = ?").run(toUserId, fromUserId);
    stmt(db, "DELETE FROM block WHERE user_id = ?").run(fromUserId);
    stmt(db, "INSERT OR IGNORE INTO block (user_id, blocked_user_id, created_at) SELECT user_id, ?, created_at FROM block WHERE blocked_user_id = ?").run(toUserId, fromUserId);
    stmt(db, "DELETE FROM block WHERE blocked_user_id = ?").run(fromUserId);
    stmt(db, "DELETE FROM block WHERE user_id = blocked_user_id").run();

    // things that simply follow the player
    stmt(db, "UPDATE hall_of_firsts SET user_id = ? WHERE user_id = ?").run(toUserId, fromUserId);
    stmt(db, "UPDATE pile SET owner_id = ? WHERE owner_id = ?").run(toUserId, fromUserId);
    stmt(db, "UPDATE report SET reporter = ? WHERE reporter = ?").run(toUserId, fromUserId);
    stmt(db, "UPDATE report SET target = ? WHERE target = ?").run(toUserId, fromUserId);
    stmt(db, "UPDATE ban SET user_id = ? WHERE user_id = ?").run(toUserId, fromUserId);
    stmt(db, "UPDATE session_log SET user_id = ? WHERE user_id = ?").run(toUserId, fromUserId);
    stmt(db, "UPDATE admin_claim SET user_id = ? WHERE user_id = ?").run(toUserId, fromUserId);

    return { character, displayName, merged };
  });
}
