// Bot helpers for NPC/boss integration tests: admin bots placed anywhere on a body, the admin `npc`
// request/reply channel, and surface geometry (the same helpers npc.test.ts keeps inline).

import type { Room } from "@colyseus/sdk";
import { matchMaker } from "@colyseus/core";
import { BODIES, createTerrain, isSafe, natureSolids, nearSafeZone, padDirs, type BodyId } from "@firstlight/shared";
import { OUTPOSTS, type OutpostBody } from "@firstlight/shared/content/padOutposts";
import { bodyBreakables } from "@firstlight/shared/planet/breakables";
import { outpostAnchor, siteDir, structureCollider } from "@firstlight/shared/planet/sites";
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

/** Site point (east, north) of a planet's pad-0 outpost frame (D42), on the ground. */
export function siteAt(body: OutpostBody, east: number, north: number): V {
  const t = createTerrain(body);
  const R = BODIES[body].radius;
  const d = siteDir(outpostAnchor(t), east, north, R);
  const r = R + t.groundHeight(d[0], d[1], d[2]);
  return [d[0] * r, d[1] * r, d[2] * r];
}

const openSpots = new Map<string, V>();

/**
 * A dry, gentle spot outside the planet's walled arrival outpost (D-b2-1) with `ahead` metres of open
 * ground along the fixed tangent (`offset`): not in or near a safe zone, no breakable within 3 m of
 * the line, no structure across it and no natural solid (a trunk, a boulder: D-solid-1) on it or
 * within a big creature's reach of it. Round 2 walled the ground the tests used to fight on (26 m off
 * pad 0); this is the nearest such spot beyond the wall, the same on every run.
 */
export function openSpotOutside(body: OutpostBody, ahead = 10): V {
  const key = `${body}:${ahead}`;
  const hit = openSpots.get(key);
  if (hit) return hit;
  const def = BODIES[body];
  const t = createTerrain(body);
  const R = def.radius;
  const walls = structureCollider(t);
  const nature = natureSolids(t);
  const roomy = { radius: 1.2, height: 1.8, step: 0.35 }; // room for a big creature anywhere on the line
  const brk = bodyBreakables(t);
  const wall = OUTPOSTS[body].wall.radius;
  const ground = (p: readonly number[]) => {
    const l = Math.hypot(p[0]!, p[1]!, p[2]!);
    return t.groundHeight(p[0]! / l, p[1]! / l, p[2]! / l);
  };
  for (let m = wall + 12; m <= wall + 40; m += 4) {
    for (let b = 0; b < 360; b += 10) {
      const a = (b * Math.PI) / 180;
      const start = siteAt(body, Math.sin(a) * m, Math.cos(a) * m);
      const g0 = ground(start);
      let ok = g0 > def.waterLevel + 0.5;
      const line: V[] = [];
      for (let k = 0; k <= ahead && ok; k += 1) {
        const q = offset(start, k, 0, R);
        const g = ground(q);
        const at: V = [q[0] / R * (R + g), q[1] / R * (R + g), q[2] / R * (R + g)];
        ok = g > def.waterLevel + 0.5 && Math.abs(g - g0) < 1.5 && !nearSafeZone(def, ...at, 6) && !brk.some((x) => Math.hypot(x.px - at[0], x.py - at[1], x.pz - at[2]) < 3 + Math.max(x.hx, x.hz));
        line.push(at);
      }
      if (!ok) continue;
      const a0 = line[0]!, a1 = line[line.length - 1]!;
      const lift = (p: V, h: number): V => { const l = Math.hypot(...p); return [p[0] / l * (l + h), p[1] / l * (l + h), p[2] / l * (l + h)]; };
      if (walls.blocks(...lift(a0, 1.2), ...lift(a1, 1.2))) continue;
      if (nature.crosses(...a0, ...a1) || line.some((q) => !nature.isClear({ x: q[0], y: q[1], z: q[2] }, roomy))) continue;
      const out: V = [start[0], start[1], start[2]];
      openSpots.set(key, out);
      return out;
    }
  }
  throw new Error(`no open spot outside the ${body} outpost`);
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
