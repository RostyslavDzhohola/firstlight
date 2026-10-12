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
