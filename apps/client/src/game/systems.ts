// Extension point: client systems (NPC rendering, effects, voice, HUD bits) created per body and
// updated every frame. Lanes add their factory to CLIENT_SYSTEMS.

import type { Game } from "./Game.ts";
import { npcClientSystem } from "../world/npcs/index.ts";
import { createQuestClient } from "./QuestClient.ts";
import { createVoiceSystem } from "../voice/index.ts";
import { horseClientSystem, horseInputSystem } from "./HorseClient.ts";

export interface ClientSystem {
  update(dt: number, now: number): void;
  dispose(): void;
}

export type ClientSystemFactory = (game: Game) => ClientSystem | null;

// Horses draw first (riders sit in the saddle before nameplates read their position) and take keys
// last (piles and world objects keep E when in reach).
export const CLIENT_SYSTEMS: ClientSystemFactory[] = [horseClientSystem, npcClientSystem, createVoiceSystem, createQuestClient, horseInputSystem];
