// The player's local sky frame (up, east, north) and the body's sun/sky-planet directions in it.
// Pure math, no three.js import: the terrain worker uses it to bake sun visibility.
//
// east = normalize(SKY_POLE × up). It's smooth everywhere except at ±SKY_POLE, which sit on
// icosahedron edge midpoints (≥ 20° from every pad on every body and 36° from the Portus plaza).
// Callers smooth the sun direction over time, so crossing a pole only makes the sky drift.

export type V3 = [number, number, number];

const PHI = (1 + Math.sqrt(5)) / 2;
const pl = Math.hypot(0.5, PHI / 2 + 0.5, PHI / 2);
export const SKY_POLE: V3 = [0.5 / pl, (PHI / 2 + 0.5) / pl, PHI / 2 / pl];

/** Writes east and north for a unit up vector. */
export function localFrame(ux: number, uy: number, uz: number, east: V3, north: V3) {
  // e = pole × up
  let ex = SKY_POLE[1] * uz - SKY_POLE[2] * uy;
  let ey = SKY_POLE[2] * ux - SKY_POLE[0] * uz;
  let ez = SKY_POLE[0] * uy - SKY_POLE[1] * ux;
  let l = Math.hypot(ex, ey, ez);
  if (l < 1e-6) {
    // Exactly at a pole: any tangent works.
    ex = 1 - ux * ux; ey = -ux * uy; ez = -ux * uz;
    l = Math.hypot(ex, ey, ez) || 1;
  }
  ex /= l; ey /= l; ez /= l;
  east[0] = ex; east[1] = ey; east[2] = ez;
  // n = up × e
  north[0] = uy * ez - uz * ey;
  north[1] = uz * ex - ux * ez;
  north[2] = ux * ey - uy * ex;
}

/** Direction for (elevation, azimuth) radians in the local frame of `up`. */
export function skyDir(ux: number, uy: number, uz: number, elev: number, az: number, out: V3): V3 {
  const e: V3 = [0, 0, 0];
  const n: V3 = [0, 0, 0];
  localFrame(ux, uy, uz, e, n);
  const ce = Math.cos(elev), se = Math.sin(elev), ca = Math.cos(az), sa = Math.sin(az);
  out[0] = ux * se + (e[0] * ca + n[0] * sa) * ce;
  out[1] = uy * se + (e[1] * ca + n[1] * sa) * ce;
  out[2] = uz * se + (e[2] * ca + n[2] * sa) * ce;
  return out;
}
