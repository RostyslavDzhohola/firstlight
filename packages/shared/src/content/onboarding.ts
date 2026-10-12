// Onboarding (SPEC §6.12, content.md §1.1): about 60 s in Portus, skippable, once per account. Move,
// look, jump, sprint, dodge, then knock down three training dummies by the arrival point. The server
// counts the hits (Portus is a safe zone, so training swings are their own `train` message) and pays
// 3 × 10 XP + 20 on completion = 50 XP (level 2) and the Spark medal. Skipping pays nothing more.
// Shared so the client draws the dummies exactly where the server tests the hits.

import type { BodyId } from "../planet/bodies.ts";
import { BODIES } from "../planet/bodies.ts";
import type { Dir } from "../planet/pads.ts";
import { offsetDir, placeDir } from "./places.ts";

export const ONBOARDING = {
  BODY: "portus" as BodyId,
  DUMMY_XP: 10,
  DONE_XP: 20,
  /** Hits that knock a dummy down (any weapon). */
  HITS_PER_DUMMY: 3,
  /** Dummy hit capsule (metres). */
  DUMMY_RADIUS: 0.5,
  DUMMY_HEIGHT: 1.9,
  /** Account stat: onboarding finished (done or skipped). It never comes back, not even after a rebirth. */
  STAT: "onboarding",
  /** Training swings are only sent within this many metres of the dummies. */
  NEAR_M: 40,
} as const;

/** Account stat per dummy: that dummy already paid its XP (survives reconnects). */
export const dummyStat = (i: number): string => `onboarding_dummy_${i}`;

/**
 * The three dummies, in a short row 10–12 m south-east of the Portus arrival point (pad anchor of
 * the `portus_plaza` place), facing the plaza: clear of the portals, Juno's stall and the Hall wall.
 */
export const TRAINING_DUMMIES: readonly { east: number; north: number }[] = [
  { east: 8.9, north: -7.2 },
  { east: 10, north: -5 },
  { east: 11.1, north: -2.8 },
];

export function dummyDir(i: number): Dir {
  const d = TRAINING_DUMMIES[i]!;
  return offsetDir(placeDir("portus_plaza"), d.east, d.north, BODIES[ONBOARDING.BODY].radius);
}

/** Feet position of dummy `i`, snapped to the ground like world objects. */
export function dummyPos(i: number, groundHeight: (x: number, y: number, z: number) => number): [number, number, number] {
  const d = dummyDir(i);
  const def = BODIES[ONBOARDING.BODY];
  const r = def.radius + Math.max(groundHeight(d[0], d[1], d[2]), def.waterLevel - 1.05) + 0.02;
  return [d[0] * r, d[1] * r, d[2] * r];
}
