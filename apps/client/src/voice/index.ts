// Voice lane entry: the client system factory (registered in CLIENT_SYSTEMS) and the API other UI
// (pause menu, the Tab player list) uses: open the panel, mute/block/report, speaking levels.

import { features } from "../config.ts";
import type { ClientSystemFactory } from "../game/systems.ts";
import type { Game } from "../game/Game.ts";
import { VoiceClient, VoiceRoom } from "./VoiceClient.ts";

let client: VoiceClient | null = null;

/** The page's voice client (created with the first room). */
export function voice(): VoiceClient | null {
  return client;
}

export const createVoiceSystem: ClientSystemFactory = (game: Game) => {
  // Hidden in this build (features.voice, D-controls-1): no client, so no V key, no mic prompt, no pill.
  if (!features.voice) return null;
  const room = game.net.room;
  if (!room || typeof RTCPeerConnection === "undefined" || typeof AudioContext === "undefined") return null;
  client ??= new VoiceClient(game);
  return new VoiceRoom(client, game, room);
};

/** Open the Voice & radio panel (opt-in first time). */
export function openVoicePanel(): void {
  client?.ui.openPanel();
}

export type { VoiceClient, VoicePeerInfo } from "./VoiceClient.ts";
