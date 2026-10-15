// Minimap size and range (pure, unit-tested). Like the tutorial callouts (calloutPlace.ts), it reads
// the HUD's real rectangles: the minimap hangs from the top of the right column, and if that square
// would overlap the tutorial panel, the player card, the hotbar or the save card it shrinks, down to
// a minimum, then hides.

import type { BodyId } from "@firstlight/shared";
import type { Rect } from "./calloutPlace.ts";

const overlaps = (a: Rect, b: Rect) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;

/** The minimap's side (px) for this window width: ~11 % of it, 150…220. */
export function preferredMinimapSize(viewportWidth: number): number {
  return Math.round(Math.min(220, Math.max(150, viewportWidth * 0.11)));
}

/**
 * Side (px) of the minimap hanging from `anchor` (its top-right corner): the preferred size if it is
 * clear of every `avoid` rectangle and inside the window, else the largest clear size down to `min`,
 * else 0 (hidden).
 */
export function minimapSize(anchor: { right: number; top: number }, preferred: number, min: number, avoid: readonly (Rect | null)[], w: number, h: number): number {
  for (let s = preferred; s >= min; s -= 2) {
    const r = { left: anchor.right - s, top: anchor.top, right: anchor.right, bottom: anchor.top + s };
    if (r.left < 0 || r.bottom > h || r.right > w) continue;
    if (!avoid.some((a) => a && overlaps(r, a))) return s;
  }
  return 0;
}

/** Ground radius (m) the minimap shows: the walled town on Portus, more on the planets. */
export function minimapRange(body: BodyId): number {
  return body === "portus" ? 60 : 110;
}
