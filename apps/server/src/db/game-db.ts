// Opens game.db (better-sqlite3, WAL) and runs migrations. All persistence functions take the handle
// as their first argument; rooms get it from `gameDb()` once the server has opened it.

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { migrate } from "./schema.ts";

export type Db = Database.Database;
type Stmt = Database.Statement;

export function openGameDb(path: string): Db {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("busy_timeout = 5000");
  migrate(db);
  return db;
}

let current: Db | null = null;

/** Set by the accounts module at boot; rooms call `gameDb()` to reach the persistence API. */
export function setGameDb(db: Db | null): void {
  current = db;
}

export function gameDb(): Db {
  if (!current) throw new Error("game.db is not open");
  return current;
}

const cache = new WeakMap<Db, Map<string, Stmt>>();

/** Prepared-statement cache per database handle. */
export function stmt(db: Db, sql: string): Stmt {
  let m = cache.get(db);
  if (!m) {
    m = new Map();
    cache.set(db, m);
  }
  let s = m.get(sql);
  if (!s) {
    s = db.prepare(sql);
    m.set(sql, s);
  }
  return s;
}

/** Run `fn` in an IMMEDIATE transaction (takes the write lock up front). Nested calls become savepoints. */
export function tx<T>(db: Db, fn: () => T): T {
  return db.transaction(fn).immediate();
}

export function parseJson<T>(text: string | null | undefined, fallback: T): T {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}
