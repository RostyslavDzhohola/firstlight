// Lake water (SPEC §7.3 water row). Each terrain chunk that reaches below the water level gets a
// water patch from the worker: a spherical cap at the water radius with the depth below the surface
// baked per vertex (no depth texture, no per-pixel height function). The shader:
//   L0  colour by depth + fresnel to the sky colour
//   L1  + animated normal noise, sun glint, shoreline foam bands
//   L2+ + a second, finer ripple octave
// Reflections come from the analytic sky (so the sun disc becomes a glint that blooms).
// SSR on the nearest lake (Ultra) is not implemented yet.

import * as THREE from "three/webgpu";
import {
  attribute, cameraPosition, clamp, dot, exp, float, max, mix, mx_noise_float, mx_noise_vec3, normalize,
  positionWorld, pow, reflect, sin, smoothstep, time, uniform, vec3, renderGroup,
} from "three/tsl";
import { atmo, skyColor } from "./atmosphere.ts";
import type { BodyLook } from "./looks.ts";
import type { WaterMeshData } from "../world/terrain.worker.ts";

export const waterUniforms = {
  shallow: uniform(new THREE.Color(0x3fe0c8)).setGroup(renderGroup),
  deep: uniform(new THREE.Color(0x0d5a78)).setGroup(renderGroup),
  foam: uniform(new THREE.Color(0xeafffa)).setGroup(renderGroup),
};

export function applyWaterLook(look: BodyLook) {
  waterUniforms.shallow.value.setHex(look.waterShallow);
  waterUniforms.deep.value.setHex(look.waterDeep);
  waterUniforms.foam.value.setHex(look.foam);
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
  const depth = attribute("depth", "float");
  const wp = positionWorld;
  const up = normalize(wp);
  const V = normalize(cameraPosition.sub(wp));
  let N: any = up;
  if (level >= 1) {
    const t = time;
    const n1 = mx_noise_vec3(wp.mul(0.32).add(vec3(t.mul(0.21), t.mul(0.13), t.mul(-0.17))));
    let g: any = n1.sub(up.mul(dot(n1, up))).mul(0.09);
    if (level >= 2) {
      const n2 = mx_noise_vec3(wp.mul(1.15).add(vec3(t.mul(-0.36), t.mul(0.29), t.mul(0.31))));
      g = g.add(n2.sub(up.mul(dot(n2, up))).mul(0.045));
    }
    // Rain on the surface: a fast, fine chop that only shows while it rains.
    const nr = mx_noise_vec3(wp.mul(5.0).add(vec3(t.mul(1.7), t.mul(-2.3), t.mul(1.9))));
    g = g.add(nr.sub(up.mul(dot(nr, up))).mul(atmo.rain.mul(0.12)));
    N = normalize(up.add(g));
  }
  const ndv = max(dot(N, V), 0.0);
  const fres = float(0.02).add(pow(float(1).sub(ndv), 5.0).mul(0.98));
  const R = reflect(V.negate(), N);
  // Keep reflections above the horizon (a flat lake can't see below it).
  const Rl = normalize(R.add(up.mul(max(float(0.03).sub(dot(R, up)), 0.0))));
  const refl = skyColor(Rl, float(level >= 1 ? 1 : 0));
  const k = float(1).sub(exp(max(depth, 0.0).mul(-0.35)));
  const sunUp = max(dot(up, atmo.sunDir), 0.0);
  const clear = mix(waterUniforms.shallow, waterUniforms.deep, k);
  // Rain stirs and greys the water (puddle-ish tint).
  const stirred = mix(clear, vec3(dot(clear, vec3(0.3, 0.45, 0.25))).mul(vec3(0.9, 1.0, 1.05)), atmo.wet.mul(0.45));
  const body = stirred.mul(sunUp.mul(0.65).add(0.35));
  let col: any = mix(body, refl, fres);
  let alpha: any = clamp(mix(float(0.5), float(0.95), smoothstep(0.0, 3.0, depth)).add(fres.mul(0.5)), 0.0, 1.0);
  if (level >= 1) {
    const rs = max(dot(Rl, atmo.sunDir), 0.0);
    col = col.add(atmo.sunColor.mul(pow(rs, 160.0).mul(1.5).add(pow(rs, 1400.0).mul(14.0))));
    const band = smoothstep(0.75, 0.0, depth).mul(smoothstep(-0.25, 0.0, depth));
    const nz = mx_noise_float(wp.mul(1.7).add(vec3(0.0, time.mul(0.35), 0.0))).mul(0.5).add(0.5);
    const pulse = sin(depth.mul(9.0).sub(time.mul(1.6))).mul(0.5).add(0.5);
    const foam = smoothstep(0.55, 0.8, nz.mul(0.55).add(pulse.mul(0.5))).mul(band);
    col = mix(col, waterUniforms.foam.mul(sunUp.mul(0.6).add(0.5)), foam);
    alpha = max(alpha, foam);
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
