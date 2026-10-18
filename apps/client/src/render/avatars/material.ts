// Avatar material: one MeshToonNodeMaterial per look (its painted albedo and sculpted normal map),
// shared by every avatar wearing that look in any palette. Per-corner Role colour picks the palette
// slot: R = primary, G = secondary, B = accent (emissive); 1 - the albedo's alpha marks painted
// accents (glyphs, lenses, emblems) that take the accent colour and glow. Soft two-band toon ramp + a
// fresnel rim tinted by a global (sky) colour. The palette colours are per-object uniforms read from
// the drawn skinned mesh (setAvatarPalette), the accent's glow included: one build and pipeline per
// look instead of one per look and palette (#39, D-load-4), the same colours.

import * as THREE from "three/webgpu";
import { attribute, dot, float, max, mix, normalMap, normalView, positionViewDirection, saturate, texture, uniform, uv, vec2, vec3 } from "three/tsl";
import type { StarterTextures } from "./assets.ts";
import { applyOccluderFadeGated } from "../occluderFade.ts";
import { leanShadow } from "../leanShadow.ts";

/** docs/content.md §8.3: primary, secondary, accent. */
export const PALETTES: readonly (readonly [number, number, number])[] = [
  [0xe9e4d8, 0x6f7780, 0xf2b544], // Ivory
  [0xc8a97e, 0x6b4a32, 0xf5a623], // Sand
  [0x1e2f5c, 0xc9ced6, 0x6fd3ff], // Midnight
  [0x5e7a3a, 0x8a6a43, 0x9be564], // Moss
  [0x2e2a2b, 0xa3402b, 0xff8a3d], // Ember
  [0x4a3260, 0x3e5568, 0xf09a7a], // Dusk
];

/** Global rim light colour/strength (the world can tint it with the sky colour). */
export const avatarRim = {
  color: uniform(new THREE.Color(0xa8c4ff)),
  strength: uniform(0.32),
};

let ramp: THREE.DataTexture | null = null;
/** The shared two-band toon ramp (also used by horses, render/Horses.ts). */
export function toonRamp(): THREE.DataTexture {
  if (ramp) return ramp;
  // dot(N,L) * 0.5 + 0.5 → irradiance. A soft terminator between a lifted shadow band and full light.
  const n = 32;
  const data = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    const x = i / (n - 1);
    const t = Math.min(1, Math.max(0, (x - 0.46) / 0.1));
    const s = t * t * (3 - 2 * t);
    const v = 0.38 + (1 - 0.38) * s + (x > 0.85 ? 0.06 * (x - 0.85) / 0.15 : 0);
    const b = Math.round(Math.min(1, v) * 255);
    data.set([b, b, b, 255], i * 4);
  }
  ramp = new THREE.DataTexture(data, n, 1, THREE.RGBAFormat);
  ramp.minFilter = THREE.LinearFilter;
  ramp.magFilter = THREE.LinearFilter;
  ramp.generateMipmaps = false;
  ramp.needsUpdate = true;
  return ramp;
}

/** A palette index in range (any integer wraps). */
export function paletteIndex(palette: number): number {
  return ((palette % PALETTES.length) + PALETTES.length) % PALETTES.length;
}

const paletteOf = new WeakMap<THREE.Object3D, number>();

/** The palette `mesh` (a skinned avatar body) draws its look's material in. */
export function setAvatarPalette(mesh: THREE.Object3D, palette: number): void {
  paletteOf.set(mesh, paletteIndex(palette));
}

/** The palettes' colours (linear, as color(hex) made them), by palette then slot. */
const PALETTE_COLORS = PALETTES.map((p) => p.map((hex) => new THREE.Color(hex)));

/**
 * One palette slot (0 primary, 1 secondary, 2 accent) as a per-object uniform: three sets it from
 * the drawn mesh right before it writes that draw's own uniform buffer (as occluderFade's gate).
 */
function slot(i: number) {
  const u = uniform(new THREE.Color(PALETTES[0]![i]!));
  return u.onObjectUpdate(({ object }) => void u.value.copy(PALETTE_COLORS[paletteOf.get(object as THREE.Object3D) ?? 0]![i]!));
}
const [cPrim, cSec, cAcc] = [slot(0), slot(1), slot(2)];

type TextureNode = ReturnType<typeof texture>;

/**
 * Per look's texture set: its material and two texture nodes (rebindAvatarTextures). Keyed by the
 * set itself, not its albedo's uuid, so a rebind to the 1024² textures keeps the same material.
 */
const cache = new WeakMap<StarterTextures, { material: THREE.MeshToonNodeMaterial; albedo: TextureNode; normal: TextureNode }>();
let looks = 0;

/** The toon material of the look with textures `tex`: every palette (setAvatarPalette on each mesh). */
export function avatarMaterial(tex: StarterTextures): THREE.MeshToonNodeMaterial {
  const hit = cache.get(tex);
  if (hit) return hit.material;
  const role = attribute("color", "vec4");
  const albedo = texture(tex.albedo, uv());
  const base = albedo.rgb;
  const painted = float(1).sub(albedo.a); // painted accent mask (stored inverted: see chars3d/build.py)
  const tint = mix(mix(mix(vec3(1, 1, 1), cPrim, role.x), cSec, role.y), cAcc, role.z);
  const fres = float(1).sub(saturate(dot(normalView, positionViewDirection))).pow(3);
  const m = new THREE.MeshToonNodeMaterial();
  m.gradientMap = toonRamp();
  m.colorNode = mix(base.mul(tint), cAcc, painted);
  // Blender bakes OpenGL-style normals against Blender UVs; glTF UVs flip V, hence Y = -1.
  const normal = texture(tex.normal, uv());
  m.normalNode = normalMap(normal, vec2(1, -1));
  // NodeMaterial.setupLighting() honours emissiveNode on every node material; the toon typings omit it.
  (m as THREE.MeshToonNodeMaterial & { emissiveNode: THREE.Node | null }).emissiveNode =
    cAcc.mul(max(role.z, painted)).mul(2.2).add(avatarRim.color.mul(fres).mul(avatarRim.strength));
  m.side = THREE.DoubleSide; // cloth is single-sided: robe hems, hoods and sleeves show their insides
  m.name = `avatar-look-${looks++}`;
  // Quest NPCs (keepers, guides) dissolve between the camera and the player; players never (D-view-5).
  applyOccluderFadeGated(m);
  // Shadows need no colour: one shadow build for every look and palette (#39, D-load-3).
  leanShadow(m);
  cache.set(tex, { material: m, albedo, normal });
  return m;
}

/**
 * Point a look's material at other textures of the same kind (the 1024² set after a session that
 * started on Low moves up a tier, D-load-6) and update `tex` to them. Textures are bindings, not
 * code: the material keeps its program, so nothing compiles again.
 */
export function rebindAvatarTextures(tex: StarterTextures, next: StarterTextures) {
  const e = cache.get(tex);
  if (e) {
    e.albedo.value = next.albedo;
    e.normal.value = next.normal;
  }
  tex.albedo = next.albedo;
  tex.normal = next.normal;
}

/** Cheap far-LOD / fallback capsule material in the palette's primary colour (shared). */
const proxyCache = new Map<number, THREE.MeshStandardNodeMaterial>();
export function proxyMaterial(palette: number): THREE.MeshStandardNodeMaterial {
  const p = paletteIndex(palette);
  let m = proxyCache.get(p);
  if (!m) {
    m = applyOccluderFadeGated(new THREE.MeshStandardNodeMaterial({ color: PALETTES[p]![0], roughness: 0.7, metalness: 0.05 }));
    proxyCache.set(p, m);
  }
  return m;
}
