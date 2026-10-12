// Small shared client store for social state: local mutes, blocks, party and pending invites.
// The voice lane reads it:
//
//   import { isMuted, setMuted, onSocialChange, isPartyMember } from "../social/store.ts";
//   isMuted(sessionId)      true when muted locally OR blocked (either way) → don't play their audio
//   setMuted(sessionId, b)  local mute from the player list (kept per account, in localStorage)
//   isPartyMember(sid)      for "mute strangers" (party only)
//   onSocialChange(fn)      re-evaluate when any of this changes
//
// Session ids change on every travel, so mutes are stored by account id; a resolver installed by the
// social system maps the current room's session ids to account ids.

import type { PartyInviteMsg, PartyStateMsg } from "@firstlight/shared/net/social";

type Listener = () => void;

const MUTE_KEY = "fl.muted";
const listeners = new Set<Listener>();
const muted = new Set<string>(loadMuted());
let blocked = new Set<string>();
let party: PartyStateMsg = { id: null, leader: null, members: [] };
let invites: PartyInviteMsg[] = [];
let resolve: (sessionId: string) => string | undefined = () => undefined;
let selfUserId: () => string = () => "";

function loadMuted(): string[] {
  try {
    const v = JSON.parse(globalThis.localStorage?.getItem(MUTE_KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, 500) : [];
  } catch {
    return [];
  }
}

function saveMuted() {
  try {
    globalThis.localStorage?.setItem(MUTE_KEY, JSON.stringify([...muted]));
  } catch {}
}

function emit() {
  for (const fn of listeners) {
    try {
      fn();
    } catch (err) {
      console.warn("social listener failed", err);
    }
  }
}

/** Subscribe to any social change (mutes, blocks, party, invites). Returns an unsubscribe function. */
export function onSocialChange(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Installed by the social system for the current room: sessionId → account id. */
export function setSessionResolver(fn: (sessionId: string) => string | undefined, self: () => string) {
  resolve = fn;
  selfUserId = self;
  emit();
}

export function userOf(sessionId: string): string | undefined {
  return resolve(sessionId);
}

// ---- mutes (local only) ------------------------------------------------------------------------

export function setMuted(sessionId: string, on: boolean): void {
  const u = resolve(sessionId);
  if (u) setMutedUser(u, on);
}

export function setMutedUser(userId: string, on: boolean): void {
  if (on === muted.has(userId)) return;
  if (on) muted.add(userId);
  else muted.delete(userId);
  saveMuted();
  emit();
}

/** Muted locally, or blocked either way: don't play this player's voice. */
export function isMuted(sessionId: string): boolean {
  const u = resolve(sessionId);
  return !!u && (muted.has(u) || blocked.has(u));
}

export function isMutedLocally(sessionId: string): boolean {
  const u = resolve(sessionId);
  return !!u && muted.has(u);
}

// ---- blocks (server-persisted; this is the client's copy) -----------------------------------

export function setBlockedList(userIds: string[]): void {
  blocked = new Set(userIds);
  emit();
}

export function isBlocked(sessionOrUserId: string): boolean {
  return blocked.has(resolve(sessionOrUserId) ?? sessionOrUserId);
}

// ---- party --------------------------------------------------------------------------------------

/** Party view without positions (they change every second; listeners care about membership). */
function partyKey(p: PartyStateMsg): string {
  return JSON.stringify([p.id, p.leader, p.members.map((m) => [m.userId, m.name, m.level, m.online, m.body, m.roomId])]);
}

export function setParty(p: PartyStateMsg): void {
  const changed = partyKey(p) !== partyKey(party);
  party = p;
  if (changed) emit();
}

export function partyState(): PartyStateMsg {
  return party;
}

export function isPartyMember(sessionOrUserId: string): boolean {
  const u = resolve(sessionOrUserId) ?? sessionOrUserId;
  return !!party.id && u !== selfUserId() && party.members.some((m) => m.userId === u);
}

/** The room a party member is in on `body` (leader first): pass as partyLeaderRoomId when travelling there. */
export function partyRoomOn(body: string): string | undefined {
  if (!party.id) return undefined;
  const me = selfUserId();
  const there = party.members.filter((m) => m.userId !== me && m.online && m.body === body && m.roomId);
  return (there.find((m) => m.userId === party.leader) ?? there[0])?.roomId ?? undefined;
}

// ---- invites ------------------------------------------------------------------------------------

export function addInvite(inv: PartyInviteMsg): void {
  invites = [...invites.filter((i) => i.from !== inv.from), inv];
  emit();
}

export function removeInvite(from: string): void {
  const n = invites.length;
  invites = invites.filter((i) => i.from !== from);
  if (invites.length !== n) emit();
}

export function pendingInvites(now = Date.now()): PartyInviteMsg[] {
  return invites.filter((i) => i.expiresAt > now);
}
