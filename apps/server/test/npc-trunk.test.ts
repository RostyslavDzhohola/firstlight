// A tree trunk between a Hopbit and its target (Codex review of D-solid-1): the Hopbit's only attack
// is a 3 m leap, a leap through a trunk is refused (it stays put), and the attack choice kept picking
// it while the stalled-chase rule only knew structures: at an Arcadia oak, 16 leap telegraphs in 20 s,
// no damage, never giving up, the player shooting from behind the trunk. Now a strike or leap whose
// line a trunk blocks isn't chosen: the creep steps round the trunk and fights, and a natural solid
// that keeps it from getting closer counts as walling it off (it gives up after unreachableMs).

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NPC_INDEX } from "@firstlight/shared/content/npcs";
import { natureSolids, propSolid, solidChunkProps, chunkOf, BODIES, type Face } from "@firstlight/shared";
import { dealDamage } from "../src/world/combat.ts";
import { NPC_TUNING, resetTuning } from "../src/world/npc/index.ts";
import { MODE, type Npc } from "../src/world/npc/npc.ts";
import type { V3 } from "../src/world/geometry.ts";
import { fakeWorld, type FakeWorld } from "./npcWorld.ts";

const OAK: V3 = [348.483916, -240.675232, -279.033278];

/** The oak's trunk radius (its solid), from the shared props. */
function trunkRadius(w: FakeWorld): number {
  const l = Math.hypot(...OAK);
  const c = chunkOf(OAK[0] / l, OAK[1] / l, OAK[2] / l, BODIES.arcadia.chunksPerFace);
  const p = solidChunkProps(w.world.terrain, c.face as Face, c.cx, c.cy).find((q) => Math.hypot(q.x - OAK[0], q.y - OAK[1], q.z - OAK[2]) < 0.01)!;
  return propSolid(p.kind, p.scale)!.radius;
}

/** The ground point `m` metres from the oak on bearing `deg`. */
function round(w: FakeWorld, deg: number, m: number): V3 {
  const l = Math.hypot(...OAK);
  const u = OAK.map((v) => v / l);
  const ref = Math.abs(u[2]!) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  const k = ref[0]! * u[0]! + ref[1]! * u[1]! + ref[2]! * u[2]!;
  const e = [ref[0]! - k * u[0]!, ref[1]! - k * u[1]!, ref[2]! - k * u[2]!];
  const el = Math.hypot(e[0]!, e[1]!, e[2]!);
  const n = [u[1]! * e[2]! - u[2]! * e[1]!, u[2]! * e[0]! - u[0]! * e[2]!, u[0]! * e[1]! - u[1]! * e[0]!].map((v) => v / el);
  const r = (deg * Math.PI) / 180;
  return w.world.snapToGround([0, 1, 2].map((j) => OAK[j]! + ((e[j]! / el) * Math.cos(r) + n[j]! * Math.sin(r)) * m) as V3);
}

describe("a Hopbit and a tree trunk between it and its target (D-solid-1)", () => {
  beforeEach(() => {
    resetTuning();
    NPC_TUNING.ambient = false;
    NPC_TUNING.bosses = false;
  });
  afterEach(() => resetTuning());

  for (const bearing of [0, 90, 180, 270]) {
    it(`bearing ${bearing}°: the player behind the oak is reached round the trunk (or the Hopbit gives up); never 20 s of leaping into it`, () => {
      const w = fakeWorld("arcadia", { immortal: true });
      const tr = trunkRadius(w);
      expect(natureSolids(w.world.terrain).near(OAK[0], OAK[1], OAK[2], 0.1)).toBe(true);
      const p = w.addPlayer("hider", round(w, bearing, tr + 0.6), 1);
      const n = w.sys.createNpc(NPC_INDEX.get("hopbit")!, 1, round(w, bearing + 180, tr + 1.4), w.clock.t, { roam: 0, instant: true }) as Npc;
      let hurtAt = -1, evadedAt = -1, leaps = 0, wasWindup = false;
      for (let t = 0; t < 20_000 && hurtAt < 0 && evadedAt < 0 && !n.dead; t += 50) {
        w.step(50);
        if (t % 1000 === 0 && !n.dead && n.mode !== MODE.EVADE) dealDamage(w.world.host, p, n, 1, false);
        if (n.mode === MODE.WINDUP && !wasWindup) leaps++;
        wasWindup = n.mode === MODE.WINDUP;
        if (p.state.hp < p.state.maxHp) hurtAt = t;
        if (n.mode === MODE.EVADE) evadedAt = t;
      }
      expect(hurtAt >= 0 || evadedAt >= 0, `leaps ${leaps}, mode ${n.mode}`).toBe(true);
      // Round a lone trunk it reaches the player.
      expect(hurtAt, `leaps ${leaps}, evaded at ${evadedAt}`).toBeGreaterThanOrEqual(0);
      expect(hurtAt).toBeLessThan(8000);
    });
  }
});
