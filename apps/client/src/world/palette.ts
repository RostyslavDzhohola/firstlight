// Per-body terrain colours (linear RGB) chosen from height above water and flatness.
// Film rule 1: each planet is saturated around one key hue plus one accent.

import { chordMetres, type BodyId, type Dir } from "@firstlight/shared";
import { PAD_APRON_RADIUS } from "@firstlight/shared/planet/outpostGround";

type RGB = [number, number, number];

export interface TerrainPalette {
  grass: RGB;
  grass2: RGB;
  rock: RGB;
  rock2: RGB;
  sand: RGB;
  bed: RGB;
  snow: RGB;
  snowLine: number;
  /** Banded rock by height (Meridian canyons). */
  bands?: RGB[];
  bandHeight?: number;
  /** Body-wide grass density factor (0..1): Meridian is sparse dry scrub. */
  grassDensity: number;
}

const srgb = (hex: number): RGB => {
  const c = (v: number) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return [c((hex >> 16) & 255), c((hex >> 8) & 255), c(hex & 255)];
};

export const PALETTES: Record<BodyId, TerrainPalette> = {
  portus: {
    grass: srgb(0x6fb85a), grass2: srgb(0x9ccc6a), rock: srgb(0xc9b8a0), rock2: srgb(0xe8d9c0),
    sand: srgb(0xe6d2a8), bed: srgb(0x7a6b55), snow: srgb(0xf4f0ff), snowLine: 999, grassDensity: 0.7,
  },
  arcadia: {
    grass: srgb(0x3fae4a), grass2: srgb(0x8fd14f), rock: srgb(0x6f7d74), rock2: srgb(0x9aa39c),
    sand: srgb(0xf2d58a), bed: srgb(0x2e7f78), snow: srgb(0xf6fbff), snowLine: 70, grassDensity: 1,
  },
  hollowmere: {
    grass: srgb(0x4f5a3c), grass2: srgb(0x6e6a4a), rock: srgb(0x4a4258), rock2: srgb(0x6c6080),
    sand: srgb(0x6b5f55), bed: srgb(0x2b2633), snow: srgb(0xd8d2ea), snowLine: 65, grassDensity: 0.8,
  },
  meridian: {
    grass: srgb(0x9a6a3c), grass2: srgb(0xb8854a), rock: srgb(0xa8452c), rock2: srgb(0xc9663a),
    sand: srgb(0xf0e6d8), bed: srgb(0xd8d0c4), snow: srgb(0xf0e6d8), snowLine: 999,
    bands: [srgb(0xb24a2c), srgb(0xd27a44), srgb(0x8e3524), srgb(0xe09a5a), srgb(0xa5402a)],
    bandHeight: 6,
    grassDensity: 0.18,
  },
};

function mix(a: RGB, b: RGB, t: number): RGB {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

function smooth(e0: number, e1: number, x: number) {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/** Colour for one vertex. `n` is a cheap per-vertex noise in [-1,1] for variation. */
export function terrainColor(p: TerrainPalette, height: number, water: number, flatness: number, n: number, out: Float32Array, o: number) {
  const h = height - water;
  let rock = mix(p.rock, p.rock2, 0.5 + 0.5 * n);
  if (p.bands && p.bandHeight) {
    const bi = Math.floor((height + 50) / p.bandHeight);
    const band = p.bands[((bi % p.bands.length) + p.bands.length) % p.bands.length]!;
    rock = mix(band, rock, 0.25);
  }
  const grass = mix(p.grass, p.grass2, 0.5 + 0.5 * n);
  const rockiness = 1 - smooth(0.72, 0.9, flatness);
  let c = mix(grass, rock, rockiness);
  // Beach and lake bed.
  const sandT = 1 - smooth(0.6, 1.8, h);
  c = mix(c, p.sand, sandT * (1 - rockiness * 0.6));
  if (h < -0.4) c = mix(p.sand, p.bed, smooth(-0.4, -4, h));
  // Snow caps.
  if (h > p.snowLine - 15) c = mix(c, p.snow, smooth(p.snowLine - 15, p.snowLine, h) * smooth(0.6, 0.85, flatness));
  out[o] = c[0];
  out[o + 1] = c[1];
  out[o + 2] = c[2];
}

/** Grass density weight (0..1) for one vertex: flat, above the beach, below the snow. */
export function grassWeight(p: TerrainPalette, height: number, water: number, flatness: number, n: number): number {
  const h = height - water;
  if (h < 0.15) return 0;
  const rockiness = 1 - smooth(0.74, 0.9, flatness);
  const sand = 1 - smooth(0.6, 1.8, h);
  let w = (1 - rockiness) * (1 - sand);
  if (h > p.snowLine - 15) w *= 1 - smooth(p.snowLine - 15, p.snowLine - 5, h);
  return Math.max(0, Math.min(1, w * p.grassDensity * (0.75 + 0.25 * n)));
}

/** The landing platforms' paved aprons reach PAD_APRON_RADIUS (10.4 m, D42): no grass on them, back to full 2 m past the edge. */
export const PAD_GRASS_RADIUS = PAD_APRON_RADIUS + 0.2;
export function padGrassMask(pads: readonly Dir[], x: number, y: number, z: number, radius: number): number {
  let m = 1;
  for (const pad of pads) m *= Math.max(0, Math.min(1, (chordMetres(pad, x, y, z, radius) - PAD_GRASS_RADIUS) / 2));
  return m;
}
