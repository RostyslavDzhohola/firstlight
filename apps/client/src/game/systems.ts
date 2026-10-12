// Extension point: client systems (NPC rendering, effects, voice, HUD bits) created per body and
// updated every frame. Lanes add their factory to CLIENT_SYSTEMS.

import type { Game } from "./Game.ts";
import { npcClientSystem } from "../world/npcs/index.ts";
import { createVoiceSystem } from "../voice/index.ts";

export interface ClientSystem {
  update(dt: number, now: number): void;
  dispose(): void;
}

export type ClientSystemFactory = (game: Game) => ClientSystem | null;

export const CLIENT_SYSTEMS: ClientSystemFactory[] = [npcClientSystem, createVoiceSystem];
