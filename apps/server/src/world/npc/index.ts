// Enemies, wildlife and bosses (SPEC §6.4–6.5). The room creates one NpcSystem per body copy.

import type { BodyRoom } from "../BodyRoom.ts";
import type { SystemFactory } from "../systems.ts";
import { NpcSystem } from "./NpcSystem.ts";
import { roomWorld } from "./world.ts";

const byRoom = new WeakMap<BodyRoom, NpcSystem>();

export const npcSystemFactory: SystemFactory = (room) => {
  const sys = new NpcSystem(roomWorld(room));
  byRoom.set(room, sys);
  return sys;
};

/** The NPC system of a room (for other systems: missions, eggs, staged scenes). */
export function npcSystemOf(room: BodyRoom): NpcSystem | undefined {
  return byRoom.get(room);
}

export { NpcSystem } from "./NpcSystem.ts";
export { NPC_TUNING, resetTuning, onNpcEvent, type NpcEvent } from "./tuning.ts";
