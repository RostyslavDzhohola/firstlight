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
 * Load every sculpted item (`low`: the 256² textures). Never rejects: an item that fails is left out
 * (a console warning) and keeps its code-built model. `tick` is called once per finished file.
 */
export async function preloadSculptedWeapons(loader: GLTFLoader, low: boolean, tick: () => void = () => {}): Promise<void> {
  const suffix = low ? "_256" : "";
  await Promise.all(SCULPTED_WEAPONS.map(async (id) => {
    try {
      const done = <T>(p: Promise<T>) => p.then((v) => { tick(); return v; });
      const [gltf, albedo, normal] = await Promise.all([
        done(loader.loadAsync(`${base()}${id}.glb`)),
        done(texture(`${id}_albedo${suffix}`, true)),
        done(texture(`${id}_normal${suffix}`, false)),
      ]);
      const mesh = meshOf(gltf.scene);
      if (!mesh) throw new Error("no mesh in the GLB");
      // The GLB's node may carry a transform; bake it so the geometry sits in socket space.
      mesh.updateWorldMatrix(true, false);
      const geometry = mesh.geometry.clone().applyMatrix4(mesh.matrixWorld);
      geometry.computeBoundingSphere();
      const tex: StarterTextures = { albedo, normal };
      ready.set(id, { geometry, material: avatarMaterial(tex, "painted") });
    } catch (err) {
      console.warn(`[weapons] sculpted ${id} failed to load; keeping the code-built model`, err);
    }
  }));
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
