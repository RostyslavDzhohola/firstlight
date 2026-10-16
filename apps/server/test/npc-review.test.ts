// F12 review fixes in the NPC and boss systems, driven through the real NpcSystem on a fake world
// (manual clock): unreachable targets, outside-arena damage, arena cover and props in NPC sight.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BODIES, isSafe, padDirs, type Breakable } from "@firstlight/shared";
import { walk } from "@firstlight/shared/content/arenas";
import { siteAnchor, siteDir } from "@firstlight/shared/planet/townFrame";
import { NF, NPC_INDEX } from "@firstlight/shared/content/npcs";
import { BodyState, PF } from "@firstlight/shared/net/schema";
import type { BodyRoom } from "../src/world/BodyRoom.ts";
import { copyStateStore, MemoryCopyStateStore } from "../src/world/copyState.ts";
import { DestructionSystem } from "../src/world/destruction.ts";
import { rayTerrain } from "../src/world/geometry.ts";
import type { PlayerActor } from "../src/world/actors.ts";
import { dealDamage, fire, stepProjectiles } from "../src/world/combat.ts";
import type { V3 } from "../src/world/geometry.ts";
import { NPC_TUNING, resetTuning } from "../src/world/npc/index.ts";
import type { BreakableHost } from "../src/world/combat.ts";
import { chest, spawnBolt } from "../src/world/npc/attacks.ts";
import { rayCylinder } from "../src/world/npc/boss.ts";
import { MODE, type Npc } from "../src/world/npc/npc.ts";
import { fakeWorld, type FakeWorld } from "./npcWorld.ts";

beforeEach(() => {
  resetTuning();
  NPC_TUNING.ambient = false;
  NPC_TUNING.bosses = false;
});
afterEach(() => resetTuning());

/** Ground point `metres` from Arcadia's main pad along a fixed tangent (+ `side`). */
/** Arcadia's pad 1 (a plain pad ring: pad 0's ring sits inside the walled outpost since round 2,
 * D-b2-1), `metres` out on bearing 20 (dry, open ground there). */
function ringPoint(w: FakeWorld, metres: number): V3 {
  const R = BODIES.arcadia.radius;
  const b = (20 * Math.PI) / 180;
  return w.world.snapToGround(siteDir(siteAnchor(padDirs(BODIES.arcadia)[1]!), Math.sin(b) * metres, Math.cos(b) * metres, R) as V3);
}

function arcadiaPoint(w: FakeWorld, metres: number, side = 0): V3 {
  const R = BODIES.arcadia.radius;
  const d = padDirs(BODIES.arcadia)[0]!;
  const t: V3 = [0, 0, 1];
  const k = t[0] * d[0] + t[1] * d[1] + t[2] * d[2];
  const t1: V3 = [t[0] - k * d[0], t[1] - k * d[1], t[2] - k * d[2]];
  const l1 = Math.hypot(...t1);
  const u: V3 = [t1[0] / l1, t1[1] / l1, t1[2] / l1];
  const s: V3 = [d[1] * u[2] - d[2] * u[1], d[2] * u[0] - d[0] * u[2], d[0] * u[1] - d[1] * u[0]];
  const v: V3 = [d[0] + (u[0] * metres + s[0] * side) / R, d[1] + (u[1] * metres + s[1] * side) / R, d[2] + (u[2] * metres + s[2] * side) / R];
  return w.world.snapToGround(v);
}

function run(w: FakeWorld, ms: number, until?: () => boolean): number {
  for (let t = 0; t < ms; t += 50) {
    w.step(50);
    if (until?.()) return t + 50;
  }
  return -1;
}

describe("unreachable targets (F12 should-fix 6)", () => {
  it("a melee NPC that can't reach a target on a pad's safe ring evades home and heals after ~5 s", () => {
    const w = fakeWorld("arcadia", { immortal: true });
    // On the pad but combat-tagged: not SAFE, so it can keep shooting (BodyRoom keeps SAFE off).
    const p = w.addPlayer("tagged", ringPoint(w, 6), 5);
    const wolf = w.sys.createNpc(NPC_INDEX.get("dusk_wolf")!, 5, ringPoint(w, 32), w.clock.t, { instant: true }) as Npc;
    const home = [...wolf.home];
    dealDamage(w.world.host, p, wolf, 10, false);
    expect(wolf.state.hp).toBeLessThan(wolf.state.maxHp);
    // It runs to the ring edge and can't bite; for the first ~4 s it keeps trying.
    run(w, 4000);
    expect(wolf.mode).not.toBe(MODE.EVADE);
    expect(p.state.hp).toBe(p.state.maxHp);
    // Then it gives up: evade (invulnerable) home, full HP.
    expect(run(w, 3000, () => wolf.mode === MODE.EVADE)).toBeGreaterThan(0);
    expect(run(w, 20_000, () => wolf.mode === MODE.IDLE)).toBeGreaterThan(0);
    expect(wolf.state.hp).toBe(wolf.state.maxHp);
    expect(Math.hypot(wolf.pos[0] - home[0]!, wolf.pos[1] - home[1]!, wolf.pos[2] - home[2]!)).toBeLessThan(3);
    expect(wolf.target).toBeNull();
  });

  it("re-aggroed by the same pad shooter after its heal, it gives up again at once: no kill inside a fresh window (F12 final Opus SF9)", () => {
    const w = fakeWorld("arcadia", { immortal: true });
    const p = w.addPlayer("camper", ringPoint(w, 6), 6);
    const wolf = w.sys.createNpc(NPC_INDEX.get("dusk_wolf")!, 4, ringPoint(w, 32), w.clock.t, { instant: true }) as Npc;
    dealDamage(w.world.host, p, wolf, 10, false);
    expect(run(w, 8000, () => wolf.mode === MODE.EVADE)).toBeGreaterThan(0);
    expect(run(w, 20_000, () => wolf.mode === MODE.IDLE)).toBeGreaterThan(0);
    // Healed and home. The camper keeps shooting from the ring: 20 % of its HP every 450 ms.
    const shot = wolf.state.maxHp * 0.2;
    let lowest = wolf.state.hp;
    for (let t = 0; t < 30_000 && !wolf.dead; t += 450) {
      dealDamage(w.world.host, p, wolf, shot, false);
      lowest = Math.min(lowest, wolf.state.hp);
      run(w, 450);
      lowest = Math.min(lowest, wolf.state.hp);
    }
    expect(wolf.dead).toBe(false);
    expect(p.state.hp).toBe(p.state.maxHp);
    // Only the shot that wakes it lands before it gives up and heals: never a window's worth.
    expect(lowest).toBeGreaterThanOrEqual(wolf.state.maxHp - shot - 1e-6);
  });

  it("a target just outside the ring but inside the NPC's steering margin is bitten, not evaded (Codex S4)", () => {
    const w = fakeWorld("arcadia", { immortal: true });
    // 14.5 m from the pad centre: outside the 12 m safe ring, inside the wolf's 12 + 3 + 0.5 m no-go zone.
    const p = w.addPlayer("margin", ringPoint(w, 14.5), 5);
    const wolf = w.sys.createNpc(NPC_INDEX.get("dusk_wolf")!, 5, ringPoint(w, 32), w.clock.t, { instant: true }) as Npc;
    dealDamage(w.world.host, p, wolf, 10, false);
    let bites = 0;
    let last = p.state.hp;
    run(w, 15_000, () => {
      if (p.state.hp < last) bites++;
      last = p.state.hp;
      return wolf.mode === MODE.EVADE;
    });
    expect(bites).toBeGreaterThan(2);
    expect(wolf.mode).not.toBe(MODE.EVADE);
    expect(wolf.state.hp).toBeLessThan(wolf.state.maxHp); // no free heal
  });

  it("a reachable target on open ground is still fought (no early evade)", () => {
    const w = fakeWorld("arcadia", { immortal: true });
    const p = w.addPlayer("open", arcadiaPoint(w, 70), 5);
    const wolf = w.sys.createNpc(NPC_INDEX.get("dusk_wolf")!, 5, arcadiaPoint(w, 80), w.clock.t, { instant: true }) as Npc;
    dealDamage(w.world.host, p, wolf, 10, false);
    let hurt = false;
    run(w, 8000, () => {
      if (p.state.hp < p.state.maxHp) hurt = true;
      return wolf.mode === MODE.EVADE;
    });
    expect(wolf.mode).not.toBe(MODE.EVADE);
    expect(hurt).toBe(true);
  });
});

/** A ground point `a` m along the arena axis and `b` m to its side from the arena centre. */
function arenaPoint(w: FakeWorld, a: number, b = 0): V3 {
  const ar = w.sys.arena!;
  return w.world.snapToGround(walk(ar.up, ar.axis, a, ar.side, b, w.world.body.radius));
}

/** Spawn the copy's boss and run past its 1 s materialise (a watcher outside the arena keeps it up). */
function bossReady(w: FakeWorld): Npc {
  NPC_TUNING.bosses = true;
  NPC_TUNING.bossAttacks = false;
  NPC_TUNING.bossMechanics = [];
  w.addPlayer("watcher", arenaPoint(w, -(w.sys.arena!.radius + 40)), 8);
  w.sys.boss!.forceSpawn(w.clock.t);
  const n = w.sys.boss!.npc!;
  run(w, 1500, () => !(n.state.flags & NF.INVULN));
  expect(n.state.flags & NF.INVULN).toBe(0);
  return n;
}

describe("boss arena reach (F12 should-fix 8)", () => {
  it("damage from beyond the arena radius + 10 m is ignored; from inside that band it counts", () => {
    const w = fakeWorld("arcadia", { immortal: true });
    const ar = w.sys.arena!;
    w.addPlayer("inside", arenaPoint(w, 0, 3), 8);
    const sniper = w.addPlayer("sniper", arenaPoint(w, ar.radius + 25), 8);
    const n = bossReady(w);
    run(w, 100);
    const hp = n.state.hp;
    expect(dealDamage(w.world.host, sniper, n, 1000, false)).toBe(false);
    expect(n.state.hp).toBe(hp);
    w.movePlayer(sniper, arenaPoint(w, ar.radius + 6));
    expect(dealDamage(w.world.host, sniper, n, 1000, false)).toBe(true);
    expect(n.state.hp).toBeLessThan(hp);
    // Mechanics (falling cover) and admin damage have no attacker and still count.
    expect(dealDamage(w.world.host, null, n, 1000, false)).toBe(true);
  });

  it("anyone who damaged the boss in the last 10 s counts for HP scaling and can be targeted", () => {
    const w = fakeWorld("arcadia", { immortal: true });
    const ar = w.sys.arena!;
    const a = w.addPlayer("a", arenaPoint(w, 0, 3), 8);
    const b = w.addPlayer("b", arenaPoint(w, 0, -3), 8);
    const s = w.addPlayer("s", arenaPoint(w, ar.radius + 6), 8);
    const n = bossReady(w);
    run(w, 200);
    expect(w.sys.boss!.count).toBe(2);
    expect(n.state.maxHp).toBe(12_000);
    // The player just outside the edge chips in: three engaged → +35%, percentage kept.
    dealDamage(w.world.host, s, n, 500, false);
    run(w, 100);
    expect(w.sys.boss!.count).toBe(3);
    expect(n.state.maxHp).toBe(16_200);
    // With the two inside gone, the boss turns on the one who hit it from the edge…
    w.movePlayer(a, arenaPoint(w, -ar.radius - 60));
    w.movePlayer(b, arenaPoint(w, -ar.radius - 60, 4));
    run(w, 600);
    expect(w.sys.boss!.count).toBe(1);
    expect(n.target).toBe(s);
    // …and forgets them 10 s after their last hit.
    expect(run(w, 11_000, () => w.sys.boss!.count === 0)).toBeGreaterThan(8500);
    expect(n.state.maxHp).toBe(12_000);
  });

  it("with nobody inside, hits from the outer band don't stick and don't hold off the reset (Codex B1)", () => {
    const w = fakeWorld("arcadia", { immortal: true });
    const ar = w.sys.arena!;
    const s = w.addPlayer("edge", arenaPoint(w, ar.radius + 6), 8);
    const n = bossReady(w);
    // Every 5 s for a minute: no damage, no engagement.
    for (let i = 0; i < 12; i++) {
      expect(dealDamage(w.world.host, s, n, 1000, false)).toBe(false);
      run(w, 5000);
    }
    expect(n.state.hp).toBe(n.state.maxHp);
    expect(w.sys.boss!.engaged).toBe(false);
  });

  it("once the arena empties, band hits stop counting and the boss resets 30 s later (Codex B1)", () => {
    const w = fakeWorld("arcadia", { immortal: true });
    const ar = w.sys.arena!;
    const a = w.addPlayer("tank", arenaPoint(w, 0, 3), 8);
    const s = w.addPlayer("edge", arenaPoint(w, ar.radius + 6), 8);
    const n = bossReady(w);
    run(w, 100);
    expect(dealDamage(w.world.host, s, n, 1000, false)).toBe(true);
    expect(w.sys.boss!.engaged).toBe(true);
    const hurt = n.state.hp;
    expect(hurt).toBeLessThan(n.state.maxHp);
    w.movePlayer(a, arenaPoint(w, -ar.radius - 60));
    const emptied = w.clock.t;
    let resetAfter = -1;
    while (w.clock.t - emptied < 40_000) {
      expect(dealDamage(w.world.host, s, n, 1000, false)).toBe(false); // every 5 s, for nothing
      if (run(w, 5000, () => n.state.hp === n.state.maxHp) >= 0) {
        resetAfter = w.clock.t - emptied;
        break;
      }
      expect(n.state.hp).toBe(hurt);
    }
    expect(resetAfter).toBeGreaterThanOrEqual(30_000);
    expect(resetAfter).toBeLessThanOrEqual(31_000);
  });
});

/** Up at a point, and a point `h` metres above it. */
const upAt = (p: V3): V3 => {
  const l = Math.hypot(p[0], p[1], p[2]);
  return [p[0] / l, p[1] / l, p[2] / l];
};
const above = (p: V3, h: number): V3 => {
  const u = upAt(p);
  return [p[0] + u[0] * h, p[1] + u[1] * h, p[2] + u[2] * h];
};

/** Fire `weapon` (scoped, no spread) from the player's head at a world point. */
function shoot(w: FakeWorld, p: PlayerActor, weapon: string, at: V3) {
  p.char.hotbar[0] = { id: weapon, tier: 1, qty: 1 };
  p.char.selected = 0;
  p.state.flags |= PF.SCOPED;
  p.lastAttackAt = 0;
  p.reloadEndsAt = 0;
  const head = above([p.state.x, p.state.y, p.state.z], 1.6);
  const d: V3 = [at[0] - head[0], at[1] - head[1], at[2] - head[2]];
  const l = Math.hypot(...d);
  const r = fire(w.world.host, p, { ox: head[0], oy: head[1], oz: head[2], dx: d[0] / l, dy: d[1] / l, dz: d[2] / l });
  expect(r).toEqual({ ok: true });
}

/** Advance combat projectiles only (the boss stays put). */
function flyProjectiles(w: FakeWorld, ms: number) {
  for (let t = 0; t < ms; t += 50) {
    w.clock.t += 50;
    stepProjectiles(w.world.host, 0.05);
  }
}

describe("boss arena cover stops ranged shots (F12 should-fix 11)", () => {
  /** Hollow King at home (15, 0); Nave pillar 7 at (18, 8); the shooter behind it at (21.6, 17.6). */
  function nave() {
    const w = fakeWorld("hollowmere", { immortal: true });
    const king = bossReady(w);
    const pillar = w.sys.boss!.cover.find((c) => c.def.id === 7)!;
    const chest = above(king.pos, 2.5);
    const clear = w.addPlayer("clear", arenaPoint(w, 0, 0), 20);
    const hidden = w.addPlayer("hidden", arenaPoint(w, 21.6, 17.6), 20);
    return { w, king, pillar, chest, clear, hidden };
  }

  it("a rifle shot with a clear line hits the King; one through a pillar stops at it", () => {
    const { w, king, pillar, chest, clear, hidden } = nave();
    const hp = king.state.hp;
    shoot(w, clear, "stillshot", chest);
    expect(king.state.hp).toBeLessThan(hp);
    const hp2 = king.state.hp;
    shoot(w, hidden, "stillshot", chest);
    expect(king.state.hp).toBe(hp2);
    expect(pillar.hp).toBe(pillar.def.hp); // light rounds can't hurt heavy-only cover
  });

  it("a rocket aimed through a pillar explodes on it (damaging it), not on the King", () => {
    const { w, king, pillar, chest, hidden } = nave();
    const hp = king.state.hp;
    shoot(w, hidden, "comet", chest);
    flyProjectiles(w, 1500);
    expect(king.state.hp).toBe(hp);
    expect(pillar.hp).toBeLessThan(pillar.def.hp);
  });

  it("a chain bolt aimed through a pillar ends on it (heavy: the pillar takes the hit)", () => {
    const { w, king, pillar, chest, hidden } = nave();
    const hp = king.state.hp;
    shoot(w, hidden, "stormcoil", chest);
    expect(king.state.hp).toBe(hp);
    expect(pillar.hp).toBeLessThan(pillar.def.hp);
  });
});

describe("rayCylinder", () => {
  // A 9 m pillar of radius 1 standing at the north pole of a 750 m sphere (up = +y).
  const base: V3 = [0, 750, 0];
  it("hits the side at the near surface, misses above the top and beside it", () => {
    expect(rayCylinder([-10, 752, 0], [1, 0, 0], 50, base, 1, 9)).toBeCloseTo(9, 6);
    expect(rayCylinder([-10, 760, 0], [1, 0, 0], 50, base, 1, 9)).toBe(Infinity);
    expect(rayCylinder([-10, 752, 1.5], [1, 0, 0], 50, base, 1, 9)).toBe(Infinity);
    expect(rayCylinder([-10, 752, 0], [1, 0, 0], 8, base, 1, 9)).toBe(Infinity); // beyond maxT
  });
  it("hits the top cap from above; a ray from inside doesn't trap the shooter", () => {
    expect(rayCylinder([0.2, 770, 0], [0, -1, 0], 50, base, 1, 9)).toBeCloseTo(11, 6);
    expect(rayCylinder([0, 752, 0], [1, 0, 0], 50, base, 1, 9)).toBe(Infinity);
  });
});

/** A stand-in for the destruction system: one intact prop, a column of radius 1.5 m rising 6 m above `at`. */
function column(at: V3): BreakableHost {
  const hit = { index: 0, t: 0 };
  const base = above(at, -3); // sunk into uneven ground: nothing passes under it
  return {
    raycast(o, d, maxT) {
      const t = rayCylinder(o, d, maxT, base, 1.5, 9);
      if (t === Infinity) return null;
      hit.t = t;
      return hit;
    },
    contains() {
      return false;
    },
    damage() {},
    splash() {},
    arc() {},
  };
}

describe("breakable props block NPC sight and bolts (F12 should-fix 12)", () => {
  it("an enemy doesn't notice a player behind a prop, and does once it's gone", () => {
    const w = fakeWorld("arcadia", { immortal: true });
    const p = w.addPlayer("hidden", arcadiaPoint(w, 70), 5);
    // 18 m away: beyond hearing (12 m), inside sight (25 m), facing the player.
    const n = w.sys.createNpc(NPC_INDEX.get("hopbit")!, 3, arcadiaPoint(w, 88), w.clock.t, { instant: true }) as Npc;
    const toP: V3 = [p.state.x - n.pos[0], p.state.y - n.pos[1], p.state.z - n.pos[2]];
    const u = upAt(n.pos);
    const k = toP[0] * u[0] + toP[1] * u[1] + toP[2] * u[2];
    const f: V3 = [toP[0] - u[0] * k, toP[1] - u[1] * k, toP[2] - u[2] * k];
    const fl = Math.hypot(...f);
    n.facing = [f[0] / fl, f[1] / fl, f[2] / fl];
    n.home = [...n.pos] as V3;
    n.roam = 0;
    w.world.host.props = column(arcadiaPoint(w, 79));
    run(w, 2000);
    expect(n.target).toBeNull();
    w.world.host.props = undefined; // broken
    expect(run(w, 2000, () => n.target === p)).toBeGreaterThan(0);
  });

  it("an NPC bolt stops at a prop instead of passing through to the player", () => {
    const w = fakeWorld("arcadia", { immortal: true });
    const p = w.addPlayer("behind", arcadiaPoint(w, 70), 5);
    const shooter = w.sys.createNpc(NPC_INDEX.get("sparkfly")!, 3, arcadiaPoint(w, 80), w.clock.t, { instant: true }) as Npc;
    w.sys.despawnNpc(shooter); // only its bolts act
    const pellet = shooter.def.attacks[0]!;
    const fireBolt = () => spawnBolt(w.sys, shooter, chest(shooter.pos, 0.6), chest([p.state.x, p.state.y, p.state.z], 0.9), pellet, 8, w.clock.t);
    w.world.host.props = column(arcadiaPoint(w, 75));
    fireBolt();
    run(w, 2000, () => w.sys.projectiles.length === 0);
    expect(w.sys.projectiles.length).toBe(0);
    expect(p.state.hp).toBe(p.state.maxHp);
    w.world.host.props = undefined;
    fireBolt();
    run(w, 2000, () => w.sys.projectiles.length === 0);
    expect(p.state.hp).toBeLessThan(p.state.maxHp);
  });
});

describe("NPC sight and bolts against a real prop (Codex N1)", () => {
  /** The production destruction system for the fake world's body, installed as the combat host's props. */
  function realProps(w: FakeWorld): DestructionSystem {
    copyStateStore.current = new MemoryCopyStateStore();
    const state = new BodyState();
    state.body = "arcadia";
    const room = { bodyDef: BODIES.arcadia, terrain: w.world.terrain, state, metadata: { body: "arcadia", copy: 0, loadtest: false }, host: w.world.host, broadcastNear() {} } as unknown as BodyRoom;
    const d = new DestructionSystem(room, () => w.clock.t);
    w.world.host.props = d;
    return d;
  }

  const dirTo = (a: V3, b: V3): [V3, number] => {
    const v: V3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const l = Math.hypot(...v);
    return [[v[0] / l, v[1] / l, v[2] / l], l];
  };

  /**
   * An intact prop with open, dry, non-pad ground 8 m to either side, where it alone blocks the
   * hopbit's eye line (0.72 m) to the player's chest (1.4 m) and the bolt line (0.6 m → 0.9 m).
   */
  function blockingProp(w: FakeWorld, d: DestructionSystem): { b: Breakable; npcAt: V3; playerAt: V3 } {
    const body = BODIES.arcadia;
    const lines = (npcAt: V3, playerAt: V3) => [[above(npcAt, 0.72), above(playerAt, 1.4)], [above(npcAt, 0.6), above(playerAt, 0.9)]] as [V3, V3][];
    for (const b of d.list) {
      for (const axis of [[b.fx, b.fy, b.fz], [b.rx, b.ry, b.rz]] as V3[]) {
        const side = (k: number) => w.world.snapToGround([b.px + axis[0] * k, b.py + axis[1] * k, b.pz + axis[2] * k]);
        const npcAt = side(8), playerAt = side(-8);
        const dry = (p: V3) => Math.hypot(...p) - body.radius > body.waterLevel + 0.3 && !isSafe(body, p[0], p[1], p[2]);
        if (!dry(npcAt) || !dry(playerAt)) continue;
        const ok = lines(npcAt, playerAt).every(([o, t]) => {
          const [dir, l] = dirTo(o, t);
          return rayTerrain(w.world.terrain, o, dir, l, 2.5) >= l - 0.75 && d.raycast(o, dir, l - 0.75)?.index === b.index;
        });
        if (!ok) continue;
        // Broken, nothing else is in the way.
        d.damage(b.index, 1e6, "heavy", "", axis);
        const open = lines(npcAt, playerAt).every(([o, t]) => {
          const [dir, l] = dirTo(o, t);
          return !d.raycast(o, dir, l - 0.75);
        });
        d.rebuild(b.index);
        if (open) return { b, npcAt, playerAt };
      }
    }
    throw new Error("no Arcadia prop blocks a clear 16 m line");
  }

  it("an intact prop hides the player from a hopbit; once broken, it notices", () => {
    const w = fakeWorld("arcadia", { immortal: true });
    const d = realProps(w);
    const { b, npcAt, playerAt } = blockingProp(w, d);
    const p = w.addPlayer("hidden", playerAt, 5);
    const n = w.sys.createNpc(NPC_INDEX.get("hopbit")!, 3, npcAt, w.clock.t, { instant: true, roam: 0 }) as Npc;
    const [toP] = dirTo(n.pos, [p.state.x, p.state.y, p.state.z]);
    const u = upAt(n.pos);
    const k = toP[0] * u[0] + toP[1] * u[1] + toP[2] * u[2];
    const f: V3 = [toP[0] - u[0] * k, toP[1] - u[1] * k, toP[2] - u[2] * k];
    const fl = Math.hypot(...f);
    n.facing = [f[0] / fl, f[1] / fl, f[2] / fl];
    run(w, 2000);
    expect(n.target).toBeNull();
    d.damage(b.index, 1e6, "heavy", "", [1, 0, 0]);
    expect(d.isBroken(b.index)).toBe(true);
    expect(run(w, 2000, () => n.target === p)).toBeGreaterThan(0);
  });

  it("an intact prop stops an NPC bolt; once broken, the bolt gets through", () => {
    const w = fakeWorld("arcadia", { immortal: true });
    const d = realProps(w);
    const { b, npcAt, playerAt } = blockingProp(w, d);
    const p = w.addPlayer("behind", playerAt, 5);
    const shooter = w.sys.createNpc(NPC_INDEX.get("sparkfly")!, 3, npcAt, w.clock.t, { instant: true }) as Npc;
    w.sys.despawnNpc(shooter);
    const fireBolt = () => spawnBolt(w.sys, shooter, above(npcAt, 0.6), above(playerAt, 0.9), shooter.def.attacks[0]!, 8, w.clock.t);
    fireBolt();
    run(w, 3000, () => w.sys.projectiles.length === 0);
    expect(w.sys.projectiles.length).toBe(0);
    expect(p.state.hp).toBe(p.state.maxHp);
    d.damage(b.index, 1e6, "heavy", "", [1, 0, 0]);
    fireBolt();
    run(w, 3000, () => w.sys.projectiles.length === 0);
    expect(p.state.hp).toBeLessThan(p.state.maxHp);
  });
});
