// Lake water (SPEC §7.3 water row; reworked in the planets' graphics pass, D-gfx-worlds-1). Each
// terrain chunk that reaches below the water level gets a water patch from the worker: a spherical
// cap at the water radius with the depth below the surface baked per vertex (no depth texture, no
// per-pixel height function, no reflection pass). The shader:
//   L0  three colour stops by depth (shore → shallow → deep), clearer at the shore, fresnel to the
//       analytic sky (so the sky's colour and the sun's glow lie on the water)
//   L1  + ripples from two scrolling taps of the detail-noise texture (they replaced three 3-D
//       procedural noises), a sun glint that breaks into glitter, a soft foam line that laps at the
//       shore with a ragged edge, mist lying on far water (Hollowmere), rain chop
//   L2+ + a second, finer ripple octave
// Each planet's water is a set of shared uniforms (looks.ts colours, worldLooks.ts WaterLook):
// Arcadia clear turquoise, Hollowmere dark and misty, Meridian shallow and mineral.
// SSR on the nearest lake (Ultra) is not implemented.

import * as THREE from "three/webgpu";
import {
  abs, attribute, cameraPosition, clamp, cross, distance, dot, exp, float, floor, Fn, fract, hash, If, length, max, mix, normalize,
  positionWorld, pow, reflect, sin, smoothstep, time, uniform, vec3, renderGroup,
} from "three/tsl";
import { atmo, skyColor } from "./atmosphere.ts";
import type { BodyLook } from "./looks.ts";
import { detailNoiseTexture } from "./noiseTexture.ts";
import { biplanar } from "./terrainMaterial.ts";
import type { WaterLook } from "./worldLooks.ts";
import type { WaterMeshData } from "../world/terrain.worker.ts";
import { CHOP_GAIN, CHOP_MEAN, RIPPLE_MIX } from "./waterRipple.ts";

export const waterUniforms = {
  shallow: uniform(new THREE.Color(0x3fe0c8)).setGroup(renderGroup),
  deep: uniform(new THREE.Color(0x0d5a78)).setGroup(renderGroup),
  foam: uniform(new THREE.Color(0xeafffa)).setGroup(renderGroup),
  shore: uniform(new THREE.Color(0x8ff5e0)).setGroup(renderGroup),
  absorb: uniform(0.35).setGroup(renderGroup),
  mist: uniform(0).setGroup(renderGroup),
  mistColor: uniform(new THREE.Color(0xffffff)).setGroup(renderGroup),
  glitter: uniform(1).setGroup(renderGroup),
  foamAmt: uniform(1).setGroup(renderGroup),
};

export function applyWaterLook(look: BodyLook, w?: WaterLook) {
  waterUniforms.shallow.value.setHex(look.waterShallow);
  waterUniforms.deep.value.setHex(look.waterDeep);
  waterUniforms.foam.value.setHex(look.foam);
  if (!w) return;
  waterUniforms.shore.value.setHex(w.shore);
  waterUniforms.absorb.value = w.absorb;
  waterUniforms.mist.value = w.mist;
  waterUniforms.mistColor.value.setHex(w.mistColor);
  waterUniforms.glitter.value = w.glitter;
  waterUniforms.foamAmt.value = w.foam;
}

const cache = new Map<number, THREE.MeshBasicNodeMaterial>();

export function waterMaterialFor(level: number): THREE.MeshBasicNodeMaterial {
  const l = Math.max(0, Math.min(3, level));
  let m = cache.get(l);
  if (!m) {
    m = build(l);
    cache.set(l, m);
  }
  return m;
}

function build(level: number): THREE.MeshBasicNodeMaterial {
  const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false });
  m.name = `water-L${level}`;
  const u = waterUniforms;
  const depth = attribute("depth", "float");
  const wp = positionWorld;
  const up = normalize(wp);
  const V = normalize(cameraPosition.sub(wp));
  let N: any = up;
  let n1: any = null;
  let n2: any = null;
  if (level >= 1) {
    const tex = detailNoiseTexture();
    const t = time;
    // The ripples' slope: each tap's noise as a vector in world space, and the part of it that lies
    // in the surface (waterRipple.ts). No tangent frame: one built from a reference axis turned
    // where the axis switched, and the normal jumped on those two latitude circles.
    const mixRow = (c: any, row: readonly [number, number, number]) => dot(c, vec3(row[0], row[1], row[2]));
    const ripple = (s: any) => {
      const c = vec3(s.r, s.g, s.a).sub(0.5);
      return vec3(mixRow(c, RIPPLE_MIX[0]), mixRow(c, RIPPLE_MIX[1]), mixRow(c, RIPPLE_MIX[2]));
    };
    const tangent = (v: any) => v.sub(up.mul(dot(v, up)));
    n1 = biplanar(tex, wp.mul(0.085).add(vec3(t.mul(0.017), t.mul(0.011), t.mul(-0.014))), up);
    const v1: any = ripple(n1);
    let g: any = tangent(v1).mul(0.13);
    let vChop: any = v1;
    if (level >= 2) {
      n2 = biplanar(tex, wp.mul(0.31).add(vec3(t.mul(-0.05), t.mul(0.041), t.mul(0.045))), up);
      vChop = ripple(n2);
      g = g.add(tangent(vChop).mul(0.07));
    }
    // Rain on the surface: the finest tap again as a fast chop (no extra fetch), its ripple vector
    // turned a quarter round the normal and scaled by the ridged channel about its mean.
    const chop = n2 ?? n1;
    g = g.add(cross(up, vChop).mul(chop.b.sub(CHOP_MEAN).mul(CHOP_GAIN)).mul(atmo.rain.mul(0.5)));
    // Rain rings (D-gfx-worlds-6): where drops land, rings spread and fade. Two grids of cells a
    // metre or so across in world space, one drop a cell, put on the water under its spot in the
    // cell at a random moment; skipped whole when it is dry. A ring fades toward its cell's faces
    // (the surface cuts the cells at every angle), so nothing is clipped at a seam.
    const rings: any = Fn(() => {
      const acc: any = vec3(0).toVar();
      If(atmo.rain.greaterThan(0.02), () => {
        const surface = length(wp);
        for (const [scale, salt, rate] of [[0.85, 0, 0.95], [1.37, 41.7, 1.2]] as const) {
          const p = wp.mul(scale).add(salt);
          const cell: any = floor(p);
          // (kept positive: the hash reads its seed as an unsigned integer, and half the planet's cells are negative)
          const h = hash(cell.x.mul(127.1).add(cell.y.mul(311.7)).add(cell.z.mul(74.7)).add(salt + 1.0e6));
          const at = vec3(hash(h.mul(91.3).add(1.0)), hash(h.mul(47.9).add(2.0)), hash(h.mul(63.1).add(3.0))).sub(0.5).mul(0.5);
          // The drop's spot in the cell, back in world space and onto the water sphere.
          const drop = normalize(cell.add(0.5).add(at).sub(salt)).mul(surface);
          const d = tangent(wp.sub(drop)).mul(scale);
          const r = length(d);
          const life = fract(time.mul(rate).add(h.mul(7.0)));
          const front = life.mul(0.42);
          const f = abs(fract(p).sub(0.5));
          const inside = float(1).sub(smoothstep(0.36, 0.5, max(f.x, max(f.y, f.z))));
          const wave = sin(r.sub(front).mul(55.0)).mul(smoothstep(0.07, 0.0, abs(r.sub(front)))).mul(float(1).sub(life)).mul(smoothstep(0.0, 0.08, life)).mul(inside);
          acc.addAssign(d.div(max(r, 0.001)).mul(wave));
        }
        acc.mulAssign(atmo.rain);
      });
      return acc;
    })();
    g = g.add(rings.mul(0.42));
    N = normalize(up.add(g));
  }
  const ndv = max(dot(N, V), 0.0);
  const fres = float(0.02).add(pow(float(1).sub(ndv), 5.0).mul(0.98));
  const R = reflect(V.negate(), N);
  // Keep reflections above the horizon (a flat lake can't see below it).
  const Rl = normalize(R.add(up.mul(max(float(0.03).sub(dot(R, up)), 0.0))));
  const refl = skyColor(Rl, float(level >= 1 ? 1 : 0));
  const d = max(depth, 0.0);
  const k = float(1).sub(exp(d.mul(u.absorb).negate()));
  const sunUp = max(dot(up, atmo.sunDir), 0.0);
  // Shore → shallow → deep.
  const clear = mix(mix(u.shore, u.shallow, smoothstep(0.0, 0.3, k)), u.deep, smoothstep(0.2, 1.0, k));
  // Rain stirs and greys the water (puddle-ish tint).
  const stirred = mix(clear, vec3(dot(clear, vec3(0.3, 0.45, 0.25))).mul(vec3(0.9, 1.0, 1.05)), atmo.wet.mul(0.45));
  const body = stirred.mul(sunUp.mul(0.65).add(0.35));
  let col: any = mix(body, refl, fres);
  // Clear at the shore (the bed shows through), opaque within a couple of metres of depth.
  let alpha: any = clamp(mix(float(0.3), float(0.95), smoothstep(0.0, 0.75, k)).add(fres.mul(0.5)), 0.0, 1.0);
  if (level >= 1) {
    // Sun: a tight glint, and a wider lobe broken into glitter by the fine speckle channel.
    const rs = max(dot(Rl, atmo.sunDir), 0.0);
    let glint: any = pow(rs, 1400.0).mul(14.0).add(pow(rs, 160.0).mul(1.5));
    if (level >= 2) {
      // Glitter needs speckle far finer than the ripples: its own tap, sparks a hand across that wink.
      const sp = biplanar(detailNoiseTexture(), wp.mul(2.3).add(vec3(time.mul(0.11), time.mul(-0.07), time.mul(0.09))), up);
      const twinkle = smoothstep(0.62, 0.74, sp.a.mul(0.6).add(sp.r.mul(0.4)).add(sin(time.mul(3.1).add(n1.r.mul(40.0))).mul(0.05)));
      glint = glint.add(pow(rs, 22.0).mul(twinkle).mul(u.glitter).mul(2.6));
    }
    col = col.add(atmo.sunColor.mul(glint));
    // Foam: a soft line where the water thins out, lapping in and out, its edge torn by the noise.
    const band = smoothstep(0.42, 0.0, depth).mul(smoothstep(-0.25, 0.0, depth));
    const lap = sin(depth.mul(14.0).sub(time.mul(1.4)).add(n1.g.mul(5.0))).mul(0.5).add(0.5);
    const foam = smoothstep(0.5, 0.82, band.mul(0.7).add(n1.r.sub(0.5).mul(0.45).mul(band)).add(lap.mul(band).mul(0.4))).mul(u.foamAmt);
    col = mix(col, u.foam.mul(sunUp.mul(0.6).add(0.5)), foam.min(1.0));
    alpha = max(alpha, foam.min(1.0));
    // Mist lying on the water at a distance, lit by the sky at the horizon.
    const dist = distance(wp, cameraPosition);
    const mistAmt = u.mist.mul(smoothstep(12.0, 110.0, dist)).mul(float(1).sub(ndv).pow(1.5));
    const lum = dot(atmo.horizon as any, vec3(0.2126, 0.7152, 0.0722));
    col = mix(col, mix(atmo.horizon, u.mistColor.mul(lum.mul(1.2).add(0.03)), 0.55), mistAmt);
    alpha = max(alpha, mistAmt);
  }
  // Soft shoreline: fade out where the patch meets the terrain.
  alpha = alpha.mul(smoothstep(-0.05, 0.12, depth));
  m.colorNode = col;
  m.opacityNode = alpha;
  return m;
}

/** Build the THREE.Mesh for one chunk's water patch. */
export function createWaterMesh(data: WaterMeshData, material: THREE.Material): THREE.Mesh {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(data.positions, 3));
  geo.setAttribute("depth", new THREE.BufferAttribute(data.depth, 1));
  geo.setIndex(new THREE.BufferAttribute(data.indices, 1));
  geo.computeBoundingSphere();
  const mesh = new THREE.Mesh(geo, material);
  mesh.matrixAutoUpdate = false;
  mesh.renderOrder = 2;
  mesh.name = "water";
  (mesh as unknown as { static: boolean }).static = true;
  return mesh;
}
