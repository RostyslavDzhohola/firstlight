// Seam 1: breakable props, driven by SDK bot clients against the in-process server. Bots fire real
// weapons; assertions read the synced state (BodyState.broken), the `broke`/`rebuilt` messages and,
// where only the server knows (prop HP), the room's destruction system.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Room } from "@colyseus/sdk";
import { matchMaker } from "@colyseus/core";
import { BODIES, createTerrain, isSafe, type Breakable, type BodyId, type Terrain } from "@firstlight/shared";
import type { Game } from "../src/app.ts";
import type { BodyRoom } from "../src/world/BodyRoom.ts";
import { DESTRUCTION, DestructionSystem } from "../src/world/destruction.ts";
import { rayTerrain, type V3 } from "../src/world/geometry.ts";
import { joinAs, safeLeave, startServer, waitFor } from "./helpers.ts";

let game: Game;
const rooms: Room[] = [];

beforeEach(async () => {
  game = await startServer();
  DESTRUCTION.rebuildMsOverride = null;
});
afterEach(async () => {
  for (const r of rooms.splice(0)) await safeLeave(r);
  await game.close();
  DESTRUCTION.rebuildMsOverride = null;
});

const st = (r: Room) => r.state as any;
const me = (r: Room) => st(r).players.get(r.sessionId);
const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
const terrains = new Map<BodyId, Terrain>();
const terrainOf = (b: BodyId) => terrains.get(b) ?? terrains.set(b, createTerrain(b)).get(b)!;

function serverRoom(r: Room): BodyRoom {
  return matchMaker.getLocalRoomById(r.roomId) as unknown as BodyRoom;
}
function destruction(r: Room): DestructionSystem {
  const sys = serverRoom(r).systems.find((s) => s instanceof DestructionSystem);
  if (!sys) throw new Error("no destruction system");
  return sys as DestructionSystem;
}

async function join(user: string, body: BodyId, starter = 3): Promise<Room> {
  const r = await joinAs(game, user, body, { starter }, "admin");
  rooms.push(r);
  await waitFor(() => !!me(r));
  return r;
}

/** Feet on the ground at a planet-space point (what the admin teleport does). */
function ground(body: BodyId, p: V3): V3 {
  const t = terrainOf(body);
  const l = Math.hypot(p[0], p[1], p[2]);
  const r = BODIES[body].radius + t.groundHeight(p[0] / l, p[1] / l, p[2] / l) + 0.02;
  return [(p[0] / l) * r, (p[1] / l) * r, (p[2] / l) * r];
}
const up = (p: V3): V3 => {
  const l = Math.hypot(p[0], p[1], p[2]);
  return [p[0] / l, p[1] / l, p[2] / l];
};
const add = (p: V3, d: V3, k: number): V3 => [p[0] + d[0] * k, p[1] + d[1] * k, p[2] + d[2] * k];
const dirTo = (a: V3, b: V3): V3 => {
  const d: V3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const l = Math.hypot(d[0], d[1], d[2]);
  return [d[0] / l, d[1] / l, d[2] / l];
};
const head = (feet: V3) => add(feet, up(feet), 1.6);

/** A point `dist` metres from the prop's footprint along local angle `a` (0 = right, π/2 = forward). */
function around(body: BodyId, b: Breakable, a: number, dist: number): V3 {
  const c = Math.cos(a), s = Math.sin(a);
  const k = b.foot + dist;
  return ground(body, [b.px + (b.rx * c + b.fx * s) * k, b.py + (b.ry * c + b.fy * s) * k, b.pz + (b.rz * c + b.fz * s) * k]);
}

function open(body: BodyId, p: V3): boolean {
  const t = terrainOf(body);
  const h = Math.hypot(p[0], p[1], p[2]) - BODIES[body].radius;
  return !isSafe(BODIES[body], p[0], p[1], p[2]) && h > BODIES[body].waterLevel + 0.4 && Math.abs(h - t.groundHeightAt(p[0], p[1], p[2])) < 0.1;
}

/** Is `b` the first thing a shot from `from` toward `to` hits (no terrain or other prop first)? */
function clearShot(sys: DestructionSystem, body: BodyId, from: V3, to: V3, b: Breakable): boolean {
  const d = dirTo(from, to);
  const len = Math.hypot(to[0] - from[0], to[1] - from[1], to[2] - from[2]);
  const hit = sys.raycast(from, d, len + 3);
  if (!hit || hit.index !== b.index) return false;
  return rayTerrain(terrainOf(body), from, d, len, 0.5) > len;
}

interface Setup {
  b: Breakable;
  shooter: V3;
  /** Aim point (prop centre or the target's body behind it). */
  aim: V3;
  target?: V3;
}

/** Find a prop of `kind` with a clean firing position `range` m away (and a target spot behind it). */
function findSetup(sys: DestructionSystem, body: BodyId, kind: Breakable["kind"], range: number, withTarget = false, skip = new Set<number>()): Setup {
  for (const b of sys.list) {
    if (b.kind !== kind || skip.has(b.index)) continue;
    for (let k = 0; k < 16; k++) {
      const a = (k / 16) * Math.PI * 2;
      const shooter = around(body, b, a, range);
      if (!open(body, shooter)) continue;
      if (withTarget) {
        const target = around(body, b, a + Math.PI, 1.3);
        if (!open(body, target)) continue;
        // Aim at the target's shins: the prop is between (crates are ~1 m tall).
        const aim = add(target, up(target), 0.45);
        if (Math.hypot(shooter[0] - target[0], shooter[1] - target[1], shooter[2] - target[2]) < 4) continue;
        if (!clearShot(sys, body, head(shooter), aim, b)) continue;
        // Without the prop the shot reaches the target (terrain doesn't block).
        const d = dirTo(head(shooter), aim);
        const len = Math.hypot(aim[0] - head(shooter)[0], aim[1] - head(shooter)[1], aim[2] - head(shooter)[2]);
        if (rayTerrain(terrainOf(body), head(shooter), d, len, 0.5) <= len) continue;
        return { b, shooter, aim, target };
      }
      const aim: V3 = [b.cx, b.cy, b.cz];
      if (clearShot(sys, body, head(shooter), aim, b)) return { b, shooter, aim };
    }
  }
  throw new Error(`no ${kind} with a clear ${range} m firing position`);
}

async function placeAt(r: Room, p: V3) {
  r.send("admin", { cmd: "teleport", args: { x: p[0], y: p[1], z: p[2] } });
  r.send("admin", { cmd: "unprotect" });
  await waitFor(() => Math.hypot(me(r).x - p[0], me(r).y - p[1], me(r).z - p[2]) < 0.3 && !(me(r).flags & 1) && !(me(r).flags & 2));
}

let seq = 10_000;
/** Face a point (the server takes facing from movement input; melee uses it). */
async function face(r: Room, at: V3) {
  const p: V3 = [me(r).x, me(r).y, me(r).z];
  const u = up(p);
  let d: V3 = [at[0] - p[0], at[1] - p[1], at[2] - p[2]];
  const k = d[0] * u[0] + d[1] * u[1] + d[2] * u[2];
  d = [d[0] - u[0] * k, d[1] - u[1] * k, d[2] - u[2] * k];
  const l = Math.hypot(d[0], d[1], d[2]);
  r.send("input", { seq: ++seq, x: p[0], y: p[1], z: p[2], fx: d[0] / l, fy: d[1] / l, fz: d[2] / l, anim: 0, t: Date.now() });
  await waitFor(() => Math.abs(me(r).fx - d[0] / l) < 0.01 && Math.abs(me(r).fz - d[2] / l) < 0.01);
}

/** Fire the selected hotbar slot from the head toward `aim`. */
function fire(r: Room, slot: number, aim: V3) {
  const o = head([me(r).x, me(r).y, me(r).z]);
  const d = dirTo(o, aim);
  r.send("fire", { slot, ox: o[0], oy: o[1], oz: o[2], dx: d[0], dy: d[1], dz: d[2], t: Date.now() });
}

function collect<T>(r: Room, type: string): T[] {
  const out: T[] = [];
  r.onMessage(type, (m: T) => out.push(m));
  return out;
}

describe("destruction (seam 1)", () => {
  it("a carbine breaks a crate (broke message + synced broken map); it can't scratch a camp wall", async () => {
    const a = await join("gunner", "arcadia");
    const sys = destruction(a);
    const broke = collect<{ id: string; archetype: number; variant: number; ix: number; iy: number; iz: number }>(a, "broke");
    const crate = findSetup(sys, "arcadia", "crate", 6);
    await placeAt(a, crate.shooter);
    a.send("scope", { on: true });
    await sleep(100);
    for (let i = 0; i < 12 && !broke.length; i++) {
      fire(a, 0, crate.aim);
      await sleep(320);
    }
    await waitFor(() => broke.length > 0);
    expect(broke[0]!.id).toBe(crate.b.id);
    expect(broke[0]!.archetype).toBe(crate.b.archetype);
    expect(broke[0]!.variant).toBeGreaterThanOrEqual(0);
    expect(broke[0]!.variant).toBeLessThan(DESTRUCTION.variants);
    // Impact direction points from the shooter to the prop.
    const d = dirTo(head(crate.shooter), crate.aim);
    expect(broke[0]!.ix * d[0] + broke[0]!.iy * d[1] + broke[0]!.iz * d[2]).toBeGreaterThan(0.9);
    await waitFor(() => st(a).broken?.has(crate.b.id));
    expect(st(a).broken.get(crate.b.id)).toBeGreaterThan(Date.now() + 170_000);

    // Light weapons don't damage heavy props.
    const wall = findSetup(sys, "arcadia", "campwall", 6);
    await placeAt(a, wall.shooter);
    for (let i = 0; i < 6; i++) {
      fire(a, 0, wall.aim);
      await sleep(320);
    }
    expect(sys.hp[wall.b.index]).toBe(wall.b.hp);
    expect(st(a).broken.has(wall.b.id)).toBe(false);
  });

  it("a breakable blocks a shot at a player behind it until it breaks, then rebuilds and blocks again", async () => {
    DESTRUCTION.rebuildMsOverride = 1500;
    const a = await join("shooter", "arcadia");
    const b = await join("hider", "arcadia", 1);
    const sys = destruction(a);
    const s = findSetup(sys, "arcadia", "crate", 7, true);
    await placeAt(a, s.shooter);
    await placeAt(b, s.target!);
    a.send("scope", { on: true });
    const rebuilt = collect<{ id: string }>(a, "rebuilt");
    await sleep(150);
    const hp0 = st(a).players.get(b.sessionId).hp;
    let shots = 0;
    while (!st(a).broken.has(s.b.id) && shots < 12) {
      fire(a, 0, s.aim);
      shots++;
      await sleep(320);
      if (!sys.isBroken(s.b.index)) expect(st(a).players.get(b.sessionId).hp).toBe(hp0);
    }
    expect(st(a).broken.has(s.b.id)).toBe(true);
    expect(shots).toBeGreaterThanOrEqual(4); // 40 HP / 9 per carbine shot
    expect(st(a).players.get(b.sessionId).hp).toBe(hp0);
    // Now the shot goes through to the player.
    fire(a, 0, s.aim);
    await waitFor(() => st(a).players.get(b.sessionId).hp < hp0);

    // Rebuild: `rebuilt` arrives, the id leaves the synced map, and the crate blocks again.
    await waitFor(() => rebuilt.some((m) => m.id === s.b.id), 4000);
    await waitFor(() => !st(a).broken.has(s.b.id));
    expect(sys.hp[s.b.index]).toBe(s.b.hp);
    const hp1 = st(a).players.get(b.sessionId).hp;
    fire(a, 0, s.aim);
    await waitFor(() => sys.hp[s.b.index]! < s.b.hp);
    await sleep(150);
    expect(st(a).players.get(b.sessionId).hp).toBe(hp1);
  });

  it("an axe chops crates; light swings can't hurt a statue, the charged chop can", async () => {
    const a = await join("axeman", "hollowmere");
    const sys = destruction(a);
    a.send("admin", { cmd: "give", args: { id: "axe" } });
    await sleep(100);
    a.send("equip", { slot: 1 });
    const crate = findSetup(sys, "hollowmere", "crate", 0.9);
    await placeAt(a, crate.shooter);
    await face(a, crate.aim);
    const broke = collect<{ id: string }>(a, "broke");
    for (let i = 0; i < 4 && !broke.some((m) => m.id === crate.b.id); i++) {
      a.send("melee", { slot: 1, t: Date.now() });
      await sleep(850);
    }
    await waitFor(() => broke.some((m) => m.id === crate.b.id));
    await waitFor(() => st(a).broken.has(crate.b.id));

    const statue = findSetup(sys, "hollowmere", "statue", 0.9);
    await placeAt(a, statue.shooter);
    await face(a, statue.aim);
    for (let i = 0; i < 2; i++) {
      a.send("melee", { slot: 1, t: Date.now() });
      await sleep(850);
    }
    expect(sys.hp[statue.b.index]).toBe(statue.b.hp);
    a.send("charge", { on: true });
    await sleep(850);
    a.send("melee", { slot: 1, t: Date.now(), heavy: true });
    await waitFor(() => sys.hp[statue.b.index]! < statue.b.hp);
    expect(statue.b.hp - sys.hp[statue.b.index]!).toBeCloseTo(66, 0); // chop 66 at level 1
  });

  it("a grenade blast breaks a statue (heavy); fists break nothing", async () => {
    const a = await join("grenadier", "hollowmere");
    const sys = destruction(a);
    a.send("admin", { cmd: "level", args: { level: 20 } });
    a.send("admin", { cmd: "give", args: { id: "grenade", tier: 3, qty: 2 } });
    await sleep(100);
    const s = findSetup(sys, "hollowmere", "statue", 3.5);
    await placeAt(a, s.shooter);
    // Aim at the statue's base: the throw's upward bias carries it into the statue.
    const base: V3 = [s.b.px, s.b.py, s.b.pz];
    const broke = collect<{ id: string; f: number }>(a, "broke");
    fire(a, 1, add(base, up(base), 0.2));
    await sleep(250);
    // Step away from the blast before the 1.4 s fuse.
    a.send("admin", { cmd: "teleport", args: { x: s.shooter[0] + (s.shooter[0] - s.b.px) * 3, y: s.shooter[1] + (s.shooter[1] - s.b.py) * 3, z: s.shooter[2] + (s.shooter[2] - s.b.pz) * 3 } });
    await waitFor(() => broke.some((m) => m.id === s.b.id), 4000);
    await waitFor(() => st(a).broken.has(s.b.id));

    // Fists ("none") never damage props, even light ones.
    const crate = findSetup(sys, "hollowmere", "crate", 0.9);
    a.send("equip", { slot: 2 }); // empty slot → fists
    await placeAt(a, crate.shooter);
    await face(a, crate.aim);
    for (let i = 0; i < 3; i++) {
      a.send("melee", { slot: 2, t: Date.now() });
      await sleep(450);
    }
    expect(sys.hp[crate.b.index]).toBe(crate.b.hp);
  });

  it("a late joiner gets the broken list; Portus has no destruction at all", async () => {
    const a = await join("breaker", "arcadia");
    const sys = destruction(a);
    const s = findSetup(sys, "arcadia", "barrel", 6);
    await placeAt(a, s.shooter);
    a.send("scope", { on: true });
    for (let i = 0; i < 12 && !st(a).broken.has(s.b.id); i++) {
      fire(a, 0, s.aim);
      await sleep(320);
    }
    await waitFor(() => st(a).broken.has(s.b.id));
    const late = await join("latecomer", "arcadia");
    expect(late.roomId).toBe(a.roomId);
    await waitFor(() => st(late).broken?.has(s.b.id));
    expect(st(late).broken.get(s.b.id)).toBe(st(a).broken.get(s.b.id));

    const p = await join("tourist", "portus");
    expect(serverRoom(p).systems.some((x) => x instanceof DestructionSystem)).toBe(false);
    expect(serverRoom(p).host.props).toBeUndefined();
  });
});
