// Hit-test geometry for combat: rays against vertical capsules (oriented to local up),
// terrain occlusion by marching the shared height field, and melee arcs.

import type { Terrain } from "@firstlight/shared";

export type V3 = [number, number, number];

export const PLAYER_RADIUS = 0.45;
export const PLAYER_HEIGHT = 1.8;
export const HEAD_FROM = 1.45; // hits above this (metres above feet) count as weak point

export interface CapsuleHit {
  t: number; // distance along the ray
  heightAboveFeet: number;
  /** Distance along the ray to its point nearest the capsule's axis: the middle of what it crosses. */
  deep: number;
}

/**
 * Segment (origin o, unit dir d, length maxT) against a capsule standing on `feet` along the local
 * up of a planet-centred world, radius r, height h. Exact: closest points between the segment and
 * the capsule axis (Ericson, Real-Time Collision Detection §5.1.9), then the entry point by solving
 * against the sphere around the closest axis point. Returns the nearest hit or null.
 */
export function rayCapsule(o: V3, d: V3, maxT: number, feet: V3, r: number, h: number): CapsuleHit | null {
  const l = Math.hypot(feet[0], feet[1], feet[2]);
  const up: V3 = [feet[0] / l, feet[1] / l, feet[2] / l];
  const A: V3 = [feet[0] + up[0] * r, feet[1] + up[1] * r, feet[2] + up[2] * r];
  const axisLen = Math.max(0, h - 2 * r);
  // Segment 1: P(s) = o + d*s, s in [0, maxT]; segment 2: Q(t) = A + up*t, t in [0, axisLen].
  const rx = o[0] - A[0], ry = o[1] - A[1], rz = o[2] - A[2];
  const a = maxT * maxT; // |d*maxT|^2 with unit d
  const e = axisLen * axisLen;
  const f = (up[0] * rx + up[1] * ry + up[2] * rz) * axisLen;
  const c = (d[0] * rx + d[1] * ry + d[2] * rz) * maxT;
  const b = (d[0] * up[0] + d[1] * up[1] + d[2] * up[2]) * maxT * axisLen;
  let s: number, t: number; // normalised parameters in [0, 1]
  const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
  if (a <= 1e-12 && e <= 1e-12) {
    s = 0; t = 0;
  } else if (a <= 1e-12) {
    s = 0; t = clamp01(f / e);
  } else if (e <= 1e-12) {
    t = 0; s = clamp01(-c / a);
  } else {
    const denom = a * e - b * b;
    s = denom > 1e-12 ? clamp01((b * f - c * e) / denom) : 0;
    t = (b * s + f) / e;
    if (t < 0) { t = 0; s = clamp01(-c / a); }
    else if (t > 1) { t = 1; s = clamp01((b - c) / a); }
  }
  const S = s * maxT;
  const T = t * axisLen;
  const P: V3 = [o[0] + d[0] * S, o[1] + d[1] * S, o[2] + d[2] * S];
  const Q: V3 = [A[0] + up[0] * T, A[1] + up[1] * T, A[2] + up[2] * T];
  const dist = Math.hypot(P[0] - Q[0], P[1] - Q[1], P[2] - Q[2]);
  if (dist > r) return null;
  // Entry point: first intersection of the ray with the sphere (centre Q, radius r).
  const mx = o[0] - Q[0], my = o[1] - Q[1], mz = o[2] - Q[2];
  const bb = mx * d[0] + my * d[1] + mz * d[2];
  const cc = mx * mx + my * my + mz * mz - r * r;
  let tHit = 0;
  if (cc > 0) {
    const disc = bb * bb - cc;
    tHit = disc > 0 ? Math.max(0, -bb - Math.sqrt(disc)) : S;
  }
  tHit = Math.min(tHit, maxT);
  const hit: V3 = [o[0] + d[0] * tHit, o[1] + d[1] * tHit, o[2] + d[2] * tHit];
  const heightAboveFeet = (hit[0] - feet[0]) * up[0] + (hit[1] - feet[1]) * up[1] + (hit[2] - feet[2]) * up[2];
  return { t: tHit, heightAboveFeet, deep: Math.max(tHit, S) };
}

/** Distance along the ray to the first terrain intersection, or Infinity. Marches in `step` metres. */
export function rayTerrain(terrain: Terrain, o: V3, d: V3, maxT: number, step = 1.5): number {
  const R = terrain.body.radius;
  let prevT = 0;
  for (let t = 0; t <= maxT; t += step) {
    const x = o[0] + d[0] * t, y = o[1] + d[1] * t, z = o[2] + d[2] * t;
    const l = Math.hypot(x, y, z);
    const g = R + terrain.groundHeight(x / l, y / l, z / l);
    if (l < g) {
      // Bisect between prevT and t.
      let lo = prevT, hi = t;
      for (let i = 0; i < 6; i++) {
        const m = (lo + hi) / 2;
        const mx = o[0] + d[0] * m, my = o[1] + d[1] * m, mz = o[2] + d[2] * m;
        const ml = Math.hypot(mx, my, mz);
        if (ml < R + terrain.groundHeight(mx / ml, my / ml, mz / ml)) hi = m;
        else lo = m;
      }
      return hi;
    }
    prevT = t;
  }
  return Infinity;
}

/** Is target within a melee arc (range metres, arc degrees) in front of the attacker? */
export function inMeleeArc(attacker: V3, facing: V3, target: V3, range: number, arcDeg: number): boolean {
  const dx = target[0] - attacker[0], dy = target[1] - attacker[1], dz = target[2] - attacker[2];
  const dist = Math.hypot(dx, dy, dz);
  if (dist > range + PLAYER_RADIUS) return false;
  if (dist < 0.5) return true;
  const fl = Math.hypot(facing[0], facing[1], facing[2]) || 1;
  const cos = (dx * facing[0] + dy * facing[1] + dz * facing[2]) / (dist * fl);
  return cos >= Math.cos(((arcDeg / 2) * Math.PI) / 180);
}

export function dist3(a: V3, b: V3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}
