// Extension point: client systems (NPC rendering, effects, voice, HUD bits) created per body and
// updated every frame. Lanes add their factory to CLIENT_SYSTEMS.

import type { Game } from "./Game.ts";
import { npcClientSystem } from "../world/npcs/index.ts";
import { createQuestClient } from "./QuestClient.ts";
import { createVoiceSystem } from "../voice/index.ts";
import { createBreakables } from "../world/Breakables.ts";
import { createSkyClient } from "./SkyClient.ts";
import { createInventoryClient } from "./InventoryClient.ts";
import { createOnboardingClient } from "./OnboardingClient.ts";
import { horseClientSystem, horseInputSystem } from "./HorseClient.ts";
import { createMapClient } from "./MapClient.ts";

export interface ClientSystem {
  update(dt: number, now: number): void;
  dispose(): void;
}

/** `offline: true` factories also run without a server (?offline, ?bench); the rest need a room. */
export type ClientSystemFactory = ((game: Game) => ClientSystem | null) & { offline?: boolean };

export const CLIENT_SYSTEMS: ClientSystemFactory[] = [npcClientSystem, createVoiceSystem, createQuestClient];
// Destruction lane: breakable props (intact meshes, debris, rebuild effect).
CLIENT_SYSTEMS.push(createBreakables);
// Weather + day/night lane: server sky sync (the environment runs offline from the shared schedule).
CLIENT_SYSTEMS.push(createSkyClient);
// Inventory panel (I): move, drop, use and wear from the hotbar and backpack.
CLIENT_SYSTEMS.push(createInventoryClient);
// Onboarding (Portus): training dummies and the first-minute tutorial HUD.
CLIENT_SYSTEMS.push(createOnboardingClient);
// Horses lane: horses draw first (riders sit in the saddle before nameplates read their position)
// and take keys after the quests client (piles and world objects keep E when in reach).
CLIENT_SYSTEMS.unshift(horseClientSystem);
CLIENT_SYSTEMS.push(horseInputSystem);
// Map lane: the map atlas bake, the waypoint's world pillar and the HUD minimap.
CLIENT_SYSTEMS.push(createMapClient);
