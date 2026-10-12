// Extension point: per-room systems (enemy AI, bosses, missions, destruction, voice…) that tick
// with the room. Each lane adds its factory to SYSTEM_FACTORIES; the room creates them on start.

import type { BodyRoom } from "./BodyRoom.ts";
import { npcSystemFactory } from "./npc/index.ts";

export interface RoomSystem {
  /** Called every simulation tick (50 ms). */
  tick(dtMs: number, now: number): void;
  /** Optional: a player joined/left (sessionId). */
  onPlayerJoin?(sessionId: string): void;
  onPlayerLeave?(sessionId: string): void;
  /** Optional: return false to refuse a dropped client's reconnection (kicked or banned players). */
  canReconnect?(sessionId: string): boolean;
  dispose?(): void;
}

export type SystemFactory = (room: BodyRoom) => RoomSystem | null;

export const SYSTEM_FACTORIES: SystemFactory[] = [npcSystemFactory];
