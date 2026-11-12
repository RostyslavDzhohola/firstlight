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
  ip: string;
  roomId: string;
  until: number;
}

/** Seats asked for or handed out and not joined yet, by account. */
const pending = new Map<string, Slot>();

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
  for (const [u, s] of pending) if (s.ip === ip && u !== userId) seen.add(u);
  return seen.size;
}

/** Agents in a room copy or holding a seat in it, not counting `userId`. */
export function agentsInRoom(roomId: string, userId: string, now = Date.now()): number {
  prune(now);
  const seen = new Set<string>();
  const room = matchMaker.getLocalRoomById(roomId) as unknown as RoomLike | undefined;
  if (room?.actors) for (const id of bodiesIn(room)) if (id.agent && id.userId !== userId) seen.add(id.userId);
  for (const [u, s] of pending) if (s.roomId === roomId && u !== userId) seen.add(u);
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

/**
 * Before the matchmaker: may this agent ask for a seat from `ip`? Claims its slot when it may (so
 * concurrent requests can't all pass); `release` it if no seat comes of it, `seated` when one does.
 */
export function claimAgentSlot(identity: Identity, ip: string, now = Date.now()): AgentRefusal | null {
  if (!AGENT_RULES.enabled) return { error: AGENT_REFUSAL.OFF, message: "AI agents can't play on this server right now (AGENTS_ENABLED is off)." };
  const have = agentsFromIp(ip, identity.userId, now);
  if (have >= AGENT_RULES.perIp) {
    return { error: AGENT_REFUSAL.LIMIT, message: `Too many AI agents are playing from this address (${have} of ${AGENT_RULES.perIp}). Close one and try again.` };
  }
  pending.set(identity.userId, { ip, roomId: "", until: now + AGENT_RULES.claimTtlMs });
  return null;
}

/** The matchmaker picked this room for the agent (called inside its lock). */
export function agentSeated(userId: string, roomId: string, now = Date.now()): void {
  const s = pending.get(userId);
  if (s) pending.set(userId, { ip: s.ip, roomId, until: now + AGENT_RULES.seatTtlMs });
}

/** No seat came of the claim (queue, refusal, error). */
export function releaseAgentSlot(userId: string): void {
  pending.delete(userId);
}

/** The agent's body is in a room now: its pending seat is used. */
export function agentJoined(userId: string): void {
  pending.delete(userId);
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
