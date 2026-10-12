// Extension point: client systems (NPC rendering, effects, voice, HUD bits) created per body and
// updated every frame. Lanes add their factory to CLIENT_SYSTEMS.

import type { Game } from "./Game.ts";
import { npcClientSystem } from "../world/npcs/index.ts";
import { createQuestClient } from "./QuestClient.ts";
import { createVoiceSystem } from "../voice/index.ts";
import { createSkyClient } from "./SkyClient.ts";

export interface ClientSystem {
  update(dt: number, now: number): void;
  dispose(): void;
}

export type ClientSystemFactory = (game: Game) => ClientSystem | null;

export const CLIENT_SYSTEMS: ClientSystemFactory[] = [npcClientSystem, createVoiceSystem, createQuestClient, createSkyClient];
