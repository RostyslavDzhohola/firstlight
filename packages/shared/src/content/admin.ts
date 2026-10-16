// Admin mode (the owner's test switches, D-admin-1): fly, god mode and double speed for admin
// accounts only, and only in the admin's private sandbox (D-admin-3), where nothing is saved. The
// server's movement validation reads the same numbers as the client controller.

import type { BodyId } from "../planet/bodies.ts";

export const ADMIN_MODE = {
  /** Flying: top speed in any direction (m/s), before Speed ×2. */
  flySpeed: 12,
  /** Flying: climb and descent speed (m/s; Space up, C down), before Speed ×2. */
  climbSpeed: 8,
  /** Speed ×2: multiplies running, sprinting, swimming and flying. */
  speedMult: 2,
} as const;

/** The admin's switches as the server holds them (sent in `you.adminMode`, admins only). */
export interface AdminModeState {
  fly: boolean;
  god: boolean;
  speed: boolean;
  /** In the admin's sandbox (D-admin-3): a private copy of the body where nothing is saved. */
  sandbox: boolean;
  /** In a sandbox: the body the real character is on ("Back to normal" goes there). */
  home?: BodyId;
}

/** What the HUD badge says in a sandbox. */
export const SANDBOX_BADGE = "SANDBOX — nothing here is saved";

export type AdminToggle = "fly" | "god" | "speed";
