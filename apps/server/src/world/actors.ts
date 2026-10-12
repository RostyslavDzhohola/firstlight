// Runtime records for everything that can be hit: players (with their character data) and NPCs.

import type { Client } from "@colyseus/core";
import type { CharacterData } from "@firstlight/shared/content/character";
import type { NpcState, PlayerState } from "@firstlight/shared/net/schema";
import type { Identity } from "../auth/identity.ts";
import type { V3 } from "./geometry.ts";

export interface PosSample {
  t: number;
  x: number;
  y: number;
  z: number;
}

export interface PlayerActor {
  kind: "player";
  id: string; // sessionId
  client: Client;
  identity: Identity;
  char: CharacterData;
  state: PlayerState;
  history: PosSample[];
  lastX: number;
  lastY: number;
  lastZ: number;
  lastMoveAt: number;
  joinedAt: number;
  violations: number;
  lastAttackAt: number;
  reloadEndsAt: number;
  heat: number;
  overheatUntil: number;
  blocking: boolean;
  combatUntil: number;
  protectedUntil: number;
  heals: { perSec: number; until: number }[];
  burn: { perSec: number; until: number; by: string } | null;
  healCooldownUntil: number;
  tonicCooldownUntil: number;
  logoutEndsAt: number | null;
  dead: boolean;
  diedAt: number;
  lastDamagedBy: string | null;
  youDirty: boolean;
  /** Minor private-state change (magazine count): send `you` soon, at most every YOU_LAZY_MS. */
  youLazy?: boolean;
  lastYouAt?: number;
  /** Retired by a newer session or an account merge: never save, never act. */
  superseded?: boolean;
  /** Leave hooks have run (BodyRoom.detach): no longer a connected player. */
  detached?: boolean;
  /** Body-removed hooks have run (BodyRoom.removeBody): gone from the room's world. */
  removed?: boolean;
  /** Logout countdown start position (cancel if moved > 0.5 m from it). */
  logoutFrom?: [number, number, number];
  loggedOut?: boolean;
  /** Movement budget (metres) refilled over time; dodge allowance once per cooldown (movement.ts). */
  moveBudget: number;
  lastBudgetAt: number;
  lastDodgeAt: number;
  /** One-off distance (dodge, knockback) usable until `moveBonusUntil`. */
  moveBonus: number;
  moveBonusUntil: number;
  /** Highest radius since last grounded (server-side fall damage). */
  peakRadius: number;
  airborne: boolean;
  swimming: boolean;
  /** Ballistic envelope while airborne: last grounded time and radius, and the launch speed allowed. */
  airStartAt: number;
  airStartLen: number;
  airLiftV: number;
  /** Server-side charge tracking (bow draw, heavy melee). */
  chargeStartedAt: number;
  specialReadyAt: number;
  lastPhraseAt: number;
  healAcc: number;
  /** Riding a horse (horses/HorseSystem). Movement allows horse speed, no dodge, no attacks. */
  mounted?: boolean;
  /** Mounted movement budget lasts until here after a dismount (the client learns a round trip later). */
  mountGraceUntil?: number;
  /** When `mounted` last changed (combat rewinds the rider's lifted hit capsule with the position). */
  mountChangedAt?: number;
  /** NPC status effects enforced by movement validation (see npc/effects.ts). */
  npcFx?: NpcMoveFx;
}

/** Movement effects from NPC attacks: chill/slow, Cease-and-Desist (no sprint, no dodge), Undertow pull. */
export interface NpcMoveFx {
  slow: number;
  slowUntil: number;
  noSprintUntil: number;
  pull: { c: V3; speed: number; until: number } | null;
}

export interface NpcActor {
  kind: "npc";
  id: string;
  /** Content id ("hopbit", "woolback", "tidewrath"…): death and damage events report it. */
  defId?: string;
  state: NpcState;
  history: PosSample[];
  radius: number;
  height: number;
  /** Called by combat when damaged; AI may react (aggro). */
  onDamaged?: (amount: number, by: string) => void;
  onKilled?: (by: string | null) => void;
  /** Extra damage multiplier (armour), 1 = none. */
  armour?: number;
  /**
   * Optional mitigation (replaces `armour`): shields, boss weak windows, invulnerable states.
   * Gets the damage after the weak-point multiplier and returns what to apply; ≤ 0 = no damage.
   */
  mitigate?: (amount: number, weak: boolean, fromDir?: V3) => number;
  /**
   * Weak-point test for a ray that hit this NPC's capsule at distance `t` (bosses: does the ray pass
   * through an exposed weak-point volume?). Replaces the generic "top of the capsule" test.
   */
  weakPoint?: (o: V3, d: V3, t: number) => boolean;
  /** Multiplier for weak-point hits on this NPC; replaces the weapon's headshot multiplier when set. */
  weakMult?: number;
  boss?: boolean;
}

export type Actor = PlayerActor | NpcActor;

export function actorPos(a: Actor): V3 {
  return [a.state.x, a.state.y, a.state.z];
}

export function pushHistory(a: Actor, now: number) {
  a.history.push({ t: now, x: a.state.x, y: a.state.y, z: a.state.z });
  if (a.history.length > 12) a.history.shift();
}

/** Position `ms` milliseconds ago (lag compensation), interpolated from the tick history. */
export function positionAgo(a: Actor, now: number, ms: number): V3 {
  const t = now - ms;
  const h = a.history;
  if (h.length === 0 || t >= h[h.length - 1]!.t) return actorPos(a);
  for (let i = h.length - 1; i > 0; i--) {
    const b = h[i]!, p = h[i - 1]!;
    if (t >= p.t) {
      const k = (t - p.t) / Math.max(1, b.t - p.t);
      return [p.x + (b.x - p.x) * k, p.y + (b.y - p.y) * k, p.z + (b.z - p.z) * k];
    }
  }
  const f = h[0]!;
  return [f.x, f.y, f.z];
}

/** Horses: riding, or just off the horse while the server still budgets horse speed for the
 *  client's in-flight inputs (HORSE.dismountGraceMs). No weapons, guard, draw or scope meanwhile. */
export function inSaddle(a: PlayerActor, now: number): boolean {
  return !!a.mounted || now < (a.mountGraceUntil ?? 0);
}

/** Was the player riding at time `t`? Changes are at least HORSE.toggleCooldownMs apart, longer than
 *  any rewind, so only the last one matters. */
export function mountedAt(a: PlayerActor, t: number): boolean {
  return t >= (a.mountChangedAt ?? 0) ? !!a.mounted : !a.mounted;
}
