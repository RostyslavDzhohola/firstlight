// Quest NPCs stand where their world objects are (round 2 review): the shop keepers at their spots
// (content/shops.ts) and the guides beside each pad, facing the plaza or the pad, after update().
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as THREE from "three/webgpu";
import { BODIES, BODY_IDS, createTerrain, padDirs } from "@firstlight/shared";
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
        // Facing: along the ground, toward the plaza centre (Portus: the town's pole) or pad 0 (every
        // planet keeper and guide works the main pad). The anchor comes from the pads, not from the
        // place the implementation reads, so the check is independent of it.
        const up = p.pos.clone().normalize();
        const anchor = body === "portus" ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(...padDirs(BODIES[body])[0]!);
        const want = anchor.multiplyScalar(p.pos.length()).sub(p.pos);
        want.addScaledVector(up, -want.dot(up)).normalize();
        expect(p.facing, `${p.def.id} has a facing`).toBeDefined();
        expect(Math.abs(p.facing!.dot(up)), `${p.def.id} faces along the ground`).toBeLessThan(1e-6);
        expect(p.facing!.dot(want), `${p.def.id} faces its anchor`).toBeGreaterThan(0.99);
        // What's drawn faces the same way: the avatar's forward (+Z after AvatarView.set) and the prop's (stall, counter).
        const drawn = new THREE.Vector3(0, 0, 1).applyQuaternion(p.npc!.root.getWorldQuaternion(new THREE.Quaternion()));
        expect(drawn.dot(want), `${p.def.id} avatar faces its anchor`).toBeGreaterThan(0.99);
        const stall = new THREE.Vector3(0, 0, 1).applyQuaternion(p.root.getWorldQuaternion(new THREE.Quaternion()));
        expect(stall.dot(want), `${p.def.id} prop faces its anchor`).toBeGreaterThan(0.99);
      }
      world.dispose();
    });
  }
});
