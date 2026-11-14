// Ambient wildlife (#7) in play: the planet's Wildlife (world/wildlife.ts) follows the player, scans
// twice a second and draws through the NPC layer's part batcher (no draw calls of its own).

import { atmo } from "../render/atmosphere.ts";
import { partDrawers, type PartBatcher } from "../world/npcs/parts.ts";
import { WILDLIFE, Wildlife } from "../world/wildlife.ts";
import type { Game } from "./Game.ts";
import type { ClientSystem } from "./systems.ts";

const SCAN_MS = 500;

class WildlifeClient implements ClientSystem {
  readonly life: Wildlife;
  private scannedAt = -Infinity;
  private readonly drawer = (batch: PartBatcher, dt: number, now: number) => this.life.draw(batch, dt, now);

  constructor(private readonly game: Game) {
    this.life = new Wildlife(game.bodyId, game.planet.terrain);
    partDrawers.add(this.drawer);
  }

  update(dt: number, now: number) {
    const p = this.game.player.pos;
    this.life.setPlayer(p.x, p.y, p.z, dt);
    this.life.night = atmo.nightRim.value as number;
    if (now - this.scannedAt >= SCAN_MS) {
      this.scannedAt = now;
      this.life.scan();
    }
  }

  dispose() {
    partDrawers.delete(this.drawer);
  }
}

/** Planets with wildlife, online (the NPC layer that draws it needs a room); not on benches. */
export function createWildlife(game: Game): ClientSystem | null {
  if (!game.net.room || game.bench || WILDLIFE[game.bodyId].length === 0) return null;
  return new WildlifeClient(game);
}
