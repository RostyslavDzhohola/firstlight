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
}

/**
 * Ray (origin o, unit dir d, max length maxT) against a capsule standing on `feet` along the
 * local up of a planet-centred world, with radius r and height h. Returns the nearest hit.
 */
export function rayCapsule(o: V3, d: V3, maxT: number, feet: V3, r: number, h: number): CapsuleHit | null {
  const l = Math.hypot(feet[0], feet[1], feet[2]);
  const up: V3 = [feet[0] / l, feet[1] / l, feet[2] / l];
  // Segment A..B is the capsule's core.
  const A: V3 = [feet[0] + up[0] * r, feet[1] + up[1] * r, feet[2] + up[2] * r];
  const B: V3 = [feet[0] + up[0] * (h - r), feet[1] + up[1] * (h - r), feet[2] + up[2] * (h - r)];
  // Closest approach between the ray and the segment (sample-free analytic solution).
  const u: V3 = [B[0] - A[0], B[1] - A[1], B[2] - A[2]];
  const w: V3 = [o[0] - A[0], o[1] - A[1], o[2] - A[2]];
  const a = 1; // d·d
  const b = d[0] * u[0] + d[1] * u[1] + d[2] * u[2];
  const c = u[0] * u[0] + u[1] * u[1] + u[2] * u[2];
  const dd = d[0] * w[0] + d[1] * w[1] + d[2] * w[2];
  const e = u[0] * w[0] + u[1] * w[1] + u[2] * w[2];
  const den = a * c - b * b;
  let sc = den > 1e-9 ? (b * e - c * dd) / den : 0;
  let tc = den > 1e-9 ? (a * e - b * dd) / den : e / c;
  tc = Math.max(0, Math.min(1, tc));
  sc = Math.max(0, Math.min(maxT, sc));
  // Refine: recompute sc for clamped tc.
  const P: V3 = [A[0] + u[0] * tc, A[1] + u[1] * tc, A[2] + u[2] * tc];
  sc = Math.max(0, Math.min(maxT, (P[0] - o[0]) * d[0] + (P[1] - o[1]) * d[1] + (P[2] - o[2]) * d[2]));
  const Q: V3 = [o[0] + d[0] * sc, o[1] + d[1] * sc, o[2] + d[2] * sc];
  const dist = Math.hypot(Q[0] - P[0], Q[1] - P[1], Q[2] - P[2]);
  if (dist > r) return null;
  // Back off to the entry point.
  const back = Math.sqrt(Math.max(0, r * r - dist * dist));
  const t = Math.max(0, sc - back);
  const hit: V3 = [o[0] + d[0] * t, o[1] + d[1] * t, o[2] + d[2] * t];
  const heightAboveFeet = (hit[0] - feet[0]) * up[0] + (hit[1] - feet[1]) * up[1] + (hit[2] - feet[2]) * up[2];
  return { t, heightAboveFeet };
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
