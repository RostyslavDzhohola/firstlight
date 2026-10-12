// Process-wide presence: which room each signed-in player is in right now, so parties and
// moderation can reach a player in another copy or on another body (one server process, SPEC §5.1).

import type { Client } from "@colyseus/core";
import type { BodyRoom } from "../world/BodyRoom.ts";
import type { PlayerActor } from "../world/actors.ts";

export interface Presence {
  userId: string;
  name: string;
  room: BodyRoom;
  sessionId: string;
  body: string;
}

const byUser = new Map<string, Presence>();

// Recent co-presence: who could have seen or heard whom (reports reach only those players).
/** A player can be reported for this long after leaving a copy you were in together. */
export const SEEN_WITHIN_MS = 10 * 60_000;
const MAX_STINTS = 8;
interface Stint {
  roomId: string;
  sessionId: string;
  from: number;
  to: number | null;
}
const stints = new Map<string, Stint[]>(); // userId → recent room stints, oldest first
/** Every live BodyRoom in this process (for /admin, announcements and cross-room lookups). */
export const liveRooms = new Set<BodyRoom>();

export function setPresence(p: Presence): void {
  byUser.set(p.userId, p);
}

/** Forget the user's presence if it still points at this session (a newer session wins). */
export function clearPresence(userId: string, sessionId: string): boolean {
  const cur = byUser.get(userId);
  if (!cur || cur.sessionId !== sessionId) return false;
  byUser.delete(userId);
  return true;
}

export function clearRoomPresence(room: BodyRoom): void {
  for (const [u, p] of byUser) if (p.room === room) byUser.delete(u);
}

export function presenceOf(userId: string): Presence | null {
  return byUser.get(userId) ?? null;
}

/** A player entered a room copy (session). */
export function stintStart(userId: string, roomId: string, sessionId: string, now = Date.now()): void {
  const list = (stints.get(userId) ?? []).filter((s) => s.to === null || now - s.to < SEEN_WITHIN_MS);
  list.push({ roomId, sessionId, from: now, to: null });
  stints.set(userId, list.slice(-MAX_STINTS));
}

/** That session left its copy (idempotent). */
export function stintEnd(userId: string, sessionId: string, now = Date.now()): void {
  for (const s of stints.get(userId) ?? []) if (s.sessionId === sessionId && s.to === null) s.to = now;
}

/** Were `a` and `b` in the same room copy at the same time, within the last SEEN_WITHIN_MS? */
export function sharedCopyRecently(a: string, b: string, now = Date.now()): boolean {
  const theirs = stints.get(b);
  if (!theirs) return false;
  for (const x of stints.get(a) ?? []) {
    for (const y of theirs) {
      if (x.roomId !== y.roomId) continue;
      const start = Math.max(x.from, y.from);
      const end = Math.min(x.to ?? now, y.to ?? now);
      if (start <= end && now - end < SEEN_WITHIN_MS) return true;
    }
  }
  return false;
}

/** Forget stints that ended long enough ago (bounded memory). */
export function sweepStints(now = Date.now()): void {
  for (const [u, list] of stints) {
    const keep = list.filter((s) => s.to === null || now - s.to < SEEN_WITHIN_MS);
    if (keep.length) stints.set(u, keep);
    else stints.delete(u);
  }
}

export function rekeyPresence(from: string, to: string): void {
  const st = stints.get(from);
  if (st) {
    stints.delete(from);
    stints.set(to, [...(stints.get(to) ?? []), ...st].slice(-MAX_STINTS));
  }
  const p = byUser.get(from);
  if (!p) return;
  byUser.delete(from);
  byUser.set(to, { ...p, userId: to });
}

/** The live actor of a user, wherever they are. */
export function liveActor(userId: string): { room: BodyRoom; actor: PlayerActor } | null {
  const p = byUser.get(userId);
  if (!p) return null;
  const actor = p.room.actors.get(p.sessionId);
  return actor ? { room: p.room, actor } : null;
}

export function sendTo(userId: string, type: string, msg: unknown): boolean {
  const live = liveActor(userId);
  if (!live) return false;
  (live.actor.client as Client).send(type, msg);
  return true;
}

export function clearAllPresence(): void {
  byUser.clear();
  stints.clear();
}
