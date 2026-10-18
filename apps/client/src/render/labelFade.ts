// World labels fade out near the camera (#22, D-view-5): the keepers' and guides' name sprites
// ("Portus Exchange · E to trade") are 4.2 m wide billboards, so a camera brushing past one filled
// the screen with it. Their opacity follows the label's depth in front of the camera (view space, the
// depth that sets its size on screen, so a label off to one side counts the same as one ahead):
// gone within LABEL_FADE_NEAR, whole beyond LABEL_FADE_FAR. It is part of the label's own shader
// (positionView of the sprite's centre), so it holds for whatever camera draws the frame.

import * as THREE from "three/webgpu";
import { float, materialOpacity, positionView, smoothstep } from "three/tsl";

/** Depth (m) in front of the camera at and within which a label is fully transparent. */
export const LABEL_FADE_NEAR = 1.5;
/** Depth (m) from which a label is fully visible. */
export const LABEL_FADE_FAR = 2.5;

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
const faded = new WeakSet<THREE.Material>();

/** Give a label's material the near-camera fade (one node shared by every label). */
export function applyLabelFade<M extends THREE.SpriteNodeMaterial>(m: M): M {
  node ??= materialOpacity.mul(smoothstep(float(LABEL_FADE_NEAR), float(LABEL_FADE_FAR), positionView.z.negate())) as unknown as THREE.Node;
  m.opacityNode = node;
  faded.add(m);
  return m;
}

/** Does `m` carry the near-camera fade? */
export function hasLabelFade(m: THREE.Material): boolean {
  return faded.has(m);
}
