// Server-side movement validation (SPEC §5.3, D3; F12 review B1 flight, S3 swimming).
//
// The client predicts and sends positions; the server checks every step:
// - Distance: a budget refilled at sprint speed (swim speed in the water) plus slack, banked up to
//   `budgetCap`. A dodge (pre-paid from refill the full bank couldn't hold) or a shove adds a
//   one-off bonus that expires. The per-packet tolerance is charged (the budget may dip below
//   zero), so it can't be repeated into extra speed.
//   Only ground covered is charged: the client walks up any slope at full speed and snaps onto it,
//   so radial motion is the height rules' business (ground, envelope), not the run budget's.
// - Height: off the ground, the body must follow a ballistic envelope from its last grounded
//   position (jump speed, gravity, generous slack). Hovering or climbing in small steps fails as
//   soon as the envelope drops below it, and `settle` pulls such bodies (or silent ones) down.
//   A prop top counts as ground, so a step that lands on one from below must fit a jump as well.

import { HORSE, rideSpeed } from "@firstlight/shared/content/horse";
import { ANIM } from "@firstlight/shared/net/schema";
import { deepWater, SWIM_FLOAT } from "@firstlight/shared/planet/water";
import { inSaddle, type PlayerActor } from "./actors.ts";
import type { V3 } from "./geometry.ts";
import { activeMoveFx, movementLimits } from "./npc/effects.ts";

export const MOVE = {
  maxSpeed: 9, // sprint (content §0)
  swimSpeed: 3,
  speedSlack: 1.2, // network jitter allowance on top of the speed
  budgetCap: 3.5, // metres that can be banked (≈ 0.3 s of sprint + slack)
  swimBudgetCap: 1.5,
  stepTolerance: 0.05, // per packet, charged
  // Dodging is paid from a reserve that refills over one dodge cooldown (T9 review). An honest
  // player sprinting and rolling at every cooldown covers 13.1 m per 1.2 s (the 15 m/s roll plus
  // its slow-down), more than the sprint allowance, and the same roll from an empty bank (right
  // after a correction or a shove) needs 1.6 m on top of the refill. With 1.6 m honest rolling gets
  // 0 corrections at 20–60 fps and 100 ms packet gaps; the price is that a modified client claiming
  // a roll at every cooldown and moving as far as allowed sustains 12.2 m/s against 10.8 (+12 %).
  dodgeBurst: 1.6,
  dodgeCooldownMs: 1200, // client PlayerController MOVE.dodgeCooldown
  dodgeWindowMs: 800, // the dodge bonus must be used within this time
  knockbackWindowMs: 1500,
  groundTolerance: 0.5, // feet may be this far below the ground
  groundedAbove: 0.35, // feet within this of the ground count as grounded (client: the same)
  gravity: 18, // client PlayerController
  jumpSpeed: 6.6, // client PlayerController (apex ≈ 1.21 m)
  airSlack: 0.5, // metres above the envelope
  airTimeSlackMs: 350, // packet timing slack on the envelope
  silentFallMs: 400, // airborne with no input for this long: the server applies gravity
  swimDepthSlack: 2.5,
};

/** What the validator needs from the body. */
export interface MoveWorld {
  radius: number;
  waterLevel: number;
  groundAt(x: number, y: number, z: number): number;
  /**
   * Intact breakable props and the Portus town's structures (D38): the highest top under the feet
   * (radius from the centre, 0 = none) and whether the feet are inside one.
   */
  footing?(x: number, y: number, z: number, step: number): { top: number; inside: boolean };
  /** Do feet moving straight from a to b pass through an intact prop or a town structure (shared collider sweep)? */
  crosses?(ax: number, ay: number, az: number, bx: number, by: number, bz: number): boolean;
}

/** Ground height (above the radius) under a position: the terrain or an intact prop top, whichever is higher. */
function supportAt(w: MoveWorld, x: number, y: number, z: number, terrain: number): number {
  const top = w.footing?.(x, y, z, MOVE.groundedAbove).top ?? 0;
  return top > 0 ? Math.max(terrain, top - w.radius) : terrain;
}

export interface MoveLimits {
  /** Refill factor (NPC slows, no-sprint). */
  speed: number;
  /** Dodge bonus factor (0 = refused). */
  dodge: number;
  /**
   * Riding (horses): the mounted refill speed in m/s (gallop under NPC effects); the bank is
   * HORSE.budgetCap and there is no dodge. Set while mounted and during the dismount grace.
   */
  ride?: number;
}

/**
 * The movement limits for a player now: NPC slows and Cease-and-Desist (npc/effects.ts), and riding
 * (HorseSystem sets `mounted`; the mounted budget outlives a dismount by HORSE.dismountGraceMs since
 * the client is a round trip behind).
 */
export function moveLimits(a: PlayerActor, now: number): MoveLimits {
  const limits = movementLimits(a, now);
  if (!inSaddle(a, now)) return limits;
  const fx = activeMoveFx(a, now);
  return { speed: limits.speed, dodge: 0, ride: rideSpeed(true, fx.slow, fx.noSprint) };
}

export type MoveResult =
  | { ok: true; swimming: boolean; grounded: boolean; len: number; ground: number }
  | { ok: false; reason: "speed" | "height" | "ground" | "prop" };

/** Is a body at radius `len` over `ground` floating in deep water (swim depth)? */
function swimmingAt(w: MoveWorld, len: number, ground: number): boolean {
  const depth = len - w.radius;
  return deepWater(ground, w.waterLevel) && depth >= w.waterLevel - MOVE.swimDepthSlack && depth <= w.waterLevel + 0.5;
}

/** Highest radius the body may have right now while airborne (the ballistic envelope). */
export function airCeiling(a: PlayerActor, now: number): number {
  const g = MOVE.gravity;
  const v0 = a.airLiftV;
  const tApex = v0 / g;
  const apex = (v0 * v0) / (2 * g);
  const t = Math.max(0, (now - a.airStartAt - MOVE.airTimeSlackMs) / 1000);
  const h = t <= tApex ? apex : apex - 0.5 * g * (t - tApex) * (t - tApex);
  return a.airStartLen + h + MOVE.airSlack;
}

/** Start the envelope over from a grounded (or freshly placed) position. */
export function groundMotion(a: PlayerActor, len: number, now: number) {
  a.airStartAt = now;
  a.airStartLen = len;
  a.airLiftV = MOVE.jumpSpeed;
}

/** Height of a standing jump's apex (the client's jump speed and gravity), about 1.21 m. */
const JUMP_APEX = (MOVE.jumpSpeed * MOVE.jumpSpeed) / (2 * MOVE.gravity);

/**
 * May a step end standing on a prop top `ground` m up (F12 confirmation Opus SF1)? A top counts as
 * ground, so without this one packet straight up onto a 2.6 m camp wall or a 4.2 m pillar was a
 * grounded step and skipped the envelope. From that top (or one within a step of it) the body walks
 * on; otherwise it must have jumped there: the landing has to fit the air envelope, or a fresh jump
 * from where it stands (a body that stood still for a while has an old envelope).
 */
function reachesTop(a: PlayerActor, w: MoveWorld, ground: number, len: number, now: number): boolean {
  const sx = a.lastX, sy = a.lastY, sz = a.lastZ;
  const from = Math.hypot(sx, sy, sz);
  const support = supportAt(w, sx, sy, sz, w.groundAt(sx, sy, sz));
  const standing = from - w.radius - support <= MOVE.groundedAbove;
  if (standing && support >= ground - MOVE.groundedAbove) return true;
  const ceiling = standing ? Math.max(airCeiling(a, now), from + JUMP_APEX + MOVE.airSlack) : airCeiling(a, now);
  return len <= ceiling;
}

/** Validate one client step and, if it is allowed, charge it. Does not move the actor. */
export function validateMove(a: PlayerActor, m: { x: number; y: number; z: number; anim: number }, w: MoveWorld, limits: MoveLimits, now: number): MoveResult {
  const elapsed = Math.min(0.25, Math.max(0, (now - a.lastBudgetAt) / 1000));
  a.lastBudgetAt = now;
  const len = Math.hypot(m.x, m.y, m.z);
  const terrain = w.groundAt(m.x, m.y, m.z);
  // Nowhere near the surface (the centre gives NaN ground, and a radial step there is free; F12
  // final Opus N-B1). Every check below is written so that NaN fails it.
  if (!(len >= w.radius * 0.5) || !Number.isFinite(len) || !Number.isFinite(terrain)) return { ok: false, reason: "ground" };
  const swimming = swimmingAt(w, len, terrain);
  // Intact props, structures and natural solids are solid (F12, D38, D-solid-1); out of the water
  // their tops count as ground too. A swimmer is solid-checked the same (a sea wall stops a swimmer
  // as a land wall stops a walker, D-b2-1, Codex review): swimming only changes the ground rules.
  const touch = w.footing?.(m.x, m.y, m.z, MOVE.groundedAbove) ?? null;
  const inside = touch?.inside ?? false;
  const foot = swimming ? null : touch;
  const ground = foot && foot.top > 0 ? Math.max(terrain, foot.top - w.radius) : terrain;
  const above = len - w.radius - ground;
  // Held up by a prop top that the terrain alone wouldn't hold (read now: `foot` is a reused object).
  const onPropTop = ground > terrain && len - w.radius - terrain > MOVE.groundedAbove;
  // Swim speed when both ends of the step are in the water (entering and leaving keep land speed);
  // horse speed and a bigger bank while riding.
  const inWater = swimming && a.swimming;
  const riding = limits.ride !== undefined;
  const speed = (riding ? limits.ride! : (inWater ? MOVE.swimSpeed : MOVE.maxSpeed) * limits.speed) * MOVE.speedSlack;
  const cap = riding ? HORSE.budgetCap : inWater ? MOVE.swimBudgetCap : MOVE.budgetCap;
  const refilled = a.moveBudget + speed * elapsed;
  a.moveBudget = Math.min(cap, refilled);
  // The dodge reserve refills over one dodge cooldown, whatever the bank does: an honest player
  // sprinting and dodging at every cooldown averages ~10.9 m/s (a 15 m/s roll plus its slow-down),
  // more than the sprint allowance, so a reserve fed only by bank overflow ran dry (T9 review).
  a.dodgeReserve = Math.min(MOVE.dodgeBurst, a.dodgeReserve + (elapsed * 1000 * MOVE.dodgeBurst) / MOVE.dodgeCooldownMs);
  if (now >= a.moveBonusUntil) a.moveBonus = 0;
  // Dodge rolls only on foot on land (the client can't roll in the water or from the saddle).
  if (m.anim === ANIM.DODGE && !riding && !swimming && !a.swimming && limits.dodge > 0 && now - a.lastDodgeAt >= MOVE.dodgeCooldownMs) {
    a.lastDodgeAt = now;
    const burst = Math.min(a.dodgeReserve, MOVE.dodgeBurst * limits.dodge);
    a.dodgeReserve -= burst;
    a.moveBonus += burst;
    a.moveBonusUntil = Math.max(a.moveBonusUntil, now + MOVE.dodgeWindowMs);
  }

  // Below the ground, deeper in a lake than swimmers float, or inside a solid prop.
  if (!swimming && (!(above >= -MOVE.groundTolerance) || (deepWater(terrain, w.waterLevel) && len - w.radius < w.waterLevel - MOVE.swimDepthSlack))) return { ok: false, reason: "ground" };
  // Walking (or swimming) into a solid is refused; a body that was put inside one (teleport, a
  // rebuild) may walk out.
  if (inside && !w.footing!(a.lastX, a.lastY, a.lastZ, MOVE.groundedAbove).inside) return { ok: false, reason: "prop" };
  // ...and so is a step whose path goes through one with both ends outside (a thin fence, F12 final
  // S2; a sea wall at swimming depth).
  if (w.crosses?.(a.lastX, a.lastY, a.lastZ, m.x, m.y, m.z)) return { ok: false, reason: "prop" };
  const grounded = swimming || above <= MOVE.groundedAbove;
  if (!grounded && !(len <= airCeiling(a, now))) return { ok: false, reason: "height" };
  if (grounded && onPropTop && !reachesTop(a, w, ground, len, now)) return { ok: false, reason: "height" };

  const dx = m.x - a.lastX, dy = m.y - a.lastY, dz = m.z - a.lastZ;
  const dist = Math.hypot(dx, dy, dz);
  // The budget pays for ground covered (the tangential part), like the client, which moves along
  // its tangent plane and then snaps onto the terrain or a prop top at any slope. Height is the
  // envelope's business: supported climbing follows the ground, airborne lift is bounded above.
  const radial = len - Math.hypot(a.lastX, a.lastY, a.lastZ);
  const charged = Math.sqrt(Math.max(0, dist * dist - radial * radial));
  if (!(charged <= a.moveBudget + a.moveBonus + MOVE.stepTolerance)) return { ok: false, reason: "speed" };

  // Allowed: spend the expiring bonus first, then the budget (which may dip by the tolerance).
  const fromBonus = Math.min(a.moveBonus, charged);
  a.moveBonus -= fromBonus;
  a.moveBudget -= charged - fromBonus;
  a.swimming = swimming;
  if (grounded) groundMotion(a, len, now);
  return { ok: true, swimming, grounded, len, ground };
}

/**
 * How high the feet are above whatever holds them up (terrain or an intact prop top); 0 while
 * swimming. Used for bodies the client isn't moving (idle, lingering).
 */
export function heightAboveSupport(a: PlayerActor, w: MoveWorld): number {
  const x = a.state.x, y = a.state.y, z = a.state.z;
  const len = Math.hypot(x, y, z);
  const terrain = w.groundAt(x, y, z);
  if (swimmingAt(w, len, terrain)) return 0;
  return len - w.radius - supportAt(w, x, y, z, terrain);
}

/** Support vanished under a standing body (a prop broke): it falls from rest, from here. */
export function startFall(a: PlayerActor, now: number) {
  const len = Math.hypot(a.state.x, a.state.y, a.state.z);
  a.airborne = true;
  a.peakRadius = Math.max(a.peakRadius, len);
  a.airStartAt = now;
  a.airStartLen = len;
  a.airLiftV = 0;
}

/**
 * Server gravity: an airborne body above its envelope (silent client, refused steps) is pulled
 * down onto the envelope or the ground. Moves the actor and returns the new position, or null.
 */
export function settle(a: PlayerActor, w: MoveWorld, now: number): V3 | null {
  const x = a.state.x, y = a.state.y, z = a.state.z;
  const len = Math.hypot(x, y, z);
  const terrain = w.groundAt(x, y, z);
  if (swimmingAt(w, len, terrain)) return null;
  const ground = supportAt(w, x, y, z, terrain);
  if (len - w.radius - ground <= MOVE.groundedAbove) return null;
  const ceiling = airCeiling(a, now);
  if (len <= ceiling) return null;
  const floor = w.radius + (deepWater(ground, w.waterLevel) ? Math.max(ground, w.waterLevel - SWIM_FLOAT) : ground) + 0.02;
  const target = Math.max(floor, ceiling - MOVE.airSlack);
  if (target >= len) return null;
  const k = target / len;
  const p: V3 = [x * k, y * k, z * k];
  a.state.x = a.lastX = p[0];
  a.state.y = a.lastY = p[1];
  a.state.z = a.lastZ = p[2];
  // The envelope keeps running: only a grounded step from the client starts a new jump.
  return p;
}

/** Upward speed the envelope still allows the body at `now` (its launch speed less gravity, with the timing slack). */
function upwardSpeedLeft(a: PlayerActor, now: number): number {
  const t = Math.max(0, (now - a.airStartAt - MOVE.airTimeSlackMs) / 1000);
  return Math.max(0, a.airLiftV - MOVE.gravity * t);
}

/**
 * A shove: extra distance for a moment, and lift. The client adds 0.4 × strength to the vertical
 * velocity it already has, so shoves stack (F12 re-review S2): the envelope restarts here with the
 * upward speed the body may still have plus this impulse.
 */
export function noteKnockback(a: PlayerActor, strength: number, now: number) {
  if (strength <= 0) return;
  a.moveBonus += strength * 1.5;
  a.moveBonusUntil = Math.max(a.moveBonusUntil, now + MOVE.knockbackWindowMs);
  const v = upwardSpeedLeft(a, now) + strength * 0.4;
  a.airStartAt = now;
  a.airStartLen = Math.hypot(a.state.x, a.state.y, a.state.z);
  a.airLiftV = v;
}

/** Fresh motion state for a body placed at radius `len` (join, teleport). */
export function motionFields(len: number, now: number) {
  return {
    moveBudget: MOVE.budgetCap,
    lastBudgetAt: now,
    lastDodgeAt: 0,
    dodgeReserve: MOVE.dodgeBurst,
    moveBonus: 0,
    moveBonusUntil: 0,
    peakRadius: len,
    airborne: false,
    swimming: false,
    airStartAt: now,
    airStartLen: len,
    airLiftV: MOVE.jumpSpeed,
  };
}
