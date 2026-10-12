// The four bodies of FIRSTLIGHT: the safe hub Portus and three planets.
// Terrain numbers are tuning values; radius and pad layout come from DECISIONS.md.

export type BodyId = "portus" | "arcadia" | "hollowmere" | "meridian";
export const BODY_IDS: readonly BodyId[] = ["portus", "arcadia", "hollowmere", "meridian"];
export const PLANET_IDS: readonly Exclude<BodyId, "portus">[] = ["arcadia", "hollowmere", "meridian"];

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
};

/** Quads per face edge for a body. */
export function quadsPerFace(body: BodyDef): number {
  return body.chunksPerFace * 32;
}
