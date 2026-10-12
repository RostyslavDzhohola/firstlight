// Moderation (SPEC §6.11): kick, ban (account + IP hash), voice-mute and announcements.
// Kicked and banned players are disconnected at once and can't reconnect into their old seat;
// /api/play refuses them (bans: until lifted; kicks: for a short cooldown).

import { PF } from "@firstlight/shared/net/schema";
import { CLOSE, SOCIAL } from "@firstlight/shared/net/social";
import type { BodyRoom } from "../world/BodyRoom.ts";
import type { PlayerActor } from "../world/actors.ts";
import { turnCredentials } from "../world/voice/turn.ts";
import { liveActor, liveRooms } from "./presence.ts";
import { banIpHash, lastIpHashOf, networkBanned, storeBan, userBanned } from "./store.ts";

const kickedUntil = new Map<string, number>();
const voiceMuted = new Set<string>();
/** Session ids removed on purpose: their reconnection seat is refused. */
const noReconnect = new Set<string>();

/** Why /api/play must refuse this account right now, or null. */
export function playRefusal(userId: string, now = Date.now()): "banned" | "kicked" | null {
  if (userBanned(userId, now)) return "banned";
  const until = kickedUntil.get(userId);
  if (until !== undefined) {
    if (until > now) return "kicked";
    kickedUntil.delete(userId);
  }
  return null;
}

/**
 * Refusal for a player already holding a seat (join or reconnect, which skip /api/play's checks):
 * account ban, kick cooldown, or a ban on the network the account last played from.
 */
export function seatRefusal(userId: string, now = Date.now()): "banned" | "kicked" | null {
  return playRefusal(userId, now) ?? (networkBanned(userId, now) ? "banned" : null);
}

export function refusesReconnect(sessionId: string): boolean {
  return noReconnect.has(sessionId);
}

/** Disconnect a player now, with a reason the client shows. No reconnection window. */
export function removePlayer(room: BodyRoom, actor: PlayerActor, code: number, reason: string): void {
  noReconnect.add(actor.id);
  // Forget the session id after the reconnection window could have expired.
  setTimeout(() => noReconnect.delete(actor.id), 120_000).unref?.();
  try {
    actor.client.send("kicked", { reason, code });
  } catch {}
  room.kickClient(actor.id, code, reason);
}

export function kickUser(userId: string, reason = "Removed by an admin", now = Date.now()): boolean {
  kickedUntil.set(userId, now + SOCIAL.KICK_COOLDOWN_MS);
  const live = liveActor(userId);
  if (!live) return false;
  removePlayer(live.room, live.actor, CLOSE.KICKED, reason);
  return true;
}

/** Ban the account and the IP hash it last played from; disconnect it if online. Returns the ban id. */
export function banAccount(userId: string, reason: string, createdBy: string | null): number {
  const id = storeBan({ userId, reason: reason.slice(0, 200), createdBy });
  void turnCredentials.revokeUser(userId); // voice relay credentials end with the ban
  const live = liveActor(userId);
  if (live) removePlayer(live.room, live.actor, CLOSE.BANNED, "Banned by an admin");
  // The network ban also removes other accounts playing from that network right now (not admins).
  const hash = banIpHash(id);
  if (hash) {
    for (const room of liveRooms) {
      for (const a of [...room.actors.values()]) {
        if (a.identity.userId === userId || a.identity.admin || a.identity.loadtest) continue;
        if (lastIpHashOf(a.identity.userId) === hash) removePlayer(room, a, CLOSE.BANNED, "Banned by an admin");
      }
    }
  }
  return id;
}

export function setVoiceMuted(userId: string, on: boolean): void {
  if (on) voiceMuted.add(userId);
  else voiceMuted.delete(userId);
  const live = liveActor(userId);
  if (live) applyVoiceMute(live.actor);
}

/** Admin voice-mute: the voice relay must not forward this player's signalling. */
export function isVoiceMuted(userId: string): boolean {
  return voiceMuted.has(userId);
}

export function applyVoiceMute(a: PlayerActor): void {
  if (voiceMuted.has(a.identity.userId)) a.state.flags |= PF.VOICE_MUTED;
  else a.state.flags &= ~PF.VOICE_MUTED;
}

/** Banner text to every player in every copy. */
export function announceAll(text: string): number {
  const t = text.trim().slice(0, 200);
  if (!t) return 0;
  let n = 0;
  for (const room of liveRooms) {
    room.broadcast("announce", { text: t });
    n += room.clients.length;
  }
  return n;
}

export function rekeyModeration(from: string, to: string): void {
  const k = kickedUntil.get(from);
  if (k !== undefined) {
    kickedUntil.delete(from);
    kickedUntil.set(to, k);
  }
  if (voiceMuted.delete(from)) voiceMuted.add(to);
}

export function resetModeration(): void {
  kickedUntil.clear();
  voiceMuted.clear();
  noReconnect.clear();
}
