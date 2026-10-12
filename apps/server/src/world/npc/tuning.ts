// Knobs for the NPC system. Exported and mutable so tests (and staged scenes) can shorten timers;
// production keeps the defaults from docs/content.md via NPC_RULES.

import { NPC_RULES } from "@firstlight/shared/content/npcs";

export const NPC_TUNING = {
  /** Ambient spawns (camps, packs, wildlife, beasts). Tests turn this off to work with admin spawns only. */
  ambient: true,
  /** Bosses spawn at their lairs when someone comes near. */
  bosses: true,
  /** Spawn points activate when a player is this close (m) … */
  activateRadius: 200,
  /** … and despawn after nobody has been within this radius for despawnAfterMs. */
  despawnRadius: 230,
  despawnAfterMs: 30_000,
  /** Activation pass interval (ms). */
  scanMs: 500,
  /** Multiplies every respawn delay (pack/camp/beast). */
  respawnScale: 1,
  leash: NPC_RULES.leash as number,
  lostSightMs: NPC_RULES.lostSightSeconds * 1000,
  /** Bosses: respawn delay, empty-arena reset, and attack control for tests. */
  bossRespawnMs: NPC_RULES.respawnBoss * 1000,
  bossResetMs: 30_000,
  bossSpawnRadius: 220,
  /** Regular boss attack rotation on/off. Timed mechanics are controlled by bossMechanics. */
  bossAttacks: true,
  /** Timed mechanics (surges, judgements, summons); null = all, or a list of attack ids. */
  bossMechanics: null as null | string[],
  /** Multiplies timed-mechanic intervals; firstMechanicMs overrides the first delay after engage. */
  bossEveryScale: 1,
  firstMechanicMs: null as null | number,
  /** Window after which the anti-solo regen starts (ms), from BossDef.regen.after. */
  regenAfterMs: null as null | number,
};

export const DEFAULT_TUNING = { ...NPC_TUNING };

export function resetTuning() {
  Object.assign(NPC_TUNING, DEFAULT_TUNING);
}

/** Hooks for other lanes: eggs (Golden Hopbit, Ticket #000), Hall of Firsts, missions (hunt kills). */
export type NpcEvent =
  | { kind: "kill"; body: string; def: string; npcLevel: number; players: string[]; userIds: string[]; area: string | null }
  | { kind: "egg"; body: string; egg: "E3" | "E9"; sessionId: string; userId: string }
  | { kind: "bossKill"; body: string; boss: string; sessionIds: string[]; userIds: string[]; names: string[] };

type Listener = (e: NpcEvent) => void;
const listeners = new Set<Listener>();
export function onNpcEvent(l: Listener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}
export function emitNpcEvent(e: NpcEvent) {
  for (const l of listeners) {
    try {
      l(e);
    } catch (err) {
      console.error("npc event listener failed", err);
    }
  }
}
