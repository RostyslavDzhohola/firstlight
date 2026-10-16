// POST /api/play: the only way into a room. Picks the fullest suitable copy of a body, enforces
// the per-body copy cap, the global cap and party headroom (D12), then reserves a seat.

import { matchMaker } from "@colyseus/core";
import { BODY_IDS, type BodyId } from "@firstlight/shared";
import type { PlayResponse } from "@firstlight/shared/net/protocol";
import type { Identity } from "../auth/identity.ts";
import { openSandbox, sandboxOf } from "../sandbox.ts";
import { identityIsAdmin } from "./adminMode.ts";
import type { BodyRoomMetadata } from "./BodyRoom.ts";
import { characterRepo } from "./characters.ts";
import { CLOSE, hub } from "./hub.ts";

export interface MatchmakingLimits {
  maxClients: number;
  soloFillLimit: number;
  maxCopiesPerBody: number;
  globalCap: number;
}

export interface PlayInput {
  body: BodyId;
  starter?: number;
  palette?: number;
  look?: number;
  partyLeaderRoomId?: string;
  partySize?: number;
  loadtest?: boolean;
  /** The admin's sandbox copy of the body (D-admin-3; enterSandbox first). */
  sandbox?: boolean;
}

const locks = new Map<string, Promise<unknown>>();

/** Serialise work per key (room creation per body) without blocking other bodies. */
async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((r) => (release = r));
  const chained = prev.then(() => next);
  locks.set(key, chained);
  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (locks.get(key) === chained) locks.delete(key);
  }
}

const queue = new Map<string, number>(); // userId → first seen (ms)

export function isBodyId(v: unknown): v is BodyId {
  return typeof v === "string" && (BODY_IDS as readonly string[]).includes(v);
}

export async function onlineCount(includeLoadtest = false): Promise<number> {
  const rooms = await matchMaker.query({ name: "body" });
  let n = 0;
  for (const r of rooms) {
    const md = r.metadata as BodyRoomMetadata | undefined;
    if (!includeLoadtest && md?.loadtest) continue;
    n += r.clients;
  }
  return n;
}

/**
 * The real world's half of entering an admin sandbox (D-admin-3), or why not: admins only (asked of
 * the account), with a character that is alive and out of a fight. A real body still in the world
 * (another window, a handoff the server hasn't seen yet) is saved and leaves it, then the sandbox
 * opens; already open (travel between sandbox bodies), it goes on.
 */
export function enterSandbox(identity: Identity, now: number): string | null {
  if (identity.loadtest || !identityIsAdmin(identity)) return "forbidden";
  const owner = identity.userId;
  const live = hub.get(owner);
  const ch = live?.actor.char ?? characterRepo.current.load(owner);
  if (!ch) return "no character";
  if (ch.dead || live?.actor.dead) return "respawn first";
  if (live && now < live.actor.combatUntil) return "in combat";
  if (live) {
    live.room.saveActor(live.actor);
    hub.release(owner, live.actor);
    live.room.retire(live.actor, CLOSE.ELSEWHERE, "playing in another window");
  }
  openSandbox(owner, ch.body, now);
  return null;
}

/** A seat in the admin's sandbox room for the body: one per admin and body, never a public copy. */
async function playSandbox(identity: Identity, input: PlayInput): Promise<PlayResponse> {
  const owner = identity.userId;
  return withLock(`sb:${owner}`, async () => {
    if (!sandboxOf(owner)) return { ok: false, error: "forbidden" };
    const rooms = await matchMaker.query({ name: "body" });
    let target = rooms.find((r) => {
      const md = r.metadata as BodyRoomMetadata | undefined;
      return md?.sandbox === owner && md.body === input.body && !r.locked;
    });
    target ??= await matchMaker.createRoom("body", { body: input.body, copy: 0, loadtest: false, sandbox: owner });
    const reservation = await matchMaker.reserveSeatFor(target, { body: input.body }, identity);
    return { ok: true, reservation: reservation as unknown as import("@firstlight/shared/net/protocol").SeatReservation };
  });
}

export async function play(identity: Identity, input: PlayInput, limits: MatchmakingLimits): Promise<PlayResponse> {
  if (input.sandbox) return playSandbox(identity, input);
  const loadtest = !!input.loadtest;
  // Bots only in load-test rooms, players only in public rooms ("no fake players, ever").
  if (loadtest !== !!identity.loadtest) return { ok: false, error: "forbidden" };
  const partySize = Math.max(1, Math.min(4, input.partySize ?? 1));

  return withLock(`${loadtest ? "lt" : "pub"}:${input.body}`, async () => {
    const all = await matchMaker.query({ name: "body" });
    const mine = all.filter((r) => {
      const md = r.metadata as BodyRoomMetadata | undefined;
      return md?.body === input.body && !!md?.loadtest === loadtest && !md?.sandbox; // sandboxes are private (D-admin-3)
    });

    if (!loadtest) {
      const total = all.reduce((s, r) => s + ((r.metadata as BodyRoomMetadata | undefined)?.loadtest ? 0 : r.clients), 0);
      if (total + partySize > limits.globalCap) return enqueue(identity.userId, total - limits.globalCap);
    }

    mine.sort((a, b) => b.clients - a.clients);
    let target = undefined as (typeof mine)[number] | undefined;

    if (input.partyLeaderRoomId) {
      const leader = mine.find((r) => r.roomId === input.partyLeaderRoomId);
      if (leader && leader.clients + 1 <= limits.maxClients && !leader.locked) target = leader;
    }
    if (!target) {
      target = mine.find((r) =>
        !r.locked && (partySize > 1 || loadtest ? r.clients + partySize <= limits.maxClients : r.clients < limits.soloFillLimit),
      );
    }
    if (!target) {
      if (mine.length >= limits.maxCopiesPerBody && !loadtest) return enqueue(identity.userId, 0);
      const used = new Set(mine.map((r) => (r.metadata as BodyRoomMetadata).copy));
      let copy = 0;
      while (used.has(copy)) copy++;
      target = await matchMaker.createRoom("body", { body: input.body, copy, loadtest });
    }
    queue.delete(identity.userId);
    const reservation = await matchMaker.reserveSeatFor(target, { body: input.body, starter: input.starter, palette: input.palette, look: input.look }, identity);
    return { ok: true, reservation: reservation as unknown as import("@firstlight/shared/net/protocol").SeatReservation };
  });
}

function enqueue(userId: string, over: number): PlayResponse {
  if (!queue.has(userId)) queue.set(userId, Date.now());
  const mineAt = queue.get(userId)!;
  let position = 1;
  for (const [, at] of queue) if (at < mineAt) position++;
  // Drop stale queue entries (no poll for 30 s).
  const now = Date.now();
  for (const [u, at] of queue) if (now - at > 10 * 60_000) queue.delete(u);
  return { ok: false, queue: { position: position + Math.max(0, over), etaSeconds: 30 * position } };
}
