// Regions inside a planet (#7 "the planets look the same everywhere"): smooth value noise over planet
// space, read by the terrain worker (ground colour per vertex) and the grass (dryness and flower
// drifts per clump), so the ground and what grows on it change together as you walk. Pure and
// deterministic: no three, no DOM (the worker imports it), the same answer on every client.

/** Integer-lattice hash → [0, 1). */
function hash3(x: number, y: number, z: number): number {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(z, 1440662683)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Smooth 3-D value noise in [0, 1). No closures or allocation: the grass calls it per clump. */
export function valueNoise(x: number, y: number, z: number): number {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  let u = x - xi, v = y - yi, w = z - zi;
  u = u * u * (3 - 2 * u);
  v = v * v * (3 - 2 * v);
  w = w * w * (3 - 2 * w);
  const c000 = hash3(xi, yi, zi), c100 = hash3(xi + 1, yi, zi), c010 = hash3(xi, yi + 1, zi), c110 = hash3(xi + 1, yi + 1, zi);
  const c001 = hash3(xi, yi, zi + 1), c101 = hash3(xi + 1, yi, zi + 1), c011 = hash3(xi, yi + 1, zi + 1), c111 = hash3(xi + 1, yi + 1, zi + 1);
  const a0 = c000 + (c100 - c000) * u, a1 = c010 + (c110 - c010) * u;
  const b0 = c001 + (c101 - c001) * u, b1 = c011 + (c111 - c011) * u;
  const a = a0 + (a1 - a0) * v, b = b0 + (b1 - b0) * v;
  return a + (b - a) * w;
}

export const smooth01 = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

export interface Region {
  /** 0 lush … 1 dry (straw meadow, bare heath, salt crust): a region ~150 m across. */
  dry: number;
  /** 0..1: a second region axis (deep clover or moss, darker and denser), ~90 m across. */
  deep: number;
  /** -1..1: patches a few metres to tens of metres across inside a region. */
  patch: number;
}

/**
 * The slow part of a region (the ~150 m and ~90 m fields): smooth enough to take at a grass cell's
 * corners and interpolate between them.
 */
export function regionLow(x: number, y: number, z: number, out: { dry: number; deep: number }): { dry: number; deep: number } {
  const a = valueNoise(x * 0.0065 + 11.3, y * 0.0065 + 4.7, z * 0.0065 + 8.1);
  const b = valueNoise(x * 0.021 + 3.1, y * 0.021 + 9.4, z * 0.021 + 1.7);
  out.dry = smooth01(0.4, 0.72, a * 0.72 + b * 0.28);
  out.deep = smooth01(0.5, 0.78, valueNoise(x * 0.011 + 27.9, y * 0.011 + 13.2, z * 0.011 + 5.5)) * (1 - out.dry);
  return out;
}

/** The fast part: patches a few metres to tens of metres across, -1..1. */
export function regionPatch(x: number, y: number, z: number): number {
  return (valueNoise(x * 0.06 + 1.9, y * 0.06 + 7.3, z * 0.06 + 2.2) * 0.65 + valueNoise(x * 0.19, y * 0.19, z * 0.19) * 0.35) * 2 - 1;
}

/**
 * The region at a planet-space point (metres). Walking 500 m in a straight line crosses several
 * dry/lush bands: the widest octave has a ~150 m wavelength, so the value swings fully about every
 * 75 m on average.
 */
export function regionAt(x: number, y: number, z: number, out: Region = { dry: 0, deep: 0, patch: 0 }): Region {
  regionLow(x, y, z, out);
  out.patch = regionPatch(x, y, z);
  return out;
}
