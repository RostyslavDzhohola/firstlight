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
import { createMissionPointer } from "./MissionPointer.ts";
import { createSiteCompass } from "./siteCompass.ts";
import { createMissionObjects } from "./missionObjects.ts";
import { createMapClient } from "./MapClient.ts";
import { createAdminModeClient } from "./AdminModeClient.ts";
import { createTrialClient } from "./TrialClient.ts";
import { createSpellClient } from "./SpellClient.ts";
import { createHoloBoard } from "../world/HoloBoard.ts";
import { createLightPools } from "../world/lightPools.ts";
import { createTownLights } from "../world/townLights.ts";
import { createControlsClient } from "./controls.ts";
import { createMomentsClient } from "./MomentsClient.ts";
import { createNextSteps } from "./NextStepsClient.ts";

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
// The tracked hunt mission points at the creeps it counts (planets).
CLIENT_SYSTEMS.push(createMissionPointer);
// Horses lane: horses draw first (riders sit in the saddle before nameplates read their position)
// and take keys after the quests client (piles and world objects keep E when in reach).
CLIENT_SYSTEMS.unshift(horseClientSystem);
CLIENT_SYSTEMS.push(horseInputSystem);
// Map lane: the map atlas bake, the waypoint's world pillar and the HUD minimap.
CLIENT_SYSTEMS.push(createMapClient);
// Admin mode (D-admin-1): the Esc menu's Admin row, flying and speed from the server, the badge.
CLIENT_SYSTEMS.push(createAdminModeClient);
// Missions lane (2026-11-12): race / defend / collect markers, the trial clock strip and its sounds.
CLIENT_SYSTEMS.push(createTrialClient);
// Spells lane: the spellbook (Q / F / X / Z), its HUD bar and aether, and the spell effects.
CLIENT_SYSTEMS.push(createSpellClient);
// Hub graphics lane (D-gfx-hub-3): the hologram scoreboard in Portus' plaza.
CLIENT_SYSTEMS.push(createHoloBoard);
// Hub graphics lane (D-gfx-hub-6): lamp and portal light pools on Portus' ground.
CLIENT_SYSTEMS.push(createLightPools);
// Hub graphics lane (D-gfx-hub-8): lantern halos, portal glow and lantern motes in Portus.
CLIENT_SYSTEMS.push(createTownLights);
// Controls lane (D-controls-5): gamepad rumble on damage and kills, and the aim slowdown's creep test.
CLIENT_SYSTEMS.push(createControlsClient);
// Look-and-feel lane (D-ui-2…5): the arrival card, earned banners, the event feed, hit direction and the spell hint.
CLIENT_SYSTEMS.push(createMomentsClient);
// "What next" hints after the tutorial (D-polish-ux-3).
CLIENT_SYSTEMS.push(createNextSteps);
// Mission objects say what they are (#86): the label over the ring, beacon or piece you look at.
CLIENT_SYSTEMS.push(createMissionObjects);
// World lane: undiscovered wild sites within sight as "?" on the compass.
CLIENT_SYSTEMS.push(createSiteCompass);
