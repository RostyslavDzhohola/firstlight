// Characters (one live character per account), discovered pads, medals and the Hall of Firsts.
//
// Death (SPEC §6.6): `killCharacter` deletes the live character, so level, XP, items, coins and
// mission progress are gone. The account, its display name, medals, Hall of Firsts entries and
// discovered pads live in other tables and are kept. Rebirth = `saveCharacter` with a fresh level-1 record.

import { parseJson, stmt, tx, type Db } from "./game-db.ts";
import { IS_TEST } from "./testAccounts.ts";

export interface CharacterData<Inv = unknown, Missions = unknown> {
  starter: string;
  palette: number;
  level: number;
  xp: number;
  coins: number;
  hp: number;
  body: string;
  /** Which copy of the body the player was in (a hint for rejoining; null = any). */
  copyHint: number | null;
  x: number;
  y: number;
  z: number;
  heading: number;
  inventory: Inv;
  missionState: Missions;
  lifeStartedAt: number;
  protectedUntil: number;
}

export interface Character<Inv = unknown, Missions = unknown> extends CharacterData<Inv, Missions> {
  userId: string;
  updatedAt: number;
}

interface CharacterRow {
  user_id: string;
  starter: string;
  palette: number;
  level: number;
  xp: number;
  coins: number;
  hp: number;
  body: string;
  copy_hint: number | null;
  pos_x: number;
  pos_y: number;
  pos_z: number;
  heading: number;
  inventory_json: string;
  mission_state_json: string;
  life_started_at: number;
  protected_until: number;
  updated_at: number;
}

function toCharacter<I, M>(r: CharacterRow): Character<I, M> {
  return {
    userId: r.user_id,
    starter: r.starter,
    palette: r.palette,
    level: r.level,
    xp: r.xp,
    coins: r.coins,
    hp: r.hp,
    body: r.body,
    copyHint: r.copy_hint,
    x: r.pos_x,
    y: r.pos_y,
    z: r.pos_z,
    heading: r.heading,
    inventory: parseJson<I>(r.inventory_json, [] as I),
    missionState: parseJson<M>(r.mission_state_json, {} as M),
    lifeStartedAt: r.life_started_at,
    protectedUntil: r.protected_until,
    updatedAt: r.updated_at,
  };
}

export function loadCharacter<I = unknown, M = unknown>(db: Db, userId: string): Character<I, M> | null {
  const r = stmt(db, "SELECT * FROM character WHERE user_id = ?").get(userId) as CharacterRow | undefined;
  return r ? toCharacter<I, M>(r) : null;
}

const SAVE_SQL = `
  INSERT INTO character (user_id, starter, palette, level, xp, coins, hp, body, copy_hint, pos_x, pos_y, pos_z, heading,
    inventory_json, mission_state_json, life_started_at, protected_until, updated_at)
  SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
  WHERE EXISTS (SELECT 1 FROM account WHERE user_id = ?)
  ON CONFLICT(user_id) DO UPDATE SET
    starter = excluded.starter, palette = excluded.palette, level = excluded.level, xp = excluded.xp,
    coins = excluded.coins, hp = excluded.hp, body = excluded.body, copy_hint = excluded.copy_hint,
    pos_x = excluded.pos_x, pos_y = excluded.pos_y, pos_z = excluded.pos_z, heading = excluded.heading,
    inventory_json = excluded.inventory_json, mission_state_json = excluded.mission_state_json,
    life_started_at = excluded.life_started_at, protected_until = excluded.protected_until,
    updated_at = excluded.updated_at`;

/**
 * Create or overwrite the live character. Returns false (and writes nothing) when the account row
 * doesn't exist — e.g. a late autosave for a guest id that was just merged into a saved account.
 * Rooms always reach this after `/api/play`, which creates the account row.
 */
export function saveCharacter(db: Db, userId: string, c: CharacterData, now = Date.now()): boolean {
  return (
    stmt(db, SAVE_SQL).run(
      userId,
      c.starter,
      c.palette,
      Math.floor(c.level),
      Math.floor(c.xp),
      Math.floor(c.coins),
      c.hp,
      c.body,
      c.copyHint,
      c.x,
      c.y,
      c.z,
      c.heading,
      JSON.stringify(c.inventory ?? []),
      JSON.stringify(c.missionState ?? {}),
      c.lifeStartedAt,
      c.protectedUntil,
      now,
      userId,
    ).changes === 1
  );
}

/** Batched autosave: many characters in one transaction. Returns how many were written. */
export function saveCharacters(db: Db, list: readonly { userId: string; data: CharacterData }[], now = Date.now()): number {
  return tx(db, () => {
    let n = 0;
    for (const { userId, data } of list) if (saveCharacter(db, userId, data, now)) n++;
    return n;
  });
}

/** Death: the live character is gone. Returns the record that died (for the death screen / pile). */
export function killCharacter<I = unknown, M = unknown>(db: Db, userId: string): Character<I, M> | null {
  return tx(db, () => {
    const c = loadCharacter<I, M>(db, userId);
    stmt(db, "DELETE FROM character WHERE user_id = ?").run(userId);
    return c;
  });
}

// ---------------------------------------------------------------------------------------------
// Discovered pads (account-level, survive death; D2)

/** Returns true if this pad is newly discovered. */
export function discoverPad(db: Db, userId: string, body: string, padId: string, now = Date.now()): boolean {
  return stmt(db, "INSERT OR IGNORE INTO discovered_pad (user_id, body, pad_id, discovered_at) VALUES (?, ?, ?, ?)").run(userId, body, padId, now).changes === 1;
}

export function listDiscoveredPads(db: Db, userId: string): { body: string; padId: string }[] {
  return (stmt(db, "SELECT body, pad_id FROM discovered_pad WHERE user_id = ? ORDER BY discovered_at").all(userId) as { body: string; pad_id: string }[]).map(
    (r) => ({ body: r.body, padId: r.pad_id }),
  );
}

// ---------------------------------------------------------------------------------------------
// Medals

/** Returns true if newly earned (show the toast). */
export function awardMedal(db: Db, userId: string, medalId: string, now = Date.now()): boolean {
  return stmt(db, "INSERT OR IGNORE INTO medal (user_id, medal_id, earned_at) VALUES (?, ?, ?)").run(userId, medalId, now).changes === 1;
}

export function listMedals(db: Db, userId: string): { medalId: string; earnedAt: number }[] {
  return (stmt(db, "SELECT medal_id, earned_at FROM medal WHERE user_id = ? ORDER BY earned_at").all(userId) as { medal_id: string; earned_at: number }[]).map(
    (r) => ({ medalId: r.medal_id, earnedAt: r.earned_at }),
  );
}

export function hasMedal(db: Db, userId: string, medalId: string): boolean {
  return !!stmt(db, "SELECT 1 FROM medal WHERE user_id = ? AND medal_id = ?").get(userId, medalId);
}

// ---------------------------------------------------------------------------------------------
// Hall of Firsts (global, once per secret)

export interface HallEntry {
  secretId: string;
  userId: string;
  displayName: string;
  foundAt: number;
}

/** First finder wins. `won` is true only for the call that engraved the entry. */
export function claimFirst(db: Db, secretId: string, userId: string, displayName: string, now = Date.now()): { won: boolean; entry: HallEntry } {
  return tx(db, () => {
    // A plaque held only by one of our test accounts is still free for a real player (D-home-6): the
    // wall doesn't show test claims, so a real find must engrave it.
    const won =
      stmt(
        db,
        `INSERT INTO hall_of_firsts (secret_id, user_id, display_name, found_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(secret_id) DO UPDATE SET user_id = excluded.user_id, display_name = excluded.display_name, found_at = excluded.found_at
         WHERE ${IS_TEST("hall_of_firsts.user_id")} AND NOT ${IS_TEST("excluded.user_id")}`,
      ).run(secretId, userId, displayName, now).changes === 1;
    const r = stmt(db, "SELECT * FROM hall_of_firsts WHERE secret_id = ?").get(secretId) as {
      secret_id: string;
      user_id: string;
      display_name: string;
      found_at: number;
    };
    return { won, entry: { secretId: r.secret_id, userId: r.user_id, displayName: r.display_name, foundAt: r.found_at } };
  });
}

/** The engraved plaques, oldest first. Test accounts' claims aren't shown (D-home-6). */
export function listHallOfFirsts(db: Db): HallEntry[] {
  return (stmt(db, `SELECT * FROM hall_of_firsts h WHERE NOT ${IS_TEST("h.user_id")} ORDER BY found_at`).all() as { secret_id: string; user_id: string; display_name: string; found_at: number }[]).map(
    (r) => ({ secretId: r.secret_id, userId: r.user_id, displayName: r.display_name, foundAt: r.found_at }),
  );
}
