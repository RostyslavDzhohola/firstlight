// Quest NPCs stand where their world objects are (round 2 review): the shop keepers at their spots
// (content/shops.ts) and the guides beside each pad, facing the plaza or the pad, after update().
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as THREE from "three/webgpu";
import { BODY_IDS, createTerrain } from "@firstlight/shared";
import { placeDir } from "@firstlight/shared/content/places";
import { SHOP_SPOT_BY_ID } from "@firstlight/shared/content/shops";
import { stubCanvasDocument } from "../render/disposeWatch.testutil.ts";

// config.ts reads the URL at import time; ?nochars keeps AvatarView on capsules (no asset fetches).
vi.stubGlobal("location", { search: "?nochars", hostname: "localhost" });

let restore: () => void;
beforeAll(() => {
  restore = stubCanvasDocument(); // nameplates draw on canvases
});
afterAll(() => restore());

describe("QuestWorld NPCs", () => {
  for (const body of BODY_IDS) {
    it(`stands every keeper and guide on ${body} at its spot, facing in`, async () => {
      const { QuestWorld } = await import("./QuestWorld.ts");
      const world = new QuestWorld(new THREE.Scene(), body, createTerrain(body));
      world.update(0.016, { activeMissions: new Set(), cosmeticsExtras: true });
      const npcs = world.props.filter((p) => p.npc);
      expect(npcs.map((p) => p.def.look).sort(), body).toEqual(body === "portus" ? ["keeper"] : ["guide", "keeper"]);
      for (const p of npcs) {
        const at = p.npc!.root.getWorldPosition(new THREE.Vector3());
        expect(at.distanceTo(p.pos), `${p.def.id} avatar`).toBeLessThan(0.5);
        if (p.def.look === "keeper") {
          const s = SHOP_SPOT_BY_ID.get(p.def.id)!;
          expect(at.distanceTo(new THREE.Vector3(...s.pos)), `${p.def.id} at its shop spot`).toBeLessThan(0.5);
        }
        // Facing: along the ground, toward the plaza centre (Portus) or the place's anchor (a pad).
        const up = p.pos.clone().normalize();
        expect(Math.abs(p.facing!.dot(up)), p.def.id).toBeLessThan(1e-6);
        const anchor = body === "portus" ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(...placeDir(p.def.place));
        const toAnchor = anchor.multiplyScalar(p.pos.length()).sub(p.pos);
        expect(p.facing!.dot(toAnchor.normalize()), `${p.def.id} faces in`).toBeGreaterThan(0.99);
      }
      world.dispose();
    });
  }
});
