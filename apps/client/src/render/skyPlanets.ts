// Sky planets (SPEC §6.1 "other planets hang in each sky", §7.2 rule 3): the other bodies as
// distant spheres at fixed directions in the local sky frame, lit by the sun with a fresnel rim,
// seen through the sky (they fade into the horizon haze). High+ adds an atmosphere halo shell.
// One InstancedMesh for the planets and one for the halos: 2 draws total.

import * as THREE from "three/webgpu";
import {
  abs, attribute, cameraPosition, dot, exp, float, int, max, mix, mx_fractal_noise_float, normalGeometry,
  normalize, normalWorld, positionWorld, pow, smoothstep, sqrt, uniformArray, vec3,
} from "three/tsl";
import { BODY_IDS } from "@firstlight/shared";
import { atmo, skyColor } from "./atmosphere.ts";
import { SKY_PLANET_PALETTES, type SkyPlanetSpec } from "./looks.ts";
import type { ResolvedSettings } from "./quality.ts";
import { skyDir, type V3 } from "./sunFrame.ts";

const DIST = 4000;
const HALO_SCALE = 1.12;
const MAX = 4;

export class SkyPlanets {
  readonly planets: THREE.InstancedMesh;
  readonly halos: THREE.InstancedMesh;
  private specs: SkyPlanetSpec[];
  private readonly land: THREE.Color[];
  private readonly sea: THREE.Color[];
  private readonly air: THREE.Color[];
  private readonly seeds: number[];
  private readonly m = new THREE.Matrix4();
  private readonly fwd = new THREE.Vector3();
  private readonly s = new THREE.Vector3();
  private readonly p = new THREE.Vector3();
  private readonly tmp: V3 = [0, 0, 0];

  constructor(private readonly scene: THREE.Scene, specs: SkyPlanetSpec[]) {
    this.specs = [];
    const land = (this.land = Array.from({ length: MAX }, () => new THREE.Color()));
    const sea = (this.sea = Array.from({ length: MAX }, () => new THREE.Color()));
    const air = (this.air = Array.from({ length: MAX }, () => new THREE.Color()));
    const seeds = (this.seeds = Array.from({ length: MAX }, () => 0));
    const landU = uniformArray(land, "color") as any;
    const seaU = uniformArray(sea, "color") as any;
    const airU = uniformArray(air, "color") as any;
    const seedU = uniformArray(seeds, "float") as any;

    const geo = new THREE.SphereGeometry(1, 48, 32);
    const idx = new Float32Array(MAX);
    for (let i = 0; i < MAX; i++) idx[i] = i;
    geo.setAttribute("pIdx", new THREE.InstancedBufferAttribute(idx, 1));
    // Round: the per-instance index arrives interpolated in the fragment stage.
    const pi = int(attribute("pIdx", "float").add(0.5));

    // Planet surface.
    const mat = new THREE.MeshBasicNodeMaterial({ fog: false });
    {
      const nL = normalGeometry;
      const seed = seedU.element(pi);
      const n1 = mx_fractal_noise_float(nL.mul(2.3).add(seed), 4, 2.0, 0.5);
      const n2 = mx_fractal_noise_float(nL.mul(9.0).sub(seed), 2, 2.0, 0.5);
      const landMask = smoothstep(-0.02, 0.12, n1);
      // Readable at a few degrees across (D-polish-6): strong land/sea contrast, a brighter coast line
      // and soft cloud bands from the same two noise fields (no extra taps).
      const coast = smoothstep(0.1, 0.0, abs(n1.sub(0.05))).mul(0.18);
      const ground = mix(seaU.element(pi).mul(0.8), landU.element(pi).mul(1.2), landMask).mul(n2.mul(0.45).add(0.85)).add(coast);
      const cloudBand = smoothstep(0.12, 0.42, n2.add(n1.mul(0.35))).mul(0.42);
      const surface = mix(ground, vec3(0.92, 0.95, 1.0), cloudBand);
      const N = normalize(normalWorld);
      const V = normalize(cameraPosition.sub(positionWorld));
      const lit = max(dot(N, atmo.sunDir), 0.0);
      // A sharp terminator: day side in full colour, the night side the sky's own colour a shade
      // darker (a planet in a daylit sky, like a day moon), so the disc is a lit sphere, never a flat
      // dark disc.
      const day = smoothstep(-0.06, 0.16, dot(N, atmo.sunDir));
      const lighting = day.mul(0.85).add(lit.mul(0.45));
      const fres = pow(float(1).sub(max(dot(N, V), 0.0)), 3.0);
      // The lit limb and a thin atmosphere rim all the way round.
      const rim = airU.element(pi).mul(fres).mul(day.mul(1.3).add(0.3));
      const viewDir = V.negate();
      const sky = skyColor(viewDir, float(0));
      const planet = mix(sky.mul(0.62).add(surface.mul(0.04)), surface.mul(lighting), day).add(rim);
      // Through the atmosphere: only a planet at the horizon sinks into the haze; above ~12° it is crisp.
      const T = smoothstep(-0.03, 0.2, dot(viewDir, atmo.up)).mul(0.8).add(0.18);
      mat.colorNode = mix(sky, planet, T);
    }
    this.planets = new THREE.InstancedMesh(geo, mat, MAX);
    this.planets.frustumCulled = false;
    this.planets.renderOrder = -10;
    this.planets.name = "skyPlanets";

    // Atmosphere halo: back-face shell; brightness from how close the view ray passes to the limb.
    const haloMat = new THREE.MeshBasicNodeMaterial({ fog: false, side: THREE.BackSide, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    {
      const N = normalize(normalWorld);
      const V = normalize(cameraPosition.sub(positionWorld));
      const c = abs(dot(N, V));
      const q = sqrt(max(float(1).sub(c.mul(c)), 0.0)).mul(HALO_SCALE); // closest approach / planet radius
      const halo = exp(q.sub(1).max(0).mul(-16.0)).mul(smoothstep(HALO_SCALE, 1.0, q));
      const sunSide = dot(N, atmo.sunDir).mul(0.5).add(0.5);
      const viewDir = V.negate();
      const T = smoothstep(-0.03, 0.4, dot(viewDir, atmo.up)).mul(0.8).add(0.1);
      haloMat.colorNode = vec3(airU.element(pi)).mul(halo.mul(sunSide.mul(0.9).add(0.1)).mul(T).mul(0.9));
    }
    this.halos = new THREE.InstancedMesh(geo, haloMat, MAX);
    this.halos.frustumCulled = false;
    this.halos.renderOrder = -9;
    this.halos.name = "skyPlanetHalos";
    scene.add(this.planets, this.halos);
    this.setSpecs(specs);
  }

  /** Show another body's sky (same meshes and shaders; only uniform values change). */
  setSpecs(specs: SkyPlanetSpec[]) {
    this.specs = specs.slice(0, MAX);
    this.specs.forEach((sp, i) => {
      const pal = SKY_PLANET_PALETTES[sp.body];
      this.land[i]!.setHex(pal.land);
      this.sea[i]!.setHex(pal.sea);
      this.air[i]!.setHex(pal.atmosphere);
      // Seed by body, so a planet looks the same from every sky.
      this.seeds[i] = (BODY_IDS.indexOf(sp.body) + 1) * 7.31;
    });
    this.planets.count = this.specs.length;
    this.halos.count = this.specs.length;
  }

  applySettings(s: ResolvedSettings) {
    this.planets.visible = s.on.skyplanets;
    this.halos.visible = s.on.skyplanets && s.sky.planetAtmospheres;
  }

  /** this.m = a sphere of radius `r` at this.p, squashed by `k` (0 none) along the unit axis in this.s. */
  private squash(r: number, k: number) {
    const a = this.s, e = this.m.elements;
    e[0] = r * (1 - k * a.x * a.x); e[1] = -r * k * a.x * a.y; e[2] = -r * k * a.x * a.z; e[3] = 0;
    e[4] = e[1]!; e[5] = r * (1 - k * a.y * a.y); e[6] = -r * k * a.y * a.z; e[7] = 0;
    e[8] = e[2]!; e[9] = e[6]!; e[10] = r * (1 - k * a.z * a.z); e[11] = 0;
    e[12] = this.p.x; e[13] = this.p.y; e[14] = this.p.z; e[15] = 1;
  }

  update(camera: THREE.Camera) {
    if (!this.planets.visible) return;
    const up = atmo.up.value;
    const fwd = camera.getWorldDirection(this.fwd);
    for (let i = 0; i < this.specs.length; i++) {
      const sp = this.specs[i]!;
      const d = skyDir(up.x, up.y, up.z, THREE.MathUtils.degToRad(sp.elevDeg), THREE.MathUtils.degToRad(sp.azDeg), this.tmp);
      const r = DIST * Math.tan(THREE.MathUtils.degToRad(sp.sizeDeg));
      this.p.set(d[0], d[1], d[2]).multiplyScalar(DIST).add(camera.position);
      // Off the view axis a sphere projects as an ellipse, longer by 1/cos along the line from the
      // screen centre (the play-test's "egg-shaped blob"): squash it by cos along that axis, as a
      // symmetric matrix, so the planet's own frame (its surface features) never turns with the camera.
      const cos = d[0] * fwd.x + d[1] * fwd.y + d[2] * fwd.z;
      this.s.set(fwd.x - d[0] * cos, fwd.y - d[1] * cos, fwd.z - d[2] * cos);
      const len = this.s.length();
      const k = len > 1e-4 && cos > 0.15 ? 1 - cos : 0;
      if (len > 1e-4) this.s.multiplyScalar(1 / len);
      this.squash(r, k);
      this.planets.setMatrixAt(i, this.m);
      this.squash(r * HALO_SCALE, k);
      this.halos.setMatrixAt(i, this.m);
    }
    this.planets.instanceMatrix.needsUpdate = true;
    this.halos.instanceMatrix.needsUpdate = true;
  }

  dispose() {
    this.scene.remove(this.planets, this.halos);
    this.planets.geometry.dispose();
    (this.planets.material as THREE.Material).dispose();
    (this.halos.material as THREE.Material).dispose();
    this.planets.dispose();
    this.halos.dispose();
  }
}

const skies = new WeakMap<THREE.Scene, SkyPlanets>();

/** The scene's one sky-planet set (created on first use, re-skinned per body). */
export function skyPlanetsFor(scene: THREE.Scene, specs: SkyPlanetSpec[]): SkyPlanets {
  let sp = skies.get(scene);
  if (!sp) {
    sp = new SkyPlanets(scene, specs);
    skies.set(scene, sp);
  } else {
    sp.setSpecs(specs);
  }
  return sp;
}
