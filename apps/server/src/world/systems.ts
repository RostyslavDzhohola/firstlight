// Extension point: per-room systems (enemy AI, bosses, missions, destruction, voice…) that tick
// with the room. Each lane adds its factory to SYSTEM_FACTORIES; the room creates them on start.

import type { BodyRoom } from "./BodyRoom.ts";
import { createDestructionSystem } from "./destruction.ts";

export interface RoomSystem {
  /** Called every simulation tick (50 ms). */
  tick(dtMs: number, now: number): void;
  /** Optional: a player joined/left (sessionId). */
  onPlayerJoin?(sessionId: string): void;
  onPlayerLeave?(sessionId: string): void;
  dispose?(): void;
}

export type SystemFactory = (room: BodyRoom) => RoomSystem | null;

export const SYSTEM_FACTORIES: SystemFactory[] = [];
// Destruction lane: breakable props (per-copy HP, broken set, rebuilds; hooks combat via host.props).
SYSTEM_FACTORIES.push(createDestructionSystem);
