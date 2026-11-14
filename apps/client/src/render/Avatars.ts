// Player avatars: the five starters (Hexwick, Brother Ash, Kappa, Unit 7, Hinoko), each in one of its
// looks (STARTER_LOOKS: Kappa and Unit 7 have two), as skinned GLBs on one shared skeleton, animated by an AnimationMixer with crossfades driven by the ANIM state, tinted by
// palette, with sockets for weapons (right hand) and cosmetics (head, face, back, belt).
// Until the GLBs are loaded (or if they fail) the old capsule stands in, so the public API
// (constructor(palette, starter, look), root, set(...), dispose()) never changes behaviour for callers.
//
// Cost control: geometry, materials and clips are shared; AvatarView.updateLod() ranks avatars by
// distance each frame: the nearest N (tier setting 8/16/24/40) animate every frame and cast shadows,
// the next N animate at ~12 Hz without shadows, the rest become a static capsule proxy.

import * as THREE from "three/webgpu";
import { clone as cloneSkinned } from "three/addons/utils/SkeletonUtils.js";
import { ANIM, PF } from "@firstlight/shared/net/schema";
import { STARTER_LOOKS, STARTERS, WEAPONS } from "@firstlight/shared/content/weapons";
import { flags } from "../config.ts";
import { avatarAssets, MODEL_SCALE, modelIndex, preloadAvatars, ROLL_SPEED, UAL_PELVIS, type AvatarAssets } from "./avatars/assets.ts";
import { avatarMaterial, PALETTES, proxyMaterial, setAvatarPalette } from "./avatars/material.ts";
import { applyOccluderFadeGated } from "./occluderFade.ts";
import { hideBareBones } from "./bareBones.ts";
import { weaponModel } from "./avatars/weapons.ts";
import { SCULPTED_WEAPONS } from "./avatars/sculptedIds.ts";
import { keptSamples } from "./warmup.ts";
import { CUT_GONE, CUT_IDLE, rezActive, rezAdmits, rezBody, rezFxMesh, rezMode, rezPose, rezSwitch, returnRezLight, takeRezLight, type RezBody, type RezFx, type RezKind, type RezPose } from "./rez.ts";

export { preloadAvatars } from "./avatars/assets.ts";

const TRIM_COLORS = [0x36f9f6, 0xffb86b, 0xff7edb, 0x9cff6b, 0xffd166, 0xb48cff];

// ---- capsule (fallback + far LOD) ------------------------------------------------------------
const bodyGeo = new THREE.CapsuleGeometry(0.34, 0.95, 4, 10);
bodyGeo.translate(0, 0.82, 0);
const headGeo = new THREE.SphereGeometry(0.24, 12, 8);
headGeo.translate(0, 1.62, 0);
const visorGeo = new THREE.BoxGeometry(0.34, 0.09, 0.12);
visorGeo.translate(0, 1.64, 0.2);
const capMats = new Map<string, THREE.Material>();
function trimMat(hex: number): THREE.Material {
  const k = `trim:${hex}`;
  let m = capMats.get(k);
  if (!m) {
    const sm = new THREE.MeshStandardNodeMaterial({ color: hex, roughness: 0.4, metalness: 0.05 });
    sm.emissive = new THREE.Color(hex);
    sm.emissiveIntensity = 2.2;
    m = applyOccluderFadeGated(sm); // quest NPCs dissolve between the camera and the player (D-view-5)
    capMats.set(k, m);
  }
  return m;
}
function capsule(palette: number, starter: number): THREE.Group {
  const g = new THREE.Group();
  const base = proxyMaterial(palette);
  const body = new THREE.Mesh(bodyGeo, base);
  const head = new THREE.Mesh(headGeo, base);
  const visor = new THREE.Mesh(visorGeo, trimMat(TRIM_COLORS[(palette + starter) % TRIM_COLORS.length]!));
  body.castShadow = true;
  g.add(body, head, visor);
  return g;
}

// ---- animation mapping -----------------------------------------------------------------------
export type OneShot = "attack" | "heavy" | "shoot" | "cast" | "throw" | "hit" | "hit_heavy";
export const EMOTES = ["emote_wave", "emote_point", "emote_cheer", "emote_dance"] as const;
export type Emote = (typeof EMOTES)[number];

const LOOPING = new Set(["idle", "walk", "run", "sprint", "fall", "swim", "swim_idle", "block_hold", "aim", "emote_dance", "ride"]);
const FADE = 0.18;
/** Blend into the dodge-roll (s): its lean shows within two frames of the key. */
const ROLL_FADE = 0.05;
// natural ground speed of each locomotion clip (measured from the CC0 root-motion variants), m/s
const CLIP_SPEED: Record<string, number> = { walk: 0.97, run: 5.36, sprint: 8.25, swim: 2.18 };

type WeaponKind = "fists" | "melee" | "ranged" | "magic" | "thrown" | "support";
function weaponKind(index: number): WeaponKind {
  const w = WEAPONS[index];
  if (!w || w.id === "fists") return "fists";
  if (w.delivery === "thrown" || w.id === "kunai") return "thrown"; // kunai are thrown overhand
  if (w.cls === "melee") return "melee";
  if (w.cls === "magic") return "magic";
  if (w.cls === "ranged") return "ranged";
  return "support";
}

function oneShotClip(kind: OneShot, w: WeaponKind): string {
  switch (kind) {
    case "attack":
      return w === "fists" ? "punch" : w === "melee" ? "melee_light" : w === "magic" || w === "support" ? "cast" : w === "thrown" ? "throw" : "shoot";
    case "heavy":
      return w === "fists" ? "punch_heavy" : w === "melee" ? "melee_heavy" : w === "magic" ? "cast" : "shoot";
    case "shoot":
      return w === "magic" ? "cast" : "shoot";
    case "cast":
      return "cast";
    case "throw":
      return "throw";
    case "hit":
      return "hit";
    case "hit_heavy":
      return "hit_heavy";
  }
}

// ---- sockets ---------------------------------------------------------------------------------
export type SocketName = "hand_r" | "hand_l" | "head" | "face" | "back" | "belt";
/** Socket points; `m` is the model (MODEL_FILES index). */
const SOCKETS: Record<SocketName, { bone: string; at: (b: (n: string) => THREE.Vector3, m: number) => THREE.Vector3 }> = {
  // grip centre: in the palm, between the wrist and the middle knuckle, a little below
  hand_r: { bone: "hand_r", at: (b) => b("hand_r").lerp(b("middle_01_r"), 0.75).add(new THREE.Vector3(0, -0.025, 0)) },
  hand_l: { bone: "hand_l", at: (b) => b("hand_l").lerp(b("middle_01_l"), 0.75).add(new THREE.Vector3(0, -0.025, 0)) },
  head: { bone: "Head", at: (_b, s) => new THREE.Vector3(0, HEAD_SOCKET[s]![0], 0) },
  face: { bone: "Head", at: (_b, s) => new THREE.Vector3(0, FACE_SOCKET[s]![0], FACE_SOCKET[s]![1]) },
  back: { bone: "spine_03", at: (_b, m) => new THREE.Vector3(0, BODY_SOCKET[m]![0], BODY_SOCKET[m]![1]) },
  belt: { bone: "pelvis", at: (_b, m) => new THREE.Vector3(0, BODY_SOCKET[m]![2], BODY_SOCKET[m]![3]) },
};
/** Per model (MODEL_FILES order). The sculpted heads are ~1.1-1.15x life size (tools/blender/chars3d
 *  recipes), the second looks' heads 2-3x: where hats sit (crown height, model space) and how much
 *  bigger hats and masks are drawn. */
const HEAD_SOCKET: readonly (readonly [number, number])[] = [[1.915, 1.15], [1.93, 1.2], [1.9, 1.22], [1.905, 1.2], [1.93, 1.18], [1.56, 2.4], [1.645, 2.2]];
/** Face socket per model: eye-line height and how far forward the face (mask, visor, beak) reaches. */
const FACE_SOCKET: readonly (readonly [number, number])[] = [[1.742, 0.138], [1.74, 0.136], [1.735, 0.15], [1.745, 0.17], [1.742, 0.146], [1.375, 0.37], [1.41, 0.29]];
/** Back socket (height, depth) and belt socket (height, depth) per model: the second looks are built
 *  low and round (Kappa B's back is its shell, Unit 7 B's its radio pack). */
const BODY_SOCKET: readonly (readonly [number, number, number, number])[] = [
  [1.3, -0.2, 1.0, 0.16], [1.3, -0.2, 1.0, 0.16], [1.3, -0.2, 1.0, 0.16], [1.3, -0.2, 1.0, 0.16], [1.3, -0.2, 1.0, 0.16],
  [0.9, -0.55, 0.62, 0.27], [1.0, -0.36, 0.7, 0.24],
];

// weapon +Z (muzzle) → model -X (right hand's knuckles at rest), weapon +Y (top) → model +Z (thumb)
export const GUN_GRIP = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(
  new THREE.Vector3(0, -1, 0), new THREE.Vector3(0, 0, 1), new THREE.Vector3(-1, 0, 0)));

/**
 * Block grips (#76, D-fix-view-3): while the guard is held (`block_hold`) these held items turn in the
 * hand, a rotation in the hand socket's axes after the mount (degrees, Blender's Euler XYZ: X first,
 * then Y, then Z about the fixed axes, as prop_check.py --rot reads it; three's order "ZYX"). The shared block
 * clip holds a sword's guard; a staff held its way ran through the Kappa's hat brim and down into the
 * shell. Turned, it lies across the guard. Checked on both Kappa looks with the held-prop clip check
 * (tools/blender/props3d/prop_check.py --rot) and renders from three sides.
 */
const BLOCK_GRIP_DEG: Readonly<Record<string, readonly [number, number, number]>> = {
  riverstaff: [-135, -5, 12],
};
const BLOCK_GRIP = new Map(
  Object.entries(BLOCK_GRIP_DEG).map(([id, [x, y, z]]) => [id, new THREE.Quaternion().setFromEuler(new THREE.Euler((x * Math.PI) / 180, (y * Math.PI) / 180, (z * Math.PI) / 180, "ZYX"))]),
);
/** Seconds the held item takes to turn into its block grip and back (about the clip's own blend in). */
export const BLOCK_GRIP_TIME = 0.15;
const _grip = new THREE.Quaternion();

/**
 * The held item's rotation in the hand socket: its mount (`rest`: GUN_GRIP or none) turned by the
 * weapon's block grip, `t` of the way (0 … 1, smoothstepped). Weapons without a block grip stay at rest.
 */
export function heldWeaponQuat(id: string, t: number, rest: THREE.Quaternion, out: THREE.Quaternion): THREE.Quaternion {
  const grip = BLOCK_GRIP.get(id);
  out.copy(rest);
  if (!grip || t <= 0) return out;
  const x = Math.min(1, t);
  return out.premultiply(_grip.identity().slerp(grip, x * x * (3 - 2 * x)));
}

/** Free what one avatar owns: each unique cloned skeleton (bone texture) and every mesh object's
 *  per-object render state (Object3D.dispose() fires the event the renderer listens for). Shared
 *  template geometry, materials and the atlas are never disposed here. */
export function releaseAvatarObjects(root: THREE.Object3D | null) {
  if (!root) return;
  const skeletons = new Set<THREE.Skeleton>();
  root.traverse((o) => {
    const sm = o as THREE.SkinnedMesh;
    if (sm.isSkinnedMesh && sm.skeleton) skeletons.add(sm.skeleton);
    if ((o as THREE.Mesh).isMesh) o.dispose();
  });
  for (const sk of skeletons) sk.dispose();
}

const _up = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _d = new THREE.Vector3();
/** The rez light leans from the palette's accent towards this. */
const _rezTint = new THREE.Color(0xbfefff);
/** The first-person head cut reaches this far (m) past the head's own vertices (and the crown and face sockets). */
const HEAD_CUT_MARGIN = 0.04;
/**
 * Per model (MODEL_FILES index): the sphere round every vertex the head carries (hair, ears, a hat's
 * brim, a beak): its centre in the Head bone's space and its radius in model units. Measured once from
 * the rest pose (headCutOf).
 */
const HEAD_CUTS = new Map<number, { centre: THREE.Vector3; r: number } | null>();

/**
 * The sphere round the vertices skinned mostly (half or more) to `head` or the bones under it, in the
 * model at rest (unscaled, identity transform): centre in `head`'s space, radius in model units.
 */
function headCutOf(model: THREE.Object3D, head: THREE.Object3D): { centre: THREE.Vector3; r: number } | null {
  const pts: THREE.Vector3[] = [];
  const box = new THREE.Box3();
  model.traverse((o) => {
    const sm = o as THREE.SkinnedMesh;
    if (!sm.isSkinnedMesh || !sm.skeleton) return;
    const mine = new Set<number>();
    sm.skeleton.bones.forEach((b, i) => {
      for (let p: THREE.Object3D | null = b; p; p = p.parent) if (p === head) return void mine.add(i);
    });
    const pos = sm.geometry.getAttribute("position");
    const si = sm.geometry.getAttribute("skinIndex");
    const sw = sm.geometry.getAttribute("skinWeight");
    if (!pos || !si || !sw || !mine.size) return;
    for (let v = 0; v < pos.count; v++) {
      let w = 0;
      for (let k = 0; k < 4; k++) if (mine.has(si.getComponent(v, k))) w += sw.getComponent(v, k);
      if (w < 0.5) continue;
      // Skinned where the bones are now (the rest pose), then into the model's space.
      const q = sm.getVertexPosition(v, new THREE.Vector3()).applyMatrix4(sm.matrixWorld);
      pts.push(q);
      box.expandByPoint(q);
    }
  });
  if (!pts.length) return null;
  const c = box.getCenter(new THREE.Vector3());
  let r = 0;
  for (const q of pts) r = Math.max(r, q.distanceTo(c));
  return { centre: head.worldToLocal(c), r };
}
/** A move of more than this in one frame is a teleport (m): the fastest horse covers under 1 m. */
export const TELEPORT_M = 8;

/**
 * The clip for ANIM.FALL given the clip playing now: a hop's way down keeps the jump clip while it
 * still runs (it reaches its landing as a 0.73 s hop lands); the long fall's flail only once it has
 * run out, or off a ledge with no jump (#78: every hop flailed from its top).
 */
export function fallClip(current: string, running: boolean): "jump_air" | "fall" {
  return current === "jump_air" && running ? "jump_air" : "fall";
}

type Lod = "full" | "mid" | "far";
const byRezDist = (p: AvatarView, q: AvatarView) => p.rezDist - q.rezDist;

/** The avatar stands on the analytic ground height, but the rendered terrain is a triangulated mesh
 *  and feet are spread on slopes: sink the model a few cm so feet read as planted (Kappa's bare feet
 *  already sit 2 cm low). */
const FOOT_SINK = [0.035, 0.035, 0.015, 0.035, 0.03, 0.02, 0.03] as const;
/** Rest pelvis joint height on the shared skeleton (m, unscaled), and how far the seat of the
 *  trousers sits below it: together they put a rider on a horse's saddle socket. */
const PELVIS_HEIGHT = 0.917;
const SEAT_CLEARANCE = 0.1;

/**
 * Where a rider's sole meets a stirrup (AvatarAssets.rideFoot: ride pose, model space) relative to the
 * saddle socket once seatDrop() has put it in the saddle, metres: x outwards, y up, z forwards.
 */
export function stirrupPoint(foot: THREE.Vector3, pelvis: number, scale: number, out = new THREE.Vector3()): THREE.Vector3 {
  return out.set(Math.abs(foot.x) * scale, foot.y * scale + SEAT_CLEARANCE - pelvis * scale, foot.z * scale);
}

function modelStirrupPoint(a: AvatarAssets, m: number, out: THREE.Vector3): THREE.Vector3 {
  const f = a.rideFoot[m];
  return f ? stirrupPoint(f, a.pelvis[m] ?? PELVIS_HEIGHT, MODEL_SCALE[m] ?? 1, out) : out.set(0, 0, 0);
}

export class AvatarView {
  /** Every live avatar (for the LOD pass). */
  static readonly all = new Set<AvatarView>();

  readonly root = new THREE.Group();
  palette: number;
  starter: number;
  /** STARTER_LOOKS index of the starter. */
  look: number;
  /** The model drawn: MODEL_FILES index for (starter, look). */
  private modelIdx: number;
  /** Leg length vs the clips' skeleton: locomotion clips cover less ground on shorter legs. */
  private stride = 1;
  /** stirrupFit() for the built model. */
  private fit: THREE.Vector3 | null = null;

  private readonly holder = new THREE.Group(); // GLB model or capsule lives here
  private model: THREE.Object3D | null = null;
  private mesh: THREE.SkinnedMesh | null = null;
  private proxy: THREE.Group;
  private mixer: THREE.AnimationMixer | null = null;
  private readonly actions = new Map<string, THREE.AnimationAction>();
  private current: THREE.AnimationAction | null = null;
  private currentName = "";
  private oneShot: { name: string; until: number } | null = null;
  private emote: Emote = "emote_wave";
  private readonly sockets = new Map<SocketName, THREE.Object3D>();
  private readonly attached = new Map<SocketName, THREE.Object3D>();
  private weaponIndex = 0;
  private weaponObj: THREE.Object3D | null = null;
  /** The held item's mount in the hand (GUN_GRIP or none) and how far it is turned into its block grip (0 … 1). */
  private readonly weaponRest = new THREE.Quaternion();
  private blockGripT = 0;
  private flagBits = 0;
  private lastAnim: number = ANIM.IDLE;
  private speed = 0;
  private havePrev = false;
  private readonly prevPos = new THREE.Vector3(); // per avatar: speed is this avatar's own displacement
  private clock = 0;
  private pendingDt = 0;
  private lod: Lod = "full";
  private midTimer = 0;
  private disposed = false;
  private debugClip: string | null = null;
  private manualDetail = false;
  private localFlags: number | null = null;
  // Rez-in / de-rez (render/rez.ts): the running effect, the body's shader values, the light mesh.
  private rezKind: RezKind | null = null;
  private rezT = 0;
  private rezGone = false;
  private rezSolid = true;
  private rezValues: RezBody | null = null;
  private rezLight: { mesh: THREE.Mesh; fx: RezFx } | null = null;
  private readonly rezNow: RezPose = { cut: CUT_IDLE, dissolve: 0, glow: 0, fx: 1, solid: true, done: true };
  /** This avatar's running effect holds one of the few slots (rezActive). */
  private rezLit = false;
  /** Scratch for rezArrivals' sort (m from the camera). */
  rezDist = 0;
  /** Where effects are judged from: the camera, kept by the LOD pass and rezArrivals. */
  private static readonly rezFrom = new THREE.Vector3();
  private static rezFromKnown = false;
  private life = 0;

  constructor(palette = 0, starter = 0, look = 0) {
    this.palette = palette;
    this.starter = starter;
    this.look = look;
    this.modelIdx = modelIndex(starter, look);
    this.root.add(this.holder);
    this.proxy = capsule(palette, starter);
    this.holder.add(this.proxy);
    AvatarView.all.add(this);
    if (!flags.has("nochars")) {
      const a = avatarAssets();
      if (a) this.buildModel(a);
      else void preloadAvatars().then((x) => { if (x && !this.disposed && !this.model) this.buildModel(x); });
    }
  }

  /** Swap starter/palette/look (e.g. once the server confirms the local player's choice). */
  setLook(palette: number, starter: number, look = 0) {
    if (palette === this.palette && starter === this.starter && look === this.look) return;
    this.palette = palette;
    this.starter = starter;
    this.look = look;
    this.modelIdx = modelIndex(starter, look);
    this.proxy.removeFromParent();
    releaseAvatarObjects(this.proxy);
    this.proxy = capsule(palette, starter);
    const a = avatarAssets();
    this.teardownModel();
    if (a && !flags.has("nochars")) this.buildModel(a);
    else this.holder.add(this.proxy);
  }

  /** Held item by WEAPONS index (PlayerState.weapon). 0 = fists (nothing in hand). */
  setWeapon(index: number) {
    if (index === this.weaponIndex && (this.weaponObj || index === 0)) return;
    this.weaponIndex = index;
    this.weaponObj?.removeFromParent();
    releaseAvatarObjects(this.weaponObj);
    this.weaponObj = null;
    const def = WEAPONS[index];
    const socket = this.sockets.get("hand_r");
    if (!def || !socket) return;
    const obj = weaponModel(def.id, this.palette);
    if (obj) {
      // Swords, staffs, wands and bows run through the fist (blade towards the thumb: the socket's
      // rest axes). Guns sit in the hand instead: muzzle along the knuckles, top towards the thumb.
      if (def.cls === "ranged" && def.delivery !== "arrow") this.weaponRest.copy(GUN_GRIP);
      else this.weaponRest.identity();
      obj.quaternion.copy(this.weaponRest);
      this.blockGripT = 0;
      socket.add(obj);
      this.weaponObj = obj;
      obj.visible = this.rezSolid;
      this.applyShadow();
    }
  }

  /**
   * How the horse's stirrups should move for this rider (HorseView.setStirrupFit): the difference
   * between where this look's feet rest in the ride pose and where its starter's original look's do
   * (the stirrups were made for those). null for an original look or without the models.
   */
  stirrupFit(): THREE.Vector3 | null {
    return this.model ? this.fit : null;
  }

  /** Metres from the saddle's seat down to where this avatar's root (feet) must go so it sits on it. */
  seatDrop(): number {
    if (!this.model) return 0.55; // capsule
    const m = this.modelIdx;
    const pelvis = avatarAssets()?.pelvis[m] ?? PELVIS_HEIGHT;
    return pelvis * (MODEL_SCALE[m] ?? 1) - (FOOT_SINK[m] ?? 0.03) - SEAT_CLEARANCE;
  }

  /** Smoothed ground speed (m/s) from this avatar's own successive positions. */
  get groundSpeed(): number {
    return this.speed;
  }

  /** The body moved here without walking (a Skipstep blink): no teleport rez-in, no speed spike from the distance (#78). */
  blinked() {
    this.havePrev = false;
  }

  /** PlayerState.flags (PF): DEAD, BLOCKING, SWIMMING, SCOPED override the animation state. */
  setFlags(bits: number) {
    const was = this.flagBits & PF.DEAD, is = bits & PF.DEAD;
    this.flagBits = bits;
    if (is && !was) {
      // Already dead when we first saw them: no body, no show. (Rez off: the body lies where it fell.)
      if (this.life < 0.5 && rezSwitch.on) this.rezHide();
      else this.rez("death");
    } else if (!is && was) this.rez("in");
  }

  /**
   * The Rez switch changed (`rezSwitch.on` is already the new value). Off: every running effect ends
   * now: bodies are whole (the dead lie where they fell, as they do with Rez off), the lights are
   * hidden, the slots are free, and the avatars in `leaving` (mid de-rez) are freed. On: the dead are
   * gone until they rise, as they are for anyone who meets them dead.
   */
  static settleRez(on: boolean, leaving?: Set<AvatarView>) {
    if (!on && leaving) {
      for (const a of leaving) a.dispose();
      leaving.clear();
    }
    for (const a of AvatarView.all) {
      if (!on) a.rezClear();
      else if (a.flagBits & PF.DEAD) a.rezHide();
    }
  }

  /**
   * Start a rez effect (render/rez.ts): "in" materialises the avatar, "out" takes it apart from the
   * head down (the caller keeps stepping it with stepRez and disposes it when that returns true),
   * "death" breaks it into shards and leaves it gone until it rises ("in").
   */
  rez(kind: RezKind): boolean {
    if (!rezSwitch.on) {
      if (kind === "in") this.rezClear();
      return false;
    }
    // The slots are few (rezAdmits): the player's own effect always runs, anyone else's needs a free
    // one and to be near enough to see. Without one an arrival is simply there, a departure simply
    // gone (the caller frees it), and a death dissolves the body without its light, so every dead
    // avatar ends the same way.
    this.rezRelease();
    const own = this.root.userData.ownAvatar === true;
    const dist = AvatarView.rezFromKnown ? this.root.position.distanceTo(AvatarView.rezFrom) : NaN;
    const lit = rezAdmits(rezActive.count, dist, own);
    if (!lit && kind !== "death") {
      if (kind === "in") this.rezClear();
      return false;
    }
    this.rezKind = kind;
    this.rezT = 0;
    this.rezGone = false;
    if (lit) {
      this.prepareRez();
      rezActive.count++;
      this.rezLit = true;
      const [, , accent] = PALETTES[((this.palette % PALETTES.length) + PALETTES.length) % PALETTES.length]!;
      const light = this.rezLight!;
      light.fx.color.setHex(accent).lerp(_rezTint, kind === "death" ? 0.25 : 0.5);
      light.mesh.visible = true;
    } else this.rezLightDone();
    this.applyRez(rezPose(kind, 0, this.rezNow));
    return true;
  }

  /**
   * The avatars that arrived this frame materialise, nearest the camera first: when more arrive at
   * once than there are slots, the ones in front of the player get them.
   */
  static rezArrivals(list: AvatarView[], camera: THREE.Camera) {
    const from = camera.getWorldPosition(AvatarView.rezFrom);
    AvatarView.rezFromKnown = true;
    if (list.length > 1) {
      for (const a of list) a.rezDist = a.root.position.distanceToSquared(from);
      list.sort(byRezDist);
    }
    for (const a of list) a.rez("in");
  }

  /** Give back this avatar's effect slot. */
  private rezRelease() {
    if (!this.rezLit) return;
    this.rezLit = false;
    rezActive.count = Math.max(0, rezActive.count - 1);
  }

  /**
   * Give the avatar its (hidden) rez light now, so a warm-up that follows draws it once: the player's
   * own avatar gets it before the arrival's warm-up, and its first effect builds nothing in play.
   */
  prepareRez() {
    if (this.rezLight) return;
    this.rezLight = takeRezLight();
    this.root.add(this.rezLight.mesh);
  }

  /** The effect is over: anyone but the player gives the light back to the pool (render/rez.ts). */
  private rezLightDone() {
    const l = this.rezLight;
    if (!l) return;
    l.mesh.visible = false;
    if (this.root.userData.ownAvatar === true) return; // the player's own stays, ready for the next warm-up
    this.rezLight = null;
    returnRezLight(l);
  }

  /** Whether a rez effect is running. */
  get rezzing(): boolean {
    return this.rezKind !== null;
  }

  /** Advance a running effect (set() does it for a placed avatar); true once it has finished. */
  stepRez(dt: number): boolean {
    const kind = this.rezKind;
    if (!kind) return true;
    this.rezT += dt;
    const pose = rezPose(kind, this.rezT, this.rezNow);
    this.applyRez(pose);
    if (!pose.done) return false;
    this.rezKind = null;
    this.rezGone = kind !== "in";
    this.rezRelease();
    this.rezLightDone();
    return true;
  }

  /** Gone without the show (someone who was already dead when they came into view). */
  private rezHide() {
    this.rezKind = null;
    this.rezRelease();
    this.rezGone = true;
    this.rezNow.cut = CUT_GONE;
    this.rezNow.dissolve = 1;
    this.rezNow.glow = 0;
    this.rezNow.solid = false;
    this.applyRez(this.rezNow);
    this.rezLightDone();
  }

  /** Back to a whole, idle body. */
  private rezClear() {
    this.rezKind = null;
    this.rezRelease();
    this.rezGone = false;
    this.rezLightDone();
    this.rezNow.cut = CUT_IDLE;
    this.rezNow.dissolve = this.rezNow.glow = 0;
    this.rezNow.solid = true;
    this.applyRez(this.rezNow);
  }

  private applyRez(pose: RezPose) {
    const b = this.rezValues;
    if (b) {
      b.feet.copy(this.root.position);
      if (b.feet.lengthSq() < 1e-6) b.feet.set(0, 1, 0);
      b.p.set(pose.cut, pose.dissolve, pose.glow);
    }
    const l = this.rezLight;
    if (l && this.rezKind) l.fx.p.set(pose.fx, rezMode(this.rezKind), pose.cut, 1);
    if (pose.solid !== this.rezSolid) {
      this.rezSolid = pose.solid;
      this.applyShadow();
      this.applyHeld();
    }
    // The far-LOD capsule has no dissolve: it just isn't there while the body is gone.
    this.proxy.visible = pose.cut > CUT_GONE && pose.dissolve < 1;
  }

  /** What the avatar holds and wears shows only while most of the body is there. */
  private applyHeld() {
    if (this.weaponObj) this.weaponObj.visible = this.rezSolid;
    for (const o of this.attached.values()) o.visible = this.rezSolid;
  }

  /** Local prediction for the player's own avatar: when set, these BLOCKING/SCOPED bits replace the
   *  server's (which arrive a round trip late). null hands them back to the server. */
  setLocalFlags(bits: number | null) {
    this.localFlags = bits;
  }

  /** Fire a one-shot clip (attack, cast, hit…) that plays over the current state. */
  trigger(kind: OneShot) {
    if (!this.mixer || this.flagBits & PF.MOUNTED) return; // full-body clips would stand the rider up in the saddle
    const name = oneShotClip(kind, weaponKind(this.weaponIndex));
    const act = this.actions.get(name);
    if (!act) return;
    const dur = act.getClip().duration / (kind === "hit" ? 1 : 1.15);
    this.oneShot = { name, until: this.clock + dur * 0.92 };
    this.play(name, kind === "hit" ? 0.08 : 0.1, true, 1.15);
  }

  /** Force a clip by name (dev page, photo mode); null returns control to the ANIM state. */
  playClip(name: string | null) {
    this.debugClip = name;
    if (name && this.actions.has(name)) this.play(name, 0.15, true);
  }

  /** Names of the loaded clips (empty until the GLBs arrive). */
  clipNames(): string[] {
    return [...this.actions.keys()];
  }

  /** Which emote ANIM.EMOTE plays (wave by default). */
  setEmote(name: Emote) {
    this.emote = name;
  }

  /** Attach an object (cosmetic, prop) to a socket; replaces whatever was there. */
  attach(slot: SocketName, obj: THREE.Object3D | null) {
    this.attached.get(slot)?.removeFromParent();
    this.attached.delete(slot);
    if (!obj) return;
    this.attached.set(slot, obj);
    obj.visible = this.rezSolid;
    (this.sockets.get(slot) ?? this.root).add(obj);
  }

  socket(slot: SocketName): THREE.Object3D | undefined {
    return this.sockets.get(slot);
  }

  /**
   * First person (D-view-fp-1, game/view.ts): the eye (the face socket: the eye line, at the front of
   * the face) into `eye`, and a sphere round the whole head (crown, back and face, with a margin for
   * hair and hats) into `centre`; returns its radius. 0 without the skinned model (capsule, far LOD).
   */
  firstPersonHead(eye: THREE.Vector3, centre: THREE.Vector3): number {
    const face = this.sockets.get("face");
    const crown = this.sockets.get("head");
    const bone = crown?.parent;
    if (!this.model || this.lod === "far" || !face || !crown || !bone) return 0;
    bone.updateWorldMatrix(true, true);
    face.getWorldPosition(eye);
    crown.getWorldPosition(_d);
    const cut = HEAD_CUTS.get(this.modelIdx);
    if (cut) centre.copy(cut.centre).applyMatrix4(bone.matrixWorld);
    else bone.getWorldPosition(centre).add(_d).multiplyScalar(0.5);
    const scale = MODEL_SCALE[this.modelIdx] ?? 1;
    return Math.max(centre.distanceTo(_d), centre.distanceTo(eye), (cut?.r ?? 0) * scale) + HEAD_CUT_MARGIN;
  }

  /** Place at a planet-space position, standing on local up, facing a tangent direction. */
  set(x: number, y: number, z: number, fx: number, fy: number, fz: number, anim: number, dt: number) {
    // ground speed from successive positions (tangential only), smoothed
    if (this.havePrev && dt > 0) {
      _up.set(x, y, z).normalize();
      _d.set(x, y, z).sub(this.prevPos);
      _d.addScaledVector(_up, -_d.dot(_up));
      const v = Math.min(20, _d.length() / dt);
      this.speed += (v - this.speed) * Math.min(1, dt * 8);
    }
    // A jump no legs make (fast travel, a rebirth at the pad): the avatar materialises where it lands.
    if (this.havePrev && dt > 0 && !this.rezGone && this.prevPos.distanceToSquared(_d.set(x, y, z)) > TELEPORT_M * TELEPORT_M) {
      if (this.rezKind !== "in" || this.rezT > 0.2) this.rez("in");
    }
    this.prevPos.set(x, y, z);
    this.havePrev = true;
    this.life += dt;

    this.root.position.set(x, y, z);
    _up.set(x, y, z).normalize();
    _fwd.set(fx, fy, fz);
    _fwd.addScaledVector(_up, -_fwd.dot(_up));
    if (_fwd.lengthSq() < 1e-6) _fwd.set(1, 0, 0).addScaledVector(_up, -_up.x);
    _fwd.normalize();
    _right.crossVectors(_up, _fwd);
    _m.makeBasis(_right, _up, _fwd);
    this.root.quaternion.setFromRotationMatrix(_m);
    if (this.rezKind) this.stepRez(dt);

    if (!this.mixer) {
      this.capsuleMotion(anim, dt);
      return;
    }
    this.clock += dt;
    this.drive(anim);
    this.lastAnim = anim;
    this.stepBlockGrip(dt);
    // LOD-aware mixer stepping
    this.pendingDt += dt;
    if (this.lod === "full") {
      this.mixer.update(this.pendingDt);
      this.pendingDt = 0;
    } else if (this.lod === "mid") {
      this.midTimer -= dt;
      if (this.midTimer <= 0) {
        this.midTimer = 1 / 12;
        this.mixer.update(this.pendingDt);
        this.pendingDt = 0;
      }
    } else if (this.pendingDt > 1) this.pendingDt = 1;
  }

  /** Turn the held item into its block grip while the guard is held, and back out after (#76). */
  private stepBlockGrip(dt: number) {
    const obj = this.weaponObj;
    if (!obj) return;
    const goal = this.currentName === "block_hold" ? 1 : 0;
    if (goal === this.blockGripT) return;
    const step = dt / BLOCK_GRIP_TIME;
    this.blockGripT = goal > this.blockGripT ? Math.min(1, this.blockGripT + step) : Math.max(0, this.blockGripT - step);
    heldWeaponQuat(WEAPONS[this.weaponIndex]?.id ?? "", this.blockGripT, this.weaponRest, obj.quaternion);
  }

  dispose() {
    this.disposed = true;
    AvatarView.all.delete(this);
    this.teardownModel();
    this.proxy.removeFromParent();
    releaseAvatarObjects(this.proxy);
    this.rezRelease();
    if (this.rezLight) {
      returnRezLight(this.rezLight); // pooled, never disposed: its shader stays built (render/rez.ts)
      this.rezLight = null;
    }
    this.root.removeFromParent();
  }

  // ---- LOD ---------------------------------------------------------------------------------
  /** Rank avatars by distance to the camera; nearest `maxFull` animate fully. Call once a frame. */
  static updateLod(camera: THREE.Camera, maxFull: number, keep?: AvatarView) {
    const cam = camera.getWorldPosition(_d);
    AvatarView.rezFrom.copy(cam);
    AvatarView.rezFromKnown = true;
    const list: { a: AvatarView; d: number }[] = [];
    for (const a of AvatarView.all) list.push({ a, d: a.root.position.distanceToSquared(cam) });
    list.sort((p, q) => p.d - q.d);
    let rank = 0;
    for (const { a, d } of list) {
      const dist = Math.sqrt(d);
      const tier: Lod = a === keep || (rank < maxFull && dist < 90) ? "full" : rank < maxFull * 2 && dist < 70 ? "mid" : "far";
      if (a !== keep) rank++;
      if (!a.manualDetail) a.setLod(tier);
    }
  }

  /** Explicit detail control (render tiers): true = full (every-frame animation, shadows), false =
   *  reduced (12 Hz animation, no shadows). Once called, the automatic LOD pass leaves this avatar
   *  alone; call clearDetail() to hand it back. */
  setDetail(full: boolean) {
    this.manualDetail = true;
    this.setLod(full ? "full" : "mid");
  }

  clearDetail() {
    this.manualDetail = false;
  }

  private setLod(tier: Lod) {
    if (tier === this.lod) return;
    this.lod = tier;
    if (!this.model) return;
    const far = tier === "far";
    this.model.visible = !far;
    if (far) this.holder.add(this.proxy);
    else this.proxy.removeFromParent();
    this.applyShadow();
  }

  private applyShadow() {
    const cast = this.lod === "full" && this.rezSolid;
    this.model?.traverse((o) => { if ((o as THREE.Mesh).isMesh) o.castShadow = cast; });
  }

  // ---- internals ---------------------------------------------------------------------------
  private buildModel(a: AvatarAssets) {
    const m = this.modelIdx;
    const tpl = a.models[m] ?? a.models[0];
    if (!tpl) return;
    const model = cloneSkinned(tpl);
    model.scale.setScalar(MODEL_SCALE[m] ?? 1);
    const tex = a.textures[m] ?? a.textures[0]!;
    const mat = avatarMaterial(tex); // the look's; the palette is the mesh's own (per-object uniforms)
    let mesh: THREE.SkinnedMesh | null = null;
    model.traverse((o) => {
      const m = o as THREE.SkinnedMesh;
      if (m.isSkinnedMesh) {
        m.material = mat;
        setAvatarPalette(m, this.palette);
        m.castShadow = true;
        m.receiveShadow = true;
        m.frustumCulled = false;
        mesh = m;
      }
    });
    this.holder.position.y = -(FOOT_SINK[m] ?? 0.03);
    this.stride = (a.pelvis[m] ?? UAL_PELVIS) / UAL_PELVIS;
    const orig = modelIndex(this.starter, 0);
    this.fit = m === orig ? null : modelStirrupPoint(a, m, new THREE.Vector3()).sub(modelStirrupPoint(a, orig, _d));
    this.model = model;
    this.mesh = mesh;
    if (mesh) {
      // The body's rez values live with the mesh; a new look takes over the running effect's.
      this.rezValues = rezBody(mesh);
      this.rezValues.feet.copy(this.root.position);
      if (this.rezValues.feet.lengthSq() < 1e-6) this.rezValues.feet.set(0, 1, 0);
      this.rezValues.p.set(this.rezNow.cut, this.rezNow.dissolve, this.rezNow.glow);
    }
    this.makeSockets(model);
    if (!flags.has("allbones")) hideBareBones(model); // the scene walks skip fingers and toes (#49)
    this.proxy.removeFromParent();
    this.holder.add(model);
    if (this.lod === "far") {
      model.visible = false;
      this.holder.add(this.proxy);
    }
    this.mixer = new THREE.AnimationMixer(model);
    for (const [name, clip] of a.modelClips[m] ?? a.clips) {
      const act = this.mixer.clipAction(clip);
      if (!LOOPING.has(name)) {
        act.setLoop(THREE.LoopOnce, 1);
        act.clampWhenFinished = true;
      }
      if (name === "block_hold") act.setLoop(THREE.LoopPingPong, Infinity);
      this.actions.set(name, act);
    }
    this.play("idle", 0, false);
    const w = this.weaponIndex;
    this.weaponIndex = -1;
    this.setWeapon(w || this.defaultWeapon());
    for (const [slot, obj] of this.attached) (this.sockets.get(slot) ?? this.root).add(obj);
  }

  /** Before the server tells us what is held, show the starter's own weapon. */
  private defaultWeapon(): number {
    const id = STARTERS[this.starter % STARTERS.length]?.weapon;
    const i = WEAPONS.findIndex((x) => x.id === id);
    return i < 0 ? 0 : i;
  }

  private makeSockets(model: THREE.Object3D) {
    this.sockets.clear();
    // model at rest, identity transform, unscaled: compute socket offsets in bone space
    const s = model.scale.x;
    model.scale.setScalar(1);
    model.updateMatrixWorld(true);
    const bones = new Map<string, THREE.Object3D>();
    model.traverse((o) => { if ((o as THREE.Bone).isBone) bones.set(o.name, o); });
    const pos = (n: string) => (bones.get(n) ? new THREE.Vector3().setFromMatrixPosition(bones.get(n)!.matrixWorld) : new THREE.Vector3());
    for (const [name, def] of Object.entries(SOCKETS) as [SocketName, (typeof SOCKETS)[SocketName]][]) {
      const bone = bones.get(def.bone);
      if (!bone) continue;
      const st = this.modelIdx;
      const target = new THREE.Matrix4().makeTranslation(def.at(pos, st));
      const local = bone.matrixWorld.clone().invert().multiply(target);
      const sock = new THREE.Object3D();
      sock.name = `socket:${name}`;
      local.decompose(sock.position, sock.quaternion, sock.scale);
      if (name === "head" || name === "face") sock.scale.multiplyScalar(HEAD_SOCKET[st]![1]); // hats and masks fit the bigger heads
      bone.add(sock);
      this.sockets.set(name, sock);
    }
    // The first-person head cut's sphere, once per model (only the local player's avatar uses it).
    const head = bones.get("Head");
    if (head && !HEAD_CUTS.has(this.modelIdx)) HEAD_CUTS.set(this.modelIdx, headCutOf(model, head));
    model.scale.setScalar(s);
    model.updateMatrixWorld(true);
  }

  private teardownModel() {
    if (this.mixer) {
      this.mixer.stopAllAction();
      if (this.model) this.mixer.uncacheRoot(this.model);
    }
    this.mixer = null;
    this.actions.clear();
    this.current = null;
    this.currentName = "";
    this.weaponObj?.removeFromParent();
    releaseAvatarObjects(this.weaponObj);
    this.weaponObj = null;
    this.model?.removeFromParent();
    releaseAvatarObjects(this.model);
    this.model = null;
    this.mesh = null;
    this.rezValues = null;
    this.sockets.clear();
  }

  private play(name: string, fade = FADE, restart = false, timeScale = 1) {
    const next = this.actions.get(name);
    if (!next) return;
    if (next === this.current && !restart) {
      next.timeScale = timeScale;
      return;
    }
    next.reset();
    next.enabled = true;
    next.setEffectiveTimeScale(timeScale);
    next.setEffectiveWeight(1);
    next.play();
    if (this.current && this.current !== next && fade > 0) this.current.crossFadeTo(next, fade, false);
    else if (this.current && this.current !== next) this.current.stop();
    this.current = next;
    this.currentName = name;
  }

  /** Pick the clip for the networked state (+ flags, + measured speed, + any one-shot). */
  private drive(anim: number) {
    if (this.debugClip) {
      const act = this.actions.get(this.debugClip);
      if (act && !LOOPING.has(this.debugClip) && !act.isRunning()) this.play(this.debugClip, 0.2, true);
      return;
    }
    const held = PF.BLOCKING | PF.SCOPED;
    const f = this.localFlags === null ? this.flagBits : (this.flagBits & ~held) | (this.localFlags & held);
    if (f & PF.DEAD || anim === ANIM.DEAD) {
      if (this.currentName !== "death") this.play("death", 0.15);
      this.oneShot = null;
      return;
    }
    if (f & PF.MOUNTED) {
      // Riding (horses): one seated pose whatever the gait; the horse does the moving.
      this.oneShot = null;
      this.play("ride", 0.25);
      return;
    }
    // landing: a short settle when touching down to stand still
    if ((this.lastAnim === ANIM.FALL || this.lastAnim === ANIM.JUMP) && anim === ANIM.IDLE && !this.oneShot) {
      const land = this.actions.get("land_short");
      if (land) {
        this.oneShot = { name: "land_short", until: this.clock + land.getClip().duration * 0.8 };
        this.play("land_short", 0.08, true);
        return;
      }
    }
    const lockedState = anim === ANIM.DODGE || anim === ANIM.HIT;
    if (this.oneShot && !lockedState) {
      if (this.clock < this.oneShot.until && anim !== ANIM.JUMP) return;
      this.oneShot = null;
    }
    let name = "idle";
    let ts = 1;
    const sp = this.speed;
    switch (anim) {
      case ANIM.WALK:
      case ANIM.RUN:
      case ANIM.SPRINT:
        // shorter legs (the second looks) step faster for the same ground speed
        if (sp < 2.2) { name = "walk"; ts = clamp(sp / (CLIP_SPEED.walk! * this.stride), 0.8, 2.0 / this.stride); }
        else if (sp < 7.4) { name = "run"; ts = clamp(sp / (CLIP_SPEED.run! * this.stride), 0.7, 1.35 / this.stride); }
        else { name = "sprint"; ts = clamp(sp / (CLIP_SPEED.sprint! * this.stride), 0.85, 1.3 / this.stride); }
        break;
      case ANIM.JUMP: name = "jump_air"; break;
      // A hop's way down keeps the jump clip (it reaches its landing as a 0.73 s hop lands); the long
      // fall's flail only once the clip has run out, off a ledge (#78: every hop flailed half-way).
      case ANIM.FALL: name = fallClip(this.currentName, !!this.current?.isRunning()); break;
      case ANIM.SWIM:
        if (sp > 0.6) { name = "swim"; ts = clamp(sp / CLIP_SPEED.swim!, 0.7, 1.6); } else name = "swim_idle";
        break;
      case ANIM.DODGE: name = "roll_fast"; ts = ROLL_SPEED; break;
      case ANIM.ATTACK: name = oneShotClip("attack", weaponKind(this.weaponIndex)); ts = 1.15; break;
      case ANIM.HEAVY: name = oneShotClip("heavy", weaponKind(this.weaponIndex)); break;
      case ANIM.BLOCK: name = "block_hold"; ts = 0.35; break;
      case ANIM.AIM: name = "aim"; break;
      case ANIM.CAST: name = "cast"; break;
      case ANIM.HIT: name = "hit"; break;
      case ANIM.EMOTE: name = this.emote; break;
      default: name = "idle";
    }
    if (anim === ANIM.IDLE || anim === ANIM.WALK || anim === ANIM.RUN) {
      if (f & PF.BLOCKING) { name = "block_hold"; ts = 0.35; }
      else if (f & PF.SCOPED) name = "aim";
    }
    if (f & PF.SWIMMING && anim !== ANIM.DODGE) {
      name = sp > 0.6 ? "swim" : "swim_idle";
    }
    // one-shot states restart when they finish while the state holds (held fire)
    const act = this.actions.get(name);
    const restart = !!act && act === this.current && !LOOPING.has(name) && !act.isRunning() && anim !== ANIM.DODGE;
    // Rolls and jumps blend in fast: they start on the frame the key is read and must show at once.
    this.play(name, name === "roll_fast" ? ROLL_FADE : name === "jump_air" ? 0.08 : FADE, restart, ts);
  }

  private capsuleMotion(anim: number, dt: number) {
    this.clock += dt * (anim === ANIM.SPRINT ? 14 : anim === ANIM.RUN ? 11 : anim === ANIM.WALK ? 7 : 2);
    const moving = anim === ANIM.WALK || anim === ANIM.RUN || anim === ANIM.SPRINT;
    const p = this.proxy;
    p.position.y = moving ? Math.abs(Math.sin(this.clock)) * 0.08 : Math.sin(this.clock) * 0.01;
    p.rotation.x = anim === ANIM.SPRINT ? 0.18 : anim === ANIM.RUN ? 0.1 : 0;
    p.rotation.z = anim === ANIM.DODGE ? Math.sin(this.clock * 3) * 0.6 : 0;
    p.scale.y = anim === ANIM.SWIM ? 0.6 : 1;
  }
}

function clamp(v: number, a: number, b: number) {
  return Math.min(b, Math.max(a, v));
}

export { PALETTES };

const WARMUP_ITEMS = ["sunbrand", "hexquill", "carbine", "riverstaff", "emberglass", "stillshot", "kunai"] as const;

/** What the avatar warm-up stands: every starter's every look once (each look is its own material
 *  with that look's textures, so its own shader build; the palette is a per-object uniform, #39,
 *  D-load-4), each holding another item, the palettes cycling so every palette's held-item accent
 *  is drawn. Checked in a real renderer with ?avatars&warmcheck: no build after the warm-up. */
export function avatarWarmupLooks(): { palette: number; starter: number; look: number; item: string }[] {
  const looks: { palette: number; starter: number; look: number; item: string }[] = [];
  for (let starter = 0; starter < STARTERS.length; starter++) {
    for (let look = 0; look < (STARTER_LOOKS[starter]?.length ?? 1); look++) {
      const i = looks.length;
      looks.push({ palette: i % PALETTES.length, starter, look, item: WARMUP_ITEMS[i % WARMUP_ITEMS.length]! });
    }
  }
  return looks;
}

let warmupViews: AvatarView[] = [];

/**
 * Shader warm-up hook (render/warmup.ts WarmupHooks): while forced on, stands every starter's every
 * look (avatarWarmupLooks, each holding an item plus a palette-accent item in the left hand) and the
 * six far-LOD capsules at `at()`. Every look's skinned toon material, its shadow pass, and every
 * weapon/proxy material then compiles behind the loading screen instead of on first sight of another
 * player or an NPC (in any palette: the palettes share their look's build). Forced off, the samples
 * leave the scene but are kept for the session (keptSamples): disposing them freed those builds again
 * (T9). They are not in AvatarView.all, so the LOD pass never ranks them.
 */
export function avatarWarmupHook(scene: THREE.Object3D, at: () => THREE.Vector3): { forceAll(on: boolean): void } {
  const samples = () =>
    keptSamples("avatarWarmup", () => {
      const parts: THREE.Object3D[] = [];
      warmupViews = avatarWarmupLooks().map(({ palette, starter, look, item }) => {
        const v = new AvatarView(palette, starter, look);
        AvatarView.all.delete(v);
        v.setDetail(true);
        v.setWeapon(Math.max(0, WEAPONS.findIndex((w) => w.id === item)));
        v.attach("hand_l", weaponModel("stormcoil", palette));
        parts.push(v.root);
        return v;
      });
      // Every sculpted item is its own toon material (its own textures): the ones no sample holds
      // go on the samples' backs, so none of them builds on first sight either (D-weapons-1).
      const held = new Set<string>(WARMUP_ITEMS);
      SCULPTED_WEAPONS.filter((id) => !held.has(id)).forEach((id, i) => {
        const v = warmupViews[i % warmupViews.length];
        if (v) v.attach(i < warmupViews.length ? "back" : "belt", weaponModel(id, i % PALETTES.length));
      });
      // Starter 0 → trim colour i: all six proxy + trim materials.
      for (let i = 0; i < PALETTES.length; i++) parts.push(capsule(i, 0));
      // The rez light (render/rez.ts): one material, drawn dark here.
      const light = rezFxMesh().mesh;
      light.frustumCulled = false;
      light.visible = true; // hidden with the group, like the other samples (its values draw it dark)
      parts.push(light);
      return parts;
    });
  return {
    forceAll(on: boolean) {
      if (!on) {
        keptSamples("avatarWarmup")?.removeFromParent();
        return;
      }
      const group = samples();
      if (!group) return;
      scene.add(group);
      const p = at();
      for (const v of warmupViews) v.set(p.x, p.y, p.z, 1, 0, 0, ANIM.IDLE, 0);
      for (const c of group.children) if (!warmupViews.some((v) => v.root === c)) c.position.copy(p);
    },
  };
}
