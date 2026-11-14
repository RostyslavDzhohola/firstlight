// Occluder fade: trees, rocks, breakable props, Juno's stall and the quest NPCs (keepers, guides:
// D-view-5) between the camera and the player dissolve with a screen-door dither, so a trunk or a
// statue never hides the avatar or the crosshair (the camera doesn't stop at trunks, D-solid-1). No transparency (no sorting, no blending): fragments inside a
// soft cone from the camera to the player (plus a narrow one along the aim) and nearer than the
// player are discarded with a stable per-pixel dither threshold. The cone moves with the camera, so
// an occluder fades as it slides into it and comes back as it leaves; nothing behind or beside the
// player is touched. Shadows keep the full shape (maskShadowNode).
//
// All inputs are shared render-group uniforms written once a frame (updateOccluderFade): the fade is
// part of each material's one shader, so there is no extra variant to warm and no rebuild ever. The
// avatars' shared materials take a gated copy: one per-object uniform lets only the quest NPCs fade.

import * as THREE from "three/webgpu";
import { bool, cameraPosition, clamp, dot, float, interleavedGradientNoise, length, max, min, mix, normalize, positionWorld, renderGroup, screenCoordinate, select, smoothstep, uniform } from "three/tsl";

/** Without a skeleton (the capsule stand-in): the chest is this far above the rendered feet (m). */
export const FADE_CHEST = 1.0;
/** Half-size of the cleared area round the chest at the player's distance (m): head to feet. */
export const FADE_RADIUS = 1.05;
/** Half-size of the cleared area along the aim (the crosshair) at the player's distance (m). */
export const FADE_AIM_RADIUS = 0.45;
/** Fragments within this depth of the player's (m) stay solid: a trunk beside you isn't in the way. */
export const FADE_DEPTH_MARGIN = 0.3;
/** Fraction of the cone (from its centre) that is fully cleared; the rest is a soft dither ramp. */
export const FADE_CORE = 0.6;
/**
 * The local player's own avatar (#22, D-view-5): fully there with the camera beyond OWN_FADE_FAR (m)
 * of its chest and head, fully dissolved within OWN_FADE_NEAR. A wall or a stall behind the player
 * pins the camera to the head, where the own clothes, hands or face filled the view.
 */
export const OWN_FADE_NEAR = 0.5;
export const OWN_FADE_FAR = 1.2;
/** The head, for the own-avatar fade: this far above the chest along local up (m). */
export const OWN_HEAD_ABOVE_CHEST = 0.5;

/**
 * At the lens (D-polish-2, play-test: "the camera sits inside the grass", and inside Meridian's scrub):
 * a prop's fragments nearer the camera than LENS_SOLID fade out, gone within LENS_GONE (m).
 */
export const LENS_GONE = 0.45;
export const LENS_SOLID = 1.3;
/**
 * Ground cover (grass blades, meadow clumps) never fills the frame: an instance rooted within
 * COVER_NEAR m of the camera is COVER_MIN of its height and full size from COVER_FAR; one within
 * SIGHT_NEAR m of the sight line from the camera to the player's chest shrinks the same way (full
 * size from SIGHT_FAR). The line stops SIGHT_STOP of the way, so the grass at the player's feet stays.
 */
export const COVER_NEAR = 0.7;
export const COVER_FAR = 2.0;
export const COVER_MIN = 0.08;
export const SIGHT_NEAR = 0.45;
export const SIGHT_FAR = 1.25;
export const SIGHT_STOP = 0.85;

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
  /** How far the local player's own avatar is dissolved (ownFade of the camera's distance), 0 … 1. */
  own: uniform(0).setGroup(renderGroup),
  /**
   * First person (D-view-fp-1): the own avatar's fragments inside this sphere (centre xyz, radius w;
   * w 0 = off) dissolve, so the eye never sees the inside of its own head while the body, the hands and
   * the held weapon stay. Shadows keep the head (maskShadowNode).
   */
  ownCut: uniform(new THREE.Vector4(0, 0, 0, 0)).setGroup(renderGroup),
};

/** The inner share of the own-head cut sphere that is fully gone; the outer rim dithers. */
export const OWN_CUT_CORE = 0.85;

/** How far (0 … 1) the first-person head cut dissolves an own-avatar point `p` (what the shader does). */
export function ownCutFade(p: THREE.Vector3, cut: THREE.Vector4 = occluderUniforms.ownCut.value): number {
  if (!(cut.w > 0)) return 0;
  return 1 - smooth(cut.w * OWN_CUT_CORE, cut.w, Math.hypot(p.x - cut.x, p.y - cut.y, p.z - cut.z));
}

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

function smooth(e0: number, e1: number, x: number) {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/** How far the own avatar dissolves with the camera `d` m from its chest and head (0 whole … 1 gone). */
export function ownFade(d: number): number {
  return 1 - smooth(OWN_FADE_NEAR, OWN_FADE_FAR, d);
}

const _seg = new THREE.Vector3();
/** ownFade for a camera at `cam`: its distance to the segment from the chest up to the head. */
export function ownFadeFor(cam: THREE.Vector3, chest: THREE.Vector3): number {
  const up = _seg.copy(chest).normalize();
  const along = Math.min(OWN_HEAD_ABOVE_CHEST, Math.max(0, (cam.x - chest.x) * up.x + (cam.y - chest.y) * up.y + (cam.z - chest.z) * up.z));
  const d = Math.hypot(cam.x - chest.x - up.x * along, cam.y - chest.y - up.y * along, cam.z - chest.z - up.z * along);
  return ownFade(d);
}

/** Height factor (COVER_MIN … 1) of a ground-cover instance rooted at `base`; `on` = the fade is on (pure; tested). */
export function coverScale(cam: THREE.Vector3, chest: THREE.Vector3, base: THREE.Vector3, on = true): number {
  const bx = base.x - cam.x, by = base.y - cam.y, bz = base.z - cam.z;
  const sx = chest.x - cam.x, sy = chest.y - cam.y, sz = chest.z - cam.z;
  const near = smooth(COVER_NEAR, COVER_FAR, Math.hypot(bx, by, bz));
  const t = Math.min(SIGHT_STOP, Math.max(0, (bx * sx + by * sy + bz * sz) / Math.max(sx * sx + sy * sy + sz * sz, 0.0001)));
  const sight = on ? smooth(SIGHT_NEAR, SIGHT_FAR, Math.hypot(bx - sx * t, by - sy * t, bz - sz * t)) : 1;
  return COVER_MIN + (1 - COVER_MIN) * Math.min(near, sight);
}

/** coverScale in TSL, for a ground-cover material's vertex stage: shared uniforms only, no extra pass. */
export function coverScaleNode(base: any): any {
  const u = occluderUniforms;
  const toBase = base.sub(cameraPosition);
  const seg = u.target.sub(cameraPosition);
  const near = smoothstep(COVER_NEAR, COVER_FAR, length(toBase));
  const t = clamp(dot(toBase, seg).div(max(dot(seg, seg), 0.0001)), 0.0, SIGHT_STOP);
  const sight = mix(float(1), smoothstep(SIGHT_NEAR, SIGHT_FAR, length(toBase.sub(seg.mul(t)))), u.strength);
  return mix(float(COVER_MIN), float(1), min(near, sight));
}

/**
 * The fade (0 solid … 1 gone) of a fragment at `p`, for a camera at `cam` aiming along unit `aim` at
 * `chest`: the same formula occluderKeep() builds in TSL, for tests and tools. Keep the two in step.
 */
export function fadeAmount(cam: THREE.Vector3, aim: THREE.Vector3, chest: THREE.Vector3, p: THREE.Vector3): number {
  const prm = fadeParams(chest.distanceTo(cam));
  const v = p.clone().sub(cam);
  const dist = v.length();
  const dir = v.divideScalar(Math.max(dist, 0.0001));
  const toTarget = chest.clone().sub(cam).normalize();
  const inPlayer = smooth(prm.cosOuter, prm.cosInner, dir.dot(toTarget));
  const inAim = smooth(prm.cosAimOuter, prm.cosAimInner, dir.dot(aim));
  const front = smooth(FADE_DEPTH_MARGIN, FADE_DEPTH_MARGIN + 0.5, prm.depth - dist);
  return Math.max(Math.max(inPlayer, inAim) * front, 1 - smooth(LENS_GONE, LENS_SOLID, dist));
}

/**
 * How `o` fades under a gated material (applyOccluderFadeGated), from it or a parent: 2 for the local
 * player's own avatar and what it holds and wears (`userData.ownAvatar`: near the camera, ownFade),
 * 1 for the quest NPCs (`userData.occluderFade`: in the cone, like props), 0 for other players (never).
 */
export function fadeGate(o: THREE.Object3D | null): FadeGate {
  for (let p = o; p; p = p.parent) {
    if (p.userData.ownAvatar) return FADE_GATE.ownAvatar;
    if (p.userData.occluderFade) return FADE_GATE.occluder;
  }
  return FADE_GATE.never;
}

/** fadeGate's values. The shader reads them as numbers: the cone times the gate for 0 and 1, the own fade above 1.5. */
export const FADE_GATE = { never: 0, occluder: 1, ownAvatar: 2 } as const;
export type FadeGate = (typeof FADE_GATE)[keyof typeof FADE_GATE];

/** Does `o` fade like an occluder (fadeGate 1)? */
export function fadesAsOccluder(o: THREE.Object3D | null): boolean {
  return fadeGate(o) === FADE_GATE.occluder;
}

/** fadeGate of the drawn object: set per object. */
const gate = uniform(0).onObjectUpdate(({ object }) => fadeGate(object as THREE.Object3D));

let maskNode: THREE.Node | null = null;
let gatedNode: THREE.Node | null = null;
/** Keep (true) or dissolve (false) this fragment. One node shared by every material that fades. */
export function occluderKeep(): THREE.Node {
  return (maskNode ??= keepNode(false));
}

/** The same, for materials shared with objects that never fade: only objects that opt in dissolve. */
export function occluderKeepGated(): THREE.Node {
  return (gatedNode ??= keepNode(true));
}

function keepNode(gated: boolean): THREE.Node {
  const u = occluderUniforms;
  const v = positionWorld.sub(cameraPosition);
  const dist = length(v);
  const dir = v.div(max(dist, 0.0001));
  const toTarget = normalize(u.target.sub(cameraPosition));
  const inPlayer = smoothstep(u.cosOuter, u.cosInner, dot(dir, toTarget));
  const inAim = smoothstep(u.cosAimOuter, u.cosAimInner, dot(dir, u.aim));
  // Only what is nearer to the camera than the chest (with a margin) is in the way. Distance from the
  // camera, not depth along the chest direction: with the camera pulled in close by a wall the aim
  // and the chest point different ways, and depth along the chest would let the aim cone reach far
  // past the player (Codex review).
  const front = smoothstep(float(FADE_DEPTH_MARGIN), float(FADE_DEPTH_MARGIN + 0.5), u.depth.sub(dist));
  const cone = max(inPlayer, inAim).mul(front);
  // Gated: 0 never, 1 the cone (quest NPCs), 2 the own avatar's near-camera fade (all of it at once).
  // Props also clear at the lens (the camera inside a bush or a canopy); avatars have their own rule.
  const lens = float(1).sub(smoothstep(LENS_GONE, LENS_SOLID, dist));
  // The own avatar: its near-camera fade, or (first person) the head inside the cut sphere.
  const cutR = u.ownCut.w;
  // Off (radius 0, centre the planet's): every fragment is far outside it, so nothing is cut.
  const cut = float(1).sub(smoothstep(cutR.mul(OWN_CUT_CORE), max(cutR, 0.0001), length(positionWorld.sub(u.ownCut.xyz))));
  const fade = (gated ? select(gate.greaterThan(1.5), max(u.own, cut), cone.mul(gate)) : max(cone, lens)).mul(u.strength);
  // Stable screen-door threshold (no time term: a still view doesn't shimmer).
  const noise = interleavedGradientNoise(screenCoordinate.xy);
  return noise.greaterThanEqual(fade) as unknown as THREE.Node;
}

const ALWAYS = bool(true) as unknown as THREE.Node;

/** Whether `node` is the shadow mask applyOccluderFade gives a material: it keeps every fragment. */
export function keepsWholeShadow(node: unknown): boolean {
  return node === ALWAYS;
}

/**
 * Make `m` fade when it stands between the camera and the player. Shadows keep the material's own
 * mask (or none): the shadow pass would otherwise take `maskNode` and punch the cone into shadows.
 */
export function applyOccluderFade<M extends THREE.NodeMaterial>(m: M): M {
  return withMask(m, occluderKeep(), "always");
}

/**
 * Like applyOccluderFade, for a material shared between objects that fade and objects that never do
 * (the avatars: quest NPCs and players). Only objects marked for it (fadesAsOccluder) dissolve; one
 * shader either way, so nothing new to warm.
 */
export function applyOccluderFadeGated<M extends THREE.NodeMaterial>(m: M): M {
  return withMask(m, occluderKeepGated(), "gated");
}

const fading = new WeakMap<THREE.Material, "always" | "gated">();

function withMask<M extends THREE.NodeMaterial>(m: M, keep: THREE.Node, how: "always" | "gated"): M {
  if (fading.has(m)) return m;
  const own = m.maskNode;
  const shadow = m.maskShadowNode ?? own ?? ALWAYS;
  m.maskNode = own ? ((own as unknown as { and(b: THREE.Node): THREE.Node }).and(keep) as THREE.Node) : keep;
  m.maskShadowNode = shadow;
  fading.set(m, how);
  return m;
}

/**
 * How much (0 solid … 1 gone) mesh `o` dissolves at world point `p`, for a camera at `cam` aiming
 * along `aim` at `chest`: fadeAmount where its material fades (and, for a gated one, `o` opts in),
 * else 0. What the shader does, for tests and tools.
 */
export function occluderFadeOf(o: THREE.Object3D, cam: THREE.Vector3, aim: THREE.Vector3, chest: THREE.Vector3, p: THREE.Vector3): number {
  const mats = (o as THREE.Mesh).material;
  const m = Array.isArray(mats) ? mats[0] : mats;
  const how = m ? fading.get(m) : undefined;
  if (!how) return 0;
  const g = how === "gated" ? fadeGate(o) : FADE_GATE.occluder;
  if (g === FADE_GATE.ownAvatar) return Math.max(ownFadeFor(cam, chest), ownCutFade(p));
  return g === FADE_GATE.occluder ? fadeAmount(cam, aim, chest, p) : 0;
}

const _t = new THREE.Vector3();
const _aim = new THREE.Vector3();
const _c = new THREE.Vector3();
const _p = fadeParams(5);

/**
 * The rendered avatar's chest (planet space) into `out`: its chest bone when the skinned model is in,
 * else the root (the drawn feet: on a horse, the saddle drop) + FADE_CHEST along local up.
 */
export function avatarChest(root: THREE.Object3D, chestBone: THREE.Object3D | null, out: THREE.Vector3): THREE.Vector3 {
  if (chestBone) {
    chestBone.updateWorldMatrix(true, false);
    return chestBone.getWorldPosition(out);
  }
  root.updateWorldMatrix(true, false);
  root.getWorldPosition(out);
  return out.addScaledVector(_t.copy(out).normalize(), FADE_CHEST);
}

/**
 * Per frame, after the camera is placed: the cone from `camera` to the player's `chest` (avatarChest).
 * `active` false (photo mode, the bench, no player) switches it off.
 */
export function updateOccluderFade(camera: THREE.Camera, chest: THREE.Vector3 | null, active: boolean, headCut: { centre: THREE.Vector3; radius: number } | null = null) {
  const u = occluderUniforms;
  if (!active || !chest) {
    u.strength.value = 0;
    u.own.value = 0;
    u.ownCut.value.set(0, 0, 0, 0);
    return;
  }
  _t.copy(chest);
  u.target.value.copy(_t);
  const depth = _t.distanceTo(camera.getWorldPosition(_c));
  fadeParams(depth, _p);
  u.depth.value = _p.depth;
  u.cosOuter.value = _p.cosOuter;
  u.cosInner.value = _p.cosInner;
  u.cosAimOuter.value = _p.cosAimOuter;
  u.cosAimInner.value = _p.cosAimInner;
  camera.getWorldDirection(_aim);
  u.aim.value.copy(_aim);
  // First person: the body stays (no near-camera fade), only the head inside the cut sphere goes.
  if (headCut && headCut.radius > 0) {
    u.own.value = 0;
    u.ownCut.value.set(headCut.centre.x, headCut.centre.y, headCut.centre.z, headCut.radius);
  } else {
    u.own.value = ownFadeFor(_c, _t);
    u.ownCut.value.set(0, 0, 0, 0);
  }
  u.strength.value = 1;
}
