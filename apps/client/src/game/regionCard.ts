// The region card (#7): walking from one named region of a planet into another (Clover Meadows into
// Fernshade Wood) shows the region's name in a small version of the arrival card. Debounced: you must
// be a little way inside the new region (not on its wobbly border) and cards are spaced out, so a walk
// along a border or a quick back-and-forth never flickers them.

import { BODIES, type BodyId } from "@firstlight/shared";
import { REGION_KINDS, regionHit, type RegionHit } from "@firstlight/shared/planet/regions";
import type { ArrivalCard } from "../ui/arrivalCard.ts";
import type { Game } from "./Game.ts";
import type { ClientSystem } from "./systems.ts";

/** Metres inside a region before it counts as entered. */
export const REGION_ENTER_M = 10;
/** No region card within this long of the last card (or of arriving in the world). */
export const REGION_CARD_GAP_MS = 9000;
/** How often the player's region is looked up. */
const PICK_MS = 400;

/** The pure part: which region the player is in, and when walking into one earns a card. */
export class RegionGate {
  private current = -1;
  private lastCard: number;

  constructor(now: number) {
    // Arriving shows the world's own card: hold region cards until it has gone.
    this.lastCard = now;
  }

  /** Feed a lookup; returns the region kind to announce, or -1. */
  step(hit: RegionHit | null, now: number): number {
    if (!hit) return -1;
    if (this.current < 0) {
      this.current = hit.kind; // the region you arrive in is named by the world's card
      return -1;
    }
    if (hit.kind === this.current || hit.edge < REGION_ENTER_M) return -1;
    this.current = hit.kind;
    if (now - this.lastCard < REGION_CARD_GAP_MS) return -1;
    this.lastCard = now;
    return hit.kind;
  }
}

export function regionCard(body: BodyId, kind: number): ArrivalCard {
  const k = REGION_KINDS[body][kind]!;
  return { body, kicker: BODIES[body].name, name: k.name, line: k.line, levels: "", region: true };
}

class RegionCards implements ClientSystem {
  private readonly gate: RegionGate;
  private readonly hit: RegionHit = { cell: 0, kind: 0, other: 0, edge: 0 };
  private pickedAt = -Infinity;

  constructor(private readonly game: Game, now: number) {
    this.gate = new RegionGate(now);
  }

  update(_dt: number, now: number) {
    if (now - this.pickedAt < PICK_MS) return;
    this.pickedAt = now;
    const g = this.game;
    const p = g.player.pos;
    const kind = this.gate.step(regionHit(g.bodyId, p.x, p.y, p.z, this.hit), now);
    if (kind >= 0) g.hud.moments.arrival(regionCard(g.bodyId, kind));
  }

  dispose() {}
}

/** Worlds with regions (not Portus); not on benches. Offline too: regions need no server. */
export function createRegionCards(game: Game): ClientSystem | null {
  if (game.bench || REGION_KINDS[game.bodyId].length === 0) return null;
  return new RegionCards(game, performance.now());
}
createRegionCards.offline = true;
