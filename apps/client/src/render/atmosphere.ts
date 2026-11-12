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
  abs, acos, cameraPosition, clamp, cross, dot, exp, float, floor, Fn, fract, hash, If, length, max, min, mix, normalize, output, positionWorld,
  positionWorldDirection, pow, renderGroup, select, sin, smoothstep, sqrt, texture, time, uniform, vec2, vec3, vec4,
} from "three/tsl";
import { detailNoiseTexture } from "./noiseTexture.ts";
import type { BodyLook } from "./looks.ts";
import { LUT_H, LUT_SLICES, SKY_MID_E, skyLutTexture } from "./skyLut.ts";
import { SunLight } from "three/addons/lights/SunLight.js";
import { SunLightNode } from "three/addons/lights/SunLightNode.js";
import type { ResolvedSettings } from "./quality.ts";
import { skyDir, type V3 } from "./sunFrame.ts";
import type { WorldLook } from "./worldLooks.ts";

const col = (hex = 0xffffff) => uniform(new THREE.Color(hex));

/** Shared atmosphere uniforms (one set per renderer). */
/** Object layer drawn only into the sun's shadow map (layer 0 is everything the view camera draws). */
export const SHADOW_ONLY_LAYER = 5;

export const atmo = {
  up: uniform(new THREE.Vector3(0, 1, 0)).setGroup(renderGroup),
  sunDir: uniform(new THREE.Vector3(0, 1, 0)).setGroup(renderGroup),
  sunColor: col().setGroup(renderGroup),
  zenith: col().setGroup(renderGroup),
  mid: col().setGroup(renderGroup),
  horizon: col().setGroup(renderGroup),
  ground: col().setGroup(renderGroup),
  glow: col().setGroup(renderGroup),
  glowStrength: uniform(0.6).setGroup(renderGroup),
  mie: uniform(0.5).setGroup(renderGroup),
  sunDisc: uniform(20).setGroup(renderGroup),
  sunCosInner: uniform(0.9998).setGroup(renderGroup),
  sunCosOuter: uniform(0.9997).setGroup(renderGroup),
  planetR: uniform(500).setGroup(renderGroup),
  waterLevel: uniform(0).setGroup(renderGroup),
  fogDensity: uniform(0.003).setGroup(renderGroup),
  fogFalloff: uniform(0.05).setGroup(renderGroup),
  fogStart: uniform(50).setGroup(renderGroup),
  /** 1 = height fog (Medium+), 0 = plain radial fog (Low). */
  fogHeight: uniform(1).setGroup(renderGroup),
  haze: uniform(0.0008).setGroup(renderGroup),
  inscatter: uniform(0.6).setGroup(renderGroup),
  /** Weight of the single-scattering LUT vs the art gradient (0 on Low). */
  scatterMix: uniform(0.6).setGroup(renderGroup),
  // ---- day/night + weather (environment.ts drives these every frame; uniforms only) ----
  /** Fractional LUT slice for the current sun elevation (skyLut.ts sliceFor). */
  lutSlice: uniform(0).setGroup(renderGroup),
  /** Star field brightness (night × clear sky). */
  stars: uniform(0).setGroup(renderGroup),
  /** Lightning flash 0..1 (sky + ambient pulse). */
  flash: uniform(0).setGroup(renderGroup),
  flashColor: col(0xd8e4ff).setGroup(renderGroup),
  /** Fog colour tint (dust storms) and its amount. */
  fogTint: col(0xc8925a).setGroup(renderGroup),
  fogTintAmt: uniform(0).setGroup(renderGroup),
  /** Multiplier for emissive "glow" materials (pads, portals, lamps): brighter at night. */
  glowBoost: uniform(1).setGroup(renderGroup),
  /**
   * Lamplight 0..1 (lit windows): night, or late dusk (Portus' sun never sets: its evening is as
   * dark as it gets). Not raised by clouds, so windows stay unlit on a rainy day.
   */
  lamps: uniform(0).setGroup(renderGroup),
  /** Surface wetness 0..1 (darker, shinier terrain/props/grass after rain). */
  wet: uniform(0).setGroup(renderGroup),
  /** Rain hitting water now 0..1 (ripples). */
  rain: uniform(0).setGroup(renderGroup),
  // ---- the planets' graphics pass (D-gfx-worlds-1), per body from worldLooks.ts
  /** Aerial perspective: far terrain drifts toward this colour before it fades into the horizon. */
  aerial: col(0x6f9fe8).setGroup(renderGroup),
  aerialAmt: uniform(0).setGroup(renderGroup),
  /** Stars: the two ends of their colour range, how many (0..1) and how bright. */
  starWarm: col(0xffebd1).setGroup(renderGroup),
  starCool: col(0xbfd9ff).setGroup(renderGroup),
  starDensity: uniform(0.5).setGroup(renderGroup),
  starGain: uniform(1).setGroup(renderGroup),
  // ---- the second pass (D-gfx-worlds-6), driven per frame by environment.ts; 0 = the shader skips the term
  /** Sun shafts and the wide glow round a low sun (dawn, dusk), in the sky and the haze. */
  shafts: uniform(0).setGroup(renderGroup),
  /** The low mist layer over water and in valleys: amount, colour, and the height (m above the water) where it has thinned to a third. */
  mist: uniform(0).setGroup(renderGroup),
  mistColor: col(0xffffff).setGroup(renderGroup),
  mistTop: uniform(8).setGroup(renderGroup),
};

/** Single-scattering radiance from the per-body sky-view LUT atlas (see skyLut.ts): two slices by
 * sun elevation, blended. */
const lutSky = Fn(([dir]: [any]) => {
  const up = atmo.up;
  const e = dot(dir, up);
  const dT = dir.sub(up.mul(e));
  const sT = atmo.sunDir.sub(up.mul(dot(atmo.sunDir, up)));
  const cosPhi = dot(dT, sT).div(max(length(dT).mul(length(sT)), 0.00001));
  const u = acos(clamp(cosPhi, -1.0, 1.0)).div(Math.PI);
  // Row within a slice, kept off the slice edges so bilinear filtering can't bleed across slices.
  const vr = clamp(sqrt(max(e, 0.0)), 0.5 / LUT_H, 1 - 0.5 / LUT_H);
  const sl = clamp(atmo.lutSlice, 0, LUT_SLICES - 1);
  const s0 = floor(sl);
  const s1 = min(s0.add(1), LUT_SLICES - 1);
  const tex = skyLutTexture();
  const a = (texture(tex, vec2(u, s0.add(vr).div(LUT_SLICES))) as any).level(0).rgb;
  const b = (texture(tex, vec2(u, s1.add(vr).div(LUT_SLICES))) as any).level(0).rgb;
  return mix(a, b, sl.sub(s0));
});

/**
 * Stars (background only), above the horizon, scaled by atmo.stars: sparse bright ones that
 * twinkle, a second layer of faint ones, and a pale river of star dust across the sky (one noise
 * tap). Skipped whole by day.
 */
const starField = Fn(([dir]: [any]) => {
  const out: any = vec3(0).toVar();
  If(atmo.stars.greaterThan(0.002), () => {
    const layer = (scale: number, density: any, size: number, salt: number): any => {
      const p = dir.mul(scale);
      const cell: any = floor(p);
      const seed = cell.x.mul(7.0).add(cell.y.mul(157.0)).add(cell.z.mul(113.0)).add(salt);
      const h = hash(seed);
      const j = vec3(hash(seed.add(1.7)), hash(seed.add(3.1)), hash(seed.add(5.3))).mul(0.6).add(0.2);
      const d = length(fract(p).sub(j));
      const on = smoothstep(float(0.999).sub(density), 1.0, h);
      const twinkle = sin(time.mul(2.7).add(h.mul(97.0))).mul(0.3).add(0.7);
      const tint = mix(atmo.starWarm, atmo.starCool, hash(seed.add(9.1)));
      return tint.mul(on.mul(smoothstep(size, 0.0, d)).mul(twinkle));
    };
    // density 0.5 lights 0.45% of the cells (the look before per-body skies); 1 about three times as many.
    const bright = layer(150.0, atmo.starDensity.mul(0.007), 0.2, 0.0).mul(6.0);
    // The river: a band round the sky, tilted against the horizon: a soft glow, mottled by the
    // coarse noise, with the faint stars crowding into it.
    const axis = normalize(atmo.up.mul(0.42).add(vec3(0.61, 0.2, -0.76)));
    const band = exp(dot(dir, axis).mul(dot(dir, axis)).mul(-11.0));
    const faint = layer(310.0, atmo.starDensity.mul(band.mul(0.07).add(0.018)), 0.24, 31.0).mul(1.8);
    const n = (texture(detailNoiseTexture(), vec2(dot(dir, vec3(0.8, 0.1, 0.59)), dot(dir, vec3(-0.59, 0.2, 0.78))).mul(0.9)) as any).level(0);
    const dust = mix(atmo.starCool, atmo.starWarm, n.g).mul(band.mul(n.g.mul(0.9).add(0.35)).mul(0.03));
    const above = smoothstep(0.02, 0.2, dot(dir, atmo.up));
    out.assign(bright.add(faint).add(dust).mul(above.mul(atmo.stars).mul(atmo.starGain)));
  });
  return out;
});

/**
 * Low-sun light toward `dir` (additive): shafts fanning out of the sun and a wide warm glow along
 * the horizon under it. A term of the sky and of the haze colour, not a pass: the streaks are one
 * tap of the noise texture round a ring about the sun's axis (so they radiate from the sun and
 * close seamlessly), fading with the angle from it. Skipped whole when atmo.shafts is 0 (most of the day).
 */
export const sunShafts = Fn(([dir]: [any]) => {
  const out: any = vec3(0).toVar();
  If(atmo.shafts.greaterThan(0.002), () => {
    const fwd = max(dot(dir, atmo.sunDir), 0.0);
    const t0 = normalize(cross(atmo.sunDir, atmo.up).add(vec3(0.0001, 0.0002, 0.0003)));
    const t1 = cross(atmo.sunDir, t0);
    const q = vec2(dot(dir, t0), dot(dir, t1));
    const ring = q.div(max(length(q), 0.0001));
    const drift = time.mul(0.004);
    const n = (texture(detailNoiseTexture(), ring.mul(0.31).add(vec2(drift.add(0.5), 0.5))) as any).level(0);
    const streak = smoothstep(0.38, 0.78, n.g.mul(0.7).add(n.r.mul(0.3)));
    const e = dot(dir, atmo.up);
    const cone = pow(fwd, 8.0);
    // No shafts on the disc itself (the halo is there) or far below the horizon.
    const rays = streak.mul(cone).mul(float(1).sub(pow(fwd, 90.0))).mul(smoothstep(-0.25, 0.02, e)).mul(0.42);
    const glow = pow(fwd, 2.5).mul(exp(abs(e).mul(-5.0))).mul(0.3);
    out.assign(atmo.sunColor.mul(rays.add(glow).add(cone.mul(0.1)).mul(atmo.shafts)));
  });
  return out;
});

/** Sky radiance (linear) towards a unit direction. `disc` adds the HDR sun disc. */
export const skyColor = Fn(([dir, disc]: [any, any]) => {
  const e = dot(dir, atmo.up);
  // 3-stop art gradient: horizon → mid (SKY_MID_E) → zenith.
  const t1 = smoothstep(0.0, SKY_MID_E, e);
  const t2 = pow(clamp(e.sub(SKY_MID_E).div(1 - SKY_MID_E), 0.0, 1.0), 0.6);
  const c: any = mix(mix(atmo.horizon, atmo.mid, t1), atmo.zenith, t2).toVar();
  const cosT = dot(dir, atmo.sunDir);
  const sunSide = cosT.mul(0.5).add(0.5);
  // Anisotropy: the anti-sun half of the sky is a little darker.
  c.assign(c.mul(sunSide.mul(0.18).add(0.86)));
  // Sun-side horizon glow (single-scatter look).
  const band = exp(abs(e).mul(-6.0));
  c.addAssign(atmo.glow.mul(band.mul(pow(sunSide, 4.0)).mul(atmo.glowStrength)));
  // Physical single scattering (Medium+), blended with the art gradient.
  c.assign(mix(c, lutSky(dir), atmo.scatterMix));
  // Below the mathematical horizon: the curved planet drops away, so keep a hazy band.
  c.assign(mix(c, atmo.ground, smoothstep(0.0, -0.35, e)));
  // Forward-scatter halo.
  const fwd = max(cosT, 0.0);
  c.addAssign(atmo.sunColor.mul(pow(fwd, 10.0).mul(0.22).add(pow(fwd, 240.0).mul(1.4)).mul(atmo.mie)));
  // Sun disc (HDR → bloom).
  const d: any = smoothstep(atmo.sunCosOuter, atmo.sunCosInner, cosT).mul(atmo.sunDisc).mul(disc);
  c.addAssign(atmo.sunColor.mul(d));
  // Lightning: the whole sky lights up, most near the horizon cloud deck.
  c.addAssign(atmo.flashColor.mul(atmo.flash.mul(float(1.2).sub(max(e, 0.0).mul(0.6)))));
  return c;
});

/**
 * Background node: the sky in the view direction (plus stars at night). `wrap` lays something over
 * it (the cloud layer, clouds.ts): the clouds hide the stars and the sun disc behind them.
 */
export function skyBackgroundNode(wrap?: (dir: any, sky: any) => any): THREE.Node {
  const sky = skyColor(positionWorldDirection, float(1)).add(starField(positionWorldDirection)).add(sunShafts(normalize(positionWorldDirection)));
  return wrap ? wrap(normalize(positionWorldDirection), sky) : sky;
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
  const c = sky.add(atmo.sunColor.mul(pow(fwd, 8.0).mul(atmo.inscatter))).add(sunShafts(dir).mul(0.8));
  // Dust storms: the haze takes the dust colour (lit by the sky's brightness).
  const lum = dot(c, vec3(0.2126, 0.7152, 0.0722));
  return mix(c, atmo.fogTint.mul(lum.mul(1.6).add(0.02)), atmo.fogTintAmt);
});

/** Scene fog node (assigned to scene.fogNode). */
export function radialFogNode(): THREE.Node {
  return Fn(() => {
    const dir = normalize(positionWorld.sub(cameraPosition));
    const f = fogAmount();
    const haze: any = fogColor(dir);
    // Aerial perspective: at middle distances the haze is the planet's own air colour (blue hills on
    // Arcadia, violet on Hollowmere), lit like the sky; the farthest ground fades into the horizon.
    const lum = dot(haze, vec3(0.2126, 0.7152, 0.0722));
    const air = atmo.aerial.mul(lum.mul(1.35).add(0.02));
    const c = mix(haze, air, atmo.aerialAmt.mul(float(1).sub(smoothstep(0.45, 0.96, f))));
    const rgb: any = mix(output.rgb, c, f).toVar();
    // The mist layer: a second, low fog that lies on the water and pools in the ground near its
    // level, thinning to a third every `mistTop` metres up. Integrated along the view ray like the
    // height fog above; lit by the haze it lies in (so the low sun's glow and shafts colour it).
    If(atmo.mist.greaterThan(0.002), () => {
      const toP = positionWorld.sub(cameraPosition);
      const sea = atmo.planetR.add(atmo.waterLevel);
      const k = float(1.1).div(atmo.mistTop);
      const hC = max(length(cameraPosition).sub(sea), -2.0);
      const hP = max(length(positionWorld).sub(sea), -2.0);
      const eC = exp(k.mul(hC).negate());
      const eP = exp(k.mul(hP).negate());
      const dh = hP.sub(hC);
      const avg = select(abs(dh.mul(k)).greaterThan(0.001), eC.sub(eP).div(k.mul(dh)), eC);
      const fm = float(1).sub(exp(atmo.mist.mul(0.02).mul(length(toP)).mul(avg).negate())).min(0.92);
      const lum = dot(haze, vec3(0.2126, 0.7152, 0.0722));
      const mc = mix(haze, atmo.mistColor.mul(lum.mul(1.25).add(0.02)), 0.6);
      rgb.assign(mix(rgb, mc, fm));
    });
    return vec4(rgb, output.a);
  })();
}

const tmpColor = new THREE.Color();

/** Load a body's look into the shared uniforms. */
export function applyLook(look: BodyLook, radius: number, waterLevel: number, s: ResolvedSettings) {
  atmo.zenith.value.setHex(look.zenith);
  atmo.mid.value.setHex(look.mid);
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
  atmo.scatterMix.value = s.sky.scatterSteps[0] > 0 ? look.scatter.mix : 0;
}

/** Load a body's far haze and stars (worldLooks.ts) into the shared uniforms. */
export function applyWorldAir(w: WorldLook, s: ResolvedSettings) {
  atmo.aerial.value.setHex(w.aerial);
  atmo.aerialAmt.value = s.on.aerial ? w.aerialAmount : 0;
  atmo.starWarm.value.setHex(w.stars.warm);
  atmo.starCool.value.setHex(w.stars.cool);
  atmo.starDensity.value = w.stars.density;
  atmo.starGain.value = w.stars.gain;
}

/**
 * The sun and fill light in the player's local frame. The sky sun direction is smoothed over time;
 * the shadow-casting direction is quantised (updates only after ~0.4° of drift) and the shadow
 * camera snaps to texels, so shadows don't shimmer while the local frame rotates as you walk.
 * Shadows: one DirectionalLight map around the player (Medium; High/Ultra by default), or with the
 * opt-in `cascades` feature on High/Ultra, r186's SunLight (2 cascades fitted to the view frustum).
 */
export class SunRig {
  readonly sun: THREE.DirectionalLight;
  readonly hemi: THREE.HemisphereLight;
  readonly sunDir = new THREE.Vector3(0, 1, 0);
  /** Cascaded sun (High/Ultra, opt-in), replaces `sun` in the scene while active. */
  cascaded: SunLight | null = null;
  private readonly shadowDir = new THREE.Vector3(0, 1, 0);
  private readonly target = new THREE.Vector3();
  private initialised = false;
  private extent = 20;
  private mapSize = 1024;
  private readonly tmp: V3 = [0, 0, 0];
  // Scratch vectors (no per-frame allocation).
  private readonly want = new THREE.Vector3();
  private readonly bx = new THREE.Vector3();
  private readonly by = new THREE.Vector3();
  private readonly snapped = new THREE.Vector3();
  private readonly keyDir = new THREE.Vector3(0, 1, 0);
  private look: BodyLook;
  /**
   * Where the sun and the key light are (local sky frame, radians). The environment (day/night
   * clock) writes these every frame; defaults are the body's reference sun. At night the key light
   * is the moon (a bright sky planet), so the same DirectionalLight keeps the scene readable.
   */
  readonly sky = { sunElev: 0.6, sunAz: 0.9, keyIsMoon: false, moonElev: 0.5, moonAz: 2.0 };

  constructor(private readonly scene: THREE.Scene, look: BodyLook, private readonly renderer?: THREE.WebGPURenderer) {
    this.look = look;
    this.sky.sunElev = look.sunElev;
    this.sky.sunAz = look.sunAz;
    this.sun = new THREE.DirectionalLight(look.sun, look.sunIntensity);
    this.sun.name = "sun";
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.04;
    // The sun's shadow map also draws shadow-only objects (the Portus town's shadow cells), which
    // the view camera never sees. (three uses the shadow camera's own mask once it has a layer
    // besides 0.)
    this.sun.shadow.camera.layers.enable(SHADOW_ONLY_LAYER);
    this.hemi = new THREE.HemisphereLight(look.hemiSky, look.hemiGround, look.hemiIntensity);
    this.hemi.name = "skyFill";
    scene.add(this.sun, this.sun.target, this.hemi);
  }

  /**
   * Re-skin the same lights for another body. The rig lives as long as the renderer: light ids
   * are part of three's lighting cache key, so new lights per planet would rebuild every lit
   * material on each travel.
   */
  setLook(look: BodyLook) {
    this.look = look;
    this.sky.sunElev = look.sunElev;
    this.sky.sunAz = look.sunAz;
    this.sky.keyIsMoon = false;
    for (const l of [this.sun, this.cascaded]) {
      if (!l) continue;
      l.color.setHex(look.sun);
      l.intensity = look.sunIntensity;
    }
    this.hemi.color.setHex(look.hemiSky);
    this.hemi.groundColor.setHex(look.hemiGround);
    this.hemi.intensity = look.hemiIntensity;
    this.initialised = false;
  }

  applySettings(s: ResolvedSettings) {
    const cast = s.on.shadows && s.shadows.mode === "map";
    const useCascades = cast && s.on.cascades && s.shadows.cascadeSize > 0 && !!this.renderer;
    if (useCascades) {
      if (!this.cascaded) {
        registerSunLight(this.renderer!);
        this.cascaded = new SunLight(this.look.sun, this.look.sunIntensity);
        this.cascaded.name = "sunCascaded";
        this.cascaded.castShadow = true;
        this.cascaded.shadow.bias = -0.0004;
        this.cascaded.shadow.normalBias = 0.04;
      }
      const sh = this.cascaded.shadow;
      // three resizes the shadow map from mapSize on its next render; never free it here.
      if (sh.mapSize.x !== s.shadows.cascadeSize) sh.mapSize.set(s.shadows.cascadeSize, s.shadows.cascadeSize);
      sh.camera.far = s.shadows.far;
      this.cascaded.position.copy(this.shadowDir);
      this.scene.remove(this.sun);
      this.scene.add(this.cascaded);
      return;
    }
    if (this.cascaded) {
      this.scene.remove(this.cascaded);
      if (!this.sun.parent) this.scene.add(this.sun);
    }
    // Never switch casting back off once it was on: three then disposes the light's shadow pass
    // while materials built earlier still run it every frame, and every frame throws (a black
    // world; Chrome play-test). With the renderer's shadow map off, materials rebuild without
    // shadow lookups, and the map simply stops updating.
    if (cast) this.sun.castShadow = true;
    this.sun.shadow.autoUpdate = cast;
    if (!cast) return;
    if (this.mapSize !== s.shadows.mapSize || this.extent !== s.shadows.extent) {
      this.mapSize = s.shadows.mapSize;
      this.extent = s.shadows.extent;
      // three resizes the shadow map from mapSize on its next render; never free it here.
      this.sun.shadow.mapSize.set(this.mapSize, this.mapSize);
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

  /** Key light (sun or moon) colour and intensity; the cascaded sun follows when active. */
  setKey(color: THREE.Color, intensity: number) {
    this.sun.color.copy(color);
    this.sun.intensity = intensity;
    if (this.cascaded) {
      this.cascaded.color.copy(color);
      this.cascaded.intensity = intensity;
    }
  }

  /** Sky fill (hemisphere light). */
  setFill(sky: THREE.Color, ground: THREE.Color, intensity: number) {
    this.hemi.color.copy(sky);
    this.hemi.groundColor.copy(ground);
    this.hemi.intensity = intensity;
  }

  /** `focus` = the point the shadows centre on (player); `up` its local up. */
  update(focus: THREE.Vector3, dt: number) {
    const up = this.target.copy(focus).normalize();
    atmo.up.value.copy(up);
    this.hemi.position.copy(up);
    const t = skyDir(up.x, up.y, up.z, this.sky.sunElev, this.sky.sunAz, this.tmp);
    const want = this.want.set(t[0], t[1], t[2]);
    if (!this.initialised) {
      this.sunDir.copy(want);
    } else {
      this.sunDir.lerp(want, 1 - Math.exp(-3 * dt)).normalize();
    }
    atmo.sunDir.value.copy(this.sunDir);
    // Key light: the sun by day, the moon at night (switched while both are dim, at twilight).
    if (this.sky.keyIsMoon) {
      const m = skyDir(up.x, up.y, up.z, this.sky.moonElev, this.sky.moonAz, this.tmp);
      this.keyDir.set(m[0], m[1], m[2]);
    } else {
      this.keyDir.copy(this.sunDir);
    }
    if (!this.initialised) {
      this.shadowDir.copy(this.keyDir);
      this.initialised = true;
    } else if (this.shadowDir.dot(this.keyDir) < 0.999975) {
      this.shadowDir.copy(this.keyDir);
    }
    // SunLight shines from its position towards the origin: a pure direction.
    if (this.cascaded) this.cascaded.position.copy(this.shadowDir);

    // Shadow camera basis: z = shadowDir, y = a stable perpendicular; snap the focus to texels.
    const z = this.shadowDir;
    const y = this.by.set(Math.abs(z.x) < 0.9 ? 1 : 0, 0, Math.abs(z.x) < 0.9 ? 0 : 1).cross(z).negate().normalize();
    const x = this.bx.crossVectors(y, z).normalize();
    const texel = (2 * this.extent) / Math.max(1, this.mapSize);
    const fx = focus.dot(x), fy = focus.dot(y);
    const snapped = this.snapped.copy(focus)
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
    if (this.cascaded) {
      this.scene.remove(this.cascaded);
      this.cascaded.dispose();
    }
  }
}

const registered = new WeakSet<object>();
/** r186: SunLight must be registered with the renderer's node library once. */
function registerSunLight(renderer: THREE.WebGPURenderer) {
  if (registered.has(renderer)) return;
  registered.add(renderer);
  (renderer as unknown as { library: { addLight(node: unknown, light: unknown): void } }).library.addLight(SunLightNode, SunLight);
}

const rigs = new WeakMap<THREE.Scene, SunRig>();

/** The scene's one sun rig (created on first use, re-skinned per body). */
export function sunRigFor(scene: THREE.Scene, look: BodyLook, renderer?: THREE.WebGPURenderer): SunRig {
  let rig = rigs.get(scene);
  if (!rig) {
    rig = new SunRig(scene, look, renderer);
    rigs.set(scene, rig);
  } else {
    rig.setLook(look);
  }
  return rig;
}
