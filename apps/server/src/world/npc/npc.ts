// Runtime record of one NPC: the combat-facing NpcActor plus AI state.

import type { AttackDef, NpcDef } from "@firstlight/shared/content/npcs";
import type { NpcActor, PlayerActor } from "../actors.ts";
import type { V3 } from "../geometry.ts";
import type { SpawnPoint } from "./spawns.ts";

export const MODE = {
  SPAWN: 0,
  IDLE: 1,
  WANDER: 2,
  NOTICE: 3,
  CHASE: 4,
  WINDUP: 5,
  ACTIVE: 6,
  RECOVER: 7,
  EVADE: 8,
  FLEE: 9,
  STUN: 10,
  DEAD: 11,
  CHANNEL: 12,
  HOWL: 13,
  RETURN: 14,
  SCRIPT: 15,
} as const;
export type Mode = (typeof MODE)[keyof typeof MODE];

export const MODE_NAME: Record<number, string> = Object.fromEntries(Object.entries(MODE).map(([k, v]) => [v, k.toLowerCase()]));

export interface ActiveAttack {
  def: AttackDef;
  index: number;
  start: number;
  resolveAt: number;
  origin: V3;
  dir: V3;
  /** Circle centres (circle/field) or the landing point (leap). */
  points: V3[];
  /** Players whose position the telegraph follows until lock. */
  tracked: string[];
  lockAt: number;
  locked: boolean;
  targetId: string | null;
  resolved: boolean;
  /** Active phase (charges, bursts, damage ticks, beams). */
  activeUntil: number;
  travelled: number;
  hitIds: Set<string>;
  nextTickAt: number;
  ticksLeft: number;
  /** Second wedge (Hollow King P3 double sweep). */
  repeatAt: number;
  repeatDir: V3 | null;
  /** Burst aim history sample. */
  aim: V3 | null;
}

/** Damage credit per account (Npc.damage is keyed by userId): HP actually removed, last session id. */
export interface DamageEntry {
  amount: number;
  userId: string;
  sid: string;
  name: string;
}

export interface Npc extends NpcActor {
  def: NpcDef;
  defIndex: number;
  level: number;
  point: SpawnPoint | null;
  member: number;
  pos: V3;
  home: V3;
  /** Leash anchor: home for packs and camps, the spot where combat started for roamers. */
  anchor: V3;
  roam: number;
  facing: V3;
  mode: Mode;
  modeAt: number;
  modeUntil: number;
  target: PlayerActor | null;
  lastSeenAt: number;
  lastLosAt: number;
  damage: Map<string, DamageEntry>;
  attack: ActiveAttack | null;
  cooldowns: number[];
  token: { target: string; ranged: boolean; until: number } | null;
  goal: V3 | null;
  nextThink: number;
  stunUntil: number;
  shieldHp: number;
  shieldMax: number;
  scatterUntil: number;
  removeAt: number;
  raiseNext: number;
  raised: Set<string>;
  summoner: string | null;
  howled: boolean;
  fleeFrom: V3 | null;
  regroupAt: number;
  /** Distance to the nearest live player, refreshed every tick (LOD and perception). */
  nearD: number;
  lod: number;
  lastUpdate: number;
  hpAcc: number;
  /** Brightbits' current 90° movement axis (0–3), −1 = none. */
  gridAxis: number;
  strafeSign: number;
  /** Since when the chased target has stood where this NPC can't reach it (brain.ts), if it has. */
  unreachSince?: number;
  /** Golden Hopbit / Ticket #000 bookkeeping. */
  egg?: { follower: string | null; since: number; walker?: string; walkFrom?: V3; walkDir?: V3 };
  /**
   * Raised by a wrong egg-puzzle answer (reason "egg", key = egg id) or an admin staged scene (reason
   * "stage"): capped per player and room, they expire, and share one repeat-kill decay key.
   */
  spawned: { reason: "egg" | "stage"; key: string; userId: string } | null;
  /** Dissolves (no rewards) at this time; 0 = never. Egg penalty and stage spawns expire. */
  expiresAt: number;
  dead: boolean;
}
