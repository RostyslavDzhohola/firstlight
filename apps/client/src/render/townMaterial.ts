// The structure sites' two shared materials (D38, D42): opaque and alpha-tested ("cutout": leaves,
// vines, tree cards). Every kit material of a site is a slot baked into the vertices (SiteTown.ts):
// the layer of the texture arrays, a linear tint, roughness, metalness, normal strength and an
// emissive mode. So a whole site draws with these two materials (one per normal-map setting), and
// every mesh of the site shares their pipelines; Portus and the Portus-kit outposts share them too
// (the same strips), except Hollowmere's, whose albedo floor differs (one more pipeline pair there).
//
// Vertex attributes: position, normal, uv; `color` (unorm8x4: linear tint rgb, normal strength a);
// `townMat` (unorm8x4: layer / 255, roughness, metalness, emissive mode / 255: 1 flame, 2 window, 3 glow).

import * as THREE from "three/webgpu";
import { attribute, float, max, mix, normalMap, select, texture, uv, vec2, vec3 } from "three/tsl";
import { atmo } from "./atmosphere.ts";

export type TownMaterialKind = "opaque" | "cutout";

/** Emissive modes in townMat.w (× 255). */
export const TOWN_EMISSIVE = { none: 0, flame: 1, window: 2, glow: 3 } as const;

/** Flames and lanterns (kept under Portus' bloom threshold by day; the night boost lifts them). */
const FLAME = new THREE.Color(1.0, 0.36, 0.06).multiplyScalar(0.55);
/** Lit windows at night. */
const WINDOW = new THREE.Color(1.0, 0.72, 0.38).multiplyScalar(0.7);
/**
 * Glow slots (the outposts' teal and amber lamps, Hollowmere's windows): their own tint at this
 * luminance, day and night (brighter at night with the other glows): above every body's bloom
 * threshold (1.1–1.4 by day, render/looks.ts), so they bloom.
 */
export const TOWN_GLOW_LUMINANCE = 1.6;

const cache = new Map<string, THREE.MeshStandardNodeMaterial>();

/**
 * The shared town material for `kind`, with or without normal maps (Low drops them). `albedoFloor`
 * (linear) lifts the darkest base colours (Hollowmere's dusk: silhouettes still read). One instance
 * per (kind, normals, texture pair, floor) for the app's lifetime.
 */
export function townMaterial(kind: TownMaterialKind, normals: boolean, color: THREE.Texture, normal: THREE.Texture, albedoFloor = 0): THREE.MeshStandardNodeMaterial {
  const key = `${kind}:${normals ? 1 : 0}:${color.uuid}:${normal.uuid}:${albedoFloor}`;
  let m = cache.get(key);
  if (m) return m;
  const cutout = kind === "cutout";
  m = new THREE.MeshStandardNodeMaterial({ side: THREE.DoubleSide, roughness: 0.85, metalness: 0 });
  m.name = `town:${kind}${normals ? "" : ":flat"}${albedoFloor > 0 ? ":floor" : ""}`;
  const tm = attribute("townMat", "vec4");
  const tint = attribute("color", "vec4");
  const layer = tm.x.mul(255).round();
  const s = texture(color, uv()).depth(layer);
  // Cutout layers are premultiplied by the canvas decode (rgb = 0 where the mask is 0).
  const albedo = cutout ? s.rgb.div(max(s.a, float(1 / 255))) : s.rgb;
  const base = albedoFloor > 0 ? max(albedo.mul(tint.rgb), vec3(albedoFloor, albedoFloor, albedoFloor)) : albedo.mul(tint.rgb);
  m.colorNode = base.mul(mix(float(1), float(0.78), atmo.wet));
  if (cutout) {
    m.opacityNode = s.a;
    m.alphaTest = 0.5;
  }
  // Rain: darker and shinier, like the terrain and props.
  m.roughnessNode = mix(tm.y, tm.y.min(0.4), atmo.wet);
  m.metalnessNode = tm.z;
  if (normals) m.normalNode = normalMap(texture(normal, uv()).depth(layer), vec2(tint.a, tint.a));
  const mode = tm.w.mul(255).round();
  // Flames burn day and night (brighter at night); windows light up with the lamps: at night, and
  // in Portus' late-dusk evening, never by day or for rain clouds.
  const flame = vec3(FLAME.r, FLAME.g, FLAME.b).mul(atmo.glowBoost);
  const lit = vec3(WINDOW.r, WINDOW.g, WINDOW.b).mul(atmo.lamps);
  // Glow: the slot's tint (baked into the vertex colour) scaled to TOWN_GLOW_LUMINANCE.
  const lum = tint.r.mul(0.2126).add(tint.g.mul(0.7152)).add(tint.b.mul(0.0722)).max(0.02);
  const glow = tint.rgb.div(lum).mul(TOWN_GLOW_LUMINANCE).mul(atmo.glowBoost);
  m.emissiveNode = select(
    mode.equal(TOWN_EMISSIVE.flame), flame,
    select(mode.equal(TOWN_EMISSIVE.window), lit, select(mode.equal(TOWN_EMISSIVE.glow), glow, vec3(0, 0, 0))),
  );
  cache.set(key, m);
  return m;
}

/** Plain stone for the collider fallback (assets missing): the solids still block, so draw them. */
let stone: THREE.MeshStandardNodeMaterial | null = null;
export function townFallbackMaterial(): THREE.MeshStandardNodeMaterial {
  if (!stone) {
    stone = new THREE.MeshStandardNodeMaterial({ color: 0xb8ab98, roughness: 0.9, metalness: 0 });
    stone.name = "town:fallback";
  }
  return stone;
}
