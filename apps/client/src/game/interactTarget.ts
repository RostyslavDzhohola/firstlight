// Which world object E takes (review finding 3, D-view-6). The caller passes the objects already in
// reach (the server's reach check stays the rule; this only chooses among them): the one nearest the
// crosshair ray within INTERACT.coneDeg wins, in both views. In first person nothing outside that cone
// is taken (no levers behind your back); in third person, where the crosshair rides above the
// shoulder and a crate at the feet sits well below it, the nearest in reach is the fallback.
// Pure and allocation-free: QuestClient calls it every frame for the prompt.

import type { ViewMode } from "./view.ts";

export const INTERACT = {
  /** Half-angle (degrees) of the cone round the crosshair ray an object's middle must be in. */
  coneDeg: 40,
  /** An object's middle: this far (m) above where it stands. */
  lift: 0.8,
} as const;

const COS_CONE = Math.cos((INTERACT.coneDeg * Math.PI) / 180);

type Vec = readonly [number, number, number] | readonly number[];

export interface InteractCandidate<T> {
  item: T;
  /** Where it stands (planet space). */
  pos: Vec;
  /** Distance from the player along the surface (the old nearest-first rule). */
  dist: number;
}

/** The object E takes from `cands` (all in reach) for a camera at `eye` looking along unit `dir`, or null. */
export function pickInteract<T>(cands: readonly InteractCandidate<T>[], eye: Vec, dir: Vec, view: ViewMode): T | null {
  let aimed: T | null = null;
  let bestCos = COS_CONE;
  let nearest: T | null = null;
  let nearestD = Infinity;
  for (const c of cands) {
    if (c.dist < nearestD) {
      nearestD = c.dist;
      nearest = c.item;
    }
    const p = c.pos;
    const l = Math.hypot(p[0]!, p[1]!, p[2]!);
    const k = 1 + INTERACT.lift / l; // lifted along up (the planet's centre is the origin)
    const vx = p[0]! * k - eye[0]!, vy = p[1]! * k - eye[1]!, vz = p[2]! * k - eye[2]!;
    const vl = Math.hypot(vx, vy, vz);
    if (vl < 1e-6) return c.item; // the eye is in it
    const cos = (vx * dir[0]! + vy * dir[1]! + vz * dir[2]!) / vl;
    if (cos >= bestCos) {
      bestCos = cos;
      aimed = c.item;
    }
  }
  return aimed ?? (view === "third" ? nearest : null);
}
