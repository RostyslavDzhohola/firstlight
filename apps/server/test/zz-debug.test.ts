import { it } from "vitest";
import { BODIES } from "@firstlight/shared";
import { NPC_INDEX } from "@firstlight/shared/content/npcs";
import { OUTPOSTS } from "@firstlight/shared/content/padOutposts";
import { outpostAnchor, siteCoords, siteDir, siteSolids, structureCollider } from "@firstlight/shared/planet/sites";
import { dealDamage } from "../src/world/combat.ts";
import { NPC_TUNING, resetTuning } from "../src/world/npc/index.ts";
import type { Npc } from "../src/world/npc/npc.ts";
import { chest } from "../src/world/npc/attacks.ts";
import { fakeWorld } from "./npcWorld.ts";
it("debug", () => {
  resetTuning(); NPC_TUNING.ambient = false; NPC_TUNING.bosses = false;
  const body = "arcadia";
  const w = fakeWorld(body, { immortal: true });
  const R = BODIES[body].radius;
  const a = outpostAnchor(w.world.terrain);
  const S = structureCollider(w.world.terrain);
  const pos = (e: number, n: number) => w.world.snapToGround(siteDir(a, e, n, R));
  const p = w.addPlayer("hider", pos(-0.5, 37.3 - 3)); // front (south)
  const n = w.sys.createNpc(NPC_INDEX.get("bonewalker")!, 5, pos(-0.5, 47.7 + 3), w.clock.t, { instant: true }) as Npc;
  dealDamage(w.world.host, p, n, 1, false);
  for (let t = 0; t < 12000; t += 50) {
    w.step(50);
    if (t % 500 === 0) {
      const [e, nn] = siteCoords(a, ...n.pos, R);
      const A = chest(n.pos, 0.6), B = chest([p.state.x, p.state.y, p.state.z], 0.6);
      process.stderr.write([t, "mode", n.mode, "at", e.toFixed(2), nn.toFixed(2), "blocks", S.blocks(...A, ...B), "walled", JSON.stringify(n.walled), "side", n.slideSide, "seen", w.clock.t - n.lastSeenAt].join(" ") + "\n");
    }
  }
});
