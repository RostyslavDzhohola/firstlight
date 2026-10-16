// game.db schema (SPEC §5.5) and a tiny forward-only migration runner keyed on PRAGMA user_version.
// Add a new entry to MIGRATIONS for every change; never edit an applied one.

import type { Db } from "./game-db.ts";

export const MIGRATIONS: readonly string[] = [
  // 1: initial schema
  `
  CREATE TABLE account (
    user_id       TEXT PRIMARY KEY,
    display_name  TEXT,
    is_admin      INTEGER NOT NULL DEFAULT 0,
    title_medal   TEXT,
    created_at    INTEGER NOT NULL,
    last_seen_at  INTEGER NOT NULL,
    banned_until  INTEGER,
    last_ip_hash  TEXT
  );
  CREATE UNIQUE INDEX account_display_name ON account(display_name COLLATE NOCASE);

  CREATE TABLE character (
    user_id             TEXT PRIMARY KEY,
    starter             TEXT NOT NULL,
    palette             INTEGER NOT NULL DEFAULT 0,
    level               INTEGER NOT NULL DEFAULT 1,
    xp                  INTEGER NOT NULL DEFAULT 0,
    coins               INTEGER NOT NULL DEFAULT 0,
    hp                  REAL NOT NULL,
    body                TEXT NOT NULL,
    copy_hint           INTEGER,
    pos_x               REAL NOT NULL,
    pos_y               REAL NOT NULL,
    pos_z               REAL NOT NULL,
    heading             REAL NOT NULL DEFAULT 0,
    inventory_json      TEXT NOT NULL DEFAULT '[]',
    mission_state_json  TEXT NOT NULL DEFAULT '{}',
    life_started_at     INTEGER NOT NULL,
    protected_until     INTEGER NOT NULL DEFAULT 0,
    updated_at          INTEGER NOT NULL
  );

  CREATE TABLE discovered_pad (
    user_id        TEXT NOT NULL,
    body           TEXT NOT NULL,
    pad_id         TEXT NOT NULL,
    discovered_at  INTEGER NOT NULL,
    PRIMARY KEY (user_id, body, pad_id)
  );

  CREATE TABLE medal (
    user_id    TEXT NOT NULL,
    medal_id   TEXT NOT NULL,
    earned_at  INTEGER NOT NULL,
    PRIMARY KEY (user_id, medal_id)
  );

  CREATE TABLE hall_of_firsts (
    secret_id     TEXT PRIMARY KEY,
    user_id       TEXT NOT NULL,
    display_name  TEXT NOT NULL,
    found_at      INTEGER NOT NULL
  );
  CREATE INDEX hall_of_firsts_user ON hall_of_firsts(user_id);

  CREATE TABLE pile (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    body        TEXT NOT NULL,
    pos_x       REAL NOT NULL,
    pos_y       REAL NOT NULL,
    pos_z       REAL NOT NULL,
    items_json  TEXT NOT NULL,
    coins       INTEGER NOT NULL DEFAULT 0,
    owner_id    TEXT,
    owner_name  TEXT NOT NULL,
    created_at  INTEGER NOT NULL
  );
  CREATE INDEX pile_body_age ON pile(body, created_at, id);
  CREATE INDEX pile_owner ON pile(owner_id);

  CREATE TABLE block (
    user_id          TEXT NOT NULL,
    blocked_user_id  TEXT NOT NULL,
    created_at       INTEGER NOT NULL,
    PRIMARY KEY (user_id, blocked_user_id)
  );
  CREATE INDEX block_blocked ON block(blocked_user_id);

  CREATE TABLE report (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    reporter    TEXT NOT NULL,
    target      TEXT NOT NULL,
    body        TEXT,
    pos_x       REAL,
    pos_y       REAL,
    pos_z       REAL,
    reason      TEXT NOT NULL,
    created_at  INTEGER NOT NULL
  );
  CREATE INDEX report_created ON report(created_at);

  CREATE TABLE ban (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     TEXT,
    ip_hash     TEXT,
    until       INTEGER,
    reason      TEXT NOT NULL DEFAULT '',
    created_by  TEXT,
    created_at  INTEGER NOT NULL
  );
  CREATE INDEX ban_user ON ban(user_id);
  CREATE INDEX ban_ip ON ban(ip_hash);

  CREATE TABLE session_log (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id         TEXT NOT NULL,
    started_at      INTEGER NOT NULL,
    ended_at        INTEGER,
    body_time_json  TEXT NOT NULL DEFAULT '{}',
    deaths          INTEGER NOT NULL DEFAULT 0,
    max_level       INTEGER NOT NULL DEFAULT 1,
    backend         TEXT,
    tier            TEXT
  );
  CREATE INDEX session_log_user ON session_log(user_id, started_at);
  CREATE INDEX session_log_started ON session_log(started_at);

  CREATE TABLE admin_claim (
    token_hash  TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL,
    claimed_at  INTEGER NOT NULL
  );

  CREATE TABLE otp_send (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    email_hash  TEXT NOT NULL,
    sent_at     INTEGER NOT NULL
  );
  CREATE INDEX otp_send_email ON otp_send(email_hash, sent_at);
  CREATE INDEX otp_send_at ON otp_send(sent_at);
  `,
  // 2: account-level counters for cumulative medals (e.g. props broken for Demolition Crew)
  `
  CREATE TABLE account_stat (
    user_id  TEXT NOT NULL,
    stat     TEXT NOT NULL,
    value    INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, stat)
  );
  `,
  // 3: per-copy world state that outlives a room (boss timers and fights, cleared spawn groups,
  // broken props). Self-contained and idempotent, so it can be renumbered when lanes merge.
  `
  CREATE TABLE IF NOT EXISTS copy_state (
    copy_key    TEXT NOT NULL,
    system      TEXT NOT NULL,
    state_json  TEXT NOT NULL,
    saved_at    INTEGER NOT NULL,
    PRIMARY KEY (copy_key, system)
  );
  `,
  // 4: pile kinds (eviction past the cap prefers staged, then loot piles, over death piles) and expiry.
  // Not idempotent (SQLite has no ADD COLUMN IF NOT EXISTS): it runs once per database, guarded by
  // user_version in its own transaction. Production is past it (v5); leave it as it is, and write
  // new migrations idempotent and append-only (F12 final Opus nit).
  `
  ALTER TABLE pile ADD COLUMN kind TEXT NOT NULL DEFAULT 'death';
  ALTER TABLE pile ADD COLUMN expires_at INTEGER;
  `,
  // 5 (lane f12-core): admin voice mutes survive restarts and deploys (F12 S12). Idempotent.
  `
  CREATE TABLE IF NOT EXISTS voice_mute (
    user_id   TEXT PRIMARY KEY,
    muted_at  INTEGER NOT NULL
  );
  `,
  // 6 (lane home-page): the public leaderboard reads its top rows from indexes instead of sorting
  // every character (D-home-3). Medal counts per account are kept by triggers on \`medal\` (awards,
  // merges and prunes all go through inserts and deletes there). Idempotent, so it can be renumbered.
  `
  CREATE INDEX IF NOT EXISTS character_rank ON character(level DESC, xp DESC, updated_at);
  CREATE TABLE IF NOT EXISTS medal_count (
    user_id  TEXT PRIMARY KEY,
    n        INTEGER NOT NULL,
    last_at  INTEGER NOT NULL
  );
  INSERT OR REPLACE INTO medal_count (user_id, n, last_at) SELECT user_id, COUNT(*), MAX(earned_at) FROM medal GROUP BY user_id;
  CREATE INDEX IF NOT EXISTS medal_count_rank ON medal_count(n DESC, last_at);
  CREATE TRIGGER IF NOT EXISTS medal_count_insert AFTER INSERT ON medal BEGIN
    INSERT INTO medal_count (user_id, n, last_at) VALUES (NEW.user_id, 1, NEW.earned_at)
      ON CONFLICT(user_id) DO UPDATE SET n = n + 1, last_at = MAX(last_at, excluded.last_at);
  END;
  CREATE TRIGGER IF NOT EXISTS medal_count_delete AFTER DELETE ON medal BEGIN
    UPDATE medal_count SET n = n - 1, last_at = COALESCE((SELECT MAX(earned_at) FROM medal WHERE user_id = OLD.user_id), 0) WHERE user_id = OLD.user_id;
    DELETE FROM medal_count WHERE user_id = OLD.user_id AND n <= 0;
  END;
  CREATE TRIGGER IF NOT EXISTS medal_count_update AFTER UPDATE OF user_id, earned_at ON medal BEGIN
    UPDATE medal_count SET n = n - 1, last_at = COALESCE((SELECT MAX(earned_at) FROM medal WHERE user_id = OLD.user_id), 0) WHERE user_id = OLD.user_id;
    DELETE FROM medal_count WHERE user_id = OLD.user_id AND n <= 0;
    INSERT INTO medal_count (user_id, n, last_at) VALUES (NEW.user_id, 1, NEW.earned_at)
      ON CONFLICT(user_id) DO UPDATE SET n = n + 1, last_at = MAX(last_at, excluded.last_at);
  END;
  `,
  // 7 (lane real-board): accounts our own automation made (tests, smoke runs) are flagged so no
  // public surface shows them (D-home-6): a row here is the account's is_test flag. A side table, not
  // a column, so the migration stays idempotent (SQLite has no ADD COLUMN IF NOT EXISTS) and can be
  // renumbered. data_migration records one-off data steps (the backfill in testAccounts.ts) and what
  // they changed, so each runs once.
  `
  CREATE TABLE IF NOT EXISTS test_account (
    user_id    TEXT PRIMARY KEY,
    source     TEXT NOT NULL,
    marked_at  INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS data_migration (
    id       TEXT PRIMARY KEY,
    ran_at   INTEGER NOT NULL,
    changed  INTEGER NOT NULL
  );
  `,
];

/** Apply every migration newer than the database's user_version, each in its own transaction. */
export function migrate(db: Db): number {
  const current = db.pragma("user_version", { simple: true }) as number;
  for (let v = current; v < MIGRATIONS.length; v++) {
    const sql = MIGRATIONS[v]!;
    db.transaction(() => {
      db.exec(sql);
      db.pragma(`user_version = ${v + 1}`);
    }).immediate();
  }
  return MIGRATIONS.length;
}
