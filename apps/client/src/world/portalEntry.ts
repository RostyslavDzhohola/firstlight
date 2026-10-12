// When a player is standing in a portal ring (what starts travel). Pure, so it is unit-tested against
// the shared, server-validated portal spots. The ring's centre is 2.6 m above the ground, so the test
// uses a point at the player's waist rather than the feet: from the feet the ring centre is always
// 2.6 m away, outside the 2.2 m ring, and walking in never travelled (T9 follow-up).

import type { PortalSpot } from "@firstlight/shared";

/** Height above the feet (metres) that has to pass through the ring. */
export const PORTAL_BODY_Y = 1;
/** Half the depth of the entry slab along the ring's facing (metres). */
export const PORTAL_HALF_DEPTH = 0.9;
/** Radius of the ring's opening (the torus is 2.2 m). */
export const PORTAL_OPENING_R = 2.2;

type Spot = Pick<PortalSpot, "center" | "facing">;

/** True when a player whose feet are at (x, y, z) (planet space) stands in this ring. No allocation. */
export function inPortal(spot: Spot, x: number, y: number, z: number): boolean {
  const l = Math.hypot(x, y, z);
  if (!(l > 0)) return false;
  const k = 1 + PORTAL_BODY_Y / l;
  const dx = x * k - spot.center[0];
  const dy = y * k - spot.center[1];
  const dz = z * k - spot.center[2];
  const f = spot.facing;
  const along = dx * f[0] + dy * f[1] + dz * f[2];
  if (Math.abs(along) >= PORTAL_HALF_DEPTH) return false;
  const lateral = Math.hypot(dx - along * f[0], dy - along * f[1], dz - along * f[2]);
  return lateral < PORTAL_OPENING_R;
}

/** The portal (if any) whose ring the player stands in. */
export function portalAt<T extends Spot>(spots: readonly T[], x: number, y: number, z: number): T | null {
  for (const s of spots) if (inPortal(s, x, y, z)) return s;
  return null;
}
