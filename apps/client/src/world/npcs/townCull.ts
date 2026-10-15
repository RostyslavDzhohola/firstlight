// Portus (D-zones-1): the creeps live outside the town walls. From the plaza and the streets, the
// 8 m walls and the houses hide them, so the NPC layer (~10–14 draws plus shadows, every batch
// drawn unculled) stays off there; from a gate passage, the top of a wall or anywhere outside they
// are drawn as usual. Pure, so it is tested without a scene.

import { inTownSafe, TOWN_GATES, type BodyDef } from "@firstlight/shared";
import { townCoords } from "@firstlight/shared/planet/townFrame";

/** Cameras higher than this above the ground (a wall walk is 6.2 m up) see over the walls. */
export const OVER_WALLS_M = 5;
/** Cameras this close to a gate's centre look out through it. */
export const NEAR_GATE_M = 14;

const _tc: [number, number] = [0, 0];

/** True when the town hides everything outside its walls from a camera at (x, y, z). */
export function creepsHiddenByTown(body: BodyDef, x: number, y: number, z: number, groundHeight: (x: number, y: number, z: number) => number): boolean {
  if (body.terrain.kind !== "hub" || !(y > 0)) return false;
  const R = body.radius;
  townCoords(x, y, z, R, _tc);
  if (!inTownSafe(_tc[0], _tc[1])) return false;
  const l = Math.hypot(x, y, z);
  const ux = x / l, uy = y / l, uz = z / l;
  if (l - R - groundHeight(ux, uy, uz) > OVER_WALLS_M) return false;
  for (const g of TOWN_GATES) if (Math.hypot(g[0] - ux, g[1] - uy, g[2] - uz) * R < NEAR_GATE_M) return false;
  return true;
}
