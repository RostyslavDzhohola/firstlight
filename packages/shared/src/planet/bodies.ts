// The bodies of FIRSTLIGHT: the safe hub Portus, three planets, and Lumen, Arcadia's moon (#6).
// Terrain numbers are tuning values; radius and pad layout come from DECISIONS.md.

export type BodyId = "portus" | "arcadia" | "hollowmere" | "meridian" | "lumen";
export const BODY_IDS: readonly BodyId[] = ["portus", "arcadia", "hollowmere", "meridian", "lumen"];
/** The three planets (each with an outpost, a shop, eggs and a boss); Lumen is a moon, not one of them. */
export const PLANET_IDS: readonly Exclude<BodyId, "portus" | "lumen">[] = ["arcadia", "hollowmere", "meridian"];

/**
 * Where a feature sits: midpoint of two pads, centre of three pads, a pad, or (`between`) a fraction `t` of the
 * way from pad a to pad b (indices into the pad list). Pairs/triples must not include opposite
 * pads (the centre would collapse onto a pad or vanish); `anchors.test.ts` checks every feature.
 */
export type FeatureAnchor = { mid: [number, number] } | { tri: [number, number, number] } | { pad: number } | { between: [number, number, number] };

export interface LakeFeature {
  name: string;
  at: FeatureAnchor;
  radius: number; // metres
  depth: number; // metres below water level at the centre
}

export interface PeakFeature {
  name: string;
  at: FeatureAnchor;
  height: number; // metres
  radius: number; // metres at the base
}

export interface TerrainParams {
  kind: "planet" | "hub";
  hillAmp: number;
  hillScale: number;
  mountainAmp: number;
  mountainScale: number;
  maskScale: number;
  maskThreshold: number;
  detailAmp: number;
  offset: number;
  /** Terrace step height in metres (0 = none). Meridian's mesas. */
  terrace: number;
  /** Hashed impact craters (bowl and rim) scattered over the body: Lumen's. Absent = none. */
  craters?: { count: number; minRadius: number; maxRadius: number; depth: number };
}

export interface BodyDef {
  id: BodyId;
  name: string;
  radius: number;
  seed: number;
  chunksPerFace: number;
  /** "icosa" = 12 pads, "dodeca" = 20 pads, "none" = hub (portals instead). */
  padLayout: "icosa" | "dodeca" | "none";
  /** Water surface height relative to the radius (metres). */
  waterLevel: number;
  terrain: TerrainParams;
  lakes: LakeFeature[];
  peaks: PeakFeature[];
  /** Level range of enemies (planets only). */
  levels: [number, number];
  /** Pull on players (m/s²); absent = BASE_GRAVITY. Lumen's low gravity makes long, floaty jumps. */
  gravity?: number;
}

/** The pull everywhere but Lumen (m/s²): the client controller's and the server's movement envelope. */
export const BASE_GRAVITY = 18;

/** A body's pull on players (m/s²). */
export function bodyGravity(body: BodyDef): number {
  return body.gravity ?? BASE_GRAVITY;
}

const planetDefaults: TerrainParams = {
  kind: "planet",
  hillAmp: 9,
  hillScale: 150,
  mountainAmp: 24,
  mountainScale: 95,
  maskScale: 380,
  maskThreshold: 0.12,
  detailAmp: 1.1,
  offset: 3,
  terrace: 0,
};

export const BODIES: Record<BodyId, BodyDef> = {
  portus: {
    id: "portus",
    name: "Portus",
    radius: 150,
    seed: 101,
    chunksPerFace: 4,
    padLayout: "none",
    waterLevel: -60,
    terrain: { ...planetDefaults, kind: "hub", hillAmp: 4, mountainAmp: 0, offset: 0 },
    lakes: [],
    peaks: [],
    levels: [0, 0],
  },
  arcadia: {
    id: "arcadia",
    name: "Arcadia",
    radius: 500,
    seed: 1001,
    chunksPerFace: 8,
    padLayout: "icosa",
    waterLevel: 0,
    terrain: { ...planetDefaults },
    lakes: [
      { name: "Glasswater Lake", at: { mid: [3, 7] }, radius: 75, depth: 16 },
      { name: "Clover Pond", at: { tri: [0, 1, 2] }, radius: 28, depth: 5 },
    ],
    peaks: [
      { name: "Kestrel Peak", at: { tri: [4, 5, 9] }, height: 95, radius: 120 },
      { name: "Highscore Hill", at: { mid: [1, 6] }, height: 45, radius: 80 },
    ],
    levels: [1, 7],
  },
  hollowmere: {
    id: "hollowmere",
    name: "Hollowmere",
    radius: 750,
    seed: 2002,
    chunksPerFace: 12,
    padLayout: "icosa",
    waterLevel: 0,
    terrain: { ...planetDefaults, hillAmp: 7, mountainAmp: 20, offset: 1.4, detailAmp: 0.9 },
    lakes: [
      { name: "Mourning Mere", at: { mid: [2, 8] }, radius: 95, depth: 12 },
      { name: "Whisper Fen", at: { tri: [0, 3, 4] }, radius: 50, depth: 3 },
    ],
    // 125 m from pad 10 toward pad 8: the pad sits at the tower's foot, the Hollow Nave just beyond.
    peaks: [{ name: "Tolling Tower", at: { between: [10, 8, 0.15] }, height: 80, radius: 110 }],
    levels: [6, 13],
  },
  meridian: {
    id: "meridian",
    name: "Meridian",
    radius: 1000,
    seed: 3003,
    chunksPerFace: 16,
    padLayout: "dodeca",
    waterLevel: 0,
    terrain: { ...planetDefaults, hillAmp: 12, mountainAmp: 34, mountainScale: 120, offset: 4, terrace: 6 },
    lakes: [{ name: "Brinewater Lake", at: { mid: [4, 11] }, radius: 120, depth: 10 }],
    peaks: [
      { name: "Chrome Spires", at: { between: [15, 9, 0.45] }, height: 110, radius: 140 }, // 330 m from pad 15; the Oversight Lobby sits at its foot
      { name: "Signal Ridge", at: { mid: [2, 0] }, height: 70, radius: 100 },
    ],
    levels: [12, 20],
  },
  // Arcadia's moon (#6): small, dry and cratered, a quarter of the pull (a jump rises ~5 m and
  // hangs for ~3 s). No seas: the water level sits far below the ground, so its basins stay dust.
  lumen: {
    id: "lumen",
    name: "Lumen",
    radius: 240,
    seed: 4004,
    chunksPerFace: 6,
    padLayout: "icosa",
    waterLevel: -60,
    terrain: {
      ...planetDefaults, hillAmp: 5, hillScale: 90, mountainAmp: 12, mountainScale: 70, maskScale: 200, detailAmp: 0.7, offset: 2,
      craters: { count: 34, minRadius: 7, maxRadius: 30, depth: 0.32 },
    },
    lakes: [{ name: "the Hush", at: { mid: [3, 7] }, radius: 50, depth: 9 }],
    peaks: [],
    levels: [6, 9],
    gravity: 4.5,
  },
};

/** Quads per face edge for a body. */
export function quadsPerFace(body: BodyDef): number {
  return body.chunksPerFace * 32;
}
