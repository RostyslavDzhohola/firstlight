// Prism Bubble rules that are awkward to observe through sockets (content.md §2.3): splash,
// projectiles and NPC ranged attacks crossing the shell are stopped and the shell takes the damage;
// attacks that don't cross it (both sides inside, or melee) land; the shell pops at 0 HP or on time.

import { describe, expect, it } from "vitest";
import { BODIES, padDirs } from "@firstlight/shared";
import { NPC_INDEX, npcDef } from "@firstlight/shared/content/npcs";
import { WEAPON_INDEX, weapon } from "@firstlight/shared/content/weapons";
import { explode, fire, projectiles, stepProjectiles, type Projectile } from "../src/world/combat.ts";
import { DestructionSystem } from "../src/world/destruction.ts";
import type { BodyRoom } from "../src/world/BodyRoom.ts";
import type { V3 } from "../src/world/geometry.ts";
import { spawnBolt, stepNpcProjectiles } from "../src/world/npc/attacks.ts";
import { BubbleField, segmentShellT } from "../src/world/support.ts";
import { fakeWorld, type FakeWorld } from "./npcWorld.ts";

/** Ground point `metres` along a fixed tangent from Arcadia's main pad. */
function at(w: FakeWorld, metres: number): V3 {
  const R = BODIES.arcadia.radius;
  const d = padDirs(BODIES.arcadia)[0]!;
  const ref = Math.abs(d[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  const k = ref[0]! * d[0] + ref[1]! * d[1] + ref[2]! * d[2];
  const t = [ref[0]! - k * d[0], ref[1]! - k * d[1], ref[2]! - k * d[2]];
  const tl = Math.hypot(t[0]!, t[1]!, t[2]!);
  const v = [d[0] + (t[0]! / tl) * (metres / R), d[1] + (t[1]! / tl) * (metres / R), d[2] + (t[2]! / tl) * (metres / R)];
  const l = Math.hypot(v[0]!, v[1]!, v[2]!);
  return w.world.snapToGround([(v[0]! / l) * R, (v[1]! / l) * R, (v[2]! / l) * R]);
}

const lift = (p: V3, h: number): V3 => {
  const l = Math.hypot(p[0], p[1], p[2]);
  return [p[0] + (p[0] / l) * h, p[1] + (p[1] / l) * h, p[2] + (p[2] / l) * h];
};

function setup() {
  const w = fakeWorld("arcadia");
  const pops: number[] = [];
  const field = new BubbleField((b) => pops.push(b.id));
  w.world.host.bubbles = field;
  return { w, field, pops };
}

describe("shell geometry", () => {
  it("finds where a segment crosses the shell, from either side", () => {
    const c: V3 = [0, 0, 0];
    expect(segmentShellT([-10, 0, 0], [1, 0, 0], 20, c, 3)).toBeCloseTo(7, 6);
    expect(segmentShellT([0, 0, 0], [1, 0, 0], 20, c, 3)).toBeCloseTo(3, 6);
    expect(segmentShellT([-10, 0, 0], [1, 0, 0], 5, c, 3)).toBeNull(); // stops short
    expect(segmentShellT([-1, 0, 0], [1, 0, 0], 1.5, c, 3)).toBeNull(); // both ends inside
    expect(segmentShellT([-10, 5, 0], [1, 0, 0], 20, c, 3)).toBeNull(); // passes by
    expect(segmentShellT([10, 0, 0], [1, 0, 0], 20, c, 3)).toBeNull(); // behind
  });

  it("pops when its HP runs out or its time is up", () => {
    const { field, pops } = setup();
    const a = field.add("p1", [0, 0, 0], 3, 100, 5000);
    const b = field.add("p2", [50, 0, 0], 3, 100, 9000);
    field.absorb(a, 60);
    expect(a.hp).toBe(40);
    field.absorb(a, 60);
    expect(pops).toEqual([a.id]);
    expect(field.list).toEqual([b]);
    field.expire(8999);
    expect(field.list).toEqual([b]);
    field.expire(9000);
    expect(pops).toEqual([a.id, b.id]);
    expect(field.list).toEqual([]);
  });
});

describe("what the shell stops", () => {
  it("splash crossing the shell: nothing reaches the player inside; the shell takes it", () => {
    const { w, field } = setup();
    const inside = w.addPlayer("in", at(w, 80), 1);
    const outside = w.addPlayer("out", at(w, 120), 1);
    const owner = w.addPlayer("owner", at(w, 200), 1);
    const shell = field.add("in", at(w, 80), 3, 150, w.clock.t + 6000);
    const comet = WEAPON_INDEX.get("comet")!;
    explode(w.world.host, owner, lift(at(w, 83.5), 0.5), 4, 45, comet);
    explode(w.world.host, owner, lift(at(w, 123.5), 0.5), 4, 45, comet);
    expect(inside.state.hp).toBe(100);
    expect(outside.state.hp).toBeLessThan(100);
    expect(shell.hp).toBeLessThan(150);
    // A blast inside the shell isn't crossing it.
    explode(w.world.host, owner, lift(at(w, 81), 0.5), 4, 45, comet);
    expect(inside.state.hp).toBeLessThan(100);
  });

  it("a projectile flying into the shell stops at it", () => {
    const { w, field } = setup();
    const target = w.addPlayer("in", at(w, 80), 1);
    const shooter = w.addPlayer("shooter", at(w, 92), 1);
    const shell = field.add("in", at(w, 80), 3, 150, w.clock.t + 6000);
    const from = lift(at(w, 92), 1.6);
    const to = lift(at(w, 80), 1.0);
    const d: V3 = [to[0] - from[0], to[1] - from[1], to[2] - from[2]];
    const l = Math.hypot(...d);
    const def = weapon("hexquill");
    const pr: Projectile = {
      id: 1, owner: shooter, weapon: def, tier: def.tiers[0], damage: 15, pos: from, vel: [(d[0] / l) * 45, (d[1] / l) * 45, (d[2] / l) * 45],
      gravity: 0, travelled: 0, maxDist: 60, pierceLeft: 0, hit: new Set([shooter.id]), fuseAt: null, stuck: false,
    };
    projectiles(w.world.host).push(pr);
    for (let i = 0; i < 20; i++) stepProjectiles(w.world.host, 0.05);
    expect(projectiles(w.world.host)).toHaveLength(0);
    expect(target.state.hp).toBe(100);
    expect(shell.hp).toBe(135);
  });

  it("NPC bolts and NPC hits from outside stop at the shell; from inside (melee) they land", () => {
    const { w, field } = setup();
    const p = w.addPlayer("in", at(w, 80), 1);
    const shell = field.add("in", at(w, 80), 3, 150, w.clock.t + 6000);
    const archer = w.sys.createNpc(NPC_INDEX.get("sparkfly")!, 2, at(w, 92), w.clock.t, { instant: true });
    const pellet = npcDef("sparkfly").attacks.find((a) => a.shape === "bolt")!;
    w.step(1); // the NPC system's list of live players (so the bolt could hit p if the shell let it)
    spawnBolt(w.sys, archer, lift(at(w, 92), 1.2), lift(at(w, 80), 0.9), pellet, 10, w.clock.t);
    for (let i = 0; i < 40; i++) {
      w.clock.t += 50;
      stepNpcProjectiles(w.sys, w.clock.t, 0.05);
    }
    expect(w.sys.projectiles).toHaveLength(0);
    expect(p.state.hp).toBe(100);
    expect(shell.hp).toBe(140);
    // A burst round from outside (source given) is stopped; a bite from inside the shell is not.
    expect(w.sys.hitPlayer(archer, p, 9, { src: lift(at(w, 92), 1.2) })).toBe(0);
    expect(shell.hp).toBe(131);
    expect(w.sys.hitPlayer(archer, p, 9, { src: lift(at(w, 81), 1.0) })).toBe(9);
    expect(w.sys.hitPlayer(archer, p, 5)).toBe(5);
  });

  it("a piercing bolt that hits someone just outside the shell still stops at the shell (nearest hit first)", () => {
    const { w, field } = setup();
    // Downhill from 78 m to 90 m: a clear line over open ground.
    const shooter = w.addPlayer("shooter", at(w, 78), 12);
    const front = w.addPlayer("front", at(w, 86), 1);
    const inside = w.addPlayer("inside", at(w, 91.5), 1);
    const shell = field.add("inside", at(w, 90), 3, 150, w.clock.t + 6000);
    const from = lift(at(w, 78), 1.0);
    const to = lift(at(w, 91.5), 1.0);
    const d: V3 = [to[0] - from[0], to[1] - from[1], to[2] - from[2]];
    const l = Math.hypot(...d);
    const def = weapon("hexquill");
    projectiles(w.world.host).push({
      id: 7, owner: shooter, weapon: def, tier: def.tiers[2], damage: 26, pos: from, vel: [(d[0] / l) * 45, (d[1] / l) * 45, (d[2] / l) * 45],
      gravity: 0, travelled: 0, maxDist: 60, pierceLeft: 2, hit: new Set([shooter.id]), fuseAt: null, stuck: false,
    });
    // One long step (10 m) crosses the front player and the shell's surface together.
    stepProjectiles(w.world.host, 10 / 45);
    for (let i = 0; i < 10; i++) stepProjectiles(w.world.host, 0.05);
    expect(front.state.hp).toBe(100 - 26);
    expect(inside.state.hp).toBe(100);
    expect(shell.hp).toBe(150 - 26);
    expect(projectiles(w.world.host)).toHaveLength(0);
  });

  it("an NPC bolt hits a player standing in front of a shell before the shell", () => {
    const { w, field } = setup();
    const front = w.addPlayer("front", at(w, 86.5), 1);
    const shell = field.add("other", at(w, 90), 3, 150, w.clock.t + 6000);
    const spark = w.sys.createNpc(NPC_INDEX.get("sparkfly")!, 2, at(w, 78), w.clock.t, { instant: true });
    const pellet = npcDef("sparkfly").attacks.find((a) => a.shape === "bolt")!;
    w.step(1); // the NPC system's list of live players
    spawnBolt(w.sys, spark, lift(at(w, 78), 1.0), lift(at(w, 90), 1.0), pellet, 10, w.clock.t);
    for (let i = 0; i < 12 && w.sys.projectiles.length; i++) {
      w.clock.t += 300;
      stepNpcProjectiles(w.sys, w.clock.t, 0.3);
    }
    expect(front.state.hp).toBe(90);
    expect(shell.hp).toBe(150);
  });
});

/** A destruction system on a fake world (the room surface it needs, nothing more). */
function destructionOn(w: FakeWorld): DestructionSystem {
  const room = { terrain: w.world.terrain, state: { broken: new Map<string, number>() }, broadcastNear: () => {}, host: w.world.host, actors: w.players } as unknown as BodyRoom;
  const sys = new DestructionSystem(room, () => w.clock.t);
  w.world.host.props = sys;
  return sys;
}

describe("splash and shells (review B2, S3, S7)", () => {
  it("splash from outside doesn't reach a fuel drum inside a shell, so nobody inside is blown up by it", () => {
    const w = fakeWorld("meridian");
    const field = new BubbleField();
    w.world.host.bubbles = field;
    const sys = destructionOn(w);
    const drum = sys.list.find((b) => b.kind === "fueldrum")!;
    const right = (m: number): V3 => w.world.snapToGround([drum.px + drum.rx * m, drum.py + drum.ry * m, drum.pz + drum.rz * m]);
    const victim = w.addPlayer("victim", right(1.0), 1);
    const owner = w.addPlayer("owner", right(30), 1);
    const shell = field.add("victim", right(1.0), 3, 150, w.clock.t + 6000);
    // A rocket bursting just outside the shell, with the drum (inside the shell) within its 4.5 m.
    explode(w.world.host, owner, lift(right(4.3), 0.6), 4.5, 61, WEAPON_INDEX.get("comet")!);
    expect(sys.hp[drum.index]).toBe(30);
    expect(sys.isBroken(drum.index)).toBe(false);
    expect(victim.state.hp).toBe(100);
    expect(shell.hp).toBeLessThan(150);
    expect(shell.hp).toBeGreaterThan(80); // charged once, not once per victim or prop
  });

  it("a nearly spent shell still protects everyone behind it from one blast (decided before it pops)", () => {
    const { w, field } = setup();
    const a = w.addPlayer("a", at(w, 90), 1);
    const b = w.addPlayer("b", at(w, 90.3), 1);
    const owner = w.addPlayer("owner", at(w, 120), 1);
    const shell = field.add("a", at(w, 90), 3, 5, w.clock.t + 6000);
    explode(w.world.host, owner, lift(at(w, 94), 0.5), 4.5, 61, WEAPON_INDEX.get("comet")!);
    expect([a.state.hp, b.state.hp]).toEqual([100, 100]);
    expect(field.list).not.toContain(shell); // it popped doing it
  });

  it("a fuel drum blast charges a shell it can't get through exactly once", () => {
    const w = fakeWorld("meridian");
    const field = new BubbleField();
    w.world.host.bubbles = field;
    const sys = destructionOn(w);
    const drum = sys.list.find((b) => b.kind === "fueldrum")!;
    const right = (m: number): V3 => w.world.snapToGround([drum.px + drum.rx * m, drum.py + drum.ry * m, drum.pz + drum.rz * m]);
    const a = w.addPlayer("a", right(-3.2), 1);
    const b = w.addPlayer("b", right(-3.4), 1);
    const shell = field.add("a", right(-3.3), 1.5, 150, w.clock.t + 6000);
    const shooter = w.addPlayer("shooter", right(25), 1);
    sys.damage(drum.index, 100, "light", "carbine", [1, 0, 0], shooter.id);
    expect(sys.isBroken(drum.index)).toBe(true);
    expect([a.state.hp, b.state.hp]).toEqual([100, 100]);
    const charged = 150 - shell.hp;
    expect(charged).toBeGreaterThan(0);
    expect(charged).toBeLessThan(60); // one charge, not one per protected player
  });

  it("a Stormcoil jump that the shell intercepts stops there and charges the shell", () => {
    const { w, field } = setup();
    const p = w.addPlayer("caster", at(w, 78), 6);
    p.char.hotbar[0] = { id: "stormcoil", tier: 2, qty: 1 };
    p.char.selected = 0;
    const first = w.addPlayer("first", at(w, 86), 1);
    const sheltered = w.addPlayer("sheltered", at(w, 90), 1);
    const shell = field.add("sheltered", at(w, 90), 2, 150, w.clock.t + 6000);
    const head = lift(at(w, 78), 1.6);
    const aim = lift(at(w, 86), 1.0);
    const d = [aim[0] - head[0], aim[1] - head[1], aim[2] - head[2]];
    const l = Math.hypot(d[0]!, d[1]!, d[2]!);
    fire(w.world.host, p, { ox: head[0], oy: head[1], oz: head[2], dx: d[0]! / l, dy: d[1]! / l, dz: d[2]! / l });
    expect(first.state.hp).toBeLessThan(100);
    expect(sheltered.state.hp).toBe(100);
    expect(shell.hp).toBeLessThan(150);
  });
});
