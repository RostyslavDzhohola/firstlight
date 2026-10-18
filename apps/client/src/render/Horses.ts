// Horses (SPEC §6.14 #2). The Quaternius CC0 low-poly horse with our saddle (tools/blender/horse;
// docs/ASSETS.md): one skinned mesh, one toon material per coat (six, shared by every horse), an
// AnimationMixer for idle / walk / run / jump, and a `saddle` node on the Torso bone that the rider
// sits on. Until the GLB arrives (or if it fails, or ?nochars) a box horse with swinging legs
// stands in, so callers never care which one they got.

import * as THREE from "three/webgpu";
import { attribute, color, dot, float, normalView, positionViewDirection, saturate } from "three/tsl";
import { clone as cloneSkinned } from "three/addons/utils/SkeletonUtils.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import { HORSE, HORSE_COATS } from "@firstlight/shared/content/horse";
import { config, flags } from "../config.ts";
import { releaseAvatarObjects } from "./Avatars.ts";
import { avatarRim, toonRamp } from "./avatars/material.ts";
import { leanShadow } from "./leanShadow.ts";
import { keptSamples } from "./warmup.ts";

// ---- assets ----------------------------------------------------------------------------------

export interface HorseAssets {
  scene: THREE.Object3D; // template (never added to the scene graph)
  clips: Map<string, THREE.AnimationClip>;
}

let promise: Promise<HorseAssets | null> | null = null;
let loaded: HorseAssets | null = null;

export function horseAssets(): HorseAssets | null {
  return loaded;
}

/** Start (or join) the one-off load (147 KB). Resolves to null on failure: views keep the box horse. */
export function preloadHorse(): Promise<HorseAssets | null> {
  if (flags.has("nochars") || flags.has("nohorses")) return Promise.resolve(null);
  promise ??= load().catch((err) => {
    console.warn("[horses] horse.glb failed to load; using the box horse", err);
    return null;
  });
  return promise;
}

async function load(): Promise<HorseAssets> {
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  const gltf = await loader.loadAsync(`${config.assetBase}/animals/horse.glb`);
  gltf.scene.traverse((o) => {
    const m = o as THREE.SkinnedMesh;
    if (m.isSkinnedMesh) m.frustumCulled = false; // skinned bounds don't follow the pose
  });
  const clips = new Map<string, THREE.AnimationClip>();
  for (const c of gltf.animations) {
    // scale: constant 1 in the source; the stirrups: sampled rest, and the rider's fit moves them
    c.tracks = c.tracks.filter((t) => !t.name.endsWith(".scale") && !t.name.startsWith("Stirrup"));
    clips.set(c.name, c);
  }
  loaded = { scene: gltf.scene, clips };
  return loaded;
}

// ---- materials -------------------------------------------------------------------------------

const LEATHER = 0x4a2e1c;
const coatMats = new Map<number, THREE.MeshToonNodeMaterial>();
const boxMats = new Map<string, THREE.MeshStandardNodeMaterial>();

function coatIndex(coat: number): number {
  const n = HORSE_COATS.length;
  return ((coat % n) + n) % n;
}

/** Toon material for a coat. The GLB's vertex colour is a role mask: R coat, G mane, B blanket, none = leather. */
export function horseMaterial(coat: number): THREE.MeshToonNodeMaterial {
  const i = coatIndex(coat);
  let m = coatMats.get(i);
  if (m) return m;
  const [hide, mane, blanket] = HORSE_COATS[i]!;
  const role = attribute("color", "vec4");
  const leather = saturate(float(1).sub(role.x).sub(role.y).sub(role.z));
  const fres = float(1).sub(saturate(dot(normalView, positionViewDirection))).pow(3);
  m = new THREE.MeshToonNodeMaterial();
  m.gradientMap = toonRamp();
  m.colorNode = color(hide).mul(role.x).add(color(mane).mul(role.y)).add(color(blanket).mul(role.z)).add(color(LEATHER).mul(leather));
  // NodeMaterial.setupLighting() honours emissiveNode; the toon typings omit it (as for avatars).
  (m as THREE.MeshToonNodeMaterial & { emissiveNode: THREE.Node | null }).emissiveNode = avatarRim.color.mul(fres).mul(avatarRim.strength);
  m.name = `horse-coat-${i}`;
  leanShadow(m); // shadows need no colour: one shadow build for every coat (#39, D-load-3)
  coatMats.set(i, m);
  return m;
}

const boxGeos = new Map<string, THREE.BoxGeometry>();
function boxGeometry(w: number, h: number, l: number): THREE.BoxGeometry {
  const k = `${w}:${h}:${l}`;
  let g = boxGeos.get(k);
  if (!g) boxGeos.set(k, (g = new THREE.BoxGeometry(w, h, l)));
  return g;
}

function boxMaterial(hex: number): THREE.MeshStandardNodeMaterial {
  const k = hex.toString(16);
  let m = boxMats.get(k);
  if (!m) {
    m = new THREE.MeshStandardNodeMaterial({ color: hex, roughness: 0.8, metalness: 0 });
    boxMats.set(k, m);
  }
  return m;
}

// ---- gait ------------------------------------------------------------------------------------

export type Gait = "idle" | "walk" | "run" | "jump";

/**
 * Clip and playback rate for a ground speed (m/s). Rates come from the clips' measured strides
 * (walk ≈ 1.4 m/s, run ≈ 7.5 m/s at 1×) and are capped so a 16 m/s gallop stays a believable
 * ~2 strides a second instead of a blur.
 */
export function gaitFor(speed: number, airborne: boolean): { clip: Gait; timeScale: number } {
  if (airborne) return { clip: "jump", timeScale: 1.7 };
  if (speed < 0.4) return { clip: "idle", timeScale: 1 };
  if (speed < 4.5) return { clip: "walk", timeScale: clamp(speed / 1.4, 0.6, 2.4) };
  return { clip: "run", timeScale: clamp(speed / 7.5, 0.8, 2.1) };
}

// ---- the view --------------------------------------------------------------------------------

const _up = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _cam = new THREE.Vector3();
const _off = new THREE.Vector3();
const _zero = new THREE.Vector3();

type Lod = "full" | "mid" | "far";

/** The box horse (fallback): body, neck, head, tail and four legs that swing with the gait. */
interface BoxHorse {
  group: THREE.Group;
  legs: THREE.Object3D[];
}

export class HorseView {
  /** Every live horse (for the LOD pass and the warm-up). */
  static readonly all = new Set<HorseView>();

  readonly root = new THREE.Group();
  readonly coat: number;
  private model: THREE.Object3D | null = null;
  private saddle: THREE.Object3D | null = null;
  private mixer: THREE.AnimationMixer | null = null;
  private readonly actions = new Map<string, THREE.AnimationAction>();
  private current: THREE.AnimationAction | null = null;
  private box: BoxHorse | null = null;
  private clock = 0;
  private lod: Lod = "full";
  private manualDetail = false;
  private pendingDt = 0;
  private midTimer = 0;
  private disposed = false;
  /** The stirrup bones (horse.glb ≥ 2026-10-16), their rest, and model-space axes in parent space. */
  private stirrups: { bone: THREE.Object3D; rest: THREE.Vector3; toParent: THREE.Matrix3; side: number }[] = [];
  private stirrupFit = new THREE.Vector3();

  constructor(coat: number) {
    this.coat = coatIndex(coat);
    this.root.name = "horse";
    HorseView.all.add(this);
    const a = horseAssets();
    if (a) this.build(a);
    else {
      this.buildBox();
      if (!flags.has("nochars")) {
        void preloadHorse().then((x) => {
          if (x && !this.disposed && !this.model) this.build(x);
        });
      }
    }
  }

  /** Stand at a planet-space position on local up, facing a tangent; pick the gait from the speed. */
  set(x: number, y: number, z: number, fx: number, fy: number, fz: number, speed: number, airborne: boolean, dt: number) {
    this.root.position.set(x, y, z);
    _up.set(x, y, z).normalize();
    _fwd.set(fx, fy, fz).addScaledVector(_up, -_fwd.dot(_up));
    if (_fwd.lengthSq() < 1e-6) _fwd.set(1, 0, 0).addScaledVector(_up, -_up.x);
    _fwd.normalize();
    _right.crossVectors(_up, _fwd);
    _m.makeBasis(_right, _up, _fwd);
    this.root.quaternion.setFromRotationMatrix(_m);
    const g = gaitFor(speed, airborne);
    this.clock += dt;
    if (!this.mixer) {
      this.animateBox(g.clip, speed, dt);
      return;
    }
    this.play(g.clip, g.timeScale);
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

  /** World position of the top of the seat (the rider socket), after the latest pose. */
  seat(out: THREE.Vector3): THREE.Vector3 {
    if (this.saddle) {
      this.saddle.updateWorldMatrix(true, false);
      return out.setFromMatrixPosition(this.saddle.matrixWorld);
    }
    return out.copy(this.root.position).addScaledVector(_up.copy(this.root.position).normalize(), HORSE.seatHeight);
  }

  /**
   * Fit the stirrups to a rider: `fit` moves both treads (and the straps' lower ends) in the horse's
   * frame, metres: x outwards (mirrored per side), y up, z forwards. null puts them back.
   */
  setStirrupFit(fit: THREE.Vector3 | null) {
    const f = fit ?? _zero;
    if (f.equals(this.stirrupFit)) return;
    this.stirrupFit.copy(f);
    for (const s of this.stirrups) {
      _off.set(f.x * s.side, f.y, f.z).applyMatrix3(s.toParent);
      s.bone.position.copy(s.rest).add(_off);
    }
  }

  /** Explicit detail (warm-up): true = every-frame animation with shadows. */
  setDetail(full: boolean) {
    this.manualDetail = true;
    this.setLod(full ? "full" : "mid");
  }

  /** Nearest horses animate every frame and cast shadows; then 12 Hz without shadows; far ones freeze. */
  static updateLod(camera: THREE.Camera) {
    camera.getWorldPosition(_cam);
    for (const h of HorseView.all) {
      if (h.manualDetail) continue;
      const d = h.root.position.distanceTo(_cam);
      h.setLod(d < 45 ? "full" : d < 140 ? "mid" : "far");
    }
  }

  dispose() {
    this.disposed = true;
    HorseView.all.delete(this);
    this.mixer?.stopAllAction();
    if (this.model) this.mixer?.uncacheRoot(this.model);
    this.mixer = null;
    releaseAvatarObjects(this.model);
    if (this.box) releaseAvatarObjects(this.box.group);
    this.root.removeFromParent();
  }

  // ---- internals -----------------------------------------------------------------------------

  private build(a: HorseAssets) {
    if (this.box) {
      this.box.group.removeFromParent();
      releaseAvatarObjects(this.box.group);
      this.box = null;
    }
    const model = cloneSkinned(a.scene);
    const mat = horseMaterial(this.coat);
    model.traverse((o) => {
      const m = o as THREE.SkinnedMesh;
      if (m.isSkinnedMesh) {
        m.material = mat;
        m.castShadow = this.lod === "full";
        m.receiveShadow = true;
        m.frustumCulled = false;
      }
      if (o.name === "saddle") this.saddle = o;
    });
    this.model = model;
    // stirrups: model-space offsets -> each bone's parent space, measured at rest (before any clip)
    model.updateMatrixWorld(true);
    const toModel = new THREE.Matrix4().copy(model.matrixWorld).invert();
    this.stirrups = [];
    for (const [name, side] of [["StirrupL", 1], ["StirrupR", -1]] as const) {
      const bone = model.getObjectByName(name);
      if (!bone?.parent) continue;
      const parentInModel = new THREE.Matrix4().multiplyMatrices(toModel, bone.parent.matrixWorld);
      this.stirrups.push({ bone, rest: bone.position.clone(), toParent: new THREE.Matrix3().setFromMatrix4(parentInModel.invert()), side });
    }
    const fit = this.stirrupFit.clone();
    this.stirrupFit.set(0, 0, 0);
    this.setStirrupFit(fit);
    this.root.add(model);
    this.mixer = new THREE.AnimationMixer(model);
    for (const [name, clip] of a.clips) {
      const act = this.mixer.clipAction(clip);
      if (name === "jump") {
        act.setLoop(THREE.LoopOnce, 1);
        act.clampWhenFinished = true;
      }
      this.actions.set(name, act);
    }
    this.play("idle", 1, 0);
    this.mixer.update(Math.random() * 3); // don't let every idle horse breathe in step
  }

  private play(name: string, timeScale: number, fade = 0.22) {
    const next = this.actions.get(name);
    if (!next) return;
    if (next === this.current) {
      next.setEffectiveTimeScale(timeScale);
      return;
    }
    next.reset();
    next.enabled = true;
    next.setEffectiveTimeScale(timeScale);
    next.setEffectiveWeight(1);
    next.play();
    if (this.current && fade > 0) this.current.crossFadeTo(next, fade, false);
    else this.current?.stop();
    this.current = next;
  }

  private setLod(tier: Lod) {
    if (tier === this.lod) return;
    this.lod = tier;
    const cast = tier === "full";
    this.root.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) o.castShadow = cast;
    });
  }

  private buildBox() {
    const [hide, mane, blanket] = HORSE_COATS[this.coat]!;
    const g = new THREE.Group();
    g.name = "boxHorse";
    const part = (w: number, h: number, l: number, hex: number, x: number, y: number, z: number, parent: THREE.Object3D = g) => {
      const mesh = new THREE.Mesh(boxGeometry(w, h, l), boxMaterial(hex));
      mesh.position.set(x, y, z);
      mesh.castShadow = true;
      parent.add(mesh);
      return mesh;
    };
    part(0.5, 0.55, 1.5, hide, 0, 1.2, 0); // barrel
    part(0.56, 0.08, 0.7, blanket, 0, 1.5, -0.05); // blanket
    part(0.3, 0.12, 0.5, LEATHER, 0, 1.58, -0.05); // seat
    const neck = part(0.26, 0.75, 0.3, hide, 0, 1.65, 0.75);
    neck.rotation.x = 0.55;
    part(0.24, 0.26, 0.55, hide, 0, 1.95, 1.05); // head
    part(0.08, 0.5, 0.25, mane, 0, 1.75, 0.62).rotation.x = 0.55; // mane
    part(0.1, 0.55, 0.12, mane, 0, 1.1, -0.85).rotation.x = -0.35; // tail
    const legs: THREE.Object3D[] = [];
    for (const [x, z] of [[0.17, 0.6], [-0.17, 0.6], [0.17, -0.6], [-0.17, -0.6]] as const) {
      const hip = new THREE.Group();
      hip.position.set(x, 1.0, z);
      part(0.14, 0.95, 0.16, hide, 0, -0.47, 0, hip);
      part(0.16, 0.1, 0.18, mane, 0, -0.95, 0, hip); // hoof
      g.add(hip);
      legs.push(hip);
    }
    this.box = { group: g, legs };
    this.root.add(g);
  }

  private animateBox(gait: Gait, speed: number, dt: number) {
    if (!this.box) return;
    void dt;
    const amp = gait === "run" ? 0.75 : gait === "walk" ? 0.35 : gait === "jump" ? 0.9 : 0;
    const rate = gait === "run" ? Math.min(14, 6 + speed * 0.5) : 2 + speed * 1.5;
    this.box.legs.forEach((leg, i) => {
      const phase = gait === "jump" ? (i < 2 ? -1 : 1) : Math.sin(this.clock * rate + (i === 0 || i === 3 ? 0 : Math.PI));
      leg.rotation.x = phase * amp;
    });
    this.box.group.position.y = gait === "run" ? Math.abs(Math.sin(this.clock * rate)) * 0.08 : 0;
  }
}

function clamp(v: number, a: number, b: number) {
  return Math.min(b, Math.max(a, v));
}

let warmupViews: HorseView[] = [];

/**
 * Shader warm-up hook (render/warmup.ts): while forced on, stands one horse per coat at `at()` with
 * full detail (shadow pass included), so the six coat materials and their shadow variants compile
 * behind the loading screen. Forced off, the samples leave the scene but are kept for the session
 * (keptSamples): disposing them freed those builds, and the first horses after arrival compiled in
 * play (T9). They are not in HorseView.all, so the LOD and blob-shadow passes skip them. Without the
 * GLB they are box horses, which is what the game shows then.
 */
export function horseWarmupHook(scene: THREE.Object3D, at: () => THREE.Vector3): { forceAll(on: boolean): void } {
  return {
    forceAll(on: boolean) {
      if (!on) {
        keptSamples("horseWarmup")?.removeFromParent();
        return;
      }
      if (flags.has("nohorses")) return;
      const group = keptSamples("horseWarmup", () => {
        warmupViews = HORSE_COATS.map((_, i) => {
          const v = new HorseView(i);
          HorseView.all.delete(v);
          v.setDetail(true);
          return v;
        });
        return warmupViews.map((v) => v.root);
      });
      if (!group) return;
      scene.add(group);
      const p = at();
      for (const v of warmupViews) v.set(p.x, p.y, p.z, 1, 0, 0, 0, false, 0);
    },
  };
}
