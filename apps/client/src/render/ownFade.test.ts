// The local player's own avatar dissolves when the camera comes close to it (#22, D-view-5): a wall or
// a stall behind the player pins the camera to the head, and the own clothes, hands or face filled the
// view. Fully there beyond OWN_FADE_FAR, gone within OWN_FADE_NEAR, through the occluder fade's dither,
// so nothing new compiles. Held items and worn cosmetics go with it; other players never fade.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as THREE from "three/webgpu";
import { stubCanvasDocument } from "./disposeWatch.testutil.ts";

// config.ts reads the URL at import time; ?nochars keeps AvatarView on capsules (no asset fetches).
vi.stubGlobal("location", { search: "?nochars", hostname: "localhost" });

let restore: () => void;
beforeAll(() => {
  restore = stubCanvasDocument(); // the static cloak's noise texture
});
afterAll(() => restore());

const R = 500;
const chest = new THREE.Vector3(0, R + 1.3, 0); // feet at the pole, chest 1.3 m up
/** A camera `d` m behind the chest, at chest height, looking at it. */
function camAt(d: number) {
  const cam = new THREE.PerspectiveCamera(75, 16 / 9, 0.3, 6000);
  cam.position.set(0, R + 1.3, -d);
  cam.lookAt(chest);
  cam.updateMatrixWorld();
  return cam;
}

describe("own-avatar near-camera fade (#22)", () => {
  it("is 0 beyond ~1.2 m from the chest and head, 1 within ~0.5 m, rising steadily between", async () => {
    const { OWN_FADE_FAR, OWN_FADE_NEAR, ownFade } = await import("./occluderFade.ts");
    expect(OWN_FADE_FAR).toBeCloseTo(1.2, 6);
    expect(OWN_FADE_NEAR).toBeCloseTo(0.5, 6);
    for (const d of [1.2, 1.5, 3, 4.6, 20]) expect(ownFade(d), `${d} m`).toBe(0);
    for (const d of [0, 0.2, 0.5]) expect(ownFade(d), `${d} m`).toBe(1);
    let last = 1;
    for (let i = 1; i < 14; i++) {
      const f = ownFade(0.5 + i * 0.05);
      expect(f).toBeLessThan(last);
      last = f;
    }
  });

  it("dissolves the own avatar, its held item and its cosmetics with the camera close; never another player", async () => {
    const { AvatarView } = await import("./Avatars.ts");
    const { weaponModel } = await import("./avatars/weapons.ts");
    const { buildCosmetic } = await import("./Cosmetics.ts");
    const { occluderFadeOf, updateOccluderFade } = await import("./occluderFade.ts");
    const scene = new THREE.Scene();
    const own = new AvatarView(0, 0);
    own.root.userData.ownAvatar = true; // Game marks the local player's
    const other = new AvatarView(1, 1);
    for (const a of [own, other]) {
      a.set(0, R, 0, 0, 0, 1, 0, 0);
      a.root.add(weaponModel("carbine", 0)!, buildCosmetic("woolly_beanie", [])!);
      scene.add(a.root);
    }
    scene.updateMatrixWorld(true);
    const meshes = (a: { root: THREE.Object3D }) => {
      const out: THREE.Mesh[] = [];
      a.root.traverse((o) => { if ((o as THREE.Mesh).isMesh) out.push(o as THREE.Mesh); });
      return out;
    };
    expect(meshes(own).length).toBeGreaterThan(3); // capsule, visor, carbine, beanie
    for (const [d, want] of [[0.3, 1], [4.6, 0]] as const) {
      const cam = camAt(d);
      updateOccluderFade(cam, chest, true);
      const aim = chest.clone().sub(cam.position).normalize();
      // A point well off the camera-chest cone: only the near fade can clear it.
      const p = chest.clone().add(new THREE.Vector3(0.6, 0.4, 0));
      for (const m of meshes(own)) expect(occluderFadeOf(m, cam.position, aim, chest, p), `own ${m.parent?.name || m.name || "mesh"} at ${d} m`).toBe(want);
      for (const m of meshes(other)) expect(occluderFadeOf(m, cam.position, aim, chest, p), `another player at ${d} m`).toBe(0);
    }
    // The shader's input follows the camera: dissolved close, whole far; photo mode and the bench
    // switch the fade off (strength 0, as before), so a photo camera up close still shows the avatar.
    const { occluderUniforms } = await import("./occluderFade.ts");
    updateOccluderFade(camAt(0.3), chest, true);
    expect(occluderUniforms.own.value).toBe(1);
    updateOccluderFade(camAt(4.6), chest, true);
    expect(occluderUniforms.own.value).toBe(0);
    updateOccluderFade(camAt(0.3), chest, false);
    expect(occluderUniforms.strength.value).toBe(0);
    expect(occluderUniforms.own.value).toBe(0);
    own.dispose();
    other.dispose();
  });
});
