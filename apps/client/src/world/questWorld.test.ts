// Quest NPCs stand where their world objects are (round 2 review): the shop keepers at their spots
// (content/shops.ts) and the guides beside each pad, facing the plaza or the pad, after update().
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as THREE from "three/webgpu";
import { BODIES, BODY_IDS, createTerrain, padDirs } from "@firstlight/shared";
import { SHOP_SPOT_BY_ID } from "@firstlight/shared/content/shops";
import { stubCanvasDocument } from "../render/disposeWatch.testutil.ts";
import { hasLabelFade, labelFadeFor } from "../render/labelFade.ts";
import { occluderFadeOf } from "../render/occluderFade.ts";

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

describe("QuestWorld near the camera (#22)", () => {
  /** A camera `back` m from `p` along -dir and a chest `ahead` m along +dir: `p` sits between them. */
  function between(p: THREE.Vector3, dir: THREE.Vector3, back = 2, ahead = 3) {
    const cam = p.clone().addScaledVector(dir, -back);
    const chest = p.clone().addScaledVector(dir, ahead);
    return { cam, chest, aim: chest.clone().sub(cam).normalize() };
  }

  it("Juno's stall and her figure dissolve between the camera and the player; a player's figure never does", async () => {
    const { QuestWorld } = await import("./QuestWorld.ts");
    const { AvatarView } = await import("../render/Avatars.ts");
    const scene = new THREE.Scene();
    const world = new QuestWorld(scene, "portus", createTerrain("portus"));
    world.update(0.016, { activeMissions: new Set(), cosmeticsExtras: true });
    scene.updateMatrixWorld(true);
    const juno = world.props.find((p) => p.def.id === "juno_vale")!;
    const up = juno.pos.clone().normalize();
    const meshes: THREE.Mesh[] = [];
    for (const name of ["stall:counter", "stall:top", "stall:awning", "stall:postL", "stall:postR", "stall:crate"]) meshes.push(juno.root.getObjectByName(name) as THREE.Mesh);
    juno.npc!.root.traverse((o) => { if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh); });
    expect(meshes.every(Boolean), "the stall's parts are named").toBe(true);
    expect(meshes.length).toBeGreaterThan(6);
    const player = new AvatarView(0, 0);
    scene.add(player.root);
    const playerMeshes: THREE.Mesh[] = [];
    player.root.traverse((o) => { if ((o as THREE.Mesh).isMesh) playerMeshes.push(o as THREE.Mesh); });
    // Looking across the stall from behind it and from above it (the camera that sat behind the
    // stall in the owner's recording), at the player on the plaza side.
    const toPlaza = juno.facing!.clone();
    for (const dir of [toPlaza, toPlaza.clone().addScaledVector(up, -0.6).normalize()]) {
      for (const m of meshes) {
        const p = new THREE.Box3().setFromObject(m).getCenter(new THREE.Vector3());
        const { cam, chest, aim } = between(p, dir);
        expect(occluderFadeOf(m, cam, aim, chest, p), `${m.name || m.parent?.name || "keeper"} between the camera and the player`).toBe(1);
      }
      const p = juno.pos.clone().addScaledVector(up, 1.2);
      const { cam, chest, aim } = between(p, dir);
      for (const m of playerMeshes) expect(occluderFadeOf(m, cam, aim, chest, p), "a player's figure stays solid").toBe(0);
    }
    player.dispose();
    world.dispose();
  });

  for (const body of BODY_IDS) {
    it(`every label on ${body} fades out near the camera; the keeper and guide dissolve as occluders`, async () => {
      const { QuestWorld } = await import("./QuestWorld.ts");
      const scene = new THREE.Scene();
      const world = new QuestWorld(scene, body, createTerrain(body));
      world.update(0.016, { activeMissions: new Set(), cosmeticsExtras: true });
      scene.updateMatrixWorld(true);
      const labels: THREE.Sprite[] = [];
      world.group.traverse((o) => { if ((o as THREE.Sprite).isSprite) labels.push(o as THREE.Sprite); });
      expect(labels.length, "the keeper's and the guide's labels").toBe(body === "portus" ? 1 : 2);
      for (const l of labels) {
        expect(hasLabelFade(l.material), "the label's material fades").toBe(true);
        // The camera coming straight at the label, 1.4 m and then 2.6 m short of it.
        const at = l.getWorldPosition(new THREE.Vector3());
        const up = at.clone().normalize();
        const side = new THREE.Vector3(1, 0, 0).addScaledVector(up, -up.x).normalize();
        const cam = new THREE.PerspectiveCamera(75, 16 / 9, 0.3, 6000);
        for (const [d, want] of [[1.4, 0], [2.6, 1]] as const) {
          cam.position.copy(at).addScaledVector(side, -d);
          cam.up.copy(up);
          cam.lookAt(at);
          cam.updateMatrixWorld();
          expect(labelFadeFor(cam, l), `${d} m from the label`).toBe(want);
        }
      }
      for (const p of world.props.filter((x) => x.npc)) {
        const figure: THREE.Mesh[] = [];
        p.npc!.root.traverse((o) => { if ((o as THREE.Mesh).isMesh) figure.push(o as THREE.Mesh); });
        const at = p.pos.clone().addScaledVector(p.pos.clone().normalize(), 1);
        const dir = p.facing!.clone();
        for (const m of figure) expect(occluderFadeOf(m, at.clone().addScaledVector(dir, -2), dir, at.clone().addScaledVector(dir, 3), at), `${p.def.id}`).toBe(1);
      }
      // An outpost draws its own stall (D-b2-3): no second, placeholder one inside it.
      const keeper = world.props.find((x) => x.def.look === "keeper")!;
      expect(!!keeper.root.getObjectByName("stall:awning"), "QuestWorld's stall").toBe(body === "portus");
      world.dispose();
    });
  }
});
