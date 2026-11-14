// Undiscovered wild sites on the compass (lane world, 2026-11-13): a "?" with its distance for each
// site this life hasn't found (you.sites) that is within sight: SITE_SIGHT_M, or LANDMARK_SIGHT_M for a
// planet's landmark (a 24–40 m arch, tree or hull seen from far off). Off the strip it hides, unlike
// the mission's marker: a hint about what's out there, not a way to follow. Found sites leave the
// compass; the map shows them (ui/map.ts).

import type { Terrain } from "@firstlight/shared";
import { wildSitePlacements } from "@firstlight/shared/planet/wildSites";
import { compassGuides, type CompassMarker } from "../social/compass.ts";
import type { Game } from "./Game.ts";
import type { ClientSystem } from "./systems.ts";

export const SITE_SIGHT_M = 300;
export const LANDMARK_SIGHT_M = 600;
/** Bronze, like the found sites' diamonds on the map. */
export const SITE_MARKER_COLOUR = "#e0a458";

/** The "?" markers for player feet at `pos` on `terrain`'s body, given the sites found this life. */
export function siteCompassMarkers(terrain: Terrain, pos: readonly number[], found: ReadonlySet<string>): CompassMarker[] {
  const out: CompassMarker[] = [];
  for (const ws of wildSitePlacements(terrain)) {
    if (found.has(ws.site.id)) continue;
    const r = terrain.body.radius + ws.base;
    const at: [number, number, number] = [ws.dir[0] * r, ws.dir[1] * r, ws.dir[2] * r];
    const sight = ws.site.kind === "landmark" ? LANDMARK_SIGHT_M : SITE_SIGHT_M;
    if (Math.hypot(at[0] - pos[0]!, at[1] - pos[1]!, at[2] - pos[2]!) > sight) continue;
    out.push({ key: `site:${ws.site.id}`, label: "?", colour: SITE_MARKER_COLOUR, pos: at, kind: "site" });
  }
  return out;
}

class SiteCompass implements ClientSystem {
  private markers: CompassMarker[] = [];
  private pickedAt = -Infinity;
  private readonly guide = () => this.markers;

  constructor(private readonly game: Game) {
    compassGuides.add(this.guide);
  }

  update(_dt: number, now: number) {
    if (now - this.pickedAt < 500) return;
    this.pickedAt = now;
    const g = this.game;
    const p = g.player.pos;
    this.markers = siteCompassMarkers(g.planet.terrain, [p.x, p.y, p.z], new Set(g.hud.you?.sites ?? []));
  }

  dispose() {
    compassGuides.delete(this.guide);
  }
}

/** Planets with wild sites only. */
export function createSiteCompass(game: Game): ClientSystem | null {
  return game.net.room && wildSitePlacements(game.planet.terrain).length > 0 ? new SiteCompass(game) : null;
}
