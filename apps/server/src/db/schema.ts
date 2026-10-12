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
  // 3: per-copy world state that outlives a room (boss timers, cleared spawn groups, broken props)
  `
  CREATE TABLE copy_state (
    copy_key    TEXT NOT NULL,
    system      TEXT NOT NULL,
    state_json  TEXT NOT NULL,
    saved_at    INTEGER NOT NULL,
    PRIMARY KEY (copy_key, system)
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
