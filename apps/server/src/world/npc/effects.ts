// Movement effects from NPC attacks, enforced by the server (review blocker: never trust the client):
// - chill (Marsh Wisp, −20% for 2 s) and slow (Grave Hands, −50% for 1.5 s) scale the movement budget;
// - Cease-and-Desist (Compliance Officer) caps speed at a run and refuses dodge bursts for 3 s;
// - Undertow (Tidewrath) drags the authoritative position toward the whirlpool every tick.
// BodyRoom.handleInput asks movementLimits(); NpcSystem applies effects and simulates pulls.

import type { StatusEffect } from "@firstlight/shared/content/npcs";
import type { NpcMoveFx, PlayerActor } from "../actors.ts";
import type { V3 } from "../geometry.ts";

/** Run and sprint speeds (content §0): no-sprint caps the budget at run speed. */
const RUN = 6;
const SPRINT = 9;

function fxOf(a: PlayerActor): NpcMoveFx {
  a.npcFx ??= { slow: 0, slowUntil: 0, noSprintUntil: 0, pull: null };
  return a.npcFx;
}

/** Apply a movement effect to a player (other effect kinds are ignored here). */
export function applyMoveEffect(a: PlayerActor, e: StatusEffect, now: number) {
  if (e.kind === "chill" || e.kind === "slow") {
    const fx = fxOf(a);
    const until = now + e.seconds * 1000;
    const amount = Math.max(0, Math.min(1, e.amount));
    // The stronger slow wins; an equal one extends; a weaker one is ignored while the stronger lasts.
    if (now >= fx.slowUntil || amount > fx.slow) {
      fx.slow = amount;
      fx.slowUntil = until;
    } else if (amount === fx.slow) fx.slowUntil = Math.max(fx.slowUntil, until);
  } else if (e.kind === "nosprint") {
    const fx = fxOf(a);
    fx.noSprintUntil = Math.max(fx.noSprintUntil, now + e.seconds * 1000);
  }
}

/** Start or extend an Undertow pull toward `c` at `speed` m/s. */
export function applyPull(a: PlayerActor, c: V3, speed: number, ms: number, now: number) {
  fxOf(a).pull = { c, speed, until: now + ms };
}

/**
 * Speed factor for the movement budget's refill (1 = normal) and the dodge allowance factor
 * (0 = dodge refused) for this player right now.
 */
export function movementLimits(a: PlayerActor, now: number): { speed: number; dodge: number } {
  const fx = a.npcFx;
  if (!fx) return { speed: 1, dodge: 1 };
  const slow = now < fx.slowUntil ? fx.slow : 0;
  const noSprint = now < fx.noSprintUntil;
  return { speed: (noSprint ? RUN / SPRINT : 1) * (1 - slow), dodge: noSprint ? 0 : 1 - slow };
}

/** The active pull, if any. */
export function activePull(a: PlayerActor, now: number): NpcMoveFx["pull"] {
  const p = a.npcFx?.pull ?? null;
  return p && now < p.until ? p : null;
}
