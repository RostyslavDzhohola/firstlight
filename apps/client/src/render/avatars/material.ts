// Avatar material: one MeshToonNodeMaterial per starter and palette (shared by every avatar wearing
// it). Each starter has a painted albedo and a sculpted normal map. Per-corner Role colour picks the
// palette slot: R = primary, G = secondary, B = accent (emissive); 1 - the albedo's alpha marks painted
// accents (glyphs, lenses, emblems) that take the accent colour and glow. Soft two-band toon ramp +
// a fresnel rim tinted by a global (sky) colour. Palette colours are shader constants, so there are
// still six programs: textures are bindings, not code.

import * as THREE from "three/webgpu";
import { attribute, color, dot, float, max, mix, normalMap, normalView, positionViewDirection, saturate, texture, uniform, uv, vec2, vec3 } from "three/tsl";
import type { StarterTextures } from "./assets.ts";
import { applyOccluderFadeGated } from "../occluderFade.ts";

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

type TextureNode = ReturnType<typeof texture>;

/** Per look's texture set, per palette: the material and its two texture nodes (rebindAvatarTextures). */
const cache = new WeakMap<StarterTextures, Map<number, { material: THREE.MeshToonNodeMaterial; albedo: TextureNode; normal: TextureNode }>>();

export function avatarMaterial(tex: StarterTextures, palette: number): THREE.MeshToonNodeMaterial {
  const p = ((palette % PALETTES.length) + PALETTES.length) % PALETTES.length;
  let byPalette = cache.get(tex);
  if (!byPalette) cache.set(tex, (byPalette = new Map()));
  const hit = byPalette.get(p);
  if (hit) return hit.material;
  const [prim, sec, acc] = PALETTES[p]!;
  const role = attribute("color", "vec4");
  const albedo = texture(tex.albedo, uv());
  const base = albedo.rgb;
  const painted = float(1).sub(albedo.a); // painted accent mask (stored inverted: see chars3d/build.py)
  const cPrim = color(prim);
  const cSec = color(sec);
  const cAcc = color(acc);
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
  m.name = `avatar-palette-${p}`;
  // Quest NPCs (keepers, guides) dissolve between the camera and the player; players never (D-view-5).
  applyOccluderFadeGated(m);
  byPalette.set(p, { material: m, albedo, normal });
  return m;
}

/**
 * Point a look's materials at other textures of the same kind (the 1024² set after a session that
 * started on Low moves up a tier, D-load-6) and update `tex` to them. Textures are bindings, not
 * code: the materials keep their programs, so nothing compiles again.
 */
export function rebindAvatarTextures(tex: StarterTextures, next: StarterTextures) {
  for (const e of cache.get(tex)?.values() ?? []) {
    e.albedo.value = next.albedo;
    e.normal.value = next.normal;
  }
  tex.albedo = next.albedo;
  tex.normal = next.normal;
}

/** Cheap far-LOD / fallback capsule material in the palette's primary colour (shared). */
const proxyCache = new Map<number, THREE.MeshStandardNodeMaterial>();
export function proxyMaterial(palette: number): THREE.MeshStandardNodeMaterial {
  const p = ((palette % PALETTES.length) + PALETTES.length) % PALETTES.length;
  let m = proxyCache.get(p);
  if (!m) {
    m = applyOccluderFadeGated(new THREE.MeshStandardNodeMaterial({ color: PALETTES[p]![0], roughness: 0.7, metalness: 0.05 }));
    proxyCache.set(p, m);
  }
  return m;
}
