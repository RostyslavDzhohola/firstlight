// Occluder fade: trees, rocks and breakable props between the camera and the player dissolve with a
// screen-door dither, so a trunk or a statue never hides the avatar or the crosshair (the camera
// doesn't stop at trunks, D-solid-1). No transparency (no sorting, no blending): fragments inside a
// soft cone from the camera to the player (plus a narrow one along the aim) and nearer than the
// player are discarded with a stable per-pixel dither threshold. The cone moves with the camera, so
// an occluder fades as it slides into it and comes back as it leaves; nothing behind or beside the
// player is touched. Shadows keep the full shape (maskShadowNode).
//
// All inputs are shared render-group uniforms written once a frame (updateOccluderFade): the fade is
// part of each material's one shader, so there is no extra variant to warm and no rebuild ever.

import * as THREE from "three/webgpu";
import { bool, cameraPosition, dot, float, interleavedGradientNoise, length, max, normalize, positionWorld, renderGroup, screenCoordinate, smoothstep, uniform } from "three/tsl";

/** The chest point the cone aims at: this far above the feet (m). */
export const FADE_CHEST = 1.0;
/** Half-size of the cleared area round the chest at the player's distance (m): head to feet. */
export const FADE_RADIUS = 1.05;
/** Half-size of the cleared area along the aim (the crosshair) at the player's distance (m). */
export const FADE_AIM_RADIUS = 0.45;
/** Fragments within this depth of the player's (m) stay solid: a trunk beside you isn't in the way. */
export const FADE_DEPTH_MARGIN = 0.3;
/** Fraction of the cone (from its centre) that is fully cleared; the rest is a soft dither ramp. */
export const FADE_CORE = 0.6;

export const occluderUniforms = {
  /** World position of the player's chest. */
  target: uniform(new THREE.Vector3()).setGroup(renderGroup),
  /** Unit camera forward (the aim). */
  aim: uniform(new THREE.Vector3(0, 0, -1)).setGroup(renderGroup),
  /** Camera → chest distance (m). */
  depth: uniform(5).setGroup(renderGroup),
  /** cos of the player cone's outer and inner half-angles. */
  cosOuter: uniform(0.98).setGroup(renderGroup),
  cosInner: uniform(0.99).setGroup(renderGroup),
  /** Same for the aim cone. */
  cosAimOuter: uniform(0.995).setGroup(renderGroup),
  cosAimInner: uniform(0.998).setGroup(renderGroup),
  /** 0 = off (photo mode, bench, ?nofade), 1 = on. */
  strength: uniform(0).setGroup(renderGroup),
};

export interface FadeParams {
  depth: number;
  cosOuter: number;
  cosInner: number;
  cosAimOuter: number;
  cosAimInner: number;
}

/** Cone thresholds for a camera at `depth` metres from the chest (pure; tested). */
export function fadeParams(depth: number, out: FadeParams = { depth: 0, cosOuter: 0, cosInner: 0, cosAimOuter: 0, cosAimInner: 0 }): FadeParams {
  const d = Math.max(0.5, depth);
  const a = Math.atan(FADE_RADIUS / d);
  const aa = Math.atan(FADE_AIM_RADIUS / d);
  out.depth = depth;
  out.cosOuter = Math.cos(a);
  out.cosInner = Math.cos(a * FADE_CORE);
  out.cosAimOuter = Math.cos(aa);
  out.cosAimInner = Math.cos(aa * FADE_CORE);
  return out;
}

let maskNode: THREE.Node | null = null;
/** Keep (true) or dissolve (false) this fragment. One node shared by every material that fades. */
export function occluderKeep(): THREE.Node {
  if (maskNode) return maskNode;
  const u = occluderUniforms;
  const v = positionWorld.sub(cameraPosition);
  const dist = length(v);
  const dir = v.div(max(dist, 0.0001));
  const toTarget = normalize(u.target.sub(cameraPosition));
  const inPlayer = smoothstep(u.cosOuter, u.cosInner, dot(dir, toTarget));
  const inAim = smoothstep(u.cosAimOuter, u.cosAimInner, dot(dir, u.aim));
  // Only what is nearer than the player (with a margin) is in the way.
  const front = smoothstep(float(FADE_DEPTH_MARGIN), float(FADE_DEPTH_MARGIN + 0.5), u.depth.sub(dot(v, toTarget)));
  const fade = max(inPlayer, inAim).mul(front).mul(u.strength);
  // Stable screen-door threshold (no time term: a still view doesn't shimmer).
  const noise = interleavedGradientNoise(screenCoordinate.xy);
  maskNode = noise.greaterThanEqual(fade) as unknown as THREE.Node;
  return maskNode;
}

const ALWAYS = bool(true) as unknown as THREE.Node;

/**
 * Make `m` fade when it stands between the camera and the player. Shadows keep the material's own
 * mask (or none): the shadow pass would otherwise take `maskNode` and punch the cone into shadows.
 */
export function applyOccluderFade<M extends THREE.NodeMaterial>(m: M): M {
  const own = m.maskNode;
  const shadow = m.maskShadowNode ?? own ?? ALWAYS;
  m.maskNode = own ? ((own as unknown as { and(b: THREE.Node): THREE.Node }).and(occluderKeep()) as THREE.Node) : occluderKeep();
  m.maskShadowNode = shadow;
  return m;
}

const _t = new THREE.Vector3();
const _aim = new THREE.Vector3();
const _p = fadeParams(5);

/**
 * Per frame, after the camera is placed: the cone from `camera` to the player's chest (`feet` + up ×
 * FADE_CHEST). `active` false (photo mode, the bench, a dead or absent player) switches it off.
 */
export function updateOccluderFade(camera: THREE.Camera, feet: THREE.Vector3 | null, active: boolean) {
  const u = occluderUniforms;
  if (!active || !feet) {
    u.strength.value = 0;
    return;
  }
  _t.copy(feet).normalize().multiplyScalar(FADE_CHEST).add(feet);
  u.target.value.copy(_t);
  const depth = _t.distanceTo(camera.position);
  fadeParams(depth, _p);
  u.depth.value = _p.depth;
  u.cosOuter.value = _p.cosOuter;
  u.cosInner.value = _p.cosInner;
  u.cosAimOuter.value = _p.cosAimOuter;
  u.cosAimInner.value = _p.cosAimInner;
  camera.getWorldDirection(_aim);
  u.aim.value.copy(_aim);
  u.strength.value = 1;
}
