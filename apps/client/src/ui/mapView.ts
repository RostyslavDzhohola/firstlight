// Map projection (pure, unit-tested): an orthographic view of the body's unit sphere centred on `c`
// and seen from above, turned so that heading `rot` (degrees clockwise from the compass's north)
// points up: 0 is north-up, the camera heading is player-up. `ppr` is pixels per body radius. The
// world map and the minimap both draw through it, so every point sits at its compass bearing.

import { bearingTo, eastAt, northAt, wrapDeg, type V3 } from "../social/compassMath.ts";

export interface MapView {
  /** Centre direction (unit, toward the viewer), screen-right and screen-up tangents. */
  readonly c: V3;
  readonly e: V3;
  readonly n: V3;
  /** Heading (degrees clockwise from north) that points up the screen. */
  readonly rot: number;
  /** Pixels per unit of body radius. */
  readonly ppr: number;
  readonly w: number;
  readonly h: number;
}

export interface Projected {
  x: number;
  y: number;
  /** d · c: > 0 on the near side of the globe. */
  z: number;
}

const DEG = Math.PI / 180;

function unit(v: V3): V3 {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

export function mapView(centre: V3, rot: number, ppr: number, w: number, h: number): MapView {
  const c = unit(centre);
  const N = northAt(c), E = eastAt(c);
  const k = Math.cos(rot * DEG), s = Math.sin(rot * DEG);
  const n: V3 = [k * N[0] + s * E[0], k * N[1] + s * E[1], k * N[2] + s * E[2]];
  const e: V3 = [k * E[0] - s * N[0], k * E[1] - s * N[1], k * E[2] - s * N[2]];
  return { c, e, n, rot, ppr, w, h };
}

export function project(v: MapView, d: V3 | readonly number[], out: Projected = { x: 0, y: 0, z: 0 }): Projected {
  const x = d[0]!, y = d[1]!, z = d[2]!;
  out.x = v.w / 2 + (x * v.e[0] + y * v.e[1] + z * v.e[2]) * v.ppr;
  out.y = v.h / 2 - (x * v.n[0] + y * v.n[1] + z * v.n[2]) * v.ppr;
  out.z = x * v.c[0] + y * v.c[1] + z * v.c[2];
  return out;
}

/** The near-side globe point under screen (x, y), or null off the globe. */
export function unproject(v: MapView, x: number, y: number): V3 | null {
  const a = (x - v.w / 2) / v.ppr, b = (v.h / 2 - y) / v.ppr;
  const rr = a * a + b * b;
  if (rr > 1) return null;
  const z = Math.sqrt(1 - rr);
  return unit([a * v.e[0] + b * v.n[0] + z * v.c[0], a * v.e[1] + b * v.n[1] + z * v.c[1], a * v.e[2] + b * v.n[2] + z * v.c[2]]);
}

/** Step from unit `d` along tangent `t` (body radii) on the great circle. */
function step(d: V3, t: V3): V3 {
  const a = Math.hypot(t[0], t[1], t[2]);
  if (a < 1e-12) return d;
  const k = Math.cos(a), s = Math.sin(a) / a;
  return unit([d[0] * k + t[0] * s, d[1] * k + t[1] * s, d[2] * k + t[2] * s]);
}

/** Move `east`/`north` metres from `d` along the compass frame (exact along one great circle). */
export function offsetDir(d: V3, east: number, north: number, radius: number): V3 {
  const N = northAt(d), E = eastAt(d);
  return step(unit(d), [(E[0] * east + N[0] * north) / radius, (E[1] * east + N[1] * north) / radius, (E[2] * east + N[2] * north) / radius]);
}

/** Compass heading (0..360, clockwise from north) from `from` toward `to`, both unit directions. */
export function headingTo(from: V3, to: V3): number {
  return (bearingTo(from, northAt(from), to) + 360) % 360;
}

/**
 * The view (same turn as `v`, scale `ppr`) in which `d` lands on screen (x, y). On an orthographic
 * map the screen direction from the centre is the compass heading from the centre (less the turn)
 * and the distance is sin(angle) · ppr, so this solves for the centre on the circle around `d` whose
 * heading back to `d` matches: exact, and stable near the poles where north turns quickly.
 */
export function placeUnder(v: MapView, d: V3, x: number, y: number, ppr = v.ppr): MapView {
  const dx = x - v.w / 2, dy = v.h / 2 - y;
  const r = Math.min(0.999, Math.hypot(dx, dy) / ppr);
  if (r < 1e-9) return mapView(d, v.rot, ppr, v.w, v.h);
  const alpha = Math.asin(r);
  const beta = v.rot + Math.atan2(dx, dy) / DEG; // heading from the centre to d
  const centre = (g: number) => offsetDir(d, Math.sin(g * DEG) * alpha, Math.cos(g * DEG) * alpha, 1);
  const miss = (g: number) => wrapDeg(beta - headingTo(centre(g), d));
  // Away from the poles the answer is straight back along beta; scan the circle for sign changes
  // and keep the root nearest that. A circle around the pole may have none (north-up can't hold
  // that point under the cursor): then take the closest heading.
  const guess = beta + 180;
  let root = guess, bestGap = Infinity, closest = guess, closestMiss = Infinity;
  const STEPS = 48;
  let g0 = guess - 180, f0 = miss(g0);
  for (let i = 1; i <= STEPS; i++) {
    const g1 = guess - 180 + (360 * i) / STEPS, f1 = miss(g1);
    if (Math.abs(f1) < closestMiss) {
      closestMiss = Math.abs(f1);
      closest = g1;
    }
    if (f0 === 0 || (Math.sign(f0) !== Math.sign(f1) && Math.abs(f0 - f1) < 180)) {
      let lo = g0, hi = g1, flo = f0;
      for (let k = 0; k < 40; k++) {
        const mid = (lo + hi) / 2, fm = miss(mid);
        if (Math.sign(fm) === Math.sign(flo)) {
          lo = mid;
          flo = fm;
        } else hi = mid;
      }
      const g = (lo + hi) / 2, gap = Math.abs(wrapDeg(g - guess));
      if (gap < bestGap) {
        bestGap = gap;
        root = g;
      }
    }
    g0 = g1;
    f0 = f1;
  }
  return mapView(centre(bestGap < Infinity ? root : closest), v.rot, ppr, v.w, v.h);
}

/** Drag: the ground under the centre follows the pointer by (dx, dy) pixels. */
export function panView(v: MapView, dx: number, dy: number): MapView {
  return placeUnder(v, v.c, v.w / 2 + dx, v.h / 2 + dy);
}

/** Zoom by `k` about screen (x, y): the ground under it stays put (about the centre off the globe). */
export function zoomView(v: MapView, k: number, x: number, y: number): MapView {
  const under = unproject(v, x, y);
  if (!under) return mapView(v.c, v.rot, v.ppr * k, v.w, v.h);
  return placeUnder(v, under, x, y, v.ppr * k);
}

/** Ground metres per screen pixel at the view centre. */
export function metresPerPixel(v: MapView, radius: number): number {
  return radius / v.ppr;
}
