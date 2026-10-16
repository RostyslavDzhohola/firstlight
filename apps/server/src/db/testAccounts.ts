// Test accounts (D-home-6): accounts our own automation made (Playwright journeys, smoke runs against
// production, browser checks). They play like anyone, but no public surface counts or names them: the
// leaderboard, the Hall of Firsts, "online now", the worlds' player counts, /api/home, /api/online and
// /stats. A row in test_account is the flag (migration 7); it's set only by our tools (a request that
// carries LOADTEST_SECRET, auth/accounts.ts) and by the one-off backfill below. Nothing is deleted.

import { stmt, tx, type Db } from "./game-db.ts";

/** SQL: true when the account in `col` is a test account. */
export const IS_TEST = (col: string) => `EXISTS (SELECT 1 FROM test_account t WHERE t.user_id = ${col})`;

export function isTestAccount(db: Db, userId: string): boolean {
  return !!stmt(db, "SELECT 1 FROM test_account WHERE user_id = ?").get(userId);
}

/** Flag an account as a test account. True if it wasn't already. */
export function markTestAccount(db: Db, userId: string, source: string, now = Date.now()): boolean {
  return stmt(db, "INSERT OR IGNORE INTO test_account (user_id, source, marked_at) VALUES (?, ?, ?)").run(userId, source, now).changes === 1;
}

/**
 * The automation accounts on production before tools marked their guests (the lead's read-only check
 * of the live game.db, 2026-10-15). Exact, case-sensitive display names. "ros" is the owner's own
 * character and is never on this list.
 */
export const AUTOMATION_NAMES_2026_10_15: readonly string[] = [
  "ChromeTester",
  "SmokeGuest42",
  "SmokeTest",
  "TownSmoke",
  "TutorialRun",
  "TutorialRun2",
  "TutorialRun3",
  "TutorialRun4",
  "BugScout_5817",
  "BlinkProbe14",
  "Smoke2Guest",
  "Smoke2Retry",
  "SmokeThree",
];

export const BACKFILL_ID = "test-accounts-2026-10-15";

/**
 * The one-off backfill: flag the guest accounts (no saved email: `isGuest`) whose display name is
 * exactly one of AUTOMATION_NAMES_2026_10_15. Runs once per database (data_migration); returns how
 * many accounts it flagged, or null when it already ran.
 */
export function backfillTestAccounts(db: Db, isGuest: (userId: string) => boolean, now = Date.now()): number | null {
  return tx(db, () => {
    if (stmt(db, "SELECT 1 FROM data_migration WHERE id = ?").get(BACKFILL_ID)) return null;
    const marks = `(${AUTOMATION_NAMES_2026_10_15.map(() => "?").join(", ")})`;
    const rows = db.prepare(`SELECT user_id AS id FROM account WHERE display_name COLLATE BINARY IN ${marks}`).all(...AUTOMATION_NAMES_2026_10_15) as { id: string }[];
    let changed = 0;
    for (const r of rows) if (isGuest(r.id) && markTestAccount(db, r.id, BACKFILL_ID, now)) changed++;
    stmt(db, "INSERT INTO data_migration (id, ran_at, changed) VALUES (?, ?, ?)").run(BACKFILL_ID, now, changed);
    return changed;
  });
}
