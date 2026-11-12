// The client's mirror of the server's special cooldown and charged-heavy rules (apps/server/src/world/combat.ts):
// one `specialReadyAt` per player, started by the Ember Seal (`castSpecial`) and by a charged heavy with a
// cooldown (the axe chop, the hammer slam: `melee()`). A heavy needs the charge held its heavyTime since the
// `charge` start, and any melee resets that charge. The client keeps from sending (and animating) what the
// server would refuse, so a refused chop no longer resets the light-attack timer (review finding 5).

import type { TierStats, WeaponDef } from "@firstlight/shared/content/weapons";

/** A refusal this soon after a cast or heavy we sent means the server never started its cooldown. */
export const PENDING_MS = 1500;
const PRIMARY_ONLY = new Set(["reloading", "empty", "overheated", "rate"]);

export class SpecialCooldown {
  private readyAt = 0;
  private pendingUntil = 0;

  /** Ready to start a hold or charge at `now` (ms, performance.now()). */
  ready(now: number): boolean {
    return now >= this.readyAt;
  }

  /** Seconds left, 0 when ready. */
  remaining(now: number): number {
    return Math.max(0, (this.readyAt - now) / 1000);
  }

  /** We sent a seal or a cooled heavy at `now`: the server starts the cooldown. */
  started(now: number, cooldownS: number) {
    this.readyAt = now + cooldownS * 1000;
    this.pendingUntil = now + PENDING_MS;
  }

  /** The server refused what we just sent: it didn't start (except its own "cooldown" refusal: its clock still runs). */
  refused(now: number, reason: string) {
    // Reasons only a primary attack gets (a dart thrown after the seal): not about the special.
    if (now >= this.pendingUntil || PRIMARY_ONLY.has(reason)) return;
    this.pendingUntil = 0;
    if (reason !== "cooldown") this.readyAt = 0;
  }
}

/** The name of a weapon's charged heavy, for notices ("Chop recharging"). */
export function heavyName(def: WeaponDef): string {
  return def.id === "hammer" ? "Slam" : "Chop";
}

export type HeavyRelease =
  /** Send the heavy at `at` (ms): now, or when the light-attack rate gate opens. */
  | { send: true; at: number }
  /** Nothing to send: released early, still cooling down, or a light swing since the charge started (it reset the charge). */
  | { send: false; why: "short" | "cooling" | "broken" };

/**
 * The right button came up on a heavy-capable melee weapon. `chargeStart` is when the charge began, `lastFire`
 * the client's last attack (both ms). A release that is ready but inside the tier's rate since the last swing is
 * held until the gate opens (the server refuses a heavy inside the rate, silently).
 */
export function heavyRelease(now: number, chargeStart: number, lastFire: number, t: TierStats, cooldown: SpecialCooldown): HeavyRelease {
  if (now - chargeStart < (t.heavyTime ?? 0.8) * 1000) return { send: false, why: "short" };
  if (lastFire > chargeStart) return { send: false, why: "broken" };
  if (t.cooldown && !cooldown.ready(now)) return { send: false, why: "cooling" };
  return { send: true, at: Math.max(now, lastFire + t.rate * 1000) };
}
