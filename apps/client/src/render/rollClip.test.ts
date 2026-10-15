// The dodge's roll clip (owner report: "it takes a second before it rolls"). The controller rolls on
// the frame C is read; the clip must show it at once: lean into the dive from its first frame, and
// tumble back up by the end of the 0.3 s roll.

import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as THREE from "three/webgpu";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";

vi.stubGlobal("location", { search: "?nochars", hostname: "localhost" });

const dir = fileURLToPath(new URL("../../public/assets-dev/", import.meta.url));

interface Pose {
  /** Pelvis tilt from the idle stance (degrees). */
  tilt: number;
  /** Head height above the feet (m, unscaled rig). */
  head: number;
}

/** The roll clip as the game cuts it (from `from`, 30 fps), sampled at clip times `ts`. */
async function rollPoses(from: number, ts: number[]): Promise<Pose[]> {
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  const b = readFileSync(dir + "characters/starters_anims.glb");
  const gltf = await loader.parseAsync(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength), "");
  const mixer = new THREE.AnimationMixer(gltf.scene);
  const pelvis = gltf.scene.getObjectByName("pelvis")!;
  let head: THREE.Object3D = pelvis;
  gltf.scene.traverse((o) => {
    if (/^head$/i.test(o.name)) head = o;
  });
  const q = new THREE.Quaternion();
  const pose = (clip: THREE.AnimationClip, t: number) => {
    mixer.stopAllAction();
    mixer.clipAction(clip).reset().play();
    mixer.setTime(t);
    gltf.scene.updateMatrixWorld(true);
    return { up: new THREE.Vector3(0, 1, 0).applyQuaternion(pelvis.getWorldQuaternion(q)), head: head.getWorldPosition(new THREE.Vector3()).y };
  };
  const stand = pose(gltf.animations.find((a) => a.name === "idle")!, 0).up;
  const roll = THREE.AnimationUtils.subclip(gltf.animations.find((a) => a.name === "roll")!, "roll_fast", from, 36, 30);
  return ts.map((t) => {
    const p = pose(roll, t);
    return { tilt: (Math.acos(Math.max(-1, Math.min(1, p.up.dot(stand)))) * 180) / Math.PI, head: p.head };
  });
}

describe("the dodge's roll clip", () => {
  it("dives from its first frame (no standing up first) and is back up as the roll ends", async () => {
    const { ROLL_FROM_FRAME, ROLL_SPEED } = await import("./avatars/assets.ts");
    const { MOVE } = await import("../game/PlayerController.ts");
    const frame = ROLL_SPEED / 60; // clip seconds per 60 Hz frame
    const early = [0, 1, 2, 3, 4, 5, 6].map((n) => n * frame);
    const poses = await rollPoses(ROLL_FROM_FRAME, [...early, MOVE.dodgeTime * ROLL_SPEED]);
    const end = poses.pop()!;
    expect(poses[0]!.tilt).toBeGreaterThan(45); // leaning into the dive at once
    for (let i = 1; i < poses.length; i++) expect(poses[i]!.head).toBeLessThanOrEqual(poses[i - 1]!.head + 0.02);
    expect(poses[2]!.head).toBeLessThan(poses[0]!.head - 0.05); // going down within two frames
    expect(end.tilt).toBeLessThan(35); // upright again as the roll's speed ends
    // The clip's own start (frame 2) rises out of a crouch first: that read as a late roll.
    const old = await rollPoses(2, early);
    expect(Math.max(...old.map((p) => p.head)) - old[0]!.head).toBeGreaterThan(0.1);
  });
});
