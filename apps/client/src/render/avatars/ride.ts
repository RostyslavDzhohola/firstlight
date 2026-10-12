// The "ride" pose (horses, SPEC §6.14 #2). The CC0 animation library has no riding clip, so this
// one is made at load time from `idle`: the legs are aimed into a straddle round the saddle and the
// arms forward onto the reins, then baked as constant tracks over idle's breathing torso and head.
// Aiming works in model space (+Y up, +Z forward), so it holds for every starter: they share one
// skeleton and differ only in scale.

import * as THREE from "three/webgpu";
import { clone as cloneSkinned } from "three/addons/utils/SkeletonUtils.js";

type Dir = (side: number) => [number, number, number];

/** Bone → the child it points at → where it should point (`side` = +1 for limbs on the +X side). */
export const RIDE_AIMS: readonly { bone: string; child: string; dir: Dir }[] = [
  // Measured against horse.glb: knees clear the blanket (±0.33 m), feet reach the stirrups (±0.36 m, 0.9 m up).
  { bone: "thigh_l", child: "calf_l", dir: (s) => [0.6 * s, -0.6, 0.53] }, // knees forward and out round the barrel
  { bone: "calf_l", child: "foot_l", dir: (s) => [0.06 * s, -0.95, -0.3] }, // shins down into the stirrups
  { bone: "thigh_r", child: "calf_r", dir: (s) => [0.6 * s, -0.6, 0.53] },
  { bone: "calf_r", child: "foot_r", dir: (s) => [0.06 * s, -0.95, -0.3] },
  { bone: "upperarm_l", child: "lowerarm_l", dir: (s) => [0.12 * s, -0.85, 0.45] }, // elbows by the hips
  { bone: "lowerarm_l", child: "hand_l", dir: (s) => [-0.25 * s, -0.2, 0.95] }, // hands together over the withers
  { bone: "upperarm_r", child: "lowerarm_r", dir: (s) => [0.12 * s, -0.85, 0.45] },
  { bone: "lowerarm_r", child: "hand_r", dir: (s) => [-0.25 * s, -0.2, 0.95] },
];

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _want = new THREE.Vector3();
const _delta = new THREE.Quaternion();
const _world = new THREE.Quaternion();
const _parent = new THREE.Quaternion();

/** Build the looping "ride" clip from `idle` on a (never rendered) clone of a starter template. */
export function makeRideClip(idle: THREE.AnimationClip, template: THREE.Object3D): THREE.AnimationClip {
  const model = cloneSkinned(template);
  model.position.set(0, 0, 0);
  model.quaternion.identity();
  model.scale.setScalar(1);
  const mixer = new THREE.AnimationMixer(model);
  mixer.clipAction(idle).play();
  mixer.update(0);
  model.updateMatrixWorld(true);
  const bones = new Map<string, THREE.Object3D>();
  model.traverse((o) => {
    if ((o as THREE.Bone).isBone) bones.set(o.name, o);
  });
  const baked = new Map<string, THREE.Quaternion>();
  for (const aim of RIDE_AIMS) {
    const bone = bones.get(aim.bone);
    const child = bones.get(aim.child);
    if (!bone || !child || !bone.parent) continue;
    _a.setFromMatrixPosition(bone.matrixWorld);
    _b.setFromMatrixPosition(child.matrixWorld).sub(_a).normalize();
    const side = Math.sign(_a.x) || 1;
    _want.set(...aim.dir(side)).normalize();
    _delta.setFromUnitVectors(_b, _want);
    bone.getWorldQuaternion(_world).premultiply(_delta);
    bone.parent.getWorldQuaternion(_parent);
    bone.quaternion.copy(_parent.invert().multiply(_world));
    bone.updateMatrixWorld(true);
    baked.set(aim.bone, bone.quaternion.clone());
  }
  mixer.stopAllAction();
  mixer.uncacheRoot(model);
  const tracks = idle.tracks.filter((t) => !baked.has(t.name.split(".")[0]!)).map((t) => t.clone());
  for (const [name, q] of baked) {
    const v = q.toArray();
    tracks.push(new THREE.QuaternionKeyframeTrack(`${name}.quaternion`, [0, idle.duration], [...v, ...v]));
  }
  return new THREE.AnimationClip("ride", idle.duration, tracks);
}
