// The cloud layer (D-gfx-worlds-1; from the `?meadow` study): clouds on a shell around the planet,
// ray-hit from the camera per sky pixel and sampled from the tileable detail-noise texture (no
// download, no ray march). Fixed to the planet, so they pass overhead as you walk, and drifting with
// time. Lit by the sun (bright tops, shaded cores, a silver lining toward the sun), fading into the
// horizon haze. Level 1 (Medium): one density tap, shaded from its own thickness (2 texture
// fetches a sky pixel). Level 2 (High, or the "clouds2" extra): two octaves and a second tap toward
// the sun (8). Each planet's cover, height, shape and colours are shared uniforms
// (applyCloudLook), the weather thickens the cover (environment.ts): no shader per body.

import * as THREE from "three/webgpu";
import { cameraPosition, clamp, dot, float, Fn, max, mix, normalize, pow, smoothstep, sqrt, time, uniform, vec3, vec4, renderGroup } from "three/tsl";
import { atmo } from "./atmosphere.ts";
import { detailNoiseTexture } from "./noiseTexture.ts";
import { biplanar } from "./terrainMaterial.ts";
import type { CloudLook } from "./worldLooks.ts";

const color = (hex = 0xffffff) => uniform(new THREE.Color(hex)).setGroup(renderGroup);

export const cloudUniforms = {
  /** Density threshold now (the look's cover, lowered by the weather's cloud amount). */
  cover: uniform(0.5).setGroup(renderGroup),
  height: uniform(320).setGroup(renderGroup),
  /** 1 / shape size (m). */
  invScale: uniform(1 / 900).setGroup(renderGroup),
  stretch: uniform(new THREE.Vector3(1, 1, 1)).setGroup(renderGroup),
  lit: color(),
  shade: color(0x8fa8d0),
  opacity: uniform(0.94).setGroup(renderGroup),
  speed: uniform(1.6).setGroup(renderGroup),
};

/** The body's clear-weather cover (environment.ts blends it toward overcast). */
let baseCover = 0.5;

export function applyCloudLook(look: CloudLook) {
  const u = cloudUniforms;
  baseCover = look.cover;
  u.cover.value = look.cover;
  u.height.value = look.height;
  u.invScale.value = 1 / look.scale;
  u.stretch.value.set(1 / look.stretch[0], 1 / look.stretch[1], 1 / look.stretch[2]);
  u.lit.value.setHex(look.lit);
  u.shade.value.setHex(look.shade);
  u.opacity.value = look.opacity;
  u.speed.value = look.speed;
}

/** Overcast threshold: a rain sky is nearly closed. */
const OVERCAST_COVER = 0.3;

/** The cover under `cloud` (0 clear … 1 the weather's full overcast) for the current body. */
export function cloudCover(cloud: number): number {
  return baseCover >= 1 && cloud <= 0 ? 1 : Math.min(baseCover, 1) + (OVERCAST_COVER - Math.min(baseCover, 1)) * Math.min(1, Math.max(0, cloud));
}

/** Per frame (environment.ts): the weather's cloud amount closes the sky. */
export function setCloudWeather(cloud: number) {
  cloudUniforms.cover.value = cloudCover(cloud);
}

/** Cloud density 0..1 at a planet-space point on the shell. */
function density(p: any, octaves: 1 | 2): any {
  const tex = detailNoiseTexture();
  const n = normalize(p);
  const u = cloudUniforms;
  const drift = vec3(time.mul(u.speed), time.mul(u.speed).mul(0.25), time.mul(u.speed).mul(-0.7));
  const q = p.add(drift).mul(u.stretch).mul(u.invScale);
  const a = biplanar(tex, q, n);
  // G: big blotches (the shapes), R: 4× finer fbm from the same fetch (the billows).
  if (octaves === 1) return a.g.mul(0.7).add(a.r.mul(0.3));
  const b = biplanar(tex, q.mul(3.4).add(vec3(0.37, 0.11, 0.73)), n);
  return a.g.mul(0.56).add(a.r.mul(0.2)).add(b.g.mul(0.24));
}

/**
 * Cloud colour (rgb) and coverage (a) towards a unit view direction, for the sky background.
 * `sky` = the clear-sky colour in that direction (clouds fade into it near the horizon).
 */
function cloudLayer(dir: any, sky: any, level: 1 | 2): any {
  return Fn(() => {
    const c = cameraPosition;
    const u = cloudUniforms;
    const rs = atmo.planetR.add(u.height);
    const b = dot(c, dir);
    const cc = dot(c, c).sub(rs.mul(rs));
    const t = b.negate().add(sqrt(max(b.mul(b).sub(cc), 0.0)));
    const p = c.add(dir.mul(t));
    const d = density(p, level);
    const cover = u.cover;
    const e = dot(dir, atmo.up);
    const horizon = smoothstep(-0.02, 0.16, e);
    const sunUp = smoothstep(-0.08, 0.2, dot(atmo.sunDir, atmo.up));
    // By night the edge is twice as soft and the deck thinner: faint moonlit shapes, no outline.
    const alpha = smoothstep(cover, cover.add(mix(float(0.34), float(0.16), sunUp)), d).mul(horizon).mul(u.opacity).mul(mix(float(0.7), float(1), sunUp));
    const thick = smoothstep(cover.add(0.1), cover.add(0.35), d);
    let core: any;
    if (level === 2) {
      // A second tap toward the sun: density rising toward the sun = this side is in the cloud's
      // own shadow (bright tops, darker bellies) without any ray marching.
      const up = normalize(p);
      const toSun = normalize(atmo.sunDir.sub(up.mul(dot(atmo.sunDir, up))).add(up.mul(0.15)));
      const dSun = density(p.add(toSun.mul(70.0)), 2);
      core = clamp(dSun.sub(d).mul(5.0).add(0.35), 0.0, 1.0).mul(0.75).add(thick.mul(0.25));
    } else {
      core = thick.mul(0.7).add(0.15);
    }
    const toward = pow(max(dot(dir, atmo.sunDir), 0.0), 6.0);
    // Kept under the bloom threshold: a bright cloud deck would veil the whole frame with bloom.
    // By night the deck is lit by the sky it hangs in (the night palette), a shade above it.
    const lit = mix(u.lit, (atmo.sunColor as any).mul(u.lit), 0.45).mul(sunUp.mul(0.82).add(0.02)).add(atmo.zenith.mul(0.35));
    const shade = mix(mix(atmo.zenith, atmo.horizon, 0.45), u.shade, sunUp.mul(0.6)).mul(mix(float(0.7), float(0.95), sunUp));
    const day = mix(lit, shade, core.mul(0.7)).add(atmo.sunColor.mul(toward.mul(float(1).sub(core)).mul(0.35).mul(sunUp)));
    // Night (D-polish-1): never darker than the sky behind it (the old deck's edges were, which drew
    // hard black outlines): the sky's own colour plus a faint moonlit lift that grows towards the core.
    const moonlit = sky.mul(1.04).add(vec3(0.012, 0.017, 0.03).mul(thick.mul(0.6).add(0.4)));
    const rgb = mix(max(day, moonlit), day, sunUp).add(atmo.flashColor.mul(atmo.flash.mul(0.8)));
    // Aerial perspective: far clouds near the horizon take the sky colour.
    const far = smoothstep(500.0, 1600.0, t).mul(0.65);
    return vec4(mix(rgb, sky, far), alpha);
  })();
}

/** Wrap a sky background colour node with the cloud layer. */
export function withClouds(dir: any, sky: any, level: 1 | 2): any {
  const cl = cloudLayer(dir, sky, level);
  return mix(sky, cl.rgb, cl.a);
}
