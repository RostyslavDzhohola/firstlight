// The solar system (#5, #6): every body on a circular orbit, a pure function of the server clock, so
// the server, every client and the bench agree on where everything is with no state streamed (the
// same rule as the day/night clock in sky.ts).
//
// The four worlds circle the star in the opening menu's order and ring sizes (home/orreryModel.ts),
// and Arcadia's moon, Lumen, circles Arcadia. In a body's sky each other body sits on the ecliptic:
// the great circle through the sun tangent to its daily path, at the body's elongation from the sun
// as seen from here (its heliocentric geometry), so it rises, sets and drifts against the sun, and
// its lit phase (the shader lights it from the sun) comes from where it really is.

import { DAY_MS, SKY_PROFILES } from "./sky.ts";
import type { BodyId } from "./planet/bodies.ts";

/** Everything that orbits: every body, the moon included. */
export type OrbitId = BodyId;

export interface Orbit {
  /** What it circles (null: the star). */
  around: OrbitId | null;
  /** Ring radius (the orrery's scene units). */
  radius: number;
  /** Game days per lap (sidereal). */
  days: number;
  /** Angle on its ring at server time 0 (radians). */
  phase: number;
  /** Height above the ecliptic as seen from a neighbour (radians, signed): bodies don't sit on one line. */
  incl: number;
}

export const ORBITS: Record<OrbitId, Orbit> = {
  // Kepler-flavoured: the lap grows with the ring as r^1.5 (3 days for the inner ring).
  portus: { around: null, radius: 3.4, days: 3, phase: 0.6, incl: 0.04 },
  arcadia: { around: null, radius: 5.6, days: 6.4, phase: 2.5, incl: 0 },
  hollowmere: { around: null, radius: 8.0, days: 10.9, phase: 4.3, incl: -0.07 },
  meridian: { around: null, radius: 10.6, days: 16.5, phase: 5.6, incl: 0.1 },
  // A new Lumen to a full one in about two and a half game days (synodic, against Arcadia's year).
  lumen: { around: "arcadia", radius: 0.55, days: 1.8, phase: 1.1, incl: 0.03 },
};

export const ORBIT_IDS = Object.keys(ORBITS) as readonly OrbitId[];

const TAU = Math.PI * 2;
const wrap = (a: number) => a - TAU * Math.floor((a + Math.PI) / TAU);

/** Where a body is in the orbital plane at server time `ms` (orrery units, the star at the origin). */
export function orbitPos(id: OrbitId, ms: number, out: [number, number] = [0, 0]): [number, number] {
  const o = ORBITS[id];
  const a = o.phase + (TAU * ms) / (o.days * DAY_MS);
  let x = o.radius * Math.cos(a), y = o.radius * Math.sin(a);
  if (o.around) {
    const p = orbitPos(o.around, ms, out);
    x += p[0];
    y += p[1];
  }
  out[0] = x;
  out[1] = y;
  return out;
}

/** The body's whole system: itself, or the world it circles. */
const root = (id: OrbitId): OrbitId => ORBITS[id].around ?? id;

/** The distance at which a body shows its look's `sizeDeg` (a typical one, from `viewer`). */
export function meanDistance(viewer: OrbitId, body: OrbitId): number {
  if (ORBITS[viewer].around === body) return ORBITS[viewer].radius;
  if (ORBITS[body].around === viewer) return ORBITS[body].radius;
  return Math.hypot(ORBITS[root(viewer)].radius, ORBITS[root(body)].radius);
}

/**
 * Where a moon's world hangs in the moon's sky (it keeps one face to its world, so its world never
 * moves in its sky): elevation and azimuth, radians, local sky frame.
 */
export const HANGS: Partial<Record<OrbitId, { elev: number; az: number }>> = {
  lumen: { elev: 0.62, az: 2.3 },
};

/** Angular size scale against the look's size: real geometry, softened so every body stays readable. */
export const SKY_SIZE_MIN = 0.7;
export const SKY_SIZE_MAX = 1.5;

export interface SkyBodyPlace {
  /** Elevation and azimuth in the viewer's local sky frame (radians). */
  elev: number;
  az: number;
  /** Elongation east of the sun (radians, −π..π): 0 behind the sun, ±π opposite it (full). */
  elong: number;
  /** Angular size against the look's own (SKY_SIZE_MIN..SKY_SIZE_MAX). */
  size: number;
}

// Scratch (called per body per frame on the client: no allocation).
const PV: [number, number] = [0, 0];
const PB: [number, number] = [0, 0];

/** The celestial pole of a body's sky: opposite the noon sun, as high as its sun path implies. */
function poleOf(viewer: OrbitId, out: number[]) {
  const p = SKY_PROFILES[viewer];
  // For a sun at declination δ seen from latitude φ: max = 90° − φ + δ, min = φ + δ − 90°.
  const lat = Math.PI / 2 - (p.maxElev - p.minElev) / 2;
  const az = p.noonAz + Math.PI;
  out[0] = Math.cos(lat) * Math.cos(az);
  out[1] = Math.cos(lat) * Math.sin(az);
  out[2] = Math.sin(lat);
}

const POLE = [0, 0, 1];

/**
 * Where `body` stands in `viewer`'s sky, given the sun's place there now (`sunElev`, `sunAz`, from
 * sunAngles or a fixed look) and the orbit clock `orbitMs` (server time; a fixed value holds the
 * bodies still). Local sky frame: x east, y north, z up, azimuth from east toward north.
 */
export function skyBodyPlace(
  viewer: OrbitId, body: OrbitId, sunElev: number, sunAz: number, orbitMs: number,
  out: SkyBodyPlace = { elev: 0, az: 0, elong: 0, size: 1 },
): SkyBodyPlace {
  const v = orbitPos(viewer, orbitMs, PV);
  const b = orbitPos(body, orbitMs, PB);
  const dx = b[0] - v[0], dy = b[1] - v[1];
  const dist = Math.hypot(dx, dy) || 1e-6;
  const elong = wrap(Math.atan2(dy, dx) - Math.atan2(-v[1], -v[0]));
  out.elong = elong;
  out.size = Math.min(SKY_SIZE_MAX, Math.max(SKY_SIZE_MIN, Math.sqrt(meanDistance(viewer, body) / dist)));
  const hang = ORBITS[viewer].around === body ? HANGS[viewer] : undefined;
  if (hang) {
    out.elev = hang.elev;
    out.az = hang.az;
    return out;
  }
  // The sun S, the direction of its daily motion M = pole × S, and the ecliptic's normal N = S × M.
  const ce = Math.cos(sunElev);
  const sx = ce * Math.cos(sunAz), sy = ce * Math.sin(sunAz), sz = Math.sin(sunElev);
  poleOf(viewer, POLE);
  let mx = POLE[1]! * sz - POLE[2]! * sy, my = POLE[2]! * sx - POLE[0]! * sz, mz = POLE[0]! * sy - POLE[1]! * sx;
  const ml = Math.hypot(mx, my, mz) || 1;
  mx /= ml; my /= ml; mz /= ml;
  const nx = sy * mz - sz * my, ny = sz * mx - sx * mz, nz = sx * my - sy * mx;
  // East of the sun = behind it along its daily motion (it rises and sets after the sun).
  const inc = ORBITS[body].incl - ORBITS[viewer].incl;
  const c = Math.cos(elong) * Math.cos(inc), s = -Math.sin(elong) * Math.cos(inc), k = Math.sin(inc);
  const x = c * sx + s * mx + k * nx, y = c * sy + s * my + k * ny, z = c * sz + s * mz + k * nz;
  out.elev = Math.asin(Math.max(-1, Math.min(1, z)));
  out.az = Math.atan2(y, x);
  return out;
}
