// What covers the Portus town ground (render-only: grass and natural-prop masks, D38): the town's site
// ground raster (siteGround.ts) in the town frame (planet/town.ts: east/north metres at the pole), from
// paved ground (plaza, streets, the castle ward, portal court floors) and structure footprints.

import { TOWN_AREAS, TOWN_FIXED, TOWN_LAYOUT, TOWN_PLAZA_PAVED, TOWN_PORTAL_FLOOR, TOWN_PREFABS, TOWN_STREETS } from "../content/portusTown.ts";
import { buildGroundField, groundDistance, groundGrass, type GroundField } from "./siteGround.ts";

/** Raster cell size (m) and half extent (m) around the pole. */
export const TOWN_GROUND_CELL = 0.5;
export const TOWN_GROUND_HALF = 96;
/** Distances are capped here (m): everything farther reads as this. */
export const TOWN_GROUND_MAX = 24;

let field: GroundField | null = null;

function townField(): GroundField {
  return (field ??= buildGroundField({
    cell: TOWN_GROUND_CELL,
    half: TOWN_GROUND_HALF,
    max: TOWN_GROUND_MAX,
    discs: [[0, 0, TOWN_PLAZA_PAVED], ...Object.values(TOWN_FIXED.portals).map((p) => [p[0], p[1], TOWN_PORTAL_FLOOR] as const)],
    strips: TOWN_STREETS,
    areas: TOWN_AREAS,
    items: TOWN_LAYOUT.map(([pi, east, north, yaw, scale]) => ({ solids: TOWN_PREFABS[pi]!.solids, east, north, yaw, scale })),
  }));
}

/**
 * Distance (m) from town point (east, north) to the nearest paved ground or structure footprint:
 * 0 on them, TOWN_GROUND_MAX far away (and outside the raster).
 */
export function townGroundDistance(east: number, north: number): number {
  return groundDistance(townField(), east, north);
}

/** Grass factor 0..1 at a town point: none on paving and footprints, full from 0.6 m off them. */
export function townGrass(east: number, north: number): number {
  return groundGrass(townField(), east, north);
}

/** Town trees (layout items of class "tree"): [east, north, crown radius]. */
const TOWN_TREES: readonly (readonly [number, number, number])[] = TOWN_LAYOUT.filter((it) => TOWN_PREFABS[it[0]]!.cls === "tree").map(
  (it) => [it[1], it[2], TOWN_PREFABS[it[0]]!.radius * it[4]] as const,
);

/**
 * May a natural prop (blossom tree, rock) stand at this town point? Not within 3 m of paving, roads
 * or a structure, and not under a town tree's crown. (Inside the walls nothing natural grows:
 * props.ts PORTUS_PLAZA_CLEAR.)
 */
export function townPropClear(east: number, north: number): boolean {
  if (townGroundDistance(east, north) < 3) return false;
  for (const [e, n, r] of TOWN_TREES) if ((e - east) ** 2 + (n - north) ** 2 < (r + 1.5) ** 2) return false;
  return true;
}
