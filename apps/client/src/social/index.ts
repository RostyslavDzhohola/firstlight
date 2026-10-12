// Social layer entry point (SPEC §6.10–6.12): importing it registers the per-room client system.
// Game calls installSocial(game) once at start; the store (./store.ts) is the API for other lanes.

import "./social.css";
import type { Game } from "../game/Game.ts";
import { CLIENT_SYSTEMS } from "../game/systems.ts";
import { isRemoval, showQueue, showRemoved } from "./screens.ts";
import { SocialUi } from "./SocialUi.ts";

let ui: SocialUi | null = null;

/** Create the persistent social UI and hook the queue/refusal screens into the network layer. */
export function installSocial(game: Game): SocialUi {
  if (!ui) {
    ui = new SocialUi(game);
    game.net.onQueue = showQueue;
    game.net.onRefused = (reason) => showRemoved(reason);
  }
  return ui;
}

/** The room closed because an admin removed us or we joined elsewhere: show why, don't auto-rejoin. */
export function removedFromWorld(code: number): boolean {
  if (!isRemoval(code)) return false;
  showRemoved(code);
  return true;
}

CLIENT_SYSTEMS.push((game) => installSocial(game).attachRoom());

export { partyRoomOn } from "./store.ts";
