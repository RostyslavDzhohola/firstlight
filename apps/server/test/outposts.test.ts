// The planets' pad-0 outposts on the server (D42-D44). Real path: a client walking into the Arcadia
// barn is corrected and never stands inside it; the jetty is walkable to its end; a save inside
// Meridian's Waystation Nine and a teleport into the Hollowmere chapel are placed clear, so the real
// client controller starts where the server does; a carbine shot through the barn hits nobody behind
// it. Unit level (the real NpcSystem and combat on the real terrain, a manual clock): NPCs don't see
// through buildings, their bolts and strikes stop at walls, a blast doesn't reach round a corner, a
// melee NPC chasing round the barn reaches its target or evades (never stuck at a wall), one whose
// target stands at the end of the jetty evades instead of waiting at the shore, and the creep groups
// near pad 0 start beside the outpost, not inside it. Round 2 (D-b2-1): the outposts are walled safe
// zones; the barn, haystacks and windmill stand outside Arcadia's wall, in the fields, so the
// fights here happen there.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BODIES, type BodyId } from "@firstlight/shared";
import { bossArena, walk } from "@firstlight/shared/content/arenas";
import { NPC_DEFS, NPC_INDEX } from "@firstlight/shared/content/npcs";
import { OUTPOSTS, type OutpostBody } from "@firstlight/shared/content/padOutposts";
import { PLAYER_BODY } from "@firstlight/shared/planet/collide";
import { outpostGroundDistance } from "@firstlight/shared/planet/outpostGround";
import { outpostAnchor, siteCoords, siteDir, siteSolids, structureCollider, type StructureSolid } from "@firstlight/shared/planet/sites";
import { newCharacter } from "@firstlight/shared/content/character";
import { characterRepo } from "../src/world/characters.ts";
import { dealDamage, explode } from "../src/world/combat.ts";
import { rayTerrain, type V3 } from "../src/world/geometry.ts";
import { canSee, chest, spawnBolt } from "../src/world/npc/attacks.ts";
import { NPC_TUNING, resetTuning } from "../src/world/npc/index.ts";
import { MODE, type Npc } from "../src/world/npc/npc.ts";
import { buildSpawnPoints } from "../src/world/npc/spawns.ts";
import { npcBody } from "../src/world/npc/steer.ts";
import { joinAs, safeLeave, startServer, waitFor } from "./helpers.ts";
import { fakeWorld, type FakeWorld } from "./npcWorld.ts";
import * as Q from "./quest-helpers.ts";

// ------------------------------------------------------------------------------------ site points

const R = (body: BodyId) => BODIES[body].radius;
const anchor = (body: OutpostBody) => outpostAnchor(Q.terrain(body));
const walls = (body: OutpostBody) => structureCollider(Q.terrain(body));

/** Feet on the ground (or on a structure's walkable top, a jetty deck) at site point (east, north). */
function at(body: OutpostBody, east: number, north: number): V3 {
  const d = siteDir(anchor(body), east, north, R(body));
  const g = Q.ground(body, d);
  const r = Math.hypot(...g);
  const top = walls(body).footing(d[0] * (r + 1.5), d[1] * (r + 1.5), d[2] * (r + 1.5), PLAYER_BODY.step).top;
  const feet = Math.max(r, top + 0.02);
  return [d[0] * feet, d[1] * feet, d[2] * feet];
}
const coords = (body: OutpostBody, p: { x: number; y: number; z: number }) => siteCoords(anchor(body), p.x, p.y, p.z, R(body));
const inside = (body: OutpostBody, p: { x: number; y: number; z: number }, radius: number = PLAYER_BODY.radius) =>
  walls(body).footing(p.x, p.y, p.z, PLAYER_BODY.step, { radius, height: 1.8, step: PLAYER_BODY.step }).inside;
const item = (body: OutpostBody, name: string) => OUTPOSTS[body].layout.find((it) => OUTPOSTS[body].prefabs[it[0]]!.name === name)!;
const lift = (p: V3, h: number): V3 => {
  const l = Math.hypot(...p);
  return [(p[0] / l) * (l + h), (p[1] / l) * (l + h), (p[2] / l) * (l + h)];
};

/** The ground box (lowest solid) of a building, with its centre and axes in site coordinates. */
function footprint(body: OutpostBody, name: string) {
  const it = item(body, name);
  const index = OUTPOSTS[body].layout.indexOf(it);
  const s = siteSolids(Q.terrain(body)).find((x) => x.item === index) as StructureSolid;
  const [ce, cn] = siteCoords(anchor(body), s.px, s.py, s.pz, R(body));
  const along = (vx: number, vy: number, vz: number): [number, number] => {
    const [e, n] = siteCoords(anchor(body), s.px + vx, s.py + vy, s.pz + vz, R(body));
    return [e - ce, n - cn];
  };
  const right = along(s.rx, s.ry, s.rz), front = along(s.fx, s.fy, s.fz);
  /** Site point `x` m along the building's right axis and `z` m along its front axis from its centre. */
  const local = (x: number, z: number): [number, number] => [ce + right[0] * x + front[0] * z, cn + right[1] * x + front[1] * z];
  return { hx: s.hx, hz: s.hz, local };
}

// ------------------------------------------------------------------------------------ real path

/** Wait until the server has replicated input `seq` (accepted, or refused and corrected). */
const processed = (b: Q.Bot, seq: number) => Q.until(`input ${seq} replicated`, () => (Q.me(b).seq ?? 0) >= seq);

/** Run along site points at 5 m/s (client packets every 50 ms); returns the corrections received. */
async function run(b: Q.Bot, body: OutpostBody, path: readonly (readonly [number, number])[]): Promise<number> {
  let corrections = 0;
  const off = b.room.onMessage("correct", () => corrections++);
  let seq = (Q.me(b).seq ?? 0) + 100;
  for (let k = 0; k + 1 < path.length; k++) {
    const [ae, an] = path[k]!, [be, bn] = path[k + 1]!;
    const n = Math.max(1, Math.ceil(Math.hypot(be - ae, bn - an) / 0.25));
    const fd = siteDir(anchor(body), ae + (be - ae) * 0.01, an + (bn - an) * 0.01, R(body));
    for (let i = 1; i <= n; i++) {
      const p = at(body, ae + ((be - ae) * i) / n, an + ((bn - an) * i) / n);
      b.send("input", { seq: ++seq, x: p[0], y: p[1], z: p[2], fx: fd[0], fy: fd[1], fz: fd[2], anim: 1, t: Date.now() });
      await Q.sleep(50); // client packet pacing
    }
  }
  await processed(b, seq);
  off();
  return corrections;
}

interface Controller {
  pos: { x: number; y: number; z: number };
  facing: { x: number; y: number; z: number };
  anim: number;
  update(dt: number, input: unknown, aiming: boolean): void;
  teleport(x: number, y: number, z: number): void;
  correct(x: number, y: number, z: number): void;
  setStructures(c: unknown): void;
}

/** The client's PlayerController (apps/client) on `body`, with the outpost's structures as the client gets them. */
async function realController(body: OutpostBody): Promise<Controller> {
  const url = new URL("../../client/src/game/PlayerController.ts", import.meta.url).href;
  const { PlayerController } = (await import(/* @vite-ignore */ url)) as { PlayerController: new (t: unknown, water: number) => Controller };
  const pc = new PlayerController(Q.terrain(body), BODIES[body].waterLevel);
  pc.setStructures({ resolve: (p: { x: number; y: number; z: number }, out: never) => walls(body).resolve(p, out) });
  return pc;
}

/** A standing player's input (no keys): the controller only settles and resolves. */
const idle = { locked: true, mouseDX: 0, mouseDY: 0, wheel: 0, sensitivity: 0.002, invertY: false, pressed: new Set<string>(), keys: new Set<string>(), down: () => false };

/** Drive the real controller for 1 s from the server's position (as Game.frame does); returns the corrections. */
async function drive(b: Q.Bot, body: OutpostBody): Promise<{ corrections: number; pc: Controller }> {
  const pc = await realController(body);
  const me = Q.me(b);
  pc.teleport(me.x, me.y, me.z);
  let corrections = 0;
  const off = b.room.onMessage("correct", (m: { x: number; y: number; z: number }) => {
    corrections++;
    pc.correct(m.x, m.y, m.z);
  });
  let seq = (me.seq ?? 0) + 100;
  for (let k = 0; k < 20; k++) {
    pc.update(0.05, idle, false);
    b.room.send("input", { seq: ++seq, x: pc.pos.x, y: pc.pos.y, z: pc.pos.z, fx: pc.facing.x, fy: pc.facing.y, fz: pc.facing.z, anim: pc.anim, t: Date.now() });
    await Q.sleep(50);
  }
  await processed(b, seq);
  off();
  return { corrections, pc };
}

describe("pad outposts in the real movement path (D44)", () => {
  beforeAll(async () => {
    Q.harness.game = await startServer();
  });
  afterAll(async () => {
    for (const r of Q.harness.rooms.splice(0)) await safeLeave(r);
    await Q.harness.game!.close();
  });

  it("refuses walking into the Arcadia barn: corrections, and the player never stands inside it", async () => {
    const b = await Q.bot("outpost_barn_walker", "arcadia");
    const barn = footprint("arcadia", "a_barn");
    const front = barn.local(0, barn.hz + 2.5), back = barn.local(0, -barn.hz - 2.5);
    await Q.tpAndWait(b, at("arcadia", ...front));
    const corrections = await run(b, "arcadia", [front, barn.local(0, 0), back]);
    expect(corrections).toBeGreaterThan(0);
    const p = Q.me(b);
    expect(inside("arcadia", p)).toBe(false);
    // Still in front of the barn (its front faces the pad, south).
    const [e, n] = coords("arcadia", p);
    const [be, bn] = barn.local(0, 0);
    expect(n).toBeLessThan(bn - barn.hz + 0.2);
    expect(Math.abs(e - be)).toBeLessThan(2);
  });

  it("accepts walking out along the Arcadia jetty to its end (its deck is walkable)", async () => {
    const b = await Q.bot("outpost_jetty_walker", "arcadia");
    const jetty = footprint("arcadia", "a_jetty");
    // The deck runs from its shore end (local z = hz) out over the water (local z = -hz).
    const shore = jetty.local(0, jetty.hz + 1.5), end = jetty.local(0, -jetty.hz + 0.6);
    await Q.tpAndWait(b, at("arcadia", ...shore));
    expect(await run(b, "arcadia", [shore, end])).toBe(0);
    expect(Q.near(b, at("arcadia", ...end), 1)).toBe(true);
    // Out over the water: the lake bed lies well below the deck.
    const p = Q.me(b);
    const l = Math.hypot(p.x, p.y, p.z);
    expect(l - R("arcadia") - Q.terrain("arcadia").groundHeight(p.x / l, p.y / l, p.z / l)).toBeGreaterThan(0.8);
  });

  it("a save at the centre of Meridian's Waystation Nine joins outside it, and the real controller gets no correction loop", async () => {
    const station = footprint("meridian", "m_waystation");
    const userId = "outpost_saved_waystation";
    const c = newCharacter(0, 0);
    c.body = "meridian";
    c.pos = at("meridian", ...station.local(0, 0));
    expect(inside("meridian", { x: c.pos[0]!, y: c.pos[1]!, z: c.pos[2]! })).toBe(true);
    characterRepo.current.save(userId, c);
    const room = await joinAs(Q.harness.game!, userId, "meridian");
    Q.harness.rooms.push(room);
    const me = () => (room.state as any).players?.get(room.sessionId);
    await waitFor(() => !!me());
    const b = { room, id: room.sessionId } as Q.Bot;
    const start = { x: me().x, y: me().y, z: me().z };
    expect(inside("meridian", start)).toBe(false);
    expect(Math.hypot(start.x - c.pos[0]!, start.y - c.pos[1]!, start.z - c.pos[2]!)).toBeLessThan(9);
    const { corrections, pc } = await drive(b, "meridian");
    expect(corrections).toBe(0);
    expect(Math.hypot(pc.pos.x - me().x, pc.pos.y - me().y, pc.pos.z - me().z)).toBeLessThan(0.05);
  });

  it("an admin teleport into the Hollowmere chapel lands outside it, and the controller agrees with the server", async () => {
    const b = await Q.bot("outpost_chapel_teleporter", "hollowmere");
    const chapel = item("hollowmere", "h_chapel");
    const target = at("hollowmere", chapel[1], chapel[2]);
    Q.tp(b, target);
    await Q.until("teleported by the chapel", () => Q.near(b, target, 9) && !Q.near(b, at("hollowmere", 0, 0), 12));
    expect(inside("hollowmere", Q.me(b))).toBe(false);
    expect((await drive(b, "hollowmere")).corrections).toBe(0);
  });

  it("a carbine shot through the barn hits nobody behind it; the same shot beside the barn does", async () => {
    const shooter = await Q.bot("outpost_shooter", "arcadia", "admin", { starter: 3 });
    const target = await Q.bot("outpost_target", "arcadia", "admin", { starter: 3 });
    const barn = footprint("arcadia", "a_barn");
    const place = async (b: Q.Bot, p: V3) => {
      b.send("admin", { cmd: "teleport", args: { x: p[0], y: p[1], z: p[2] } });
      b.send("admin", { cmd: "unprotect" });
      await Q.until("placed", () => Q.near(b, p, 0.3) && !(Q.me(b).flags & 3));
    };
    const shoot = (from: V3, aim: V3) => {
      const o = lift(from, 1.6);
      const d: V3 = [aim[0] - o[0], aim[1] - o[1], aim[2] - o[2]];
      const l = Math.hypot(...d);
      shooter.send("scope", { on: true });
      shooter.send("fire", { slot: 0, ox: o[0], oy: o[1], oz: o[2], dx: d[0] / l, dy: d[1] / l, dz: d[2] / l, t: Date.now() });
    };
    // Through the barn: 2.5 m in front of it to 2.5 m behind it.
    const a = at("arcadia", ...barn.local(0, barn.hz + 2.5)), z = at("arcadia", ...barn.local(0, -barn.hz - 2.5));
    await place(shooter, a);
    await place(target, z);
    await Q.sleep(300);
    const hp0 = Q.me(target).hp;
    shoot(a, lift(z, 1.1));
    await Q.sleep(900);
    expect(Q.me(target).hp).toBe(hp0);
    // Control: the same line 11 m to the barn's side, clear of it (and of the terrain).
    const a2 = at("arcadia", ...barn.local(barn.hx + 7, barn.hz + 2.5)), z2 = at("arcadia", ...barn.local(barn.hx + 7, -barn.hz - 2.5));
    const o2 = lift(a2, 1.6), c2 = lift(z2, 1.1);
    const d2: V3 = [c2[0] - o2[0], c2[1] - o2[1], c2[2] - o2[2]];
    const l2 = Math.hypot(...d2);
    expect(rayTerrain(Q.terrain("arcadia"), o2, [d2[0] / l2, d2[1] / l2, d2[2] / l2], l2, 0.5)).toBeGreaterThan(l2);
    expect(walls("arcadia").blocks(...o2, ...c2)).toBe(false);
    await place(shooter, a2);
    await place(target, z2);
    await Q.sleep(300);
    const hp1 = Q.me(target).hp;
    shoot(a2, c2);
    await Q.until("the control shot hits", () => Q.me(target).hp < hp1, 3000);
  });

  it("a shooter who steps a few centimetres into the barn's face (within the move tolerance) still can't shoot through it", async () => {
    const shooter = await Q.bot("outpost_wall_shooter", "arcadia", "admin", { starter: 3 });
    const target = await Q.bot("outpost_wall_target", "arcadia", "admin", { starter: 3 });
    const barn = footprint("arcadia", "a_barn");
    const groundAt = (e: number, n: number) => Q.ground("arcadia", siteDir(anchor("arcadia"), e, n, R("arcadia")));
    const outsideFace = barn.local(0, barn.hz + 1), inFace = barn.local(0, barn.hz - 0.025);
    const behind = groundAt(...barn.local(0, -barn.hz - 2.5));
    for (const [b, p] of [[shooter, groundAt(...outsideFace)], [target, behind]] as const) {
      b.send("admin", { cmd: "teleport", args: { x: p[0], y: p[1], z: p[2] } });
      b.send("admin", { cmd: "unprotect" });
      await Q.until("placed", () => Q.near(b, p, 0.3) && !(Q.me(b).flags & 3));
    }
    // Walk up to and 2.5 cm into the front face: the movement tolerance accepts it.
    let corrections = 0;
    const off = shooter.room.onMessage("correct", () => corrections++);
    let seq = (Q.me(shooter).seq ?? 0) + 100;
    const fd = siteDir(anchor("arcadia"), inFace[0], inFace[1], R("arcadia"));
    for (let i = 1; i <= 10; i++) {
      const k = i / 10;
      const p = groundAt(outsideFace[0] + (inFace[0] - outsideFace[0]) * k, outsideFace[1] + (inFace[1] - outsideFace[1]) * k);
      shooter.send("input", { seq: ++seq, x: p[0], y: p[1], z: p[2], fx: fd[0] - p[0] / Math.hypot(...p), fy: fd[1] - p[1] / Math.hypot(...p), fz: fd[2] - p[2] / Math.hypot(...p), anim: 1, t: Date.now() });
      await Q.sleep(50);
    }
    await Q.until("input replicated", () => (Q.me(shooter).seq ?? 0) >= seq);
    off();
    const feet = groundAt(...inFace);
    expect(corrections).toBe(0);
    expect(Q.near(shooter, feet, 0.05)).toBe(true);
    // From there, through the barn at the target behind it: the wall the shooter stands in stops it.
    await Q.sleep(300);
    const hp0 = Q.me(target).hp;
    const o = lift(feet, 1.6), c = lift(behind, 1.1);
    const d: V3 = [c[0] - o[0], c[1] - o[1], c[2] - o[2]];
    const l = Math.hypot(...d);
    shooter.send("scope", { on: true });
    shooter.send("fire", { slot: 0, ox: o[0], oy: o[1], oz: o[2], dx: d[0] / l, dy: d[1] / l, dz: d[2] / l, t: Date.now() });
    await Q.sleep(900);
    expect(Q.me(target).hp).toBe(hp0);
  });
});

// ------------------------------------------------------------------------------------ NPCs and combat

describe("pad outposts against NPCs and blasts (D43, D44)", () => {
  beforeAll(() => {
    resetTuning();
    NPC_TUNING.ambient = false;
    NPC_TUNING.bosses = false;
  });
  afterAll(() => resetTuning());

  /** Fake-world feet at a site point (ground, or a walkable structure top). */
  const spot = (w: FakeWorld, body: OutpostBody, e: number, n: number): V3 => {
    const g = w.world.snapToGround(siteDir(anchor(body), e, n, R(body)));
    const top = at(body, e, n);
    return Math.hypot(...top) > Math.hypot(...g) + 0.05 ? top : g;
  };
  function run(w: FakeWorld, ms: number, each?: () => boolean): number {
    for (let t = 0; t < ms; t += 50) {
      w.step(50);
      if (each?.()) return t + 50;
    }
    return -1;
  }
  const npc = (w: FakeWorld, id: string, level: number, p: V3) => w.sys.createNpc(NPC_INDEX.get(id)!, level, p, w.clock.t, { instant: true }) as Npc;
  const npcInside = (body: OutpostBody, n: Npc) => inside(body, { x: n.pos[0], y: n.pos[1], z: n.pos[2] }, n.radius);

  it("NPCs don't see through the barn: a bone archer facing a player behind it never notices them; in the open it does", () => {
    const w = fakeWorld("arcadia", { immortal: true });
    const barn = footprint("arcadia", "a_barn");
    const eye = (p: V3) => chest(p, 1.5);
    // 22 m apart (beyond hearing, inside sight), the barn between.
    const pp = spot(w, "arcadia", ...barn.local(0, -barn.hz - 3)), np = spot(w, "arcadia", ...barn.local(0, barn.hz + 3.5));
    expect(canSee(w.sys, eye(np), chest(pp, 1.4))).toBe(false);
    // Clear of the barn, the same distance.
    const pp2 = spot(w, "arcadia", ...barn.local(barn.hx + 7, -barn.hz - 3)), np2 = spot(w, "arcadia", ...barn.local(barn.hx + 7, barn.hz + 3.5));
    expect(canSee(w.sys, eye(np2), chest(pp2, 1.4))).toBe(true);
    // Perception (cone + sight) on the real tick: hidden, then in the open.
    const p = w.addPlayer("hidden", pp);
    const archer = npc(w, "bone_archer", 6, np);
    archer.facing = [0, 0, 0];
    const face = () => {
      const d: V3 = [p.state.x - archer.pos[0], p.state.y - archer.pos[1], p.state.z - archer.pos[2]];
      const u = Math.hypot(...archer.pos);
      const k = (d[0] * archer.pos[0] + d[1] * archer.pos[1] + d[2] * archer.pos[2]) / u;
      const t: V3 = [d[0] - (k * archer.pos[0]) / u, d[1] - (k * archer.pos[1]) / u, d[2] - (k * archer.pos[2]) / u];
      const l = Math.hypot(...t);
      archer.facing = [t[0] / l, t[1] / l, t[2] / l];
    };
    face();
    expect(run(w, 4000, () => { face(); return archer.target !== null; })).toBe(-1);
    w.movePlayer(p, pp2);
    archer.pos = np2;
    face();
    expect(run(w, 4000, () => { face(); return archer.target !== null; })).toBeGreaterThan(0);
  });

  it("an NPC bolt stops at the barn; the same bolt beside it hits", () => {
    const w = fakeWorld("arcadia", { immortal: false });
    const barn = footprint("arcadia", "a_barn");
    const pp = spot(w, "arcadia", ...barn.local(0, -barn.hz - 3)), np = spot(w, "arcadia", ...barn.local(0, barn.hz + 3.5));
    const p = w.addPlayer("behind", pp);
    const archer = npc(w, "bone_archer", 6, np);
    const bolt = archer.def.attacks.find((a) => a.shape === "bolt")!;
    spawnBolt(w.sys, archer, chest(archer.pos, 1.5), chest(pp, 1.1), bolt, 20, w.clock.t);
    run(w, 3000);
    expect(p.state.hp).toBe(p.state.maxHp);
    // Beside the barn.
    const pp2 = spot(w, "arcadia", ...barn.local(barn.hx + 7, -barn.hz - 3)), np2 = spot(w, "arcadia", ...barn.local(barn.hx + 7, barn.hz + 3.5));
    w.movePlayer(p, pp2);
    archer.pos = np2;
    spawnBolt(w.sys, archer, chest(np2, 1.5), chest(pp2, 1.1), bolt, 20, w.clock.t);
    expect(run(w, 3000, () => p.state.hp < p.state.maxHp)).toBeGreaterThan(0);
  });

  it("a blast doesn't reach round the barn's corner; the same blast in the open does (breakables keep their rule)", () => {
    const w = fakeWorld("arcadia", { immortal: true });
    const barn = footprint("arcadia", "a_barn");
    const owner = w.addPlayer("bomber", spot(w, "arcadia", ...barn.local(barn.hx + 12, barn.hz + 12)));
    // Blast 0.5 m in front of the barn's front face near its corner; the victim 0.5 m off its side
    // face, 2.5 m away: the corner lies between them.
    const blastAt = (e: number, n: number) => lift(spot(w, "arcadia", e, n), 1.0);
    const sheltered = npc(w, "bonewalker", 5, spot(w, "arcadia", ...barn.local(barn.hx + 0.5, barn.hz - 1.5)));
    const open = npc(w, "bonewalker", 5, spot(w, "arcadia", ...barn.local(barn.hx + 7.5, barn.hz - 1.5)));
    expect(npcInside("arcadia", sheltered)).toBe(false);
    const hp = sheltered.state.hp, hpOpen = open.state.hp;
    explode(w.world.host, owner, blastAt(...barn.local(barn.hx - 1, barn.hz + 0.5)), 4, 60, 0);
    expect(sheltered.state.hp).toBe(hp);
    explode(w.world.host, owner, blastAt(...barn.local(barn.hx + 6, barn.hz + 0.5)), 4, 60, 0);
    expect(open.state.hp).toBeLessThan(hpOpen);
  });

  /** A melee NPC on the far side of a building from its target: does it reach the target or evade within `ms`? Never inside. */
  function chaseRound(body: OutpostBody, building: string, kind: string, side: "front" | "back" | "left" | "right") {
    const w = fakeWorld(body, { immortal: true });
    const f = footprint(body, building);
    const off = (k: number): [number, number] =>
      side === "front" ? f.local(0, k * (f.hz + 3)) : side === "back" ? f.local(0, -k * (f.hz + 3)) : side === "left" ? f.local(-k * (f.hx + 3), 0) : f.local(k * (f.hx + 3), 0);
    const p = w.addPlayer("hider", spot(w, body, ...off(-1)));
    const n = npc(w, kind, 5, spot(w, body, ...off(1)));
    expect(npcInside(body, n)).toBe(false);
    dealDamage(w.world.host, p, n, 1, false);
    let reached = false, evaded = false, wasInside = false;
    run(w, 25_000, () => {
      if (npcInside(body, n)) wasInside = true;
      if (p.state.hp < p.state.maxHp) reached = true;
      if (n.mode === MODE.EVADE) evaded = true;
      return reached || evaded;
    });
    return { reached, evaded, wasInside, n, w };
  }

  // (Round 2: Meridian's buildings all stand inside its walled outpost now, so its enforcer runs round the barn.)
  for (const [body, building, kind] of [["arcadia", "a_barn", "bonewalker"], ["arcadia", "a_barn", "gnawer"], ["arcadia", "a_barn", "enforcer"]] as const) {
    for (const side of ["front", "back", "left", "right"] as const) {
      it(`a ${kind} chasing a player round the ${building} (from its ${side}) reaches them or evades; never stuck, never inside`, () => {
        const r = chaseRound(body, building, kind, side);
        expect(r.reached || r.evaded, `${kind} ${side}: mode ${r.n.mode}`).toBe(true);
        expect(r.wasInside).toBe(false);
      });
    }
  }

  it("a melee NPC with its target just behind a haystack goes round it or gives up; it never swings at the stack forever", () => {
    // (Round 2: the lantern posts this used stand inside the walled outposts now; the haystack north of
    // Arcadia's wall is the nearest slim obstacle out in the fields.)
    const w = fakeWorld("arcadia", { immortal: true });
    const site = OUTPOSTS.arcadia;
    const index = site.layout.map((it, i) => [it, i] as const).filter(([it]) => site.prefabs[it[0]]!.name === "a_hay").at(0)![1];
    const stack = siteSolids(Q.terrain("arcadia")).find((x) => x.item === index)!;
    const [ce, cn] = siteCoords(anchor("arcadia"), stack.px, stack.py, stack.pz, R("arcadia"));
    expect(Math.hypot(ce, cn)).toBeGreaterThan(OUTPOSTS.arcadia.wall.radius + 3);
    // Either side of the stack along a line through it, 1 m off its side each.
    const k0 = stack.hx + 1;
    const along = (k: number) => spot(w, "arcadia", ce + k, cn);
    const p = w.addPlayer("hider", along(-k0));
    const n = npc(w, "bonewalker", 6, along(k0));
    expect(npcInside("arcadia", n)).toBe(false);
    const a = chest(n.pos, Math.min(n.height * 0.8, 2)), b = chest([p.state.x, p.state.y, p.state.z], 1.1);
    expect(walls("arcadia").blocks(...a, ...b)).toBe(true); // the stack is in the way
    const start = [...n.pos] as V3;
    dealDamage(w.world.host, p, n, 1, false);
    let reached = false, evaded = false;
    const t = run(w, 15_000, () => {
      if (p.state.hp < p.state.maxHp) reached = true;
      if (n.mode === MODE.EVADE) evaded = true;
      return reached || evaded;
    });
    expect(reached || evaded, `mode ${n.mode}, moved ${Math.hypot(n.pos[0] - start[0], n.pos[1] - start[1], n.pos[2] - start[2]).toFixed(2)} m`).toBe(true);
    expect(t).toBeLessThan(NPC_TUNING.unreachableMs + 3000);
    expect(npcInside("arcadia", n)).toBe(false);
  });

  it("a melee-only NPC whose target stands at the end of the jetty evades instead of waiting at the shore", () => {
    const w = fakeWorld("arcadia", { immortal: true });
    const jetty = footprint("arcadia", "a_jetty");
    const end = at("arcadia", ...jetty.local(0, -jetty.hz + 0.6));
    const p = w.addPlayer("angler", end);
    const n = npc(w, "bonewalker", 5, spot(w, "arcadia", ...jetty.local(0, jetty.hz + 4)));
    dealDamage(w.world.host, p, n, 1, false);
    const t = run(w, 15_000, () => n.mode === MODE.EVADE);
    expect(t).toBeGreaterThan(0);
    expect(t).toBeLessThan(NPC_TUNING.unreachableMs + 4000);
    expect(p.state.hp).toBe(p.state.maxHp);
    // And it never walked onto the jetty or into the lake.
    expect(npcInside("arcadia", n)).toBe(false);
  });

  it("creep groups near pad 0 (the arrival herds and packs, D-zones-2) start on open ground beside the outpost", () => {
    for (const body of ["arcadia", "hollowmere", "meridian"] as const) {
      const t = Q.terrain(body);
      let near = 0;
      for (const p of buildSpawnPoints(t, bossArena(t))) {
        for (const m of p.members) {
          const q = walk(p.dir, p.t1, m.a, p.t2, m.b, R(body));
          const [e, n] = siteCoords(anchor(body), q[0], q[1], q[2], R(body));
          if (Math.hypot(e, n) > 90) continue;
          near++;
          expect(outpostGroundDistance(body, e, n), `${body} group ${p.id}`).toBeGreaterThanOrEqual(1.5 + NPC_DEFS[m.def]!.radius);
        }
      }
      expect(near, body).toBeGreaterThan(0);
    }
  });

  it("a big NPC put down against the barn is pushed clear for its own body (radius 1.1), not the player's", () => {
    const w = fakeWorld("arcadia", { immortal: true });
    const barn = footprint("arcadia", "a_barn");
    const golem = npc(w, "cabinet_golem", 5, spot(w, "arcadia", ...barn.local(barn.hx + 0.6, 0)));
    expect(walls("arcadia").isClear({ x: golem.pos[0], y: golem.pos[1], z: golem.pos[2] }, npcBody(golem.radius, golem.height))).toBe(true);
  });
});
