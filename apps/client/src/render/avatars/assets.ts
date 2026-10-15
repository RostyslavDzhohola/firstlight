// Starter character assets: five sculpted, skinned GLBs on one shared skeleton, one GLB of clips, and
// per starter an albedo (alpha = painted accent mask) and a tangent-space normal map. Loaded once
// (meshopt-compressed) behind the loading screen; every AvatarView clones from here.
// Built by tools/blender/chars3d/build.sh (the clips by tools/blender/characters/build_anims.py).

import * as THREE from "three/webgpu";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import { config } from "../../config.ts";
import { makeRideClip } from "./ride.ts";

/** Order matches PlayerState.starter and STARTERS in @firstlight/shared/content/weapons. */
export const STARTER_FILES = ["hexwick", "ash", "kappa", "unit7", "ninja"] as const;

/** Per-starter model scale (one skeleton; silhouettes differ in build): Hexwick slim and young,
 *  Brother Ash tall, Kappa squat, Unit 7 compact, the ninja lean. */
export const STARTER_SCALE = [0.95, 1.04, 0.9, 0.98, 0.96] as const;

export interface StarterTextures {
  /** sRGB colour; 1 - alpha marks painted accents (glyphs, lens, emblem) that take the palette accent. */
  albedo: THREE.Texture;
  /** Tangent-space normals (OpenGL convention, Blender UVs: the material flips Y for glTF UVs). */
  normal: THREE.Texture;
}

export interface AvatarAssets {
  starters: THREE.Object3D[]; // template scenes (never added to the scene graph)
  textures: StarterTextures[];
  clips: Map<string, THREE.AnimationClip>;
}

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

async function load(onProgress?: (frac: number) => void): Promise<AvatarAssets> {
  const base = `${config.assetBase}/characters/`;
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  let done = 0;
  const total = STARTER_FILES.length * 3 + 1;
  const tick = <T>(p: Promise<T>) => p.then((v) => { onProgress?.(++done / total); return v; });
  const texLoader = new THREE.TextureLoader();
  const suffix = lowRes ? "_512" : "";
  const tex = (name: string, srgb: boolean) =>
    tick(texLoader.loadAsync(`${base}${name}${suffix}.webp`)).then((t) => {
      t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      t.flipY = false; // glTF UV convention
      t.anisotropy = 4;
      t.needsUpdate = true;
      return t;
    });

  const [anims, chars, textures] = await Promise.all([
    tick(loader.loadAsync(`${base}starters_anims.glb`)),
    Promise.all(STARTER_FILES.map((f) => tick(loader.loadAsync(`${base}${f}.glb`)))),
    Promise.all(STARTER_FILES.map(async (f) => {
      const [albedo, normal] = await Promise.all([tex(`${f}_albedo`, true), tex(`${f}_normal`, false)]);
      return { albedo, normal };
    })),
  ]);

  const clips = new Map<string, THREE.AnimationClip>();
  for (const c of anims.animations) clips.set(c.name, slim(c));
  addSubclips(clips);

  const starters = chars.map((g) => {
    g.scene.traverse((o) => {
      const m = o as THREE.SkinnedMesh;
      if (m.isSkinnedMesh) {
        m.frustumCulled = false; // skinned bounds don't follow the pose; the LOD pass culls by distance
        m.geometry.computeBoundingSphere();
      }
    });
    return g.scene;
  });
  const idle = clips.get("idle");
  if (idle && starters[0]) clips.set("ride", makeRideClip(idle, starters[0])); // horses: no CC0 riding clip
  loaded = { starters, textures, clips };
  return loaded;
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

function addSubclips(clips: Map<string, THREE.AnimationClip>) {
  const sub = (src: string, name: string, a: number, b: number) => {
    const c = clips.get(src);
    if (c) clips.set(name, THREE.AnimationUtils.subclip(c, name, a, b, 30));
  };
  sub("jump", "jump_air", 9, 40); // skip the crouch: the game jump leaves the ground at once
  sub("block", "block_hold", 9, 17); // held guard (ping-pong)
  sub("roll", "roll_fast", 2, 36); // the tumble itself
  sub("land", "land_short", 0, 14);
}
