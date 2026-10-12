// Bot helpers for NPC/boss integration tests: admin bots placed anywhere on a body, the admin `npc`
// request/reply channel, and surface geometry (the same helpers npc.test.ts keeps inline).

import type { Room } from "@colyseus/sdk";
import { matchMaker } from "@colyseus/core";
import { BODIES, isSafe, padDirs, type BodyId } from "@firstlight/shared";
import { PF } from "@firstlight/shared/net/schema";
import type { Game } from "../src/app.ts";
import type { BodyRoom } from "../src/world/BodyRoom.ts";
import { joinAs, waitFor } from "./helpers.ts";

export type V = [number, number, number];
export const st = (r: Room) => r.state as any;
export const me = (r: Room) => st(r).players.get(r.sessionId);
export const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

/** Horizontal distance (along the surface, ignoring height). */
export function flat(a: readonly number[], b: readonly number[]): number {
  const la = Math.hypot(a[0]!, a[1]!, a[2]!), lb = Math.hypot(b[0]!, b[1]!, b[2]!);
  return Math.hypot(a[0]! / la - b[0]! / lb, a[1]! / la - b[1]! / lb, a[2]! / la - b[2]! / lb) * la;
}

/** `metres` along a fixed tangent from `p` (plus `sideways`), on the sphere of radius R. */
export function offset(p: readonly number[], metres: number, sideways: number, R: number): V {
  const l = Math.hypot(p[0]!, p[1]!, p[2]!);
  const d = [p[0]! / l, p[1]! / l, p[2]! / l];
  const ref = Math.abs(d[2]!) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  const k = ref[0]! * d[0]! + ref[1]! * d[1]! + ref[2]! * d[2]!;
  let t = [ref[0]! - k * d[0]!, ref[1]! - k * d[1]!, ref[2]! - k * d[2]!];
  const tl = Math.hypot(t[0]!, t[1]!, t[2]!);
  t = t.map((v) => v / tl);
  const s = [d[1]! * t[2]! - d[2]! * t[1]!, d[2]! * t[0]! - d[0]! * t[2]!, d[0]! * t[1]! - d[1]! * t[0]!];
  const v = [d[0]! + (t[0]! * metres + s[0]! * sideways) / R, d[1]! + (t[1]! * metres + s[1]! * sideways) / R, d[2]! + (t[2]! * metres + s[2]! * sideways) / R];
  const vl = Math.hypot(v[0]!, v[1]!, v[2]!);
  return [(v[0]! / vl) * R, (v[1]! / vl) * R, (v[2]! / vl) * R];
}

/** A point `metres` from a pad centre along a fixed tangent. */
export function nearPad(body: BodyId, pad: number, metres: number, sideways = 0): V {
  const R = BODIES[body].radius;
  const d = padDirs(BODIES[body])[pad]!;
  return offset([d[0] * R, d[1] * R, d[2] * R], metres, sideways, R);
}

export function place(r: Room, p: readonly number[]) {
  r.send("admin", { cmd: "teleport", args: { x: p[0], y: p[1], z: p[2] } });
  r.send("admin", { cmd: "unprotect" });
}

/** Join as an admin bot at `at` (level set), unprotected; SAFE only if `at` is on a pad. */
export async function adminBot(game: Game, rooms: Room[], name: string, body: BodyId, at: readonly number[], level = 1): Promise<Room> {
  const r = await joinAs(game, name, body, { starter: 3 }, "admin");
  rooms.push(r);
  await waitFor(() => !!me(r));
  r.send("admin", { cmd: "level", args: { level } });
  place(r, at);
  const safe = isSafe(BODIES[body], at[0]!, at[1]!, at[2]!) ? PF.SAFE : 0;
  await waitFor(() => flat([me(r).x, me(r).y, me(r).z], at) < 2 && (me(r).flags & (PF.SAFE | PF.PROTECTED)) === safe);
  return r;
}

let reqSeq = 0;
/** Send an admin `npc` command and wait for the reply of `type`. */
export function ask<T = any>(r: Room, type: string, msg: Record<string, unknown>): Promise<T> {
  const req = ++reqSeq;
  return new Promise((ok, fail) => {
    const off = r.onMessage(type, (m: any) => {
      if (m.req !== req) return;
      (off as unknown as () => void)?.();
      ok(m);
    });
    r.send("npc", { ...msg, req });
    setTimeout(() => fail(new Error(`no ${type} reply`)), 3000);
  });
}

export const bossInfo = (r: Room, action = "info") => ask<any>(r, "bossInfo", { cmd: "boss", action });
export const spawnNpc = (r: Room, kind: string, at: readonly number[], extra: Record<string, unknown> = {}) =>
  ask<{ id: string }>(r, "npcInfo", { cmd: "spawn", kind, x: at[0], y: at[1], z: at[2], ...extra }).then((m) => m.id);
export const npcList = (r: Room) => ask<{ npcs: any[] }>(r, "npcList", { cmd: "list" }).then((m) => m.npcs);

/** The server-side room behind a client room (in-process server). */
export function serverRoom(r: Room): BodyRoom {
  return matchMaker.getLocalRoomById(r.roomId) as unknown as BodyRoom;
}

/** Wait until no body room is left (the last one auto-disposed). */
export async function noBodyRooms(ms = 6000): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if ((await matchMaker.query({ name: "body" })).length === 0) return;
    await sleep(25);
  }
  throw new Error("body rooms still open");
}
