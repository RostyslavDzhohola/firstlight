// F12 review fixes in the NPC and boss systems, driven through the real NpcSystem on a fake world
// (manual clock): unreachable targets, outside-arena damage, arena cover and props in NPC sight.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BODIES, padDirs } from "@firstlight/shared";
import { walk } from "@firstlight/shared/content/arenas";
import { NF, NPC_INDEX } from "@firstlight/shared/content/npcs";
import { dealDamage } from "../src/world/combat.ts";
import type { V3 } from "../src/world/geometry.ts";
import { NPC_TUNING, resetTuning } from "../src/world/npc/index.ts";
import { MODE, type Npc } from "../src/world/npc/npc.ts";
import { fakeWorld, type FakeWorld } from "./npcWorld.ts";

beforeEach(() => {
  resetTuning();
  NPC_TUNING.ambient = false;
  NPC_TUNING.bosses = false;
});
afterEach(() => resetTuning());

/** Ground point `metres` from Arcadia's main pad along a fixed tangent (+ `side`). */
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
    const p = w.addPlayer("tagged", arcadiaPoint(w, 6), 5);
    const wolf = w.sys.createNpc(NPC_INDEX.get("dusk_wolf")!, 5, arcadiaPoint(w, 32), w.clock.t, { instant: true }) as Npc;
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

/** Spawn the copy's boss and run past its 1 s materialise. */
function bossReady(w: FakeWorld): Npc {
  NPC_TUNING.bosses = true;
  NPC_TUNING.bossAttacks = false;
  NPC_TUNING.bossMechanics = [];
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
    const sniper = w.addPlayer("sniper", arenaPoint(w, ar.radius + 25), 8);
    const n = bossReady(w);
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
    // With the two inside gone, the boss turns on the one hitting it from the edge…
    w.movePlayer(a, arenaPoint(w, -ar.radius - 60));
    w.movePlayer(b, arenaPoint(w, -ar.radius - 60, 4));
    dealDamage(w.world.host, s, n, 500, false);
    run(w, 600);
    expect(w.sys.boss!.count).toBe(1);
    expect(n.target).toBe(s);
    // …and forgets them 10 s after their last hit.
    expect(run(w, 11_000, () => w.sys.boss!.count === 0)).toBeGreaterThan(9000);
    expect(n.state.maxHp).toBe(12_000);
  });
});
