// Map lane client system (also offline): starts the body's map atlas bake on arrival, keeps the
// waypoint's light pillar in the world and clears the waypoint when you reach it, and draws the
// HUD minimap. The map panel itself (M) lives with the quests client (ui/map.ts).

import type { ClientSystem, ClientSystemFactory } from "./systems.ts";
import type { Game } from "./Game.ts";
import { mapAtlas } from "../ui/mapAtlas.ts";
import { Minimap } from "../ui/minimap.ts";
import { waypoints } from "../ui/waypoint.ts";
import { WaypointBeacon } from "../world/WaypointBeacon.ts";

class MapClient implements ClientSystem {
  readonly minimap: Minimap;
  private readonly beacon: WaypointBeacon;
  private readonly off: () => void;

  constructor(private readonly game: Game) {
    const p = game.player.pos;
    const l = p.length() || 1;
    mapAtlas.bake(game.bodyId, [p.x / l, p.y / l, p.z / l]);
    this.beacon = new WaypointBeacon(game.ctx.scene, game.planet.terrain, game.planet.body.radius);
    this.beacon.set(waypoints.get(game.bodyId));
    this.off = waypoints.onChange((body, dir) => {
      if (body === this.game.bodyId) this.beacon.set(dir);
    });
    this.minimap = new Minimap(game, game.hud.minimapSlot);
  }

  update() {
    const g = this.game;
    const p = g.player.pos;
    if (waypoints.arrive(g.bodyId, [p.x, p.y, p.z], g.planet.body.radius)) g.hud.toast("Waypoint reached", "info");
    this.beacon.update(g.ctx.camera.position);
    this.minimap.update();
  }

  dispose() {
    this.off();
    this.beacon.dispose();
    this.minimap.dispose();
  }
}

export const createMapClient: ClientSystemFactory = (game) => new MapClient(game);
createMapClient.offline = true;
