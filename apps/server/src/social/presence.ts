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

export function rekeyPresence(from: string, to: string): void {
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
}
