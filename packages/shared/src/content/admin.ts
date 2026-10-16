// Admin mode (the owner's test switches, D-admin-1): fly, god mode and double speed for admin
// accounts only. The server's movement validation reads the same numbers as the client controller.

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
  /** In a test session (D-admin-2): nothing earned is kept; "Back to normal" ends it. */
  session: boolean;
}

export type AdminToggle = "fly" | "god" | "speed";
