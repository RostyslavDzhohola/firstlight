// The local player's riding state (horses, SPEC §6.14 #2). The server decides who is mounted
// (PF.MOUNTED on our PlayerState); the client follows it, except that it may leave the saddle early
// (deep water ahead, death) so prediction never runs faster than the server allows. It never gets
// on early: horse speed starts only once the server says so.

import { HORSE, rideSpeed, tooDeepToRide } from "@firstlight/shared/content/horse";
import type { WeaponDef } from "@firstlight/shared/content/weapons";

/**
 * Tonics, Patchkits and Prism Bubbles: the server takes `use` for them anywhere, from the saddle and
 * in safe zones too (BodyRoom.use, support.ts), so the client doesn't holster them there.
 */
export function usableAnywhere(def: WeaponDef): boolean {
  return def.delivery === "heal" || def.delivery === "bubble";
}

export class MountState {
  /** Riding as far as movement prediction and the camera are concerned. */
  riding = false;
  /** 0 → 1 blend towards the riding camera (eased, ~0.35 s). */
  blend = 0;
  private slidOff = false;
  private serverMounted = false;
  private lastAsk = -Infinity;
  /** Seconds since we last rode (Infinity = never). */
  private sinceOff = Infinity;

  /** Feed the server's flag every frame. */
  sync(serverMounted: boolean) {
    this.serverMounted = serverMounted;
    if (!serverMounted) this.slidOff = false;
    this.riding = serverMounted && !this.slidOff;
  }

  /** Leave the saddle now; stays off until the server's flag clears too (see dismountDue). */
  slideOff() {
    this.slidOff = true;
    this.riding = false;
    this.lastAsk = -Infinity;
  }

  /** After a slide-off, while the server still has us mounted: true when a dismount request is due
   *  (at once, then again every HORSE.toggleCooldownMs, since the server ignores changes that soon). */
  dismountDue(nowMs: number): boolean {
    if (!this.slidOff || !this.serverMounted || nowMs - this.lastAsk < HORSE.toggleCooldownMs) return false;
    this.lastAsk = nowMs;
    return true;
  }

  /** True when the server still has us mounted but we already got off (send it a dismount). */
  get awaitingServer(): boolean {
    return this.slidOff;
  }

  /** No weapons, guard, draw or scope: riding, or off for less than the server's dismount grace
   *  (it refuses attacks while it still budgets horse speed: HORSE.dismountGraceMs). */
  get weaponsLocked(): boolean {
    return this.riding || this.sinceOff * 1000 < HORSE.dismountGraceMs;
  }

  step(dt: number) {
    this.sinceOff = this.riding ? 0 : this.sinceOff + dt;
    const target = this.riding ? 1 : 0;
    const k = Math.min(1, dt * 3);
    this.blend += (target - this.blend) * k;
    if (Math.abs(this.blend - target) < 1e-3) this.blend = target;
  }
}

/** Horses are on: the server says so (`you.horses`, its FEATURE_HORSES flag) and no ?nohorses kill switch. */
export function horsesEnabled(you: { horses?: boolean } | null | undefined, killSwitch: boolean): boolean {
  return !killSwitch && you?.horses === true;
}

/** Camera while riding: eyes higher and further back (blend 0 = on foot, 1 = in the saddle). */
export function rideCamera(blend: number): { lift: number; back: number } {
  return { lift: 1.0 * blend, back: 1.8 * blend };
}

/** Move speed for the controller (m/s): horse canter / gallop when mounted, under NPC slows
 *  (MOVE.slow / MOVE.noSprint, set by the NPC renderer) exactly as the server budgets it. */
export function mountedSpeed(sprint: boolean, slow = 0, noSprint = false): number {
  return rideSpeed(sprint, slow, noSprint);
}

/** Should the rider slide off here? (the server applies the same rule) */
export function rideBlockedByWater(groundHeight: number, waterLevel: number): boolean {
  return tooDeepToRide(groundHeight, waterLevel);
}

/**
 * What E / H mean right now and which prompt to show (null = none). `near` = own horse within reach.
 * Riding: E or H gets off. On foot next to your horse: E or H gets on. Otherwise H whistles.
 */
export function horseKeys(s: { riding: boolean; haveHorse: boolean; near: boolean; moving: boolean }): { e: "ride" | "dismount" | null; prompt: string | null } {
  if (s.riding) return { e: "dismount", prompt: s.moving ? null : "E — Get off your horse" };
  if (s.haveHorse && s.near) return { e: "ride", prompt: "E — Ride your horse" };
  return { e: null, prompt: null };
}
