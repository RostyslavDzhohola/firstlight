// The shipped horse GLB (tools/blender/horse) against what the client relies on: the saddle socket
// survives compression, the role mask is real (not the FBX's white layer), four clips, and every
// starter sits on it with knees round the barrel and feet on the stirrups.

import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import * as THREE from "three/webgpu";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import { HORSE } from "@firstlight/shared/content/horse";

vi.stubGlobal("location", { search: "?nochars", hostname: "localhost" });

const dir = decodeURIComponent(new URL("../../public/assets-dev/", import.meta.url).pathname);
async function glb(path: string) {
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  const b = readFileSync(dir + path);
  return loader.parseAsync(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength), "");
}

describe("horse.glb", () => {
  it("has the saddle socket, four clips and a four-role colour mask", async () => {
    const horse = await glb("animals/horse.glb");
    expect(horse.scene.getObjectByName("saddle")).toBeTruthy();
    expect(horse.animations.map((a) => a.name).sort()).toEqual(["idle", "jump", "run", "walk"]);
    let mesh: THREE.SkinnedMesh | null = null;
    horse.scene.traverse((o) => { if ((o as THREE.SkinnedMesh).isSkinnedMesh) mesh = o as THREE.SkinnedMesh; });
    const col = (mesh as unknown as THREE.SkinnedMesh).geometry.attributes.color!;
    const roles = new Set<string>();
    for (let i = 0; i < col.count; i++) roles.add([col.getX(i), col.getY(i), col.getZ(i)].map((c) => Math.round(c)).join(""));
    expect([...roles].sort()).toEqual(["000", "001", "010", "100"]); // leather, blanket, mane, coat
  });

  it("seats every starter: pelvis on the saddle, knees out round the barrel, feet by the stirrups", async () => {
    const { makeRideClip } = await import("./avatars/ride.ts");
    const { STARTER_FILES, STARTER_SCALE } = await import("./avatars/assets.ts");
    const horse = await glb("animals/horse.glb");
    const anims = await glb("characters/starters_anims.glb");
    const idle = anims.animations.find((a) => a.name === "idle")!;
    horse.scene.updateMatrixWorld(true);
    const seat = new THREE.Vector3().setFromMatrixPosition(horse.scene.getObjectByName("saddle")!.matrixWorld);
    expect(seat.y).toBeCloseTo(HORSE.seatHeight, 1);
    for (const [i, file] of STARTER_FILES.entries()) {
      const rider = (await glb(`characters/${file}.glb`)).scene;
      const clip = makeRideClip(idle, rider);
      const s = STARTER_SCALE[i]!;
      rider.scale.setScalar(s);
      rider.position.set(seat.x, seat.y - (0.917 * s - 0.1), seat.z); // AvatarView.seatDrop() without the foot sink
      expect(Math.abs(rider.position.y - HORSE.riderLift), `${file} feet vs the server's rider lift`).toBeLessThan(0.12);
      const mixer = new THREE.AnimationMixer(rider);
      mixer.clipAction(clip).play();
      mixer.update(0);
      rider.updateMatrixWorld(true);
      const at = (n: string) => new THREE.Vector3().setFromMatrixPosition(rider.getObjectByName(n)!.matrixWorld);
      expect(at("pelvis").y - seat.y, file).toBeGreaterThan(0);
      expect(at("pelvis").y - seat.y, file).toBeLessThan(0.15);
      for (const side of ["l", "r"]) {
        expect(Math.abs(at(`calf_${side}`).x), `${file} knee`).toBeGreaterThan(0.27);
        const foot = at(`foot_${side}`);
        expect(foot.y, `${file} foot height`).toBeGreaterThan(0.9);
        expect(foot.y, `${file} foot height`).toBeLessThan(1.12);
        expect(Math.abs(foot.x), `${file} foot out`).toBeGreaterThan(0.29);
      }
    }
  });
});
