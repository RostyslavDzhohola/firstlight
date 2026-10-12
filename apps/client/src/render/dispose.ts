// Releasing GPU resources of scene subtrees (F12 S7). In three's WebGPURenderer every mesh that was
// drawn owns a render object (bind groups, uniform buffers, a node-builder reference) that listens for
// `dispose` on the object, its material and its geometry. Removing a mesh from the scene frees none
// of it, and the listeners on a shared material keep every such mesh alive. So:
//   - a view that built its own geometry/materials/textures calls disposeTree(root, keep) on unload;
//   - a view that draws shared geometry + materials calls releaseObjects(root) when it drops meshes.
// Shared module caches are passed as `keep` and never freed here.

import type * as THREE from "three/webgpu";

/** Resources a view must not free (module-level caches shared across instances or bodies). */
export type Keep = (resource: object) => boolean;

export interface DisposeCounts {
  objects: number;
  geometries: number;
  materials: number;
  textures: number;
}

export type Drawable = THREE.Object3D & {
  geometry?: THREE.BufferGeometry;
  material?: THREE.Material | THREE.Material[];
  isSprite?: boolean;
};

/** Objects in a subtree that carry geometry or a material (meshes, sprites, lines, points). */
export function drawables(root: THREE.Object3D): Drawable[] {
  const out: Drawable[] = [];
  root.traverse((o) => {
    if ((o as Drawable).geometry || (o as Drawable).material) out.push(o as Drawable);
  });
  return out;
}

/** Free each drawable's per-object render state (Object3D.dispose); geometry and materials stay. */
export function releaseObjects(root: THREE.Object3D): number {
  const list = drawables(root);
  for (const o of list) o.dispose();
  return list.length;
}

/** Textures a material holds in its own properties (map, emissiveMap, …). */
export function texturesOf(m: THREE.Material, out: Set<THREE.Texture>) {
  for (const key of Object.keys(m)) {
    const v = (m as unknown as Record<string, unknown>)[key] as { isTexture?: boolean } | null;
    if (v && typeof v === "object" && v.isTexture) out.add(v as THREE.Texture);
  }
}

/**
 * Free everything a subtree owns: per-object render state, geometries, materials and their textures,
 * except what `keep` claims. Sprites' geometry is three's shared quad and is never freed. Detach the
 * root yourself (before or after). Returns what was freed.
 */
export function disposeTree(root: THREE.Object3D, keep: Keep = () => false): DisposeCounts {
  const list = drawables(root);
  const geos = new Set<THREE.BufferGeometry>();
  const mats = new Set<THREE.Material>();
  const texs = new Set<THREE.Texture>();
  for (const o of list) {
    if (o.geometry && !o.isSprite && !keep(o.geometry)) geos.add(o.geometry);
    const ms = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
    for (const m of ms) {
      if (keep(m)) continue;
      mats.add(m);
      texturesOf(m, texs);
    }
  }
  for (const o of list) o.dispose();
  for (const g of geos) g.dispose();
  for (const m of mats) m.dispose();
  let textures = 0;
  for (const t of texs) {
    if (keep(t)) continue;
    t.dispose();
    textures++;
  }
  return { objects: list.length, geometries: geos.size, materials: mats.size, textures };
}
