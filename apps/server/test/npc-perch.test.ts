// A player standing out of melee reach above an NPC (a pillar or wall top) is unreachable to it
// (F12 confirmation Opus should-fix 1, probe "perch"): the NPC evades home and heals instead of
// standing under the perch being shot down. Ranged NPCs and low perches (a crate) still fight.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BODIES, padDirs } from "@firstlight/shared";
import { NPC_INDEX } from "@firstlight/shared/content/npcs";
import { dealDamage } from "../src/world/combat.ts";
import type { V3 } from "../src/world/geometry.ts";
import { NPC_TUNING, resetTuning } from "../src/world/npc/index.ts";
import { MODE, type Npc } from "../src/world/npc/npc.ts";
import { fakeWorld, type FakeWorld } from "./npcWorld.ts";

describe("a player perched out of melee reach is unreachable to the NPC (F12 confirmation Opus SF1)", () => {
  /** Ground point `metres` from Arcadia's main pad along a fixed tangent, lifted `up` m. */
  function arcadiaPoint(w: FakeWorld, metres: number, up = 0): V3 {
    const R = BODIES.arcadia.radius;
    const d = padDirs(BODIES.arcadia)[0]!;
    const t: V3 = [0, 0, 1];
    const k = t[0] * d[0] + t[1] * d[1] + t[2] * d[2];
    const t1: V3 = [t[0] - k * d[0], t[1] - k * d[1], t[2] - k * d[2]];
    const l1 = Math.hypot(...t1);
    const v: V3 = [d[0] + (t1[0] / l1) * (metres / R), d[1] + (t1[1] / l1) * (metres / R), d[2] + (t1[2] / l1) * (metres / R)];
    const g = w.world.snapToGround(v);
    const l = Math.hypot(...g);
    return [(g[0] / l) * (l + up), (g[1] / l) * (l + up), (g[2] / l) * (l + up)];
  }
  function run(w: FakeWorld, ms: number, each?: () => boolean): number {
    for (let t = 0; t < ms; t += 50) {
      w.step(50);
      if (each?.()) return t + 50;
    }
    return -1;
  }
  beforeAll(() => {
    resetTuning();
    NPC_TUNING.ambient = false;
    NPC_TUNING.bosses = false;
  });
  afterAll(() => resetTuning());

  it("the review's perch: a level-20 dusk wolf under a 4.13 m pillar top evades and heals; the shooter never kills it", () => {
    const w = fakeWorld("arcadia", { immortal: true });
    const p = w.addPlayer("percher", arcadiaPoint(w, 70, 4.13), 6);
    const wolf = w.sys.createNpc(NPC_INDEX.get("dusk_wolf")!, 20, arcadiaPoint(w, 79), w.clock.t, { instant: true }) as Npc;
    // The perched player keeps shooting it for 30 s: 3 % of its HP every 450 ms (a kill in 15 s).
    const shot = wolf.state.maxHp * 0.03;
    let evades = 0;
    let healed = false;
    let mode = wolf.mode;
    for (let t = 0; t < 30_000 && !wolf.dead; t += 450) {
      dealDamage(w.world.host, p, wolf, shot, false);
      run(w, 450, () => {
        if (wolf.mode === MODE.EVADE && mode !== MODE.EVADE) evades++;
        if (mode === MODE.EVADE && wolf.mode !== MODE.EVADE && wolf.state.hp === wolf.state.maxHp) healed = true;
        mode = wolf.mode;
        return false;
      });
    }
    expect(wolf.dead).toBe(false);
    expect(evades).toBeGreaterThan(0);
    expect(healed).toBe(true);
    expect(p.state.hp).toBe(p.state.maxHp);
  });

  it("a target on a low crate (1 m up, within the bite's 3 m) is still fought, not evaded", () => {
    const w = fakeWorld("arcadia", { immortal: true });
    const p = w.addPlayer("cratesitter", arcadiaPoint(w, 70, 1.0), 5);
    const wolf = w.sys.createNpc(NPC_INDEX.get("dusk_wolf")!, 5, arcadiaPoint(w, 79), w.clock.t, { instant: true }) as Npc;
    dealDamage(w.world.host, p, wolf, 10, false);
    let hurt = false;
    run(w, 10_000, () => {
      if (p.state.hp < p.state.maxHp) hurt = true;
      return wolf.mode === MODE.EVADE;
    });
    expect(wolf.mode).not.toBe(MODE.EVADE);
    expect(hurt).toBe(true);
  });

  it("an NPC with a ranged attack keeps shooting a perched player instead of evading", () => {
    const w = fakeWorld("arcadia", { immortal: true });
    const p = w.addPlayer("perched", arcadiaPoint(w, 70, 4.13), 5);
    // Bone Archers walk and only shoot arrows (bolts fly in 3D).
    const npc = w.sys.createNpc(NPC_INDEX.get("bone_archer")!, 8, arcadiaPoint(w, 80), w.clock.t, { instant: true }) as Npc;
    dealDamage(w.world.host, p, npc, 1, false);
    run(w, 10_000, () => npc.mode === MODE.EVADE);
    expect(npc.mode).not.toBe(MODE.EVADE);
  });
});
