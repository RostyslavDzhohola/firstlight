// The Portus castle town (D38): the Portus site of the shared structure sites (planet/sites.ts, D42).
// Where each placed prefab stands on the planet, and its indestructible structure solids, shared so
// the client controller and the server's movement validator block the same walls, houses and towers.
// The layout and the collider solids are generated data (content/portusTown.ts, tools/blender/portus).
//
// Town frame: the Portus pole (+Y) with east = -X and north = +Z, the frame content/places.ts uses
// there, so Juno, the Hall wall, the dummies and the portals line up with the town. `east`/`north`
// are geodesic (arc-length) offsets, like places.offsetDir. A placed prefab's frame is the pole frame
// carried along the great circle to its spot (minimal rotation), turned by its yaw (degrees,
// counter-clockwise seen from above; 0 = the prefab's front faces south). Its base sits on the
// rendered ground under its centre (the town floor is flat: terrain.ts PORTUS_TOWN_FLAT).

import type { TownPlacement } from "./townFrame.ts";
import type { Terrain } from "./terrain.ts";
import { TOWN_BODY, placeSolids, sitePlacements, siteSolids, type StructureSolid } from "./sites.ts";
import { TOWN_PREFABS } from "../content/portusTown.ts";

export { townCoords, townDir, townFrame, TOWN_EAST, TOWN_NORTH, TOWN_UP, type TownPlacement } from "./townFrame.ts";
export {
  hallBoardPlacement, HALL_BOARD, HALL_STAND_SOLIDS, JUNO_COUNTER_ITEM, JUNO_COUNTER_SOLIDS, placeTownItem, StructureCollider, structureCollider, TOWN_BODY,
  type StructureSolid,
} from "./sites.ts";

/** Every town item placed on `terrain` (empty off Portus). Cached per terrain. */
export function townPlacements(terrain: Terrain): readonly TownPlacement[] {
  return terrain.body.id === TOWN_BODY ? sitePlacements(terrain) : [];
}

/** The structure solids of one placed town item, appended to `out` (indices continue from out.length). */
export function itemSolids(p: TownPlacement, out: StructureSolid[]): void {
  placeSolids(p, TOWN_PREFABS[p.prefab]!.solids, out);
}

/**
 * Every structure solid of the town on `terrain` (empty off Portus): the layout's prefabs, then the
 * Hall of Firsts board's stand (item -1) and Juno's counter (item -2). Deterministic; cached per terrain.
 */
export function townSolids(terrain: Terrain): readonly StructureSolid[] {
  return terrain.body.id === TOWN_BODY ? siteSolids(terrain) : [];
}
