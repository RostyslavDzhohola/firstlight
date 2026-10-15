// What covers a planet's pad-0 outpost ground (render-only: grass and natural-prop masks, D42): the
// outpost's site ground raster (siteGround.ts) in pad 0's frame (planet/sites.ts), from the paved
// apron round the pad, the paths and the structure footprints. Natural props also stay clear of the
// outpost's own trees. Visual only: nothing authoritative reads natural props (props.ts).

import { OUTPOSTS, type OutpostBody } from "../content/padOutposts.ts";
import type { BodyId } from "./bodies.ts";
import { buildGroundField, groundDistance, groundGrass, type GroundField } from "./siteGround.ts";

/** Raster cell (m), half extent (m) round pad 0 and the distance cap (m). */
export const OUTPOST_GROUND_CELL = 0.5;
export const OUTPOST_GROUND_HALF = 64;
export const OUTPOST_GROUND_MAX = 16;
/** The paved apron round every landing platform (m): no grass on it (the pad grass mask covers the other pads). */
export const PAD_APRON_RADIUS = 10.4;

const fields = new Map<OutpostBody, GroundField>();

function fieldOf(body: OutpostBody): GroundField {
  let f = fields.get(body);
  if (!f) {
    const site = OUTPOSTS[body];
    f = buildGroundField({
      cell: OUTPOST_GROUND_CELL,
      half: OUTPOST_GROUND_HALF,
      max: OUTPOST_GROUND_MAX,
      discs: [[0, 0, PAD_APRON_RADIUS]],
      strips: site.paths,
      areas: [],
      items: site.layout.map(([pi, east, north, yaw, scale]) => ({ solids: site.prefabs[pi]!.solids, east, north, yaw, scale })),
    });
    fields.set(body, f);
  }
  return f;
}

function isOutpostBody(body: BodyId): body is OutpostBody {
  return body === "arcadia" || body === "hollowmere" || body === "meridian";
}

/** Distance (m) from pad-0 site point (east, north) to the nearest apron, path or footprint (OUTPOST_GROUND_MAX far away). */
export function outpostGroundDistance(body: BodyId, east: number, north: number): number {
  return isOutpostBody(body) ? groundDistance(fieldOf(body), east, north) : OUTPOST_GROUND_MAX;
}

/** Grass factor 0..1 at a pad-0 site point: none on the apron, paths and footprints. */
export function outpostGrass(body: BodyId, east: number, north: number): number {
  return isOutpostBody(body) ? groundGrass(fieldOf(body), east, north) : 1;
}

/** May a natural prop stand here? Not within 3 m of the apron, a path or a structure, and not under an outpost tree. */
export function outpostPropClear(body: BodyId, east: number, north: number): boolean {
  if (!isOutpostBody(body)) return true;
  if (Math.abs(east) > OUTPOST_GROUND_HALF || Math.abs(north) > OUTPOST_GROUND_HALF) return true;
  if (groundDistance(fieldOf(body), east, north) < 3) return false;
  const site = OUTPOSTS[body];
  for (const [pi, e, n, , s] of site.layout) {
    const p = site.prefabs[pi]!;
    if (p.cls === "tree" && (e - east) ** 2 + (n - north) ** 2 < (p.radius * s + 1.5) ** 2) return false;
  }
  return true;
}
