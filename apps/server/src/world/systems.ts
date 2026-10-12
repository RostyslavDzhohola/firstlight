// Extension point: per-room systems (enemy AI, bosses, missions, destruction, voice…) that tick
// with the room. Each lane adds its factory to SYSTEM_FACTORIES; the room creates them on start.

import type { YouState } from "@firstlight/shared/net/protocol";
import type { PlayerActor } from "./actors.ts";
import type { BodyRoom } from "./BodyRoom.ts";
import { createDestructionSystem } from "./destruction.ts";
import { npcSystemFactory } from "./npc/index.ts";
import { createQuestSystem } from "./quests/QuestSystem.ts";
import { createVoiceSystem } from "./voice/index.ts";
import { createSkySystem } from "./SkySystem.ts";

export interface RoomSystem {
  /** Called every simulation tick (50 ms). */
  tick(dtMs: number, now: number): void;
  /** Optional: a player joined/left (sessionId). Leave runs once per session, when the client goes; its body may linger. */
  onPlayerJoin?(sessionId: string): void;
  onPlayerLeave?(sessionId: string): void;
  /** Optional: a player's body left this room's world for good (final leave, linger over, takeover, merge). Once per actor. */
  onBodyRemoved?(actor: PlayerActor): void;
  /** Optional: fill system-owned fields of the private `you` message before it is sent. */
  decorateYou?(actor: PlayerActor, you: YouState): void;
  /** Optional: handle an admin command the room doesn't know. Return true if handled. */
  onAdmin?(actor: PlayerActor, cmd: string, args: Record<string, unknown>): boolean;
  /** Optional: return false to refuse a dropped client's reconnection (kicked or banned players). */
  canReconnect?(sessionId: string): boolean;
  dispose?(): void;
}

export type SystemFactory = (room: BodyRoom) => RoomSystem | null;

export const SYSTEM_FACTORIES: SystemFactory[] = [npcSystemFactory, createVoiceSystem, createQuestSystem];
// Destruction lane: breakable props (per-copy HP, broken set, rebuilds; hooks combat via host.props).
SYSTEM_FACTORIES.push(createDestructionSystem);
// Weather + day/night lane: per-copy sky clock and weather schedule.
SYSTEM_FACTORIES.push(createSkySystem);
