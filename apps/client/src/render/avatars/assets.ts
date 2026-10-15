// Starter character assets: four skinned GLBs on one shared skeleton, one GLB of clips, one atlas.
// Loaded once (meshopt-compressed) behind the loading screen; every AvatarView clones from here.
// Built by tools/blender/characters/build.sh.

import * as THREE from "three/webgpu";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import { config } from "../../config.ts";
import { makeRideClip } from "./ride.ts";

/** Order matches PlayerState.starter and STARTERS in @firstlight/shared/content/weapons. */
export const STARTER_FILES = ["hexwick", "ash", "kappa", "unit7"] as const;

/** Per-starter model scale (one skeleton; silhouettes differ in build): Hexwick slim and young,
 *  Brother Ash tall, Kappa squat, Unit 7 compact. */
export const STARTER_SCALE = [0.95, 1.04, 0.9, 0.98] as const;

export interface AvatarAssets {
  starters: THREE.Object3D[]; // template scenes (never added to the scene graph)
  clips: Map<string, THREE.AnimationClip>;
  atlas: THREE.Texture;
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
  const total = STARTER_FILES.length + 2;
  const tick = <T>(p: Promise<T>) => p.then((v) => { onProgress?.(++done / total); return v; });

  const [atlas, anims, ...chars] = await Promise.all([
    tick(new THREE.TextureLoader().loadAsync(`${base}starters_atlas.png`)),
    tick(loader.loadAsync(`${base}starters_anims.glb`)),
    ...STARTER_FILES.map((f) => tick(loader.loadAsync(`${base}${f}.glb`))),
  ]);
  atlas.colorSpace = THREE.SRGBColorSpace;
  atlas.flipY = false; // glTF UV convention
  atlas.anisotropy = 4;
  atlas.needsUpdate = true;

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
  loaded = { starters, clips, atlas };
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
