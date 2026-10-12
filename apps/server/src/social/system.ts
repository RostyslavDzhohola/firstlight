// The social room system: parties, blocks, reports, admin moderation actions and session analytics
// for one BodyRoom. Registered in SYSTEM_FACTORIES by ./index.ts; state that must outlive a room
// (parties, presence, sessions) lives in process-wide modules.

import type { Client } from "@colyseus/core";
import { PF } from "@firstlight/shared/net/schema";
import { CLOSE, REPORT_REASONS, SOCIAL, type PartyMemberInfo, type PartyStateMsg } from "@firstlight/shared/net/social";
import { z } from "zod";
import type { BodyRoom } from "../world/BodyRoom.ts";
import type { PlayerActor } from "../world/actors.ts";
import type { RoomSystem } from "../world/systems.ts";
import { trackClientInfo, trackJoin, trackLeave, trackTick } from "./analytics.ts";
import { announceAll, applyVoiceMute, banAccount, kickUser, refusesReconnect, removePlayer, seatRefusal, setVoiceMuted } from "./moderation.ts";
import { parties, type Party } from "./parties.ts";
import { clearPresence, clearRoomPresence, liveActor, liveRooms, presenceOf, sendTo, setPresence } from "./presence.ts";
import { allow, clearLimits, sweepLimits } from "./limits.ts";
import { blockedBy, blockedEitherWay, onBlockHooks, setBlocked, storeReport } from "./store.ts";

export const SOCIAL_RULES = {
  /** A member who stays offline this long leaves their party. */
  PARTY_OFFLINE_MS: 120_000,
  INVITES_PER_MINUTE: 10,
  REPORTS_PER_10_MIN: 5,
  BLOCKS_PER_MINUTE: 20,
  MAX_BLOCKS: 200,
};

const id = z.string().min(1).max(64);
const partySchema = z.object({ action: z.enum(["invite", "accept", "decline", "leave", "kick"]), target: id.optional() });
const blockSchema = z.object({ target: id, on: z.boolean().optional() });
const reportSchema = z.object({ target: id, reason: z.enum(REPORT_REASONS), note: z.string().max(200).optional() });
const infoSchema = z.object({ backend: z.string().max(16), tier: z.string().max(16) });
const modSchema = z.object({
  action: z.enum(["kick", "ban", "voicemute", "goto", "bring", "announce"]),
  target: id.optional(),
  reason: z.string().max(200).optional(),
  on: z.boolean().optional(),
  text: z.string().max(200).optional(),
});

// ---- process-wide helpers ------------------------------------------------------------------------

const offlineTimers = new Map<string, ReturnType<typeof setTimeout>>();

let lastSweep = 0;
/** Drop stale rate-limit keys and names of players who are gone and partyless (bounded memory). */
function sweep(now: number): void {
  if (now - lastSweep < 60_000) return;
  lastSweep = now;
  sweepLimits(now);
  for (const u of lastNames.keys()) if (!presenceOf(u) && !parties.of(u)) lastNames.delete(u);
}

function memberInfo(userId: string): PartyMemberInfo {
  const live = liveActor(userId);
  const pres = presenceOf(userId);
  if (live) {
    const s = live.actor.state;
    return { userId, name: live.actor.identity.name, level: s.level, online: true, body: live.room.bodyDef.id, roomId: live.room.roomId, sessionId: live.actor.id, x: s.x, y: s.y, z: s.z };
  }
  return { userId, name: pres?.name ?? lastNames.get(userId) ?? "Wanderer", level: 0, online: false, body: null, roomId: null, sessionId: null, x: 0, y: 0, z: 0 };
}

const lastNames = new Map<string, string>();
/** sessionId → userId of live players (onPlayerLeave runs after the room dropped the actor). */
const sessionUser = new Map<string, string>();

/** A guest saved and got a new account id: follow it. */
export function rekeySessions(from: string, to: string): void {
  for (const [sid, u] of sessionUser) if (u === from) sessionUser.set(sid, to);
  const name = lastNames.get(from);
  if (name !== undefined) lastNames.set(to, name);
}

function partyState(p: Party | null): PartyStateMsg {
  if (!p) return { id: null, leader: null, members: [] };
  return { id: p.id, leader: p.leader, members: p.members.map(memberInfo) };
}

/** Push the party view to each user and keep PlayerState.party in step wherever they are. */
export function syncParty(userIds: Iterable<string>): void {
  for (const u of new Set(userIds)) {
    const p = parties.of(u);
    const live = liveActor(u);
    if (live) live.actor.state.party = p?.id ?? "";
    sendTo(u, "party:state", partyState(p));
  }
}

/** The room a party member is in on `body`, preferring the leader. Used by /api/play (D12 headroom). */
export function partyRoomFor(userId: string, body: string, requested?: string): string | undefined {
  const p = parties.of(userId);
  if (!p) return undefined;
  const rooms = new Map<string, string>(); // userId → roomId on that body
  for (const m of p.members) {
    if (m === userId) continue;
    const pres = presenceOf(m);
    if (pres && pres.body === body) rooms.set(m, pres.room.roomId);
  }
  if (requested && [...rooms.values()].includes(requested)) return requested;
  return rooms.get(p.leader) ?? rooms.values().next().value;
}

function scheduleOfflineLeave(userId: string): void {
  clearTimeout(offlineTimers.get(userId));
  if (!parties.of(userId)) return;
  const t = setTimeout(() => {
    offlineTimers.delete(userId);
    if (presenceOf(userId)) return;
    const r = parties.leave(userId);
    syncParty(r.affected);
  }, SOCIAL_RULES.PARTY_OFFLINE_MS);
  t.unref?.();
  offlineTimers.set(userId, t);
}

export function resetSocialTimers(): void {
  for (const t of offlineTimers.values()) clearTimeout(t);
  offlineTimers.clear();
  clearLimits();
}

export type BlockOutcome = { ok: true; changed: boolean } | { ok: false; reason: string };

/**
 * Block or unblock: the one path for the Tab list and the voice panel (same rate limit and list cap).
 * A block withdraws invites between the two; only a new block runs the voice hooks (hang up, and
 * rotate relay credentials when the pair was linked), so repeating it changes nothing (F12 B1).
 */
export function applyBlock(blocker: string, target: string, on: boolean, now = Date.now()): BlockOutcome {
  if (blocker === target) return { ok: false, reason: "that's you" };
  if (!allow(`blk:${blocker}`, SOCIAL_RULES.BLOCKS_PER_MINUTE, 60_000, now)) return { ok: false, reason: "slow down" };
  const current = blockedBy(blocker);
  const had = current.includes(target);
  if (on && !had && current.length >= SOCIAL_RULES.MAX_BLOCKS) return { ok: false, reason: "your block list is full" };
  const changed = had !== on && setBlocked(blocker, target, on, now);
  if (on) {
    for (const inv of parties.cancelBetween(blocker, target)) sendTo(inv.to, "party:invite-closed", { from: inv.from, to: inv.to, reason: "cancelled" });
    if (changed) for (const h of onBlockHooks) h(blocker, target);
  }
  return { ok: true, changed };
}

// ---- the room system ------------------------------------------------------------------------------

export function createSocialSystem(room: BodyRoom): RoomSystem {
  liveRooms.add(room);
  let lastSlow = 0;

  const actorOf = (c: Client) => room.actors.get(c.sessionId);
  const deny = (c: Client, action: string, reason: string) => c.send("denied", { action, reason });
  const toast = (c: Client, text: string, kind = "info") => c.send("toast", { text, kind });
  /** A player in this copy by sessionId or userId. */
  const inRoom = (target: string): PlayerActor | undefined => {
    const bySession = room.actors.get(target);
    if (bySession) return bySession;
    for (const a of room.actors.values()) if (a.identity.userId === target) return a;
    return undefined;
  };
  /** A player anywhere by sessionId (this copy) or userId. */
  const anywhere = (target: string): { room: BodyRoom; actor: PlayerActor } | null => {
    const here = inRoom(target);
    return here ? { room, actor: here } : liveActor(target);
  };
  const dist = (a: PlayerActor, b: PlayerActor) => Math.hypot(a.state.x - b.state.x, a.state.y - b.state.y, a.state.z - b.state.z);

  room.onMessage("party", partySchema, (c, m) => {
    const me = actorOf(c);
    if (!me || me.identity.loadtest) return;
    const uid = me.identity.userId;
    switch (m.action) {
      case "invite": {
        const t = m.target ? inRoom(m.target) : undefined;
        if (!t) return deny(c, "party", "that player isn't in this world copy");
        if (t === me) return deny(c, "party", "you can't invite yourself");
        if (dist(me, t) > SOCIAL.INVITE_RANGE_M) return deny(c, "party", "too far away (30 m)");
        if (blockedEitherWay(uid, t.identity.userId)) return deny(c, "party", "you can't invite this player");
        if (!allow(`inv:${uid}`, SOCIAL_RULES.INVITES_PER_MINUTE, 60_000)) return deny(c, "party", "slow down");
        const r = parties.invite(uid, me.identity.name, t.identity.userId);
        if (!r.ok) return deny(c, "party", r.reason);
        t.client.send("party:invite", { from: uid, fromName: me.identity.name, partyId: r.invite.partyId, expiresAt: r.invite.expiresAt });
        toast(c, `Party invite sent to ${t.identity.name}`);
        return;
      }
      case "accept": {
        if (!m.target) return;
        const r = parties.accept(uid, m.target);
        if (!r.ok) return deny(c, "party", r.reason);
        sendTo(m.target, "party:invite-closed", { from: m.target, to: uid, reason: "accepted" });
        for (const other of r.party.members) if (other !== uid) sendTo(other, "toast", { text: `${me.identity.name} joined the party`, kind: "info" });
        syncParty([...r.party.members, ...r.leftMembers]);
        return;
      }
      case "decline": {
        if (!m.target) return;
        const inv = parties.decline(uid, m.target);
        if (inv) {
          sendTo(m.target, "party:invite-closed", { from: m.target, to: uid, reason: "declined" });
          sendTo(m.target, "toast", { text: `${me.identity.name} declined your invite`, kind: "info" });
        }
        return;
      }
      case "leave": {
        const r = parties.leave(uid);
        for (const other of r.affected) if (other !== uid) sendTo(other, "toast", { text: `${me.identity.name} left the party`, kind: "info" });
        syncParty(r.affected.length ? r.affected : [uid]);
        return;
      }
      case "kick": {
        if (!m.target) return;
        const r = parties.kick(uid, m.target);
        if (!r.ok) return deny(c, "party", r.reason);
        sendTo(m.target, "toast", { text: "You were removed from the party", kind: "warn" });
        syncParty(r.affected);
        return;
      }
    }
  });

  room.onMessage("social:block", blockSchema, (c, m) => {
    const me = actorOf(c);
    if (!me || me.identity.loadtest) return;
    const uid = me.identity.userId;
    const on = m.on ?? true;
    // Block someone who is playing (this copy or anywhere); unblock anyone on your list.
    const target = inRoom(m.target)?.identity.userId ?? (liveActor(m.target) || (!on && blockedBy(uid).includes(m.target)) ? m.target : undefined);
    if (!target) return deny(c, "block", "player not found");
    if (target === uid) return;
    const r = applyBlock(uid, target, on);
    if (!r.ok) return deny(c, "block", r.reason);
    c.send("social:blocked", { userIds: blockedBy(uid) });
    toast(c, on ? "Blocked. You won't hear or get invites from them." : "Unblocked.");
  });

  room.onMessage("report", reportSchema, (c, m) => {
    const me = actorOf(c);
    if (!me || me.identity.loadtest) return;
    const found = anywhere(m.target);
    if (!found) return deny(c, "report", "player not found");
    const t = found.actor;
    const target = t.identity.userId;
    if (target === me.identity.userId) return;
    if (!allow(`rep:${me.identity.userId}:${target}`, 1, 10 * 60_000) || !allow(`rep:${me.identity.userId}`, SOCIAL_RULES.REPORTS_PER_10_MIN, 10 * 60_000)) {
      return toast(c, "Report already sent. Thanks.");
    }
    const note = m.note?.replace(/\s+/g, " ").trim();
    const name = t.identity.name;
    storeReport({
      reporter: me.identity.userId,
      target,
      body: found.room.bodyDef.id,
      pos: [t.state.x, t.state.y, t.state.z],
      reason: `${m.reason}${name ? ` [${name}]` : ""}${note ? `: ${note}` : ""}`,
    });
    toast(c, "Report sent. Thanks — an admin will look at it.");
  });

  room.onMessage("client:info", infoSchema, (c, m) => {
    const me = actorOf(c);
    if (!me) return;
    trackClientInfo(me.identity.userId, m.backend.toLowerCase(), m.tier.toLowerCase());
    // The client's social snapshot (its handlers are attached by now).
    c.send("party:state", partyState(parties.of(me.identity.userId)));
    c.send("social:blocked", { userIds: blockedBy(me.identity.userId) });
    for (const inv of parties.pendingFor(me.identity.userId)) c.send("party:invite", { from: inv.from, fromName: inv.fromName, partyId: inv.partyId, expiresAt: inv.expiresAt });
  });

  room.onMessage("mod", modSchema, (c, m) => {
    const me = actorOf(c);
    if (!me) return;
    if (!me.identity.admin) return deny(c, "mod", "admins only");
    if (m.action === "announce") {
      announceAll(m.text ?? "");
      return;
    }
    const t = m.target ? anywhere(m.target) : null;
    if (!t) return deny(c, "mod", "player not found");
    const uid = t.actor.identity.userId;
    switch (m.action) {
      case "kick":
        if (t.actor === me) return deny(c, "mod", "that's you");
        kickUser(uid, m.reason || "Removed by an admin");
        toast(c, `Kicked ${t.actor.identity.name}`);
        return;
      case "ban":
        if (t.actor === me) return deny(c, "mod", "that's you");
        banAccount(uid, m.reason || "banned in game", me.identity.userId);
        toast(c, `Banned ${t.actor.identity.name} (account and network)`);
        return;
      case "voicemute": {
        const on = m.on ?? !(t.actor.state.flags & PF.VOICE_MUTED);
        setVoiceMuted(uid, on);
        toast(c, `${t.actor.identity.name}: voice ${on ? "muted" : "unmuted"}`);
        return;
      }
      case "goto":
        if (t.room !== room) return deny(c, "mod", "not in this world copy");
        room.admin(c, "teleport", { x: t.actor.state.x, y: t.actor.state.y, z: t.actor.state.z });
        return;
      case "bring":
        if (t.room !== room) return deny(c, "mod", "not in this world copy");
        room.admin(c, "teleport", { x: me.state.x, y: me.state.y, z: me.state.z, target: t.actor.id });
        return;
    }
  });

  return {
    onPlayerJoin(sessionId) {
      const a = room.playerById(sessionId);
      if (!a) return;
      const uid = a.identity.userId;
      // A seat reserved before a kick or ban must not get them back in.
      const refusal = a.identity.loadtest ? null : seatRefusal(uid);
      if (refusal) {
        removePlayer(room, a, refusal === "kicked" ? CLOSE.KICKED : CLOSE.BANNED, refusal === "kicked" ? "Removed by an admin" : "Banned by an admin");
        return;
      }
      sessionUser.set(sessionId, uid);
      setPresence({ userId: uid, name: a.identity.name, room, sessionId, body: room.bodyDef.id });
      lastNames.set(uid, a.identity.name);
      clearTimeout(offlineTimers.get(uid));
      offlineTimers.delete(uid);
      applyVoiceMute(a);
      if (!room.metadata?.loadtest) trackJoin(a, room.bodyDef.id);
      const p = parties.of(uid);
      a.state.party = p?.id ?? "";
      if (p) syncParty(p.members);
    },

    onPlayerLeave(sessionId) {
      const u = sessionUser.get(sessionId);
      if (!u) return;
      sessionUser.delete(sessionId);
      trackLeave(u, sessionId);
      if (clearPresence(u, sessionId)) {
        scheduleOfflineLeave(u);
        const p = parties.of(u);
        if (p) syncParty(p.members.filter((x) => x !== u));
      }
    },

    canReconnect(sessionId) {
      if (refusesReconnect(sessionId)) return false;
      const a = room.playerById(sessionId);
      return !(a && !a.identity.loadtest && seatRefusal(a.identity.userId));
    },

    tick(_dt, now) {
      if (now - lastSlow < 1000) return;
      lastSlow = now;
      sweep(now);
      for (const inv of parties.expire(now)) sendTo(inv.from, "party:invite-closed", { from: inv.from, to: inv.to, reason: "expired" });
      for (const a of room.actors.values()) {
        trackTick(a.identity.userId, now);
        // Members in other copies/bodies move: refresh positions for compass markers.
        const p = parties.of(a.identity.userId);
        if (p) a.client.send("party:state", partyState(p));
      }
    },

    dispose() {
      liveRooms.delete(room);
      clearRoomPresence(room);
    },
  };
}
