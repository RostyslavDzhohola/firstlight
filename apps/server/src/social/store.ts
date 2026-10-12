// Persistence the social systems use: blocks, reports, bans and the play-session log.
//
// Uses game.db (the persistence API in src/db) whenever the accounts module has opened it, so
// production and the accounts-backed tests write real rows. Without a database (in-memory dev
// servers, plain seam tests) blocks, reports and bans fall back to process memory and analytics
// are skipped.

import { gameDb, stmt, type Db } from "../db/game-db.ts";
import {
  banUser,
  blockUser,
  endSession,
  fileReport,
  isBanned,
  isBlockedEitherWay,
  listBlocked,
  startSession,
  unblockUser,
  updateSession,
  type SessionProgress,
} from "../db/index.ts";

/** The open game.db, or null when the server runs without one. */
export function currentDb(): Db | null {
  try {
    return gameDb();
  } catch {
    return null;
  }
}

// ---- memory fallback ---------------------------------------------------------------------------

const memBlocks = new Map<string, Set<string>>(); // userId → blocked userIds
const memBans = new Set<string>();
const memReports: { reporter: string; target: string; body: string | null; pos: [number, number, number] | null; reason: string; createdAt: number }[] = [];

/** Test hook: forget the in-memory fallback state. */
export function resetMemoryStore(): void {
  memBlocks.clear();
  memBans.clear();
  memReports.length = 0;
}

// ---- blocks --------------------------------------------------------------------------------------

export function setBlocked(userId: string, target: string, on: boolean, now = Date.now()): boolean {
  if (userId === target) return false;
  const db = currentDb();
  if (db) return on ? blockUser(db, userId, target, now) : unblockUser(db, userId, target);
  let set = memBlocks.get(userId);
  if (!set) memBlocks.set(userId, (set = new Set()));
  const had = set.has(target);
  if (on) set.add(target);
  else set.delete(target);
  return had !== on;
}

export function blockedBy(userId: string): string[] {
  const db = currentDb();
  if (db) return listBlocked(db, userId);
  return [...(memBlocks.get(userId) ?? [])];
}

/** True when either player blocked the other: no voice, no party invites between them. */
export function blockedEitherWay(a: string, b: string): boolean {
  if (a === b) return false;
  const db = currentDb();
  if (db) return isBlockedEitherWay(db, a, b);
  return !!memBlocks.get(a)?.has(b) || !!memBlocks.get(b)?.has(a);
}

// ---- reports -------------------------------------------------------------------------------------

export interface ReportFiling {
  reporter: string;
  target: string;
  body: string | null;
  pos: [number, number, number] | null;
  reason: string;
  now?: number;
}

export function storeReport(r: ReportFiling): number {
  const db = currentDb();
  const now = r.now ?? Date.now();
  if (db) return fileReport(db, { reporter: r.reporter, target: r.target, body: r.body, pos: r.pos, reason: r.reason, now });
  memReports.push({ reporter: r.reporter, target: r.target, body: r.body, pos: r.pos, reason: r.reason, createdAt: now });
  return memReports.length;
}

export function memoryReports(): readonly (typeof memReports)[number][] {
  return memReports;
}

// ---- bans ----------------------------------------------------------------------------------------

/** Ban an account and (by default) the IP hash it last played from. Returns the ban id (0 in memory mode). */
export function storeBan(input: { userId: string; reason: string; createdBy: string | null; until?: number | null }): number {
  const db = currentDb();
  if (db) return banUser(db, { userId: input.userId, reason: input.reason, createdBy: input.createdBy, until: input.until ?? null });
  memBans.add(input.userId);
  return 0;
}

export function userBanned(userId: string, now = Date.now()): boolean {
  const db = currentDb();
  if (db) return isBanned(db, userId, now);
  return memBans.has(userId);
}

/** Clear the account's banned_until once no active ban remains (after lifting one ban by id). */
export function clearBannedUntilIfFree(db: Db, userId: string, now = Date.now()): void {
  if (!isBanned(db, userId, now)) stmt(db, "UPDATE account SET banned_until = NULL WHERE user_id = ?").run(userId);
}

// ---- play sessions (analytics) -------------------------------------------------------------------

export function sessionStart(userId: string, now = Date.now()): number | null {
  const db = currentDb();
  return db ? startSession(db, { userId, startedAt: now }) : null;
}

export function sessionUpdate(id: number | null, p: SessionProgress): void {
  const db = currentDb();
  if (db && id !== null) updateSession(db, id, p);
}

export function sessionEnd(id: number | null, p: SessionProgress & { endedAt?: number }): void {
  const db = currentDb();
  if (db && id !== null) endSession(db, id, p);
}

/** Record the renderer backend and tier the client reported (first report wins). */
export function sessionClient(id: number | null, backend: string, tier: string): void {
  const db = currentDb();
  if (db && id !== null) {
    stmt(db, "UPDATE session_log SET backend = COALESCE(backend, ?), tier = COALESCE(tier, ?) WHERE id = ?").run(backend, tier, id);
  }
}
