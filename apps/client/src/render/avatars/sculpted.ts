// Sculpted held items: weapons built as code in headless Blender (tools/blender/props3d, the
// models-as-code method, #54). Per item one static GLB in socket space (origin = the grip, +Z = tip
// or head, +Y = up / the edge side, bows with their limbs along +Z), its Role colours per corner, and an
// albedo (alpha = 1 - painted glow) plus a tangent-space normal map: 512² by default, the 256² set on
// the Low tier. Loaded once with the character assets (assets.ts, behind the loading screen, so the
// warm-up compiles their materials) and shared by every holder: one geometry and one toon material
// per item for every palette (the palette is a per-object uniform, setAvatarPalette). An item that
// fails to load keeps its code-built model (weapons.ts), which also stands in until the load is done.

import * as THREE from "three/webgpu";
import type { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { config } from "../../config.ts";
import type { StarterTextures } from "./assets.ts";
import { avatarMaterial, setAvatarPalette } from "./material.ts";

import { SCULPTED_WEAPONS } from "./sculptedIds.ts";

export { SCULPTED_WEAPONS };

interface Sculpted {
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
}

const ready = new Map<string, Sculpted>();

const base = () => `${config.assetBase}/weapons/`;

function texture(name: string, srgb: boolean): Promise<THREE.Texture> {
  return new THREE.TextureLoader().loadAsync(`${base()}${name}.webp`).then((t) => {
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.flipY = false; // glTF UV convention
    t.anisotropy = 4;
    t.needsUpdate = true;
    return t;
  });
}

/** The one mesh of a prop GLB (the build exports a single joined mesh). */
function meshOf(scene: THREE.Object3D): THREE.Mesh | null {
  let found: THREE.Mesh | null = null;
  scene.traverse((o) => {
    if (!found && (o as THREE.Mesh).isMesh) found = o as THREE.Mesh;
  });
  return found;
}

/**
 * How long the optional sculpted items may hold the loading screen (ms). Past it the load resolves
 * with what it has; the rest keep their code-built models for this visit (weapons review 1: a
 * download that never settled held entry for good).
 */
export const SCULPTED_PRELOAD_DEADLINE_MS = 15_000;

export interface SculptedPreloadOptions {
  /** Texture loader (tests); default: the asset base's WebP. */
  texture?: (name: string, srgb: boolean) => Promise<THREE.Texture>;
  deadlineMs?: number;
}

/**
 * Load every sculpted item (`low`: the 256² textures). Never rejects and never takes longer than the
 * deadline: an item that fails or is still downloading then is left out (a console warning) and keeps
 * its code-built model, also when its files land later, so nothing changes a material the warm-up
 * already compiled. `tick` is called once per finished file.
 */
export async function preloadSculptedWeapons(loader: GLTFLoader, low: boolean, tick: () => void = () => {}, opts: SculptedPreloadOptions = {}): Promise<void> {
  const suffix = low ? "_256" : "";
  const tex = opts.texture ?? texture;
  let open = true;
  const all = Promise.all(SCULPTED_WEAPONS.map(async (id) => {
    try {
      const done = <T>(p: Promise<T>) => p.then((v) => { if (open) tick(); return v; });
      const [gltf, albedo, normal] = await Promise.all([
        done(loader.loadAsync(`${base()}${id}.glb`)),
        done(tex(`${id}_albedo${suffix}`, true)),
        done(tex(`${id}_normal${suffix}`, false)),
      ]);
      if (!open) {
        console.warn(`[weapons] sculpted ${id} arrived after the loading deadline; keeping the code-built model`);
        return;
      }
      const mesh = meshOf(gltf.scene);
      if (!mesh) throw new Error("no mesh in the GLB");
      // The GLB's node may carry a transform; bake it so the geometry sits in socket space.
      mesh.updateWorldMatrix(true, false);
      const geometry = mesh.geometry.clone().applyMatrix4(mesh.matrixWorld);
      geometry.computeBoundingSphere();
      const maps: StarterTextures = { albedo, normal };
      ready.set(id, { geometry, material: avatarMaterial(maps, "painted") });
    } catch (err) {
      if (open) console.warn(`[weapons] sculpted ${id} failed to load; keeping the code-built model`, err);
    }
  }));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((res) => {
    timer = setTimeout(() => {
      const late = SCULPTED_WEAPONS.filter((id) => !ready.has(id));
      if (late.length) console.warn(`[weapons] sculpted ${late.join(", ")} not in after ${opts.deadlineMs ?? SCULPTED_PRELOAD_DEADLINE_MS} ms; keeping the code-built models`);
      res();
    }, opts.deadlineMs ?? SCULPTED_PRELOAD_DEADLINE_MS);
  });
  await Promise.race([all, deadline]);
  open = false;
  clearTimeout(timer);
}

/** How many files preloadSculptedWeapons fetches (for a loading bar). */
export const SCULPTED_FILE_COUNT = SCULPTED_WEAPONS.length * 3;

/** Whether `id` is drawn from its sculpted GLB now. */
export function hasSculptedWeapon(id: string): boolean {
  return ready.has(id);
}

/** A new mesh of the sculpted item `id` in `palette` (shares geometry and material), or null. */
export function sculptedWeapon(id: string, palette: number): THREE.Object3D | null {
  const s = ready.get(id);
  if (!s) return null;
  const mesh = new THREE.Mesh(s.geometry, s.material);
  mesh.name = `weapon:${id}:sculpted`;
  mesh.castShadow = true;
  setAvatarPalette(mesh, palette);
  return mesh;
}
