// Sky, fog and sun for a planet-centred scene (SPEC §7.2 rule 3, §7.3 sky/fog row).
//
// - skyColor(dir): analytic single-scatter-style sky in the player's local frame: horizon→zenith
//   gradient, below-horizon haze (small planets show a lot of it), a sun-side horizon glow, a Mie
//   halo and an HDR sun disc that blooms.
// - fogNode: radial exponential height fog integrated along the view ray using the height above the
//   planet radius (TSL's built-in height fog uses world Y, which is wrong on a sphere), plus a uniform
//   haze term for aerial perspective. Fog colour = the sky towards the view direction + sun inscatter.
//   Installed as `scene.fogNode`, so every node material with `fog: true` gets it for free.
// - Every input is a shared uniform: switching bodies or tiers never rebuilds these shaders.

import * as THREE from "three/webgpu";
import {
  abs, cameraPosition, clamp, dot, exp, float, Fn, length, max, mix, normalize, output, positionWorld,
  positionWorldDirection, pow, select, smoothstep, uniform, vec4,
} from "three/tsl";
import type { BodyLook } from "./looks.ts";
import type { ResolvedSettings } from "./quality.ts";
import { skyDir, type V3 } from "./sunFrame.ts";

const col = (hex = 0xffffff) => uniform(new THREE.Color(hex));

/** Shared atmosphere uniforms (one set per renderer). */
export const atmo = {
  up: uniform(new THREE.Vector3(0, 1, 0)),
  sunDir: uniform(new THREE.Vector3(0, 1, 0)),
  sunColor: col(),
  zenith: col(),
  horizon: col(),
  ground: col(),
  glow: col(),
  glowStrength: uniform(0.6),
  mie: uniform(0.5),
  sunDisc: uniform(20),
  sunCosInner: uniform(0.9998),
  sunCosOuter: uniform(0.9997),
  planetR: uniform(500),
  waterLevel: uniform(0),
  fogDensity: uniform(0.003),
  fogFalloff: uniform(0.05),
  fogStart: uniform(50),
  /** 1 = height fog (Medium+), 0 = plain radial fog (Low). */
  fogHeight: uniform(1),
  haze: uniform(0.0008),
  inscatter: uniform(0.6),
};

/** Sky radiance (linear) towards a unit direction. `disc` adds the HDR sun disc. */
export const skyColor = Fn(([dir, disc]: [any, any]) => {
  const e = dot(dir, atmo.up);
  const t = pow(max(e, 0.0), 0.42);
  const c: any = mix(atmo.horizon, atmo.zenith, t).toVar();
  // Below the mathematical horizon: the curved planet drops away, so keep a hazy band.
  c.assign(mix(c, atmo.ground, smoothstep(0.0, -0.35, e)));
  const cosT = dot(dir, atmo.sunDir);
  const sunSide = cosT.mul(0.5).add(0.5);
  // Anisotropy: the anti-sun half of the sky is a little darker.
  c.assign(c.mul(sunSide.mul(0.18).add(0.86)));
  // Sun-side horizon glow (single-scatter look).
  const band = exp(abs(e).mul(-6.0));
  c.addAssign(atmo.glow.mul(band.mul(pow(sunSide, 4.0)).mul(atmo.glowStrength)));
  // Forward-scatter halo.
  const fwd = max(cosT, 0.0);
  c.addAssign(atmo.sunColor.mul(pow(fwd, 10.0).mul(0.22).add(pow(fwd, 240.0).mul(1.4)).mul(atmo.mie)));
  // Sun disc (HDR → bloom).
  const d: any = smoothstep(atmo.sunCosOuter, atmo.sunCosInner, cosT).mul(atmo.sunDisc).mul(disc);
  c.addAssign(atmo.sunColor.mul(d));
  return c;
});

/** Background node: the sky in the view direction. */
export function skyBackgroundNode(): THREE.Node {
  return skyColor(positionWorldDirection, float(1));
}

/** Fog amount (0..1) for the current fragment. Exposed for custom materials (sky planets, particles). */
export const fogAmount = Fn(() => {
  const toP = positionWorld.sub(cameraPosition);
  const dist = length(toP);
  const d = max(dist.sub(atmo.fogStart), 0.0);
  const hC = length(cameraPosition).sub(atmo.planetR);
  const hP = length(positionWorld).sub(atmo.planetR);
  const b = max(atmo.fogFalloff, 0.0001);
  const eC = exp(b.mul(hC).negate().min(6.0));
  const eP = exp(b.mul(hP).negate().min(6.0));
  const dh = hP.sub(hC);
  // Mean of exp(-b·h) along the ray, with h interpolated linearly between the endpoints.
  const avg = select(abs(dh.mul(b)).greaterThan(0.001), eC.sub(eP).div(b.mul(dh)), eC);
  const od = atmo.fogDensity.mul(d).mul(mix(float(1), avg, atmo.fogHeight)).add(atmo.haze.mul(d));
  return float(1).sub(exp(od.negate())).min(0.97);
});

/** Fog colour towards the view direction: sky near the horizon + sun inscatter (aerial perspective). */
export const fogColor = Fn(([dir]: [any]) => {
  const e = dot(dir, atmo.up);
  const dirH = normalize(dir.sub(atmo.up.mul(e)).add(atmo.up.mul(clamp(e, -0.05, 0.3))));
  const sky = skyColor(dirH, float(0));
  const fwd = max(dot(dir, atmo.sunDir), 0.0);
  return sky.add(atmo.sunColor.mul(pow(fwd, 8.0).mul(atmo.inscatter)));
});

/** Scene fog node (assigned to scene.fogNode). */
export function radialFogNode(): THREE.Node {
  return Fn(() => {
    const dir = normalize(positionWorld.sub(cameraPosition));
    const f = fogAmount();
    return vec4(mix(output.rgb, fogColor(dir), f), output.a);
  })();
}

const tmpColor = new THREE.Color();

/** Load a body's look into the shared uniforms. */
export function applyLook(look: BodyLook, radius: number, waterLevel: number, s: ResolvedSettings) {
  atmo.zenith.value.setHex(look.zenith);
  atmo.horizon.value.setHex(look.horizon);
  atmo.ground.value.setHex(look.ground);
  atmo.glow.value.setHex(look.glow);
  atmo.glowStrength.value = look.glowStrength;
  atmo.mie.value = look.mie;
  atmo.sunColor.value.copy(tmpColor.setHex(look.sun));
  atmo.sunDisc.value = look.sunDisc;
  const r = THREE.MathUtils.degToRad(look.sunSizeDeg);
  atmo.sunCosInner.value = Math.cos(r * 0.8);
  atmo.sunCosOuter.value = Math.cos(r * 1.2);
  atmo.planetR.value = radius;
  atmo.waterLevel.value = waterLevel;
  atmo.fogDensity.value = look.fogDensity;
  atmo.fogFalloff.value = look.fogFalloff;
  atmo.fogStart.value = look.fogStart;
  atmo.haze.value = look.haze;
  atmo.inscatter.value = look.inscatter;
  atmo.fogHeight.value = s.fog.height ? 1 : 0;
}

/**
 * The sun and fill light in the player's local frame. The sky sun direction is smoothed over time;
 * the shadow-casting direction is quantised (updates only after ~0.4° of drift) and the shadow
 * camera snaps to texels, so shadows don't shimmer while the local frame rotates as you walk.
 */
export class SunRig {
  readonly sun: THREE.DirectionalLight;
  readonly hemi: THREE.HemisphereLight;
  readonly sunDir = new THREE.Vector3(0, 1, 0);
  private readonly shadowDir = new THREE.Vector3(0, 1, 0);
  private readonly target = new THREE.Vector3();
  private initialised = false;
  private extent = 20;
  private mapSize = 1024;
  private readonly tmp: V3 = [0, 0, 0];

  constructor(private readonly scene: THREE.Scene, private readonly look: BodyLook) {
    this.sun = new THREE.DirectionalLight(look.sun, look.sunIntensity);
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.04;
    this.hemi = new THREE.HemisphereLight(look.hemiSky, look.hemiGround, look.hemiIntensity);
    scene.add(this.sun, this.sun.target, this.hemi);
  }

  applySettings(s: ResolvedSettings) {
    const cast = s.on.shadows && s.shadows.mode === "map";
    this.sun.castShadow = cast;
    if (!cast) return;
    if (this.mapSize !== s.shadows.mapSize || this.extent !== s.shadows.extent) {
      this.mapSize = s.shadows.mapSize;
      this.extent = s.shadows.extent;
      this.sun.shadow.mapSize.set(this.mapSize, this.mapSize);
      this.sun.shadow.map?.dispose();
      (this.sun.shadow as { map: unknown }).map = null;
    }
    const sc = this.sun.shadow.camera as THREE.OrthographicCamera;
    sc.left = -this.extent;
    sc.right = this.extent;
    sc.top = this.extent;
    sc.bottom = -this.extent;
    sc.near = 1;
    sc.far = 400;
    sc.updateProjectionMatrix();
  }

  /** `focus` = the point the shadows centre on (player); `up` its local up. */
  update(focus: THREE.Vector3, dt: number) {
    const up = this.target.copy(focus).normalize();
    atmo.up.value.copy(up);
    this.hemi.position.copy(up);
    const t = skyDir(up.x, up.y, up.z, this.look.sunElev, this.look.sunAz, this.tmp);
    const want = new THREE.Vector3(t[0], t[1], t[2]);
    if (!this.initialised) {
      this.sunDir.copy(want);
      this.shadowDir.copy(want);
      this.initialised = true;
    } else {
      this.sunDir.lerp(want, 1 - Math.exp(-3 * dt)).normalize();
      if (this.shadowDir.dot(this.sunDir) < 0.999975) this.shadowDir.copy(this.sunDir);
    }
    atmo.sunDir.value.copy(this.sunDir);

    // Shadow camera basis: z = shadowDir, y = a stable perpendicular; snap the focus to texels.
    const z = this.shadowDir;
    const ref = Math.abs(z.x) < 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 0, 1);
    const y = new THREE.Vector3().crossVectors(z, ref).normalize();
    const x = new THREE.Vector3().crossVectors(y, z).normalize();
    const texel = (2 * this.extent) / Math.max(1, this.mapSize);
    const fx = focus.dot(x), fy = focus.dot(y);
    const snapped = focus.clone()
      .addScaledVector(x, Math.round(fx / texel) * texel - fx)
      .addScaledVector(y, Math.round(fy / texel) * texel - fy);
    this.sun.shadow.camera.up.copy(y);
    this.sun.target.position.copy(snapped);
    this.sun.position.copy(snapped).addScaledVector(z, 200);
    this.sun.target.updateMatrixWorld();
  }

  dispose() {
    this.scene.remove(this.sun, this.sun.target, this.hemi);
    this.sun.shadow.map?.dispose();
    this.sun.dispose();
    this.hemi.dispose();
  }
}

