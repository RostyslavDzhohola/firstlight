// Creeps reach a player wading in shallow water (D-solid-2). Players wade (and shoot) in water up to
// SWIM_DEPTH (1.2 m) deep, but ground creeps only stepped 0.6 m in: a Hopbit chasing a player who
// stood knee-deep in a lake found them "out of reach", gave up, ran home healed to full, and every
// later shot made it give up again at once (the pad-shooter rule), so it could never be killed (e2e
// J3.4: 70 Hexquill hits, no kill). Chasing, ground creeps now wade as deep as a player can stand;
// a swimmer (who can't shoot) is still out of reach, and calm creeps keep to the shallows.

import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { BODIES } from "@firstlight/shared";
import { SWIM_DEPTH } from "@firstlight/shared/planet/water";
import { NPC_INDEX } from "@firstlight/shared/content/npcs";
import { dealDamage } from "../src/world/combat.ts";
import { NPC_TUNING, resetTuning } from "../src/world/npc/index.ts";
import { MODE, type Npc } from "../src/world/npc/npc.ts";
import { feetHeight, nearSafeRing } from "../src/world/npc/steer.ts";
import type { V3 } from "../src/world/geometry.ts";
import { fakeWorld, type FakeWorld } from "./npcWorld.ts";

const BODY = BODIES.arcadia;
/** Where the e2e player stood: 0.9 m deep in a lake 42 m from Dawnpad (wading, not swimming). */
const WADE: V3 = [287.6, 406.9, -28.5];

function frame(p: readonly number[]): { u: V3; e: V3; n: V3 } {
  const l = Math.hypot(p[0]!, p[1]!, p[2]!);
  const u: V3 = [p[0]! / l, p[1]! / l, p[2]! / l];
  const k = u[2];
  const el = Math.hypot(-k * u[0], -k * u[1], 1 - k * u[2]);
  const e: V3 = [(-k * u[0]) / el, (-k * u[1]) / el, (1 - k * u[2]) / el];
  const n: V3 = [u[1] * e[2] - u[2] * e[1], u[2] * e[0] - u[0] * e[2], u[0] * e[1] - u[1] * e[0]];
  return { u, e, n };
}
const depth = (w: FakeWorld, p: readonly number[]) => {
  const l = Math.hypot(p[0]!, p[1]!, p[2]!);
  return BODY.waterLevel - w.world.terrain.groundHeight(p[0]! / l, p[1]! / l, p[2]! / l);
};

/** A dry spot (ground ≥ 0.3 m above the water) `m` metres from `p`, off the safe zones. */
function dryNear(w: FakeWorld, p: V3, m: number): V3 {
  const { e, n } = frame(p);
  for (let b = 0; b < 360; b += 10) {
    const r = (b * Math.PI) / 180;
    const q = w.world.snapToGround([p[0] + (e[0] * Math.cos(r) + n[0] * Math.sin(r)) * m, p[1] + (e[1] * Math.cos(r) + n[1] * Math.sin(r)) * m, p[2] + (e[2] * Math.cos(r) + n[2] * Math.sin(r)) * m]);
    if (depth(w, q) < -0.3 && !nearSafeRing(w.sys.ground, q[0], q[1], q[2], 8)) return q;
  }
  throw new Error("no dry ground nearby");
}

/** A spot `lo`–`hi` m deep within 40 m of `p`. */
function waterNear(w: FakeWorld, p: V3, lo: number, hi: number): V3 {
  const { e, n } = frame(p);
  for (let m = 2; m < 40; m += 2) {
    for (let b = 0; b < 360; b += 15) {
      const r = (b * Math.PI) / 180;
      const q = w.world.snapToGround([p[0] + (e[0] * Math.cos(r) + n[0] * Math.sin(r)) * m, p[1] + (e[1] * Math.cos(r) + n[1] * Math.sin(r)) * m, p[2] + (e[2] * Math.cos(r) + n[2] * Math.sin(r)) * m]);
      const d = depth(w, q);
      if (d >= lo && d <= hi) return q;
    }
  }
  throw new Error(`no water ${lo}–${hi} m deep nearby`);
}

describe("creeps reach a wading player (D-solid-2)", () => {
  beforeEach(() => {
    resetTuning();
    NPC_TUNING.ambient = false;
    NPC_TUNING.bosses = false;
  });
  afterEach(() => resetTuning());

  it("a Hopbit chases a player standing 0.9 m deep in a lake, fights and can be killed; it never gives up", () => {
    const w = fakeWorld("arcadia", { immortal: true });
    const at = w.world.snapToGround(WADE);
    expect(depth(w, at)).toBeGreaterThan(0.6);
    expect(depth(w, at)).toBeLessThan(SWIM_DEPTH);
    const p = w.addPlayer("wader", at, 1);
    const n = w.sys.createNpc(NPC_INDEX.get("hopbit")!, 1, dryNear(w, at, 14), w.clock.t, { roam: 0, instant: true }) as Npc;
    let evaded = false, hurt = false;
    for (let t = 0; t < 20_000 && !n.dead; t += 50) {
      w.step(50);
      if (t % 600 === 0 && !n.dead) dealDamage(w.world.host, p, n, 1, false);
      if (n.mode === MODE.EVADE) evaded = true;
      if (p.state.hp < p.state.maxHp) hurt = true;
    }
    expect(evaded).toBe(false);
    expect(hurt).toBe(true);
    expect(n.dead).toBe(true);
  });

  it("a swimmer is still out of reach (the creep gives up); calm creeps keep to the shallows", () => {
    const w = fakeWorld("arcadia", { immortal: true });
    const swim = waterNear(w, w.world.snapToGround(WADE), SWIM_DEPTH + 0.6, 4);
    const R = BODY.radius;
    const l = Math.hypot(...swim);
    expect(feetHeight(w.sys.ground, swim[0] / l, swim[1] / l, swim[2] / l, "ground", 0, true)).toBeNull();
    // Calm (not chasing), a ground creep won't step where a wader stands knee-deep.
    const knee = waterNear(w, w.world.snapToGround(WADE), 0.7, 1.1);
    const kl = Math.hypot(...knee);
    expect(feetHeight(w.sys.ground, knee[0] / kl, knee[1] / kl, knee[2] / kl, "ground")).toBeNull();
    expect(feetHeight(w.sys.ground, knee[0] / kl, knee[1] / kl, knee[2] / kl, "ground", 0, true)).not.toBeNull();
    // A target swimming: the chase gives up after the unreachable clock.
    const p = w.addPlayer("swimmer", [swim[0] * (R + BODY.waterLevel - 1.05) / l, swim[1] * (R + BODY.waterLevel - 1.05) / l, swim[2] * (R + BODY.waterLevel - 1.05) / l], 1);
    const n = w.sys.createNpc(NPC_INDEX.get("hopbit")!, 1, dryNear(w, w.world.snapToGround(WADE), 14), w.clock.t, { roam: 0, instant: true }) as Npc;
    let evaded = false;
    for (let t = 0; t < 15_000 && !evaded; t += 50) {
      w.step(50);
      if (t % 600 === 0 && !n.dead && n.mode !== MODE.EVADE) dealDamage(w.world.host, p, n, 1, false);
      if (n.mode === MODE.EVADE) evaded = true;
    }
    expect(evaded).toBe(true);
  });
});
