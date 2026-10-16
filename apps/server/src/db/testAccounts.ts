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

type MarkListener = (userId: string) => void;
const markListeners = new Set<MarkListener>();

/** Called when an account becomes a test account (the rooms drop a live player from public counts at once). */
export function onTestMarked(fn: MarkListener): () => void {
  markListeners.add(fn);
  return () => markListeners.delete(fn);
}

/** Flag an account as a test account. True if it wasn't already. */
export function markTestAccount(db: Db, userId: string, source: string, now = Date.now()): boolean {
  const added = stmt(db, "INSERT OR IGNORE INTO test_account (user_id, source, marked_at) VALUES (?, ?, ?)").run(userId, source, now).changes === 1;
  if (added) {
    for (const fn of [...markListeners]) {
      try {
        fn(userId);
      } catch (err) {
        console.error("test-account listener failed", err);
      }
    }
  }
  return added;
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

/** A later find (2026-10-16): one more automation guest from an earlier E2E run, cut off the first list. */
export const AUTOMATION_NAMES_2026_10_16: readonly string[] = ["Tester441"];

/** The backfills in order; each runs once per database under its own id. */
export const BACKFILLS: readonly { id: string; names: readonly string[] }[] = [
  { id: BACKFILL_ID, names: AUTOMATION_NAMES_2026_10_15 },
  { id: "test-accounts-2026-10-16", names: AUTOMATION_NAMES_2026_10_16 },
];

/**
 * The one-off backfills: flag the guest accounts (no saved email: `isGuest`) whose display name is
 * exactly one of a backfill's names. Each runs once per database (data_migration); returns how many
 * accounts the ones that ran flagged, or null when all of them already ran.
 */
export function backfillTestAccounts(db: Db, isGuest: (userId: string) => boolean, now = Date.now()): number | null {
  return tx(db, () => {
    let ran = false;
    let changed = 0;
    for (const b of BACKFILLS) {
      if (stmt(db, "SELECT 1 FROM data_migration WHERE id = ?").get(b.id)) continue;
      ran = true;
      const marks = `(${b.names.map(() => "?").join(", ")})`;
      const rows = db.prepare(`SELECT user_id AS id FROM account WHERE display_name COLLATE BINARY IN ${marks}`).all(...b.names) as { id: string }[];
      let n = 0;
      for (const r of rows) if (isGuest(r.id) && markTestAccount(db, r.id, b.id, now)) n++;
      stmt(db, "INSERT INTO data_migration (id, ran_at, changed) VALUES (?, ?, ?)").run(b.id, now, n);
      changed += n;
    }
    return ran ? changed : null;
  });
}
