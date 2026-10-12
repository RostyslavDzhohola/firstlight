// Game event bus, one per room. The room emits what it already knows (damage, deaths, pickups,
// level-ups, travel); other lanes emit what only they know (NPC kills, boss kills, broken props,
// onboarding). Missions, medals and Easter eggs (world/quests) listen. Handlers run synchronously
// and are isolated: a throwing handler is logged and never breaks the emitter.
//
// The NPC lane's own process-wide events (npc/tuning.ts onNpcEvent: kill, bossKill, egg) are
// bridged onto this bus by the quests system (quests/QuestSystem.ts onNpcEvent), and the quests
// system honours `spawnRequest` through npcSystemOf(room). Any other lane can emit directly:
//
//   import { emitGameEvent } from "../events.ts";
//   emitGameEvent(room, {
//     type: "kill",
//     npcKind: "hopbit",              // content id (missions match on it: hopbit, cantor, associate, compliance_officer…)
//     killerId: lastHitterSessionId,  // player session id, or null
//     creditIds: [...],               // players credited (XP rule: ≥ 20% damage or the killing blow); defaults to [killerId]
//     area: "clover_fields",          // NPC spawn-area id, or pos: [x, y, z] (hunt missions with an area check use either)
//     bossId: "tidewrath",            // bosses only: "tidewrath" | "hollow_king" | "receiver"
//     // for bosses, creditIds = every LOOT-ELIGIBLE player (medals, Triple Crown, Hall of Firsts)
//   });
//   emitGameEvent(room, { type: "propBroken", playerId });      // destruction lane (Demolition Crew)
//   emitGameEvent(room, { type: "onboardingDone", playerId });  // onboarding (Spark)
//
// NPC kinds in damage/death events come from NpcActor.defId, else the NPC table entry for its
// NpcState.kind (npcKindOf).

import type { BodyId } from "@firstlight/shared";
import { NPC_DEFS } from "@firstlight/shared/content/npcs";
import type { BossId } from "@firstlight/shared/content/places";
import type { EggId } from "@firstlight/shared/content/secrets";
import type { NpcActor } from "./actors.ts";
import type { BodyRoom } from "./BodyRoom.ts";
import type { V3 } from "./geometry.ts";

/** NPC content id of an actor: its `defId`, else the NPC table entry for NpcState.kind. */
export function npcKindOf(n: NpcActor): string | undefined {
  return n.defId ?? NPC_DEFS[n.state.kind]?.id;
}

export interface KillEvent {
  type: "kill";
  /** NPC content id, e.g. "hopbit", "woolback", "tidewrath". */
  npcKind: string;
  npcId?: string;
  /** Session id of the player who landed the killing blow (null: environment, other NPC). */
  killerId: string | null;
  /** Players credited with the kill (default [killerId]). For bosses: every loot-eligible player. */
  creditIds?: string[];
  bossId?: BossId;
  level?: number;
  /** Where it died (hunt area checks by distance, Long Shot). */
  pos?: V3;
  /** NPC spawn-area id (npcs.ts NPC_AREAS), when it belonged to one: hunt areas match on it. */
  area?: string;
}

export interface DeathEvent {
  type: "death";
  victimId: string;
  /** Session id of the killing player, or NPC id; null for the world (falls, admin damage). */
  killerId: string | null;
  killerKind: "player" | "npc" | "world";
  /** NPC content id when an NPC killed the player (NpcActor.defId). */
  npcKind?: string;
  pos: V3;
}

export interface DamageEvent {
  type: "damage";
  targetId: string;
  targetKind: "player" | "npc";
  attackerId: string | null;
  attackerKind: "player" | "npc" | "world";
  /** NPC content id of the attacker (NpcActor.defId) or of the target when it is an NPC. */
  npcKind?: string;
  /** True when the NPC side is a boss. */
  boss?: boolean;
  amount: number;
  /** Target HP after the hit. */
  hpAfter: number;
  maxHp: number;
  at: number;
}

export interface PickupEvent {
  type: "pickup";
  playerId: string;
  pileId: string;
  pileOwnerUserId: string;
  pileCreatedAt: number;
  /** Items actually kept (full bags put the rest back on the ground). */
  items: number;
  coins: number;
}

export interface LevelUpEvent {
  type: "levelUp";
  playerId: string;
  level: number;
}

export interface TravelEvent {
  type: "travel";
  playerId: string;
  body: BodyId;
}

export interface PadDiscoveredEvent {
  type: "padDiscovered";
  playerId: string;
  pad: number;
}

/** A finished egg (the item is granted by the quests system). The NPC lane emits this for E3. */
export interface SecretFoundEvent {
  type: "secretFound";
  playerId: string;
  secretId: EggId;
}

/** A step of an egg that another lane observes, e.g. the Golden Hopbit reached its burrow (E3). */
export interface SecretStepEvent {
  type: "secretStep";
  playerId: string;
  secretId: EggId;
  step: string;
}

export interface PropBrokenEvent {
  type: "propBroken";
  /** Who broke it (session id), if a player did. */
  playerId: string | null;
  propId?: string;
}

export interface OnboardingDoneEvent {
  type: "onboardingDone";
  playerId: string;
}

export interface MissionDoneEvent {
  type: "missionDone";
  playerId: string;
  missionId: string;
}

export interface MedalEvent {
  type: "medal";
  playerId: string;
  medalId: string;
}

/** Ask the NPC lane to spawn something: egg penalties (E2 Hopbits, E5 Bonewalkers) or staged scenes. */
export interface SpawnRequestEvent {
  type: "spawnRequest";
  reason: "egg" | "stage";
  npcKind?: string;
  bossId?: BossId;
  count: number;
  pos: V3;
  /** The player who triggered it (eggs). */
  playerId?: string;
  /** The egg whose wrong answer raised it (penalty spawns are capped and expire). */
  egg?: EggId;
}

export type GameEvent =
  | KillEvent
  | DeathEvent
  | DamageEvent
  | PickupEvent
  | LevelUpEvent
  | TravelEvent
  | PadDiscoveredEvent
  | SecretFoundEvent
  | SecretStepEvent
  | PropBrokenEvent
  | OnboardingDoneEvent
  | MissionDoneEvent
  | MedalEvent
  | SpawnRequestEvent;

export type GameEventHandler = (e: GameEvent) => void;

const buses = new WeakMap<BodyRoom, Set<GameEventHandler>>();

/** Emit an event in a room. Returns how many handlers saw it. */
export function emitGameEvent(room: BodyRoom, e: GameEvent): number {
  const set = buses.get(room);
  if (!set) return 0;
  let n = 0;
  for (const h of [...set]) {
    try {
      h(e);
      n++;
    } catch (err) {
      console.error(`game event ${e.type} handler failed`, err);
    }
  }
  return n;
}

/** Listen to a room's events. Returns the unsubscribe function (call it in dispose). */
export function onGameEvent(room: BodyRoom, h: GameEventHandler): () => void {
  let set = buses.get(room);
  if (!set) {
    set = new Set();
    buses.set(room, set);
  }
  set.add(h);
  return () => set.delete(h);
}
