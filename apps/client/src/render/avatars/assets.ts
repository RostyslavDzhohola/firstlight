// Starter character assets: one skinned GLB per look (the five sculpted starters, plus the second looks
// of Kappa and Unit 7), all on one shared skeleton, one GLB of clips, and per look an albedo (alpha =
// painted accent mask) and a tangent-space normal map (the second looks share one flat 4x4 map: their
// design has no sculpt detail). Loaded once (meshopt-compressed) behind the loading screen, every look
// up front: each look's materials are their own shader builds, so a look downloaded on first sight
// would compile in play; the warm-up builds them all behind the loading screen instead (D-chars-3).
// Every AvatarView clones from here.
// Built by tools/blender/chars3d/build.sh (the clips by tools/blender/characters/build_anims.py, the
// second looks by chars3d/rig_astra.py).

import * as THREE from "three/webgpu";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import { lookId } from "@firstlight/shared/content/weapons";
import { config } from "../../config.ts";
import { makeRideClip } from "./ride.ts";

/** Every look's model file (STARTER_LOOKS ids): first the five starters' original looks, in
 *  PlayerState.starter order, then the second looks. */
export const MODEL_FILES = ["hexwick", "ash", "kappa", "unit7", "ninja", "kappa_b", "unit7_b"] as const;
/** The starters' original looks (index = PlayerState.starter). */
export const STARTER_FILES = MODEL_FILES.slice(0, 5);

/** Per-model scale (one skeleton; silhouettes differ in build): Hexwick slim and young, Brother Ash
 *  tall, Kappa squat, Unit 7 compact, the ninja lean; the second looks keep their designed size. */
export const MODEL_SCALE = [0.95, 1.04, 0.9, 0.98, 0.96, 1.0, 1.06] as const;
export const STARTER_SCALE = MODEL_SCALE.slice(0, 5);

/** The model (MODEL_FILES index) for a starter's look; an unknown look draws the original. */
export function modelIndex(starter: number, look = 0): number {
  const i = (MODEL_FILES as readonly string[]).indexOf(lookId(starter, look));
  return i >= 0 ? i : ((starter % STARTER_FILES.length) + STARTER_FILES.length) % STARTER_FILES.length;
}

export interface StarterTextures {
  /** sRGB colour; 1 - alpha marks painted accents (glyphs, lens, emblem) that take the palette accent. */
  albedo: THREE.Texture;
  /** Tangent-space normals (OpenGL convention, Blender UVs: the material flips Y for glTF UVs). */
  normal: THREE.Texture;
}

export interface AvatarAssets {
  /** Template scenes by MODEL_FILES index (never added to the scene graph). */
  models: THREE.Object3D[];
  textures: StarterTextures[];
  /** The shared clips (built for the UAL proportions every original look has). */
  clips: Map<string, THREE.AnimationClip>;
  /** Clips per model: the originals share `clips`; a second look gets its own pelvis tracks. */
  modelClips: Map<string, THREE.AnimationClip>[];
  /** Rest pelvis height per model (model space, unscaled, m). */
  pelvis: number[];
}

/** Rest pelvis height of the shared skeleton (UAL), what the clips' pelvis tracks are made for. */
export const UAL_PELVIS = 0.917;

/** Texture size: 1024² by default, 512² on the Low tier (set before the first preload). */
let lowRes = false;
export function setAvatarTextureLowRes(low: boolean) {
  lowRes = low;
}

let promise: Promise<AvatarAssets | null> | null = null;
let loaded: AvatarAssets | null = null;
let failed = false;

export function avatarAssets(): AvatarAssets | null {
  return loaded;
}

export function avatarAssetsFailed(): boolean {
  return failed;
}

/** Start (or join) the one-off load. Resolves to null on failure (callers keep the capsule). */
export function preloadAvatars(onProgress?: (frac: number) => void): Promise<AvatarAssets | null> {
  if (!promise) promise = load(onProgress).catch((err) => {
    console.warn("[avatars] character assets failed to load; using capsules", err);
    failed = true;
    return null;
  });
  return promise;
}

const base = () => `${config.assetBase}/characters/`;

function gltfLoader(): GLTFLoader {
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  return loader;
}

function loadTexture(name: string, srgb: boolean): Promise<THREE.Texture> {
  return new THREE.TextureLoader().loadAsync(`${base()}${name}${lowRes ? "_512" : ""}.webp`).then((t) => {
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.flipY = false; // glTF UV convention
    t.anisotropy = 4;
    t.needsUpdate = true;
    return t;
  });
}

let flat: THREE.DataTexture | null = null;
/** The second looks' normal map: flat (0.5, 0.5, 1), 4x4, sampled like the real ones. */
export function flatNormalMap(): THREE.DataTexture {
  if (flat) return flat;
  const px = new Uint8Array(4 * 4 * 4);
  for (let i = 0; i < 16; i++) px.set([128, 128, 255, 255], i * 4);
  flat = new THREE.DataTexture(px, 4, 4, THREE.RGBAFormat);
  flat.colorSpace = THREE.NoColorSpace;
  flat.magFilter = THREE.LinearFilter;
  flat.minFilter = THREE.LinearMipmapLinearFilter;
  flat.generateMipmaps = true;
  flat.anisotropy = 4;
  flat.needsUpdate = true;
  return flat;
}

/** A model template ready to clone: skinned meshes never frustum-culled (the LOD pass culls). */
function template(g: { scene: THREE.Object3D }): THREE.Object3D {
  g.scene.traverse((o) => {
    const m = o as THREE.SkinnedMesh;
    if (m.isSkinnedMesh) {
      m.frustumCulled = false; // skinned bounds don't follow the pose; the LOD pass culls by distance
      m.geometry.computeBoundingSphere();
    }
  });
  return g.scene;
}

async function load(onProgress?: (frac: number) => void): Promise<AvatarAssets> {
  const loader = gltfLoader();
  let done = 0;
  const own = (i: number) => i < STARTER_FILES.length; // a sculpted original with its own normal map
  const total = MODEL_FILES.length * 2 + STARTER_FILES.length + 1;
  const tick = <T>(p: Promise<T>) => p.then((v) => { onProgress?.(++done / total); return v; });

  const [anims, chars, textures] = await Promise.all([
    tick(loader.loadAsync(`${base()}starters_anims.glb`)),
    Promise.all(MODEL_FILES.map((f) => tick(loader.loadAsync(`${base()}${f}.glb`)))),
    Promise.all(MODEL_FILES.map(async (f, i) => {
      const [albedo, normal] = await Promise.all([
        tick(loadTexture(`${f}_albedo`, true)),
        own(i) ? tick(loadTexture(`${f}_normal`, false)) : Promise.resolve(flatNormalMap()),
      ]);
      return { albedo, normal };
    })),
  ]);

  const clips = new Map<string, THREE.AnimationClip>();
  for (const c of anims.animations) clips.set(c.name, slim(c));
  addSubclips(clips);

  const models = chars.map(template);
  const idle = clips.get("idle");
  if (idle && models[0]) clips.set("ride", makeRideClip(idle, models[0])); // horses: no CC0 riding clip
  const pelvis = models.map(pelvisHeight);
  const modelClips = pelvis.map((h) => (Math.abs(h - UAL_PELVIS) < 0.02 ? clips : legClips(clips, h)));
  loaded = { models, textures, clips, modelClips, pelvis };
  return loaded;
}

/** Rest pelvis height of a template (model space, unscaled). */
export function pelvisHeight(model: THREE.Object3D): number {
  model.updateMatrixWorld(true);
  const p = model.getObjectByName("pelvis");
  return p ? new THREE.Vector3().setFromMatrixPosition(p.matrixWorld).y : UAL_PELVIS;
}

/**
 * The clips for a body with other leg lengths (a second look): every bone's rotation is shared, and
 * only the pelvis track (the one position track left) is rescaled about the rest pose, so the feet
 * still reach the ground, the bob and the crouches shrink with the legs. The rest positions are read
 * from the tracks' own space: pelvis.position is local to `root`, as in every model.
 */
export function legClips(clips: Map<string, THREE.AnimationClip>, height: number): Map<string, THREE.AnimationClip> {
  const k = height / UAL_PELVIS;
  const out = new Map<string, THREE.AnimationClip>();
  for (const [name, clip] of clips) {
    const tracks = clip.tracks.map((t) => {
      if (t.name !== "pelvis.position") return t;
      const v = t.values.slice();
      for (let i = 0; i < v.length; i++) v[i] = v[i]! * k;
      return new THREE.VectorKeyframeTrack(t.name, Array.from(t.times), Array.from(v));
    });
    out.set(name, new THREE.AnimationClip(clip.name, clip.duration, tracks, clip.blendMode));
  }
  return out;
}

/** Drop constant scale tracks and per-bone translations (the skeleton's rest lengths already match):
 *  only the pelvis keeps its position track. Cuts mixer work from 195 to ~66 tracks per clip. */
function slim(clip: THREE.AnimationClip): THREE.AnimationClip {
  clip.tracks = clip.tracks.filter((t) => {
    if (t.name.endsWith(".scale")) return false;
    if (t.name.endsWith(".position")) return t.name.startsWith("pelvis.");
    return true;
  });
  return clip;
}

/** First frame (30 fps) of the Roll clip the dodge plays: the lean into the dive (pelvis ~40° over). */
export const ROLL_FROM_FRAME = 6;
/** Playback speed of the dodge's roll: the tumble fits the 0.3 s roll (PlayerController MOVE.dodgeTime). */
export const ROLL_SPEED = 2.4;

function addSubclips(clips: Map<string, THREE.AnimationClip>) {
  const sub = (src: string, name: string, a: number, b: number) => {
    const c = clips.get(src);
    if (c) clips.set(name, THREE.AnimationUtils.subclip(c, name, a, b, 30));
  };
  sub("jump", "jump_air", 9, 40); // skip the crouch: the game jump leaves the ground at once
  sub("block", "block_hold", 9, 17); // held guard (ping-pong)
  // The tumble itself, from the forward lean. Frames 2–5 rise out of a crouch: from frame 2 the body
  // stood tall for the roll's first ~70 ms while it already slid, so the roll looked late.
  sub("roll", "roll_fast", ROLL_FROM_FRAME, 36);
  sub("land", "land_short", 0, 14);
}
