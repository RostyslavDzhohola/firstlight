// Terrain NodeMaterial (SPEC §7.3 terrain row). Vertex colours from the worker carry the biome; the
// shader adds procedural detail with biplanar sampling (Quilez: 2 fetches instead of 3) of a tiling
// noise texture, slope/height variation (rock strata on cliffs, wet shore band), baked AO, and on
// Low the baked sun visibility. High+ perturbs normals from the detail height (Mikkelsen bump).
// One material per (layers, normals) variant, cached and shared by every chunk of every body.

import * as THREE from "three/webgpu";
import {
  abs, attribute, cameraPosition, clamp, cross, dFdx, dFdy, distance, dot, float, length, mix, normalize,
  normalViewGeometry, normalWorldGeometry, positionView, positionWorld, sign, sin, smoothstep, step,
  texture, uniform, vec2, vec3, vertexColor, renderGroup,
} from "three/tsl";
import { atmo } from "./atmosphere.ts";
import { detailNoiseTexture } from "./noiseTexture.ts";
import type { ResolvedSettings } from "./quality.ts";

export const terrainUniforms = {
  /** How much of the baked concavity AO to apply (less when GTAO runs). */
  aoStrength: uniform(0.85).setGroup(renderGroup),
  /** 1 on Low: darken by the baked sun visibility (no shadow map there). */
  bakedSun: uniform(0).setGroup(renderGroup),
  detailStrength: uniform(1).setGroup(renderGroup),
};

/**
 * Biplanar texture sample (https://iquilezles.org/articles/biplanar/), branch-free: the major and
 * median axes are picked with 0/1 masks instead of select(), because TSL turns select() into
 * if/else and WGSL forbids derivatives (dpdx/dpdy) in non-uniform control flow.
 */
export function biplanar(tex: THREE.Texture, p: any, n: any): any {
  const an: any = abs(n);
  // Major axis masks (ties resolve x → y → z).
  const mX = step(an.y, an.x).mul(step(an.z, an.x));
  const mY = float(1).sub(mX).mul(step(an.z, an.y));
  const mZ = float(1).sub(mX).sub(mY);
  // Minor axis masks (ties resolve z → y → x), never the major axis.
  const nZ = float(1).sub(mZ).mul(step(an.z, an.x)).mul(step(an.z, an.y));
  const nY = float(1).sub(mY).mul(float(1).sub(nZ)).mul(step(an.y, an.x)).mul(step(an.y, an.z));
  const nX = float(1).sub(nY).sub(nZ);
  // Median = neither.
  const eX = float(1).sub(mX).sub(nX);
  const eY = float(1).sub(mY).sub(nY);
  const eZ = float(1).sub(mZ).sub(nZ);
  const dx: any = dFdx(p);
  const dy: any = dFdy(p);
  const pick2 = (wx: any, wy: any, wz: any, v: any) => v.yz.mul(wx).add(v.zx.mul(wy)).add(v.xy.mul(wz));
  const pick1 = (wx: any, wy: any, wz: any) => an.x.mul(wx).add(an.y.mul(wy)).add(an.z.mul(wz));
  const a = (texture(tex, pick2(mX, mY, mZ, p)) as any).grad(pick2(mX, mY, mZ, dx), pick2(mX, mY, mZ, dy));
  const b = (texture(tex, pick2(eX, eY, eZ, p)) as any).grad(pick2(eX, eY, eZ, dx), pick2(eX, eY, eZ, dy));
  const w = clamp(vec2(pick1(mX, mY, mZ), pick1(eX, eY, eZ)).sub(0.5773).div(1 - 0.5773), 0, 1);
  return a.mul(w.x).add(b.mul(w.y)).div(w.x.add(w.y).add(0.0001));
}

const cache = new Map<string, THREE.MeshStandardNodeMaterial>();

export function terrainMaterialFor(s: ResolvedSettings): THREE.MeshStandardNodeMaterial {
  const layers = s.on.detail ? s.terrain.detailLayers : 0;
  const normals = layers >= 4 && s.terrain.normals;
  const key = `${layers}:${normals}`;
  let m = cache.get(key);
  if (!m) {
    m = build(layers, normals);
    cache.set(key, m);
  }
  return m;
}

/** Shared uniform values for the current settings (no rebuild). */
export function applyTerrainSettings(s: ResolvedSettings) {
  terrainUniforms.bakedSun.value = s.terrain.bakedSun && !(s.on.shadows && s.shadows.mode === "map") ? 1 : 0;
  terrainUniforms.aoStrength.value = s.on.ao ? 0.45 : 0.85;
}

function build(layers: number, normals: boolean): THREE.MeshStandardNodeMaterial {
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.92, metalness: 0 });
  m.name = `terrain-L${layers}${normals ? "N" : ""}`;
  const base = vertexColor().rgb;
  const bake = attribute("bake", "vec2");
  const wp = positionWorld;
  const up = normalize(wp);
  const Ng = normalWorldGeometry;
  const flat = dot(Ng, up);
  const h = length(wp).sub(atmo.planetR).sub(atmo.waterLevel);
  const rock = float(1).sub(smoothstep(0.72, 0.9, flat));
  let col: any = base;
  let height: any = null;

  if (layers >= 2) {
    const tex = detailNoiseTexture();
    const dist = distance(wp, cameraPosition);
    const nearFade = float(1).sub(smoothstep(40.0, 110.0, dist)).mul(terrainUniforms.detailStrength);
    const fine = biplanar(tex, wp.div(1.3), Ng);
    const coarse = biplanar(tex, wp.div(9.0), Ng);
    const d1 = fine.r.sub(0.5).mul(nearFade);
    const d2 = coarse.g.sub(0.5);
    // Fine grain: stronger on rock.
    col = col.mul(float(1).add(d1.mul(mix(0.28, 0.42, rock))));
    // Coarse blotches; on grass they drift towards a sun-dried yellow.
    col = col.mul(float(1).add(d2.mul(0.32)));
    const dry = clamp(d2.mul(2.0), 0.0, 1.0).mul(float(1).sub(rock));
    col = mix(col, col.mul(vec3(1.1, 1.04, 0.82)), dry.mul(0.6));
    height = d1.mul(0.06);
    if (layers >= 4) {
      // Rock strata: bands that follow the height above the radius, warped by noise → horizontal
      // layers on cliffs whatever the local up is.
      const warp = biplanar(tex, wp.div(14.0), Ng).b;
      const strata = sin(h.mul(1.9).add(warp.mul(6.0))).mul(0.5);
      col = col.mul(float(1).add(strata.mul(0.4).mul(rock)));
      const large = biplanar(tex, wp.div(45.0), Ng).a.sub(0.5);
      col = col.mul(float(1).add(large.mul(0.22)));
      height = height.add(strata.mul(rock).mul(0.12).mul(nearFade));
    }
  }

  // Wet band at the shore and darker lake bed.
  const wet = float(1).sub(smoothstep(0.0, 0.9, h)).mul(float(1).sub(rock.mul(0.5)));
  col = col.mul(mix(float(1), float(0.62), wet));
  // Rain (weather): flat ground soaks darker than rock faces; puddle sheen via roughness below.
  const rainWet = atmo.wet.mul(float(1).sub(rock.mul(0.4)));
  col = col.mul(mix(float(1), float(0.72), rainWet));
  // Baked AO (always) and baked sun visibility (Low).
  col = col.mul(mix(float(1), bake.x, terrainUniforms.aoStrength));
  col = col.mul(mix(float(1), mix(float(0.55), float(1), bake.y), terrainUniforms.bakedSun));
  m.colorNode = col;
  m.roughnessNode = mix(mix(float(0.93), float(0.5), wet), float(0.32), rainWet.mul(0.85));

  if (normals && height) {
    // Mikkelsen surface-gradient bump from screen-space derivatives of the procedural height.
    const sx = dFdx(positionView);
    const sy = dFdy(positionView);
    const vN = normalViewGeometry;
    const r1 = cross(sy, vN);
    const r2 = cross(vN, sx);
    const det = dot(sx, r1);
    const dh = vec2(dFdx(height), dFdy(height));
    const grad = sign(det).mul(r1.mul(dh.x).add(r2.mul(dh.y)));
    m.normalNode = normalize(abs(det).mul(vN).sub(grad));
  }
  return m;
}
