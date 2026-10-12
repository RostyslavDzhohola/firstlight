// Bot helpers for the quests tests: SDK clients that record every message, plus world positions
// computed from the same shared data and terrain the server uses.

import { matchMaker } from "@colyseus/core";
import type { Room } from "@colyseus/sdk";
import { BODIES, createTerrain, padDirs, type BodyId } from "@firstlight/shared";
import { objectPos, WORLD_OBJECT_BY_ID } from "@firstlight/shared/content/world";
import type { Game } from "../src/app.ts";
import type { BodyRoom } from "../src/world/BodyRoom.ts";
import { joinAs, safeLeave, waitFor } from "./helpers.ts";

export const harness: { game: Game | null; rooms: Room[] } = { game: null, rooms: [] };

export interface Bot {
  room: Room;
  id: string;
  you: any;
  toasts: string[];
  msgs: Map<string, any[]>;
  send(type: string, msg?: unknown): void;
  last(type: string): any;
  count(type: string): number;
}

export async function bot(userId: string, body: BodyId, role = "admin", extra: Record<string, unknown> = {}): Promise<Bot> {
  const room = await joinAs(harness.game!, userId, body, extra, role);
  harness.rooms.push(room);
  const b: Bot = {
    room,
    id: room.sessionId,
    you: null,
    toasts: [],
    msgs: new Map(),
    send: (type, msg = {}) => room.send(type, msg as never),
    last: (type) => b.msgs.get(type)?.at(-1),
    count: (type) => b.msgs.get(type)?.length ?? 0,
  };
  room.onMessage("*", (type: string | number, m: any) => {
    const k = String(type);
    if (k === "you") b.you = m;
    if (k === "toast") b.toasts.push(m.text);
    const l = b.msgs.get(k) ?? [];
    l.push(m);
    b.msgs.set(k, l);
  });
  await waitFor(() => (room.state as any).players?.get(room.sessionId) !== undefined && b.you !== null);
  return b;
}

export const me = (b: Bot) => (b.room.state as any).players.get(b.id);
export const serverRoom = (b: Bot) => matchMaker.getLocalRoomById(b.room.roomId) as unknown as BodyRoom;

const terrains = new Map<BodyId, ReturnType<typeof createTerrain>>();
export function terrain(body: BodyId) {
  let t = terrains.get(body);
  if (!t) terrains.set(body, (t = createTerrain(body)));
  return t;
}

/** Ground position for a unit direction on a body (same snapping as the server). */
export function ground(body: BodyId, d: readonly number[]): [number, number, number] {
  const def = BODIES[body];
  const g = Math.max(terrain(body).groundHeight(d[0]!, d[1]!, d[2]!), def.waterLevel - 1.05);
  const r = def.radius + g + 0.02;
  return [d[0]! * r, d[1]! * r, d[2]! * r];
}

export function objAt(id: string): [number, number, number] {
  const o = WORLD_OBJECT_BY_ID.get(id)!;
  return objectPos(o, (x, y, z) => terrain(o.body).groundHeight(x, y, z));
}

export function padAt(body: BodyId, i: number) {
  return ground(body, padDirs(BODIES[body])[i]!);
}

/** A point `metres` along the surface from pad `i` (outside its safe ring for metres > 12). */
export function offPad(body: BodyId, i: number, metres: number): [number, number, number] {
  const R = BODIES[body].radius;
  const d = padDirs(BODIES[body])[i]!;
  const ref = Math.abs(d[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  const k = ref[0]! * d[0] + ref[1]! * d[1] + ref[2]! * d[2];
  const t = [ref[0]! - k * d[0], ref[1]! - k * d[1], ref[2]! - k * d[2]];
  const tl = Math.hypot(t[0]!, t[1]!, t[2]!);
  const v = [d[0] + (t[0]! / tl) * (metres / R), d[1] + (t[1]! / tl) * (metres / R), d[2] + (t[2]! / tl) * (metres / R)];
  const l = Math.hypot(v[0]!, v[1]!, v[2]!);
  return ground(body, [v[0]! / l, v[1]! / l, v[2]! / l]);
}

export function tp(b: Bot, p: readonly number[]) {
  b.send("admin", { cmd: "teleport", args: { x: p[0], y: p[1], z: p[2] } });
}

export async function tpAndWait(b: Bot, p: readonly number[]) {
  tp(b, p);
  await waitFor(() => Math.hypot(me(b).x - p[0]!, me(b).y - p[1]!, me(b).z - p[2]!) < 1.5);
}

export const near = (b: Bot, p: readonly number[], m: number) => Math.hypot(me(b).x - p[0]!, me(b).y - p[1]!, me(b).z - p[2]!) <= m;
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** waitFor with a label in the failure message. */
export async function until(label: string, cond: () => boolean, ms = 6000) {
  await waitFor(cond, ms).catch(() => {
    throw new Error(`timed out waiting for: ${label}`);
  });
}
export const invIds = (b: Bot) => [...b.you.hotbar, ...b.you.backpack].filter(Boolean).map((i: any) => i.id);

/** Kill a bot outside the safe ring, rebirth and rejoin `body` (as the client does). */
export async function dieAndRejoin(b: Bot, userId: string, body: BodyId, pad = 0): Promise<{ bot: Bot; pileId: string }> {
  await tpAndWait(b, offPad(body, pad, 40));
  b.send("admin", { cmd: "unprotect" });
  await sleep(120);
  b.send("admin", { cmd: "damage", args: { amount: 5000 } });
  await waitFor(() => b.count("death") > 0);
  const pileId = b.last("death").pileId as string;
  b.send("respawn", { starter: 1, palette: 0 });
  await waitFor(() => b.count("reborn") > 0);
  await safeLeave(b.room);
  const portus = await bot(userId, "portus");
  await safeLeave(portus.room);
  return { bot: await bot(userId, body), pileId };
}
