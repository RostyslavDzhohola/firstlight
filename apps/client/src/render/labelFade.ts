// World labels fade out near the camera (#22, D-view-5): the keepers' and guides' name sprites
// ("Portus Exchange · E to trade") are 4.2 m wide billboards, so a camera brushing past one filled
// the screen with it. Their opacity follows the label's depth in front of the camera (view space, the
// depth that sets its size on screen, so a label off to one side counts the same as one ahead):
// gone within LABEL_FADE_NEAR, whole beyond LABEL_FADE_FAR. It is part of the label's own shader
// (positionView of the sprite's centre), so it holds for whatever camera draws the frame.

import * as THREE from "three/webgpu";
import { clamp, float, materialOpacity, modelViewMatrix, positionView, smoothstep, vec4 } from "three/tsl";

/** Depth (m) in front of the camera at and within which a label is fully transparent. */
export const LABEL_FADE_NEAR = 1.5;
/** Depth (m) from which a label is fully visible. */
export const LABEL_FADE_FAR = 2.5;

/**
 * The size clamp (D-polish-4, play-test: a keeper's name covered her own "E Talk" prompt): a label is
 * its world size from LABEL_FULL_DEPTH m out; nearer, it shrinks with the depth, so on screen it stays
 * the size it has at LABEL_FULL_DEPTH (about 60 px of 720 for a two-line label), down to LABEL_MIN_SCALE.
 */
export const LABEL_FULL_DEPTH = 11;
export const LABEL_MIN_SCALE = 0.14;

/** A label's size factor at `depth` m in front of the camera (the shader's formula). */
export function labelScale(depth: number): number {
  return Math.min(1, Math.max(LABEL_MIN_SCALE, depth / LABEL_FULL_DEPTH));
}

/** A label's opacity factor at `depth` m in front of the camera (the shader's formula). */
export function labelFade(depth: number): number {
  const t = Math.min(1, Math.max(0, (depth - LABEL_FADE_NEAR) / (LABEL_FADE_FAR - LABEL_FADE_NEAR)));
  return t * t * (3 - 2 * t);
}

const _v = new THREE.Vector3();
/** The opacity factor `label` (a sprite) is drawn with from `camera` (world matrices up to date). */
export function labelFadeFor(camera: THREE.Camera, label: THREE.Object3D): number {
  label.getWorldPosition(_v).applyMatrix4(camera.matrixWorldInverse);
  return labelFade(-_v.z);
}

let node: THREE.Node | null = null;
let scaleNode: THREE.Node | null = null;
const faded = new WeakSet<THREE.Material>();

/** Give a label's material the near-camera fade (one node shared by every label). */
export function applyLabelFade<M extends THREE.SpriteNodeMaterial>(m: M): M {
  node ??= materialOpacity.mul(smoothstep(float(LABEL_FADE_NEAR), float(LABEL_FADE_FAR), positionView.z.negate())) as unknown as THREE.Node;
  m.opacityNode = node;
  // The sprite's own centre in view space (what three's sprite vertex stage scales round).
  scaleNode ??= clamp(modelViewMatrix.mul(vec4(0, 0, 0, 1)).z.negate().div(LABEL_FULL_DEPTH), LABEL_MIN_SCALE, 1.0) as unknown as THREE.Node;
  m.scaleNode = scaleNode;
  faded.add(m);
  return m;
}

/** Does `m` carry the near-camera fade? */
export function hasLabelFade(m: THREE.Material): boolean {
  return faded.has(m);
}
