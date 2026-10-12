// Client NPC rendering (enemies, wildlife, bosses). Registered in CLIENT_SYSTEMS (game/systems.ts).

import type { ClientSystemFactory } from "../../game/systems.ts";
import { NpcRenderer } from "./NpcRenderer.ts";

export const npcClientSystem: ClientSystemFactory = (game) => (game.net.room ? new NpcRenderer(game) : null);

export { bossStore, type BossHud } from "./bossStore.ts";
