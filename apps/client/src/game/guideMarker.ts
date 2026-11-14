// The way to a planet's guide on the compass (play-through 2026-11-14): a new player arriving on
// Arcadia from the tutorial saw only PAD; Lark, who gives the first missions, wasn't marked anywhere.
// While no tracked mission points somewhere on this body and the guide still has missions the
// player hasn't taken or finished this life, the compass marks the guide. Pure, tested in node.

import type { BodyId } from "@firstlight/shared";
import { GUIDES, missionsFrom } from "@firstlight/shared/content/missions";

/** The guide the compass should point at, or null. */
export function guideToVisit(body: BodyId, held: readonly { id: string; done: boolean }[], missionMarked: boolean): { id: string; name: string } | null {
  if (missionMarked || body === "portus") return null;
  const g = GUIDES[body as Exclude<BodyId, "portus">];
  if (!g) return null;
  const seen = new Set(held.map((m) => m.id));
  return missionsFrom(g.id).some((m) => !seen.has(m.id)) ? { id: g.id, name: g.name } : null;
}
