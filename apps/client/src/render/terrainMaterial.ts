// Terrain NodeMaterial (SPEC §7.3 terrain row). Vertex colours from the worker carry the biome; the
// shader adds procedural detail with biplanar sampling (Quilez: 2 fetches instead of 3) of a tiling
// noise texture, slope/height variation (rock strata on cliffs, wet shore band), baked AO, and on
// Low the baked sun visibility. High+ perturbs normals from the detail height (Mikkelsen bump).
// One material per (layers, normals, layers-on) variant, cached and shared by every chunk of every body.
//
// Ground layers (`terrainfx`, D-gfx-worlds-1): the worker's vertex colours are a soft, 2–4 m wide
// blend, so slopes read as smooth gradients. On top of them the shader draws each layer per pixel
// from the slope and the height, with its edge broken up by the detail noise the material already
// samples (no extra texture fetch): steep faces turn to rock with dark cracks, a band of worn earth
// lies under them, the beach has a ragged edge, snow settles on flat high ground, moss grows on
// rock that faces the sky and dry flats crack. The colours and amounts are shared uniforms
// (applyGroundLook), so every body draws with the same shader.

import * as THREE from "three/webgpu";
import {
  abs, attribute, cameraPosition, clamp, cross, dFdx, dFdy, distance, dot, float, length, max, mix, normalize,
  normalViewGeometry, normalWorldGeometry, positionView, positionWorld, pow, sign, sin, smoothstep, step,
  texture, uniform, vec2, vec3, vertexColor, renderGroup,
} from "three/tsl";
import { atmo } from "./atmosphere.ts";
import { detailNoiseTexture } from "./noiseTexture.ts";
import type { ResolvedSettings } from "./quality.ts";
import type { GroundLook } from "./worldLooks.ts";

const groundColor = (hex: number) => uniform(new THREE.Color(hex)).setGroup(renderGroup);

/** The current body's per-pixel ground layers (worldLooks.ts GroundLook). */
export const groundUniforms = {
  rock: groundColor(0x7b8780),
  dirt: groundColor(0x6b5238),
  sand: groundColor(0xf2d58a),
  snow: groundColor(0xf6fbff),
  snowLine: uniform(999).setGroup(renderGroup),
  moss: uniform(0).setGroup(renderGroup),
  mossColor: groundColor(0x4f6a26),
  cracks: uniform(0).setGroup(renderGroup),
  /** Turf under the grass (D-gfx-worlds-6): the blade roots' colour and how far the ground takes it
   *  (0: bare, as on Meridian and in the hub), out to `underReach` metres (the grass radius; 0: no grass). */
  under: groundColor(0x16361a),
  underAmt: uniform(0).setGroup(renderGroup),
  underReach: uniform(0).setGroup(renderGroup),
  /** Lichen or dust on the scattered rocks (vegetationAssets.ts): colour and amount. */
  lichen: groundColor(0xb8c070),
  lichenAmt: uniform(0).setGroup(renderGroup),
};

export function applyGroundLook(g: GroundLook) {
  const u = groundUniforms;
  u.rock.value.setHex(g.rock);
  u.dirt.value.setHex(g.dirt);
  u.sand.value.setHex(g.sand);
  u.snow.value.setHex(g.snow);
  u.snowLine.value = g.snowLine;
  u.moss.value = g.moss;
  u.mossColor.value.setHex(g.mossColor);
  u.cracks.value = g.cracks;
  u.lichen.value.setHex(g.lichen);
  u.lichenAmt.value = g.lichenAmt;
}

export const terrainUniforms = {
  /** How much of the baked concavity AO to apply (less when GTAO runs). */
  aoStrength: uniform(0.85).setGroup(renderGroup),
  /** 1 on Low: darken by the baked sun visibility (no shadow map there). */
  bakedSun: uniform(0).setGroup(renderGroup),
  /**
   * How much the baked sun visibility applies now (0..1, written per frame by the environment):
   * it was baked for the look's reference sun, so it fades out as the live sun moves away from
   * that direction, sets or hides behind cloud.
   */
  sunMatch: uniform(1).setGroup(renderGroup),
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
  const fx = layers >= 2 && s.on.terrainfx;
  const key = `${layers}:${normals}:${fx}`;
  let m = cache.get(key);
  if (!m) {
    m = build(layers, normals, fx);
    cache.set(key, m);
  }
  return m;
}

/** Shared uniform values for the current settings (no rebuild). */
export function applyTerrainSettings(s: ResolvedSettings) {
  terrainUniforms.bakedSun.value = s.terrain.bakedSun && !(s.on.shadows && s.shadows.mode === "map") ? 1 : 0;
  terrainUniforms.aoStrength.value = s.on.ao ? 0.45 : 0.85;
}

function build(layers: number, normals: boolean, fx: boolean): THREE.MeshStandardNodeMaterial {
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.92, metalness: 0 });
  m.name = `terrain-L${layers}${normals ? "N" : ""}${fx ? "" : "-plain"}`;
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
  let snowPx: any = null;
  let beach: any = null;
  let puddle: any = null;

  if (layers >= 2) {
    const tex = detailNoiseTexture();
    const dist = distance(wp, cameraPosition);
    const nearFade = float(1).sub(smoothstep(40.0, 110.0, dist)).mul(terrainUniforms.detailStrength);
    const fine = biplanar(tex, wp.div(1.3), Ng);
    const coarse = biplanar(tex, wp.div(9.0), Ng);
    const d1 = fine.r.sub(0.5).mul(nearFade);
    const d2 = coarse.g.sub(0.5);
    if (fx) {
      const g = groundUniforms;
      // The slope as each pixel sees it: the coarse noise moves the thresholds, so layers meet in a
      // ragged line instead of a contour. `d2` is about ±0.35.
      const slope = flat.add(d2.mul(0.16));
      const rockPx = float(1).sub(smoothstep(0.7, 0.84, slope));
      // Worn earth: the band between the turf and the rock face, and thin patches where the turf breaks.
      // Patchy (the fine noise gates it), so it never draws a line along the mesh's facets.
      const dirtPx = smoothstep(0.96, 0.8, slope.add(d2.mul(0.2))).mul(float(1).sub(rockPx)).mul(smoothstep(0.42, 0.62, coarse.r)).mul(0.7)
        .mul(float(1).sub(smoothstep(-30.0, -12.0, h.sub(g.snowLine)))); // no earth rim round the snow fields
      col = mix(col, g.dirt.mul(float(1).add(d2.mul(0.5))), dirtPx);
      // Rock faces: the layer colour over the vertex blend, strata and cracks follow below.
      const rockCol = mix(g.rock, col, 0.5);
      col = mix(col, rockCol, rockPx);
      // Cracks: the ridged channel's valleys, thin dark lines on rock (close up) and across dry flats.
      // (the ridged channel peaks along thin lines; its top few percent are the cracks)
      const crackFine = smoothstep(0.9, 0.98, fine.b).mul(nearFade);
      const crackWide = smoothstep(0.92, 0.985, coarse.b);
      const open = float(1).sub(rockPx).mul(smoothstep(0.9, 0.98, flat)).mul(smoothstep(0.9, 2.2, h));
      col = col.mul(float(1).sub(crackFine.mul(rockPx).mul(0.26)));
      col = col.mul(float(1).sub(crackWide.mul(0.7).add(crackFine.mul(0.6)).min(1.0).mul(open).mul(g.cracks).mul(0.42)));
      col = col.mul(float(1).add(coarse.r.sub(0.5).mul(open).mul(g.cracks).mul(0.5)));
      // Moss where rock faces the sky.
      const mossPx = smoothstep(0.5, 0.78, slope.add(d2.mul(0.25))).mul(rockPx).mul(g.moss);
      col = mix(col, g.mossColor.mul(float(1).add(d2.mul(0.6))), mossPx.mul(0.85));
      // Under the grass the turf takes the blade roots' colour, near the camera where you look down
      // into the clumps: the gaps between blades read as their shade. Only where the ground is
      // green (the worker's worn earth and dry heath stay themselves), fading out before the grass thins.
      const green = smoothstep(0.0, 0.03, base.g.sub(base.r));
      const underK = green.mul(float(1).sub(rockPx)).mul(float(1).sub(dirtPx)).mul(g.underAmt)
        .mul(float(1).sub(smoothstep(g.underReach.mul(0.3), g.underReach.mul(0.8).add(0.01), dist)));
      col = mix(col, g.under.mul(float(1).add(d1.mul(0.5)).add(d2.mul(0.35))), underK);
      // The beach: warm bright sand up to a ragged line a metre or two above the water, then a wide
      // soft band where it thins into the turf (the grass thins and shortens over the same band, grass.ts).
      const sandH = h.add(d2.mul(2.0));
      const sandPx = float(1).sub(smoothstep(0.7, 2.6, sandH)).mul(float(1).sub(rockPx.mul(0.7))).mul(step(-0.6, h));
      const sandCol = g.sand.mul(float(1).add(d1.mul(0.22)).add(coarse.r.sub(0.5).mul(0.12)));
      col = mix(col, sandCol, smoothstep(0.0, 0.75, sandPx).mul(0.96));
      beach = sandPx;
      // Snow on flat high ground, drifting lower in the noise's hollows.
      const snowH = h.add(d2.mul(14.0)).sub(g.snowLine);
      snowPx = smoothstep(-9.0, -3.0, snowH).mul(smoothstep(0.55, 0.8, slope));
      col = mix(col, g.snow.mul(float(1).add(d1.mul(0.12))), snowPx);
    }
    // Fine grain: stronger on rock.
    col = col.mul(float(1).add(d1.mul(mix(0.28, 0.42, rock))));
    // Coarse blotches; on grass they drift towards a sun-dried yellow.
    const offBeach = beach ? float(1).sub(beach.mul(0.8)) : float(1);
    col = col.mul(float(1).add(d2.mul(0.32).mul(offBeach)));
    const dry = clamp(d2.mul(2.0), 0.0, 1.0).mul(float(1).sub(rock)).mul(offBeach);
    // Rain pools in the coarse noise's hollows on flat ground: where the sheen lies (below).
    if (fx) puddle = smoothstep(0.02, -0.12, d2).mul(smoothstep(0.86, 0.97, flat));
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
  // Wet sand right at the water is a shade deeper; the bed below the surface darkens as before.
  const wetBeach = beach ? mix(wet, float(1).sub(smoothstep(-0.25, 0.3, h)), 0.75) : wet;
  col = col.mul(mix(float(1), float(0.62), wetBeach));
  // Rain (weather): flat ground soaks darker than rock faces; puddle sheen via roughness below.
  const rainWet = atmo.wet.mul(float(1).sub(rock.mul(0.4)));
  col = col.mul(mix(float(1), float(0.72), rainWet));
  // Baked AO (always) and baked sun visibility (Low).
  col = col.mul(mix(float(1), bake.x, terrainUniforms.aoStrength));
  col = col.mul(mix(float(1), mix(float(0.55), float(1), bake.y), terrainUniforms.bakedSun.mul(terrainUniforms.sunMatch)));
  m.colorNode = col;
  if (puddle) {
    // Wet sheen: while it rains, flat ground mirrors the sky at grazing angles, most in the puddles.
    const V = normalize(cameraPosition.sub(wp));
    const graze = pow(float(1).sub(max(dot(V, up), 0.0)), 4.0);
    const sheen = rainWet.mul(graze).mul(puddle.mul(0.75).add(0.25)).mul(smoothstep(0.8, 0.95, flat));
    m.emissiveNode = (atmo.horizon as any).mul(sheen.mul(0.5));
  }
  const rough = mix(mix(float(0.93), float(0.5), wet), float(0.32), rainWet.mul(0.85));
  m.roughnessNode = snowPx ? mix(rough, float(0.55), snowPx) : rough;

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
