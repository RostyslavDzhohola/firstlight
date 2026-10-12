// Per-body art direction (SPEC §6.1 grades, §7.2 look rules). Colours are sRGB hex (converted to
// linear when loaded into uniforms). Angles: radians unless the name says degrees.
// Film rule 1: each planet is saturated around one key hue plus one accent.

import type { BodyId } from "@firstlight/shared";
import type { GradeParams } from "./post.ts";

export interface SkyPlanetSpec {
  body: BodyId;
  /** Elevation and azimuth in the local sky frame, degrees. */
  elevDeg: number;
  azDeg: number;
  /** Angular radius, degrees. */
  sizeDeg: number;
}

export interface BodyLook {
  // Sky
  zenith: number;
  horizon: number;
  /** Haze below the mathematical horizon (small planets show a lot of it). */
  ground: number;
  /** Sun-side horizon glow (single-scatter look). */
  glow: number;
  glowStrength: number;
  /** Forward-scatter halo around the sun. */
  mie: number;
  sun: number;
  sunIntensity: number;
  /** HDR multiplier of the sun disc (blooms). */
  sunDisc: number;
  sunSizeDeg: number;
  sunElev: number;
  sunAz: number;
  // Fill light
  hemiSky: number;
  hemiGround: number;
  hemiIntensity: number;
  // Fog: density(h) = fogDensity * exp(-fogFalloff * (h - 0)) plus a uniform haze term.
  fogDensity: number;
  fogFalloff: number;
  fogStart: number;
  haze: number;
  inscatter: number;
  // Water
  waterShallow: number;
  waterDeep: number;
  foam: number;
  // Grass
  grassRoot: number;
  grassTip: number;
  grassHeight: number;
  // Post
  exposure: number;
  bloomThreshold: number;
  bloomStrength: number;
  grade: GradeParams;
  skyPlanets: SkyPlanetSpec[];
}

export interface SkyPlanetPalette {
  land: number;
  sea: number;
  atmosphere: number;
}

export const SKY_PLANET_PALETTES: Record<BodyId, SkyPlanetPalette> = {
  portus: { land: 0xe8cfa0, sea: 0xd9b48a, atmosphere: 0xffd8b0 },
  arcadia: { land: 0x4caf50, sea: 0x26c6da, atmosphere: 0x8fe8ff },
  hollowmere: { land: 0x5b4a7a, sea: 0x1f2a48, atmosphere: 0xc78dff },
  meridian: { land: 0xc0583a, sea: 0x3fa8b0, atmosphere: 0xffc7a0 },
};

export const LOOKS: Record<BodyId, BodyLook> = {
  portus: {
    zenith: 0x4a7fe0, horizon: 0xffdcc0, ground: 0xe9c3a6, glow: 0xffc28a, glowStrength: 0.55, mie: 0.5,
    sun: 0xfff1d6, sunIntensity: 3.2, sunDisc: 22, sunSizeDeg: 1.3, sunElev: 0.85, sunAz: 0.6,
    hemiSky: 0x9fb8ff, hemiGround: 0x6a5644, hemiIntensity: 1.4,
    fogDensity: 0.0025, fogFalloff: 0.04, fogStart: 40, haze: 0.0006, inscatter: 0.6,
    waterShallow: 0x5fd8d0, waterDeep: 0x1a6a88, foam: 0xf4fffc,
    grassRoot: 0x3f7a35, grassTip: 0x9ccc6a, grassHeight: 0.38,
    exposure: 1.0, bloomThreshold: 1.25, bloomStrength: 0.35,
    grade: { slope: [1.04, 1.0, 0.95], offset: [0, 0, 0], power: [1, 1, 1], saturation: 1.08, hue: 0 },
    skyPlanets: [
      { body: "arcadia", elevDeg: 28, azDeg: 35, sizeDeg: 7 },
      { body: "hollowmere", elevDeg: 16, azDeg: 150, sizeDeg: 5.5 },
      { body: "meridian", elevDeg: 40, azDeg: 250, sizeDeg: 8 },
    ],
  },
  arcadia: {
    zenith: 0x2f7ff0, horizon: 0xc4f4ec, ground: 0xa8d8cc, glow: 0xffd27a, glowStrength: 0.65, mie: 0.6,
    sun: 0xffe2a8, sunIntensity: 3.4, sunDisc: 24, sunSizeDeg: 1.2, sunElev: 0.55, sunAz: 0.9,
    hemiSky: 0x9fe8ff, hemiGround: 0x3f5a2a, hemiIntensity: 1.4,
    fogDensity: 0.003, fogFalloff: 0.05, fogStart: 50, haze: 0.0008, inscatter: 0.7,
    waterShallow: 0x3fe0c8, waterDeep: 0x0d5a78, foam: 0xeafffa,
    grassRoot: 0x2c7a34, grassTip: 0x9fdc58, grassHeight: 0.45,
    exposure: 1.0, bloomThreshold: 1.25, bloomStrength: 0.35,
    grade: { slope: [0.97, 1.03, 1.02], offset: [0, 0.004, 0.006], power: [1, 1, 1], saturation: 1.18, hue: 0 },
    skyPlanets: [
      { body: "portus", elevDeg: 22, azDeg: 300, sizeDeg: 3 },
      { body: "hollowmere", elevDeg: 35, azDeg: 120, sizeDeg: 6 },
      { body: "meridian", elevDeg: 12, azDeg: 210, sizeDeg: 9 },
    ],
  },
  hollowmere: {
    zenith: 0x1a1240, horizon: 0xc77dc8, ground: 0x7a5a90, glow: 0xff9ad0, glowStrength: 0.9, mie: 0.8,
    sun: 0xffb0d8, sunIntensity: 1.8, sunDisc: 16, sunSizeDeg: 1.6, sunElev: 0.12, sunAz: 2.2,
    hemiSky: 0x8a6ad0, hemiGround: 0x2a2030, hemiIntensity: 1.3,
    fogDensity: 0.009, fogFalloff: 0.09, fogStart: 25, haze: 0.0016, inscatter: 0.9,
    waterShallow: 0x2f8a80, waterDeep: 0x101a30, foam: 0x9effd8,
    grassRoot: 0x2a3324, grassTip: 0x6e7a4a, grassHeight: 0.5,
    exposure: 1.05, bloomThreshold: 1.1, bloomStrength: 0.4,
    grade: { slope: [1.0, 0.95, 1.08], offset: [0.006, 0, 0.016], power: [1.04, 1.02, 1.0], saturation: 1.06, hue: -0.02 },
    skyPlanets: [
      { body: "portus", elevDeg: 30, azDeg: 40, sizeDeg: 3 },
      { body: "arcadia", elevDeg: 20, azDeg: 300, sizeDeg: 10 },
      { body: "meridian", elevDeg: 45, azDeg: 180, sizeDeg: 7 },
    ],
  },
  meridian: {
    zenith: 0x2a62c8, horizon: 0xffd2b0, ground: 0xd8a88a, glow: 0xffe0c0, glowStrength: 0.4, mie: 0.45,
    sun: 0xffffff, sunIntensity: 4.0, sunDisc: 28, sunSizeDeg: 1.0, sunElev: 0.95, sunAz: 1.4,
    hemiSky: 0xa8c8ff, hemiGround: 0x6a2a18, hemiIntensity: 1.2,
    fogDensity: 0.0022, fogFalloff: 0.035, fogStart: 60, haze: 0.001, inscatter: 0.55,
    waterShallow: 0x4fd0c8, waterDeep: 0x135c6a, foam: 0xf0fffc,
    grassRoot: 0x7a5a30, grassTip: 0xc8a060, grassHeight: 0.3,
    exposure: 1.0, bloomThreshold: 1.4, bloomStrength: 0.3,
    grade: { slope: [1.06, 0.99, 0.95], offset: [0, 0.004, 0.012], power: [1, 1, 1], saturation: 1.12, hue: 0 },
    skyPlanets: [
      { body: "portus", elevDeg: 18, azDeg: 80, sizeDeg: 2.5 },
      { body: "arcadia", elevDeg: 30, azDeg: 200, sizeDeg: 8 },
      { body: "hollowmere", elevDeg: 50, azDeg: 320, sizeDeg: 6.5 },
    ],
  },
};
