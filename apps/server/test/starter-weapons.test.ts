// Every starter's own weapon on every combat planet, on the real message path (owner report
// 2026-10-14: "weapons work in the safe zone but not outside"). Inside a pad's safe ring the attack is
// refused with a reason the client turns into a notice; outside it lands on an NPC. Also the cases
// that used to fail silently: a camera zoomed all the way out (the shot origin is the camera, up to
// ~9 m behind the head) and the arrival protection.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Room } from "@colyseus/sdk";
import { BODIES, createTerrain, isSafe, type BodyId } from "@firstlight/shared";
import { PF } from "@firstlight/shared/net/schema";
import { STARTERS } from "@firstlight/shared/content/weapons";
import type { Game } from "../src/app.ts";
import { joinAs, safeLeave, startServer, waitFor } from "./helpers.ts";
import { flat, me, nearPad, offset, place, serverRoom, spawnNpc, st, type V } from "./npc-bots.ts";
import { DestructionSystem } from "../src/world/destruction.ts";

let game: Game;
const rooms: Room[] = [];

beforeEach(async () => {
  game = await startServer();
});
afterEach(async () => {
  for (const r of rooms.splice(0)) await safeLeave(r);
  await game.close();
});

const COMBAT_PLANETS: BodyId[] = ["arcadia", "hollowmere", "meridian"];
const up = (p: readonly number[]): V => {
  const l = Math.hypot(p[0]!, p[1]!, p[2]!);
  return [p[0]! / l, p[1]! / l, p[2]! / l];
};
const pos = (r: Room): V => [me(r).x, me(r).y, me(r).z];
const add = (a: readonly number[], b: readonly number[], k = 1): V => [a[0]! + b[0]! * k, a[1]! + b[1]! * k, a[2]! + b[2]! * k];
const norm = (v: readonly number[]): V => {
  const l = Math.hypot(v[0]!, v[1]!, v[2]!);
  return [v[0]! / l, v[1]! / l, v[2]! / l];
};

/** A starter of `starter` on `body`, admin (teleport, NPC spawns), denials collected. */
async function shooter(body: BodyId, starter: number) {
  const r = await joinAs(game, `s${starter}-${body}`, body, { starter }, "admin");
  rooms.push(r);
  await waitFor(() => !!me(r));
  const denied: { action: string; reason: string }[] = [];
  r.onMessage("denied", (m: { action: string; reason: string }) => denied.push(m));
  const hits: { target: string; amount: number }[] = [];
  r.onMessage("hit", (m: { attacker: string; target: string; amount: number }) => {
    if (m.attacker === r.sessionId) hits.push({ ...m });
  });
  for (const t of ["you", "toast", "shot", "projectile", "explode", "swing", "npcInfo", "immune"]) r.onMessage(t, () => {});
  return { r, denied, hits };
}

let seq = 1000;
/** Stand at `at` facing `toward` (the server takes the facing from movement input; melee arcs use it). */
async function standAt(r: Room, at: V, toward: V) {
  place(r, at);
  await waitFor(() => flat(pos(r), at) < 1.5 && !(me(r).flags & PF.PROTECTED));
  const p = pos(r);
  const u = up(p);
  const v = [toward[0] - p[0], toward[1] - p[1], toward[2] - p[2]];
  const k = v[0]! * u[0] + v[1]! * u[1] + v[2]! * u[2];
  const f = norm([v[0]! - k * u[0], v[1]! - k * u[1], v[2]! - k * u[2]]);
  r.send("input", { seq: ++seq, x: p[0], y: p[1], z: p[2], fx: f[0], fy: f[1], fz: f[2], anim: 0, t: Date.now() });
  await waitFor(() => Math.abs(me(r).fx - f[0]) < 1e-3 && Math.abs(me(r).fz - f[2]) < 1e-3);
}

/** A camera ray at the NPC's chest: from the head, or from `back` metres behind it along the same line. */
function aim(r: Room, npc: { x: number; y: number; z: number }, back = 0) {
  const p = pos(r);
  const head = add(p, up(p), 1.6);
  const n: V = [npc.x, npc.y, npc.z];
  const chest = add(n, up(n), 0.7);
  const d = norm([chest[0] - head[0], chest[1] - head[1], chest[2] - head[2]]);
  // The game's camera sits behind the head, a little up and to the right (PlayerController.placeCamera).
  const right = norm([d[1] * up(p)[2] - d[2] * up(p)[1], d[2] * up(p)[0] - d[0] * up(p)[2], d[0] * up(p)[1] - d[1] * up(p)[0]]);
  const o = back > 0 ? add(add(add(head, d, -back), right, 0.55), up(p), 0.25) : head;
  return { ox: o[0], oy: o[1], oz: o[2], dx: d[0], dy: d[1], dz: d[2] };
}

/** Attack with the selected weapon (fire or melee, as the client does). */
function attack(r: Room, ranged: boolean, npc: { x: number; y: number; z: number }, back = 0) {
  if (ranged) r.send("fire", { slot: 0, ...aim(r, npc, back), t: Date.now() });
  else r.send("melee", { slot: 0, t: Date.now(), heavy: false });
}

/** The pad-0 safe ring and a dry, open spot `metres` outside it. */
function spots(body: BodyId) {
  const inside = nearPad(body, 0, 4);
  expect(isSafe(BODIES[body], ...inside)).toBe(true);
  const outside = nearPad(body, 0, 26);
  expect(isSafe(BODIES[body], ...outside)).toBe(false);
  return { inside, outside };
}

describe("starter weapons on the combat planets", () => {
  for (const body of COMBAT_PLANETS) {
    for (const [starter, s] of STARTERS.entries()) {
      const ranged = s.weapon === "hexquill" || s.weapon === "carbine";
      it(`${body}: ${s.name} with the ${s.weapon} is refused inside a pad ring and lands outside`, async () => {
        const { r, denied, hits } = await shooter(body, starter);
        expect(me(r).weapon).toBeGreaterThan(0); // the starter weapon is in hand, not fists
        const { inside, outside } = spots(body);
        // The NPC stands a few metres ahead of the shooter (melee: within the arc).
        const at = (from: V) => offset(from, ranged ? 9 : 1.6, 0, BODIES[body].radius);

        // Inside the ring: refused, with the reason the client shows ("Weapons are holstered…").
        const target0 = at(inside);
        await standAt(r, inside, target0);
        expect(me(r).flags & PF.SAFE).toBeTruthy();
        attack(r, ranged, { x: target0[0], y: target0[1], z: target0[2] });
        await waitFor(() => denied.length > 0);
        expect(denied[0]).toEqual({ action: ranged ? "fire" : "melee", reason: "safe zone" });

        // Outside: accepted, and the NPC takes the hit.
        const target = at(outside);
        await standAt(r, outside, target);
        expect(me(r).flags & (PF.SAFE | PF.SWIMMING)).toBe(0);
        const id = await spawnNpc(r, "woolback", target, { instant: true, roam: 0 });
        await waitFor(() => !!st(r).npcs?.get(id));
        const npc = st(r).npcs.get(id);
        const hp = npc.hp;
        denied.length = 0;
        attack(r, ranged, npc);
        await waitFor(() => hits.some((h) => h.target === id) || denied.length > 0);
        expect(denied).toEqual([]);
        await waitFor(() => st(r).npcs.get(id)?.hp < hp);
      });
    }
  }

  it("a ranged shot from a camera zoomed all the way out (9 m behind the head) is accepted", async () => {
    const { r, denied, hits } = await shooter("arcadia", 0); // Hexwick, Hexquill
    const { outside } = spots("arcadia");
    const target = offset(outside, 10, 0, BODIES.arcadia.radius);
    await standAt(r, outside, target);
    const id = await spawnNpc(r, "woolback", target, { instant: true, roam: 0 });
    await waitFor(() => !!st(r).npcs?.get(id));
    attack(r, true, st(r).npcs.get(id), 9);
    await waitFor(() => hits.some((h) => h.target === id) || denied.length > 0);
    expect(denied).toEqual([]);
  });

  it("a shot whose aim line passes far from the shooter's head is still refused (origin)", async () => {
    const { r, denied } = await shooter("arcadia", 3); // Unit 7, carbine
    const { outside } = spots("arcadia");
    const target = offset(outside, 10, 0, BODIES.arcadia.radius);
    await standAt(r, outside, target);
    const shot = aim(r, { x: target[0], y: target[1], z: target[2] });
    // The same direction from 9 m to the side: that line never comes near the head.
    const p = pos(r);
    const side = norm([shot.dy * up(p)[2] - shot.dz * up(p)[1], shot.dz * up(p)[0] - shot.dx * up(p)[2], shot.dx * up(p)[1] - shot.dy * up(p)[0]]);
    r.send("fire", { slot: 0, ...shot, ox: shot.ox + side[0] * 9, oy: shot.oy + side[1] * 9, oz: shot.oz + side[2] * 9, t: Date.now() });
    await waitFor(() => denied.length > 0);
    expect(denied[0]).toEqual({ action: "fire", reason: "origin" });
  });

  // The origin slides along the aim line to the head (D-combat-1): it must not shoot through cover
  // in front of the head, nor reach further than the weapon does from the head.
  it("a zoomed-out shot still stops at cover in front of the shooter", async () => {
    const { r, hits } = await shooter("arcadia", 0); // Hexquill
    const terrain = createTerrain(BODIES.arcadia);
    const sys = serverRoom(r).systems.find((x) => x instanceof DestructionSystem) as DestructionSystem;
    const R = BODIES.arcadia.radius;
    // A tall, intact prop on dry, unsafe, gentle ground: stand 1.7 m on one side, the NPC 3 m beyond.
    let stand: V | null = null;
    let beyond: V | null = null;
    let prop = -1;
    for (const b of sys.list) {
      if (b.h < 2.5 || sys.isBroken(b.index)) continue;
      const c = norm([b.px, b.py, b.pz]);
      for (let k = 0; k < 8 && !stand; k++) {
        const ang = (k / 8) * Math.PI * 2;
        const side = norm([b.rx * Math.cos(ang) + b.fx * Math.sin(ang), b.ry * Math.cos(ang) + b.fy * Math.sin(ang), b.rz * Math.cos(ang) + b.fz * Math.sin(ang)]);
        const a = norm(add(c, side, (Math.max(b.hx, b.hz) + 1.2) / R));
        const z = norm(add(c, side, -(Math.max(b.hx, b.hz) + 3) / R));
        const ga = terrain.groundHeight(...a), gz = terrain.groundHeight(...z), gc = terrain.groundHeight(...c);
        if (ga < BODIES.arcadia.waterLevel + 0.5 || gz < BODIES.arcadia.waterLevel + 0.5) continue;
        if (Math.abs(ga - gc) > 0.3 || Math.abs(gz - gc) > 0.3 || isSafe(BODIES.arcadia, a[0] * R, a[1] * R, a[2] * R)) continue;
        if (sys.list.some((o) => o !== b && Math.hypot(o.px - b.px, o.py - b.py, o.pz - b.pz) < 8)) continue;
        stand = [a[0] * (R + ga), a[1] * (R + ga), a[2] * (R + ga)];
        prop = b.index;
        beyond = [z[0] * (R + gz), z[1] * (R + gz), z[2] * (R + gz)];
      }
      if (stand) break;
    }
    expect(stand, "a tall prop with room on both sides").not.toBeNull();
    await standAt(r, stand!, beyond!);
    const id = await spawnNpc(r, "woolback", beyond!, { instant: true, roam: 0 });
    await waitFor(() => !!st(r).npcs?.get(id));
    const shots: unknown[] = [];
    r.onMessage("projectile", (m) => shots.push(m));
    attack(r, true, st(r).npcs.get(id), 9); // camera 9 m back on the same line
    await waitFor(() => shots.length > 0);
    await new Promise((ok) => setTimeout(ok, 600)); // the bolt's flight
    expect(hits.filter((h) => h.target === id)).toEqual([]);
    // Control: with the prop broken, the same shot lands.
    sys.damage(prop, 1e6, "heavy", "comet", [0, 0, 1], null);
    await new Promise((ok) => setTimeout(ok, 450)); // the fire rate
    attack(r, true, st(r).npcs.get(id), 9);
    await waitFor(() => hits.some((h) => h.target === id));
  });

  it("a zoomed-out shot reaches no further than the weapon does from the head", async () => {
    const { r, hits, denied } = await shooter("arcadia", 0); // Hexquill: 40 m, the bolt flies 48 m at most
    const terrain = createTerrain(BODIES.arcadia);
    const R = BODIES.arcadia.radius;
    // A start outside a pad ring with open, dry ground for 56 m in some direction: nothing higher
    // than the shooter's chest in between, so terrain can't be what stops the bolt.
    let outside: V | null = null;
    let far: ((m: number) => V) | null = null;
    for (let pad = 0; pad < 12 && !far; pad++) {
      for (const out of [20, 30]) {
        const start = nearPad("arcadia", pad, out);
        if (isSafe(BODIES.arcadia, ...start)) continue;
        const g0 = terrain.groundHeight(...norm(start));
        for (let k = 0; k < 16 && !far; k++) {
          const line = (m: number) => offset(start, Math.cos((k / 16) * Math.PI * 2) * m, Math.sin((k / 16) * Math.PI * 2) * m, R);
          let ok = g0 > BODIES.arcadia.waterLevel + 0.5;
          for (let m = 2; m <= 56 && ok; m += 2) {
            const p = line(m);
            const g = terrain.groundHeight(...norm(p));
            ok = g < g0 + 1 && g > g0 - 3 && g > BODIES.arcadia.waterLevel + 0.5 && !isSafe(BODIES.arcadia, ...p);
          }
          if (ok) {
            outside = start;
            far = line;
          }
        }
        if (far) break;
      }
    }
    expect(far, "open ground for 56 m").not.toBeNull();
    const shoot = async (m: number) => {
      const at = far!(m);
      await standAt(r, outside!, at);
      const id = await spawnNpc(r, "woolback", at, { instant: true, roam: 0 });
      await waitFor(() => !!st(r).npcs?.get(id));
      await new Promise((ok) => setTimeout(ok, 450)); // the Hexquill's fire rate
      attack(r, true, st(r).npcs.get(id), 9);
      await new Promise((ok) => setTimeout(ok, 1600)); // 54 m at 45 m/s
      return hits.some((h) => h.target === id);
    };
    expect(await shoot(30)).toBe(true); // control: in range, from the same zoomed-out camera
    expect(await shoot(54)).toBe(false);
    expect(denied).toEqual([]);
  });

  it("a bolt that lands on a creature still arriving (invulnerable) says so instead of looking like a miss", async () => {
    const { r, denied, hits } = await shooter("arcadia", 0); // Hexquill
    const immune: { target: string; reason: string }[] = [];
    r.onMessage("immune", (m: { target: string; reason: string }) => immune.push(m));
    const { outside } = spots("arcadia");
    const target = offset(outside, 9, 0, BODIES.arcadia.radius);
    await standAt(r, outside, target);
    const id = await spawnNpc(r, "woolback", target, { roam: 0 }); // not instant: it fades in, invulnerable
    await waitFor(() => !!st(r).npcs?.get(id));
    expect(st(r).npcs.get(id).flags & 16).toBeTruthy(); // NF.SPAWNING
    attack(r, true, st(r).npcs.get(id));
    await waitFor(() => immune.length > 0 || hits.some((h) => h.target === id));
    expect(immune[0]).toEqual({ target: id, reason: "spawning" });
    expect(hits.filter((h) => h.target === id)).toEqual([]);
    expect(denied).toEqual([]);
  });

  it("right after arriving (spawn protection) an attack is refused with a reason", async () => {
    const { r, denied } = await shooter("hollowmere", 0);
    const { outside } = spots("hollowmere");
    r.send("admin", { cmd: "teleport", args: { x: outside[0], y: outside[1], z: outside[2] } });
    await waitFor(() => flat(pos(r), outside) < 1.5 && !(me(r).flags & PF.SAFE));
    expect(me(r).flags & PF.PROTECTED).toBeTruthy();
    attack(r, true, { x: outside[0], y: outside[1], z: outside[2] });
    await waitFor(() => denied.length > 0);
    expect(denied[0]).toEqual({ action: "fire", reason: "protected" });
  });

  it("the starter weapon keeps working after a level-up and loot in the hotbar", async () => {
    const { r, denied, hits } = await shooter("meridian", 0);
    r.send("admin", { cmd: "level", args: { level: 6 } });
    r.send("admin", { cmd: "give", args: { id: "emberglass", tier: 1 } });
    await waitFor(() => me(r).level === 6);
    const { outside } = spots("meridian");
    const target = offset(outside, 9, 0, BODIES.meridian.radius);
    await standAt(r, outside, target);
    const id = await spawnNpc(r, "woolback", target, { instant: true, roam: 0 });
    await waitFor(() => !!st(r).npcs?.get(id));
    attack(r, true, st(r).npcs.get(id));
    await waitFor(() => hits.some((h) => h.target === id) || denied.length > 0);
    expect(denied).toEqual([]);
  });
});
