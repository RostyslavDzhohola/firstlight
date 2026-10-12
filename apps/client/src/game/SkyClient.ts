// Client side of the sky (SPEC §6.14 #3/#4): registers the "sky" handler, then asks the server for
// the copy's sky (client systems are created after join, so a message pushed on join could arrive
// before the handler exists). Re-syncs every SKY_SYNC_MS to correct clock drift. The render side
// (render/environment.ts) extrapolates between messages and runs offline from the same schedule.

import { SKY_SYNC_MS, type SkyState } from "@firstlight/shared";
import type { Game } from "./Game.ts";
import type { ClientSystem } from "./systems.ts";

export class SkyClient implements ClientSystem {
  private nextSync = 0;

  constructor(private readonly game: Game) {
    const room = game.net.room!;
    room.onMessage("sky", (m: SkyState) => game.env.setServerSky(m));
    this.sync();
  }

  private sync() {
    this.game.net.room?.send("skySync", {});
    this.nextSync = performance.now() + SKY_SYNC_MS;
  }

  update(_dt: number, now: number) {
    if (now >= this.nextSync) this.sync();
  }

  dispose() {}
}

export const createSkyClient = (game: Game): ClientSystem | null => (game.net.room ? new SkyClient(game) : null);
