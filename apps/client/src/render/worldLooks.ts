// Per-planet art direction for the wild (D-gfx-worlds-1): what grows in the grass, the clouds, the
// per-pixel ground layers, the water, the far haze, the stars. looks.ts keeps the sky, light, fog and
// grade; this file is everything the planets' graphics pass added, so each planet reads as its own
// place: Arcadia a bright flowering meadow, Hollowmere a violet fen of pale reeds and glowing fungi,
// Meridian dry cracked flats with seed-head scrub and mineral water. Colours are sRGB hex.

import type { BodyId } from "@firstlight/shared";

type Four = [number, number, number, number];

export interface MeadowLook {
  /** Share of clumps that flower at the heart of a drift, and the sprinkle outside drifts. */
  flowerShare: number;
  flowerBase: number;
  /** Head colour per species: 0–2 are discs (petals, caps), 3 is an upright spike (lavender, reed, seed head). */
  heads: Four;
  /** Centre colour of species 0 (a daisy's eye, a fungus cap's rim light). */
  eye: number;
  /** Self-light per species, shown as the sky darkens (0 = lit like a leaf). */
  glow: Four;
  /** Stem height per species, as a factor of the clump's grass (fungi sit low, reeds stand tall). */
  stem: Four;
  /** Head size per species (1 = a daisy, ~7 cm). */
  size: Four;
  /** Blade colour targets: where the body's grass root/tip is pulled to (lush) and the dry end. */
  lushRoot: number;
  lushTip: number;
  dryRoot: number;
  dryTip: number;
  /** How far the look's own grassRoot/grassTip are pulled toward the lush colours (0..1). */
  pull: number;
  /** Added to the region's dryness (regionNoise.ts): Meridian is dry everywhere. */
  dryBias: number;
  /** Clump height factor over the look's grassHeight. */
  height: number;
}

export interface CloudLook {
  /** Density threshold: lower = more cloud (≥ 1: none). */
  cover: number;
  /** Shell height above the ground (m) and the size of the cloud shapes (m). */
  height: number;
  scale: number;
  /** Planet-space stretch of the lookup (streaks: one axis much smaller than the others). */
  stretch: [number, number, number];
  /** Sunlit and shaded colours, and the layer's opacity. */
  lit: number;
  shade: number;
  opacity: number;
  /** Drift speed (m/s). */
  speed: number;
}

export interface GroundLook {
  /** Per-pixel layers of the terrain material: steep rock, the worn band under it, the beach, snow. */
  rock: number;
  dirt: number;
  sand: number;
  snow: number;
  /** Height above the water where snow settles on flat ground (999: never). */
  snowLine: number;
  /** Moss on rock that faces the sky (0 = none) and its colour. */
  moss: number;
  mossColor: number;
  /** Dry cracks on flat open ground (0 = none). */
  cracks: number;
}

export interface WaterLook {
  /** Very shallow water at the shore (the third colour stop; minerals on Meridian). */
  shore: number;
  /** How fast the water darkens with depth (per metre; higher = murkier, shallower-looking). */
  absorb: number;
  /** Mist lying on the surface at a distance (0..1) and its colour. */
  mist: number;
  mistColor: number;
  /** Sun glitter strength and foam line strength. */
  glitter: number;
  foam: number;
}

export interface WorldLook {
  meadow: MeadowLook;
  clouds: CloudLook;
  ground: GroundLook;
  water: WaterLook;
  /** Aerial perspective: far terrain drifts toward this colour (distant hills go blue or purple). */
  aerial: number;
  aerialAmount: number;
  /** Star tint (two ends of the colour range), density (0..1) and brightness. */
  stars: { warm: number; cool: number; density: number; gain: number };
}

export const WORLD_LOOKS: Record<BodyId, WorldLook> = {
  // The hub keeps its tidy lawns: a little clover, a few fair-weather clouds.
  portus: {
    meadow: {
      flowerShare: 0.35, flowerBase: 0.01, heads: [0xf6f2e6, 0xf2c21b, 0xe9a8c0, 0xb7a2e8], eye: 0xf0b020,
      glow: [0, 0, 0, 0], stem: [1.2, 1.15, 1.0, 1.3], size: [0.9, 0.7, 0.75, 1],
      lushRoot: 0x25421c, lushTip: 0x9fb955, dryRoot: 0x3c3a14, dryTip: 0xcdb46a, pull: 0.55, dryBias: -0.25, height: 1.15,
    },
    clouds: { cover: 0.58, height: 300, scale: 760, stretch: [1, 1, 1], lit: 0xfffaf0, shade: 0x9fb0d0, opacity: 0.85, speed: 1.2 },
    ground: { rock: 0xcbbba4, dirt: 0x8a6f52, sand: 0xe6d2a8, snow: 0xf4f0ff, snowLine: 999, moss: 0.25, mossColor: 0x6a8a3a, cracks: 0 },
    water: { shore: 0x9ff0e0, absorb: 0.35, mist: 0, mistColor: 0xffffff, glitter: 1, foam: 1 },
    aerial: 0x8fb4e8, aerialAmount: 0.3,
    stars: { warm: 0xffe8c8, cool: 0xc8dcff, density: 0.5, gain: 1 },
  },
  arcadia: {
    meadow: {
      flowerShare: 0.6, flowerBase: 0.025, heads: [0xf7f3e8, 0xf5c518, 0xe98fb4, 0x8a6ad6], eye: 0xf0b020,
      glow: [0, 0, 0, 0], stem: [1.3, 1.25, 1.1, 1.45], size: [1, 0.72, 0.68, 1],
      lushRoot: 0x1c3014, lushTip: 0x9fb04c, dryRoot: 0x34340f, dryTip: 0xcdb46a, pull: 0.72, dryBias: -0.18, height: 1.45,
    },
    clouds: { cover: 0.5, height: 320, scale: 900, stretch: [1, 1, 1], lit: 0xffffff, shade: 0x8fa8d0, opacity: 0.94, speed: 1.6 },
    ground: { rock: 0x7b8780, dirt: 0x6b5238, sand: 0xf2d58a, snow: 0xf6fbff, snowLine: 70, moss: 0.7, mossColor: 0x4f6a26, cracks: 0 },
    water: { shore: 0x8ff5e0, absorb: 0.3, mist: 0, mistColor: 0xffffff, glitter: 1.2, foam: 1 },
    aerial: 0x6f9fe8, aerialAmount: 0.55,
    stars: { warm: 0xfff0d0, cool: 0xbcd8ff, density: 0.55, gain: 1 },
  },
  // Pale reeds, ghost blooms and fungi that light themselves; a low violet overcast.
  hollowmere: {
    meadow: {
      flowerShare: 0.3, flowerBase: 0.012, heads: [0x4fffd0, 0xd8c8ff, 0xe86ad0, 0xd9d2c0], eye: 0xc8fff0,
      glow: [1.6, 0.18, 0.4, 0.05], stem: [0.42, 1.1, 0.6, 1.7], size: [1.15, 0.7, 0.65, 1.25],
      lushRoot: 0x1a2622, lushTip: 0x86a488, dryRoot: 0x322a30, dryTip: 0xc4bca6, pull: 0.7, dryBias: 0.1, height: 1.5,
    },
    clouds: { cover: 0.47, height: 260, scale: 1100, stretch: [1, 0.55, 1], lit: 0xf090d0, shade: 0x2c1c50, opacity: 0.72, speed: 0.8 },
    ground: { rock: 0x4a4258, dirt: 0x33283a, sand: 0x6b5f55, snow: 0xd8d2ea, snowLine: 65, moss: 0.55, mossColor: 0x2f5a50, cracks: 0.15 },
    water: { shore: 0x58c8b0, absorb: 0.7, mist: 0.75, mistColor: 0xb890e0, glitter: 0.7, foam: 0.7 },
    aerial: 0x8a5ad0, aerialAmount: 0.7,
    stars: { warm: 0xffc8f0, cool: 0xb8a8ff, density: 0.8, gain: 1.3 },
  },
  // Dry bunch grass with seed heads on cracked flats; thin high streaks of cloud; mineral shallows.
  meridian: {
    meadow: {
      flowerShare: 0.3, flowerBase: 0.04, heads: [0xe8d9a8, 0xd9a05a, 0xc8603a, 0xe6cf9a], eye: 0xb87838,
      glow: [0, 0, 0, 0], stem: [1.1, 1.0, 0.8, 1.55], size: [0.5, 0.45, 0.5, 1.1],
      lushRoot: 0x4a3a1c, lushTip: 0xa89a58, dryRoot: 0x5a3c20, dryTip: 0xe0c088, pull: 0.5, dryBias: 0.55, height: 1.35,
    },
    clouds: { cover: 0.6, height: 520, scale: 1500, stretch: [1, 0.22, 0.7], lit: 0xfff4e6, shade: 0xc9a48c, opacity: 0.6, speed: 2.4 },
    ground: { rock: 0xa8452c, dirt: 0x7a3d28, sand: 0xf0e6d8, snow: 0xf0e6d8, snowLine: 999, moss: 0, mossColor: 0x000000, cracks: 0.85 },
    water: { shore: 0xd8f0a0, absorb: 0.9, mist: 0.1, mistColor: 0xffd8b8, glitter: 1.5, foam: 0.6 },
    aerial: 0xd08a9a, aerialAmount: 0.5,
    stars: { warm: 0xffe0c0, cool: 0xc0e8ff, density: 0.65, gain: 1.1 },
  },
};
