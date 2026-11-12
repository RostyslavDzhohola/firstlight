// The arrival title card (D-ui-2): entering a world shows its name in the wordmark's style, the one
// line the home page gives it, its recommended levels and a thin rule that draws itself; it fades as
// the player rezzes in and never takes input. This file is the pure part: what the card says, and
// when an arrival earns one. ui/momentsView.ts draws it.

import { BODIES, type BodyId } from "@firstlight/shared/planet/bodies";
import { worldLevels, worldLine } from "../home/homeModel.ts";

export interface ArrivalCard {
  body: BodyId;
  /** Small caps over the name. */
  kicker: string;
  name: string;
  line: string;
  /** "Levels 1–7", "Safe · Lv 1–2". */
  levels: string;
}

export function arrivalCard(body: BodyId): ArrivalCard {
  return {
    body,
    kicker: body === "portus" ? "The hub" : "Now entering",
    name: BODIES[body].name,
    line: worldLine(body),
    levels: worldLevels(body),
  };
}

/** How long the card holds (ms) before it fades; the whole stay is in, hold, out. */
export const ARRIVAL_HOLD_MS = 3200;

/**
 * Whether entering `body` earns a card: the first world of the session and every change of world
 * do; coming back into the same one (a reconnect, a rejoin after saving, a graphics re-warm, being
 * reborn where you stood) doesn't.
 */
export class ArrivalGate {
  private last: BodyId | null = null;

  arrive(body: BodyId): boolean {
    if (body === this.last) return false;
    this.last = body;
    return true;
  }
}
