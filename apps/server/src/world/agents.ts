// AI agents in the rooms (D-agents-1..3): who may take a seat as one, and how many at once.
//
// An agent is a player whose /api/play request says so (shared net/agents.ts). The limits keep
// agents from crowding people out: a switch (env.agents), a cap per address and a cap per room copy.
// They count bodies in the world (connected, and lingering after a drop) and seats handed out but not
// used yet; an agent coming back for its own body never counts against itself.

import { matchMaker } from "@colyseus/core";
import { AGENT_REFUSAL } from "@firstlight/shared/net/agents";
import type { Identity } from "../auth/identity.ts";
import { env } from "../env.ts";

/** The limits (read per request; tests change them and put them back). */
export const AGENT_RULES = {
  get enabled(): boolean {
    return env.agents;
  },
  set enabled(v: boolean) {
    env.agents = v;
  },
  /** Agents playing at once from one address. Loopback counts like any address (local play: raise AGENTS_PER_IP). */
  perIp: env.agentsPerIp,
  /** Agents in one room copy (of NET.MAX_CLIENTS seats). */
  perRoom: env.agentsPerRoom,
  /** A seat handed out but not joined stops counting after this (the room's reservation is 8 s). */
  seatTtlMs: 10_000,
  /** A request still waiting for the matchmaker stops counting after this. */
  claimTtlMs: 60_000,
};

export interface AgentRefusal {
  error: string;
  message: string;
}

interface Slot {
  userId: string;
  ip: string;
  roomId: string;
  until: number;
}

/**
 * Seats asked for or handed out and not joined yet, one entry per /api/play request, by its claim
 * handle (`Identity.agentClaim`). An account may hold several (PLAY_LIMITS.userSeats): each one is
 * its own, so a request that fails releases only what it claimed, and every outstanding seat counts
 * until it is used or expires (review 2026-11-12 agent-kit #1).
 */
const pending = new Map<string, Slot>();
let claimSeq = 0;

interface RoomLike {
  actors: Map<string, { identity: Identity; superseded?: boolean }>;
  lingering?: Map<string, { actor: { identity: Identity; superseded?: boolean } }>;
}

/** Every room this process runs (a function, so this module doesn't import the rooms). */
export const agentRooms: { current: () => Iterable<RoomLike & { roomId: string }> } = { current: () => [] };

function* bodiesIn(room: RoomLike): Iterable<Identity> {
  for (const a of room.actors.values()) if (!a.superseded) yield a.identity;
  for (const l of room.lingering?.values() ?? []) if (!l.actor.superseded) yield l.actor.identity;
}

function prune(now: number): void {
  for (const [k, s] of pending) if (s.until <= now) pending.delete(k);
}

/** Agents from `ip` in the world or on their way in, not counting `userId`. */
export function agentsFromIp(ip: string, userId: string, now = Date.now()): number {
  prune(now);
  const seen = new Set<string>();
  for (const room of agentRooms.current()) for (const id of bodiesIn(room)) if (id.agent && id.agentIp === ip && id.userId !== userId) seen.add(id.userId);
  for (const s of pending.values()) if (s.ip === ip && s.userId !== userId) seen.add(s.userId);
  return seen.size;
}

/** Agents in a room copy or holding a seat in it, not counting `userId`. */
export function agentsInRoom(roomId: string, userId: string, now = Date.now()): number {
  prune(now);
  const seen = new Set<string>();
  const room = matchMaker.getLocalRoomById(roomId) as unknown as RoomLike | undefined;
  if (room?.actors) for (const id of bodiesIn(room)) if (id.agent && id.userId !== userId) seen.add(id.userId);
  for (const s of pending.values()) if (s.roomId === roomId && s.userId !== userId) seen.add(s.userId);
  return seen.size;
}

/** May this room copy take one more agent (`userId`)? */
export function roomTakesAgent(roomId: string, userId: string): boolean {
  return agentsInRoom(roomId, userId) < AGENT_RULES.perRoom;
}

export const ROOM_FULL_OF_AGENTS: AgentRefusal = {
  error: AGENT_REFUSAL.LIMIT,
  message: "Every copy of this world already has its share of AI agents. Try another world, or again later.",
};

const OFF: AgentRefusal = { error: AGENT_REFUSAL.OFF, message: "AI agents can't play on this server right now (AGENTS_ENABLED is off)." };

/**
 * Before the matchmaker: may this agent ask for a seat from `ip`? Claims a slot of its own when it
 * may (so concurrent requests can't all pass) and returns the claim's handle: `releaseAgentSlot` it
 * if no seat comes of it, `agentSeated` when one does; the room uses it up (`useAgentSeat`).
 */
export function claimAgentSlot(identity: Identity, ip: string, now = Date.now()): { claim: string } | { refused: AgentRefusal } {
  if (!AGENT_RULES.enabled) return { refused: OFF };
  const have = agentsFromIp(ip, identity.userId, now);
  if (have >= AGENT_RULES.perIp) {
    return { refused: { error: AGENT_REFUSAL.LIMIT, message: `Too many AI agents are playing from this address (${have} of ${AGENT_RULES.perIp}). Close one and try again.` } };
  }
  const claim = `agent:${++claimSeq}`;
  pending.set(claim, { userId: identity.userId, ip, roomId: "", until: now + AGENT_RULES.claimTtlMs });
  return { claim };
}

/** The matchmaker picked this room for the claim (called inside its lock). */
export function agentSeated(claim: string | undefined, roomId: string, now = Date.now()): void {
  const s = claim ? pending.get(claim) : undefined;
  if (s) pending.set(claim!, { ...s, roomId, until: now + AGENT_RULES.seatTtlMs });
}

/** No seat came of this claim, or its seat was refused at the door: only this claim goes. */
export function releaseAgentSlot(claim: string | undefined): void {
  if (claim) pending.delete(claim);
}

/**
 * The room is about to put this agent's body in (BodyRoom.onJoin, synchronously with the join): its
 * seat is used up, and admission is checked again against everything else that counts right now
 * (bodies and other outstanding seats). A seat that is no longer counted (expired, released, another
 * room's) can't be used. Returns the refusal's code, or null when the agent may come in.
 */
export function useAgentSeat(identity: Identity, roomId: string, now = Date.now()): string | null {
  prune(now);
  const claim = identity.agentClaim;
  const s = claim ? pending.get(claim) : undefined;
  if (claim) pending.delete(claim);
  if (!s || s.userId !== identity.userId || s.roomId !== roomId) return "seat expired";
  if (!AGENT_RULES.enabled) return AGENT_REFUSAL.OFF;
  if (agentsFromIp(s.ip, s.userId, now) >= AGENT_RULES.perIp || agentsInRoom(roomId, s.userId, now) >= AGENT_RULES.perRoom) return AGENT_REFUSAL.LIMIT;
  return null;
}

/** Outstanding agent claims and seats (tests). */
export function agentSlotsPending(now = Date.now()): number {
  prune(now);
  return pending.size;
}

/** Agents in the public world right now (ops: /stats, /api/online). */
export function agentsOnline(): number {
  const seen = new Set<string>();
  for (const room of agentRooms.current()) for (const a of room.actors.values()) if (a.identity.agent && !a.identity.loadtest && !a.superseded) seen.add(a.identity.userId);
  return seen.size;
}

/** Tests: forget every pending seat. */
export function resetAgentSlots(): void {
  pending.clear();
}
