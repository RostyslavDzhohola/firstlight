// The Portus castle town (D38): where each placed prefab stands on the planet, and its indestructible
// structure solids. Shared so the client controller and the server's movement validator block the
// same walls, houses and towers (like the breakables, but never broken, never on the wire and not in
// the breakable list: breakable ids and indices are wire/persistence keys). The layout and the
// collider solids are generated data (content/portusTown.ts, tools/blender/portus).
//
// Town frame: the Portus pole (+Y) with east = -X and north = +Z, the frame content/places.ts uses
// there, so Juno, the Hall wall, the dummies and the portals line up with the town. `east`/`north`
// are geodesic (arc-length) offsets, like places.offsetDir. A placed prefab's frame is the pole frame
// carried along the great circle to its spot (minimal rotation), turned by its yaw (degrees,
// counter-clockwise seen from above; 0 = the prefab's front faces south). Its base sits on the
// rendered ground under its centre (the town floor is flat: terrain.ts PORTUS_TOWN_FLAT).

import { TOWN_LAYOUT, TOWN_PREFABS, type TownItem } from "../content/portusTown.ts";
import { townFrame, type TownPlacement } from "./townFrame.ts";
import { BreakableCollider, emptyContact, PLAYER_BODY, pushOutOfBreakable, resetContact, supportHeightAt, type PropContact, type XYZ } from "./collide.ts";
import type { SolidFrame } from "./breakables.ts";
import type { BodyId } from "./bodies.ts";
import type { Terrain } from "./terrain.ts";

/** The body the town stands on. */
export const TOWN_BODY: BodyId = "portus";

export { townCoords, townDir, townFrame, TOWN_EAST, TOWN_NORTH, TOWN_UP, type TownPlacement } from "./townFrame.ts";

/** Where `item` stands: frame from the layout, base on the rendered ground under its centre. */
export function placeTownItem(item: TownItem, index: number, terrain: Terrain): TownPlacement {
  const R = terrain.body.radius;
  const p: TownPlacement = { item: index, prefab: item[0], scale: item[4], px: 0, py: 0, pz: 0, rx: 0, ry: 0, rz: 0, ux: 0, uy: 0, uz: 0, fx: 0, fy: 0, fz: 0 };
  townFrame(item[1], item[2], item[3], R, p);
  const base = R + terrain.groundHeight(p.ux, p.uy, p.uz);
  p.px = p.ux * base;
  p.py = p.uy * base;
  p.pz = p.uz * base;
  return p;
}

const placementCache = new WeakMap<Terrain, readonly TownPlacement[]>();

/** Every town item placed on `terrain` (empty off Portus). Cached per terrain. */
export function townPlacements(terrain: Terrain): readonly TownPlacement[] {
  if (terrain.body.id !== TOWN_BODY) return [];
  let list = placementCache.get(terrain);
  if (!list) {
    list = TOWN_LAYOUT.map((it, i) => placeTownItem(it, i, terrain));
    placementCache.set(terrain, list);
  }
  return list;
}

/** One indestructible collider solid of a town item (a box or an upright cylinder). */
export interface StructureSolid extends SolidFrame {
  /** Layout index and prefab index it belongs to. */
  item: number;
  prefab: number;
}

/** The structure solids of one placed item, appended to `out` (indices continue from out.length). */
export function itemSolids(p: TownPlacement, out: StructureSolid[]): void {
  const pre = TOWN_PREFABS[p.prefab]!;
  const s = p.scale;
  for (const sol of pre.solids) {
    const [shape, cx, cz, hx, hz, y0, y1, yaw] = sol;
    const a = (yaw * Math.PI) / 180;
    const c = Math.cos(a), sn = Math.sin(a);
    // Solid axes in the item frame: x' = cos·right - sin·front, z' = sin·right + cos·front.
    const rx = c * p.rx - sn * p.fx, ry = c * p.ry - sn * p.fy, rz = c * p.rz - sn * p.fz;
    const fx = sn * p.rx + c * p.fx, fy = sn * p.ry + c * p.fy, fz = sn * p.rz + c * p.fz;
    const lift = y0 * s;
    const px = p.px + p.rx * cx * s + p.fx * cz * s + p.ux * lift;
    const py = p.py + p.ry * cx * s + p.fy * cz * s + p.uy * lift;
    const pz = p.pz + p.rz * cx * s + p.fz * cz * s + p.uz * lift;
    const h = (y1 - y0) * s;
    const ex = hx * s, ez = (shape === 1 ? hx : hz) * s;
    out.push({
      index: out.length, item: p.item, prefab: p.prefab,
      px, py, pz, rx, ry, rz, ux: p.ux, uy: p.uy, uz: p.uz, fx, fy, fz,
      shape: shape as 0 | 1, hx: ex, hz: ez, h,
      cx: px + p.ux * h * 0.5, cy: py + p.uy * h * 0.5, cz: pz + p.uz * h * 0.5,
      bound: Math.sqrt(ex * ex + ez * ez + (h * h) / 4),
    });
  }
}

const solidCache = new WeakMap<Terrain, readonly StructureSolid[]>();

/** Every structure solid of the town on `terrain` (empty off Portus). Deterministic; cached per terrain. */
export function townSolids(terrain: Terrain): readonly StructureSolid[] {
  if (terrain.body.id !== TOWN_BODY) return [];
  let list = solidCache.get(terrain);
  if (!list) {
    const out: StructureSolid[] = [];
    for (const p of townPlacements(terrain)) itemSolids(p, out);
    list = out;
    solidCache.set(terrain, list);
  }
  return list;
}

/** Feet this far inside a solid's footprint (and below its top) are inside it, not pressed against it (server rule). */
const INSIDE_MARGIN = 0.1;
const always = (): boolean => true;

/**
 * The town's structures as one collider for both sides: the client controller resolves the player
 * against them (MoveColliders.resolve), the server's movement validator asks `footing` and
 * `crosses` (the same rules as the breakables in destruction.ts, every solid always solid).
 */
export class StructureCollider {
  readonly solids: readonly StructureSolid[];
  readonly collider: BreakableCollider<StructureSolid>;
  private readonly candidates: number[] = [];
  private readonly scratch: XYZ = { x: 0, y: 0, z: 0 };
  private readonly contact: PropContact = emptyContact();
  private readonly footingOut = { top: 0, inside: false };
  private readonly a: XYZ = { x: 0, y: 0, z: 0 };
  private readonly b: XYZ = { x: 0, y: 0, z: 0 };

  constructor(solids: readonly StructureSolid[]) {
    this.solids = solids;
    this.collider = new BreakableCollider<StructureSolid>(solids);
  }

  /** Push feet `p` out of the structures near it; fills `out` (push direction, floor under the feet). */
  resolve(p: XYZ, out: PropContact): boolean {
    return this.collider.resolve(p, always, out);
  }

  /** Distance along a ray (unit d) to the first structure within maxT, or Infinity. */
  raycast(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxT: number): number {
    return this.collider.raycast(ox, oy, oz, dx, dy, dz, maxT, always);
  }

  /**
   * Movement footing at feet (x, y, z): `top` = distance from the planet centre of the highest
   * structure top under the feet (0 = none); `inside` = the feet are deep in a solid (the client
   * would push the body out by more than its radius + 0.1 m). Reused object.
   */
  footing(x: number, y: number, z: number, step: number): { top: number; inside: boolean } {
    const out = this.footingOut;
    out.top = supportHeightAt(this.collider, x, y, z, always, { radius: PLAYER_BODY.radius, step });
    out.inside = false;
    if (this.solids.length === 0) return out;
    const n = this.collider.grid.collect(x, y, z, 0, 0, 0, 0, PLAYER_BODY.radius + PLAYER_BODY.height, this.candidates);
    for (let k = 0; k < n && !out.inside; k++) {
      const p = this.scratch;
      p.x = x;
      p.y = y;
      p.z = z;
      if (!pushOutOfBreakable(this.solids[this.candidates[k]!]!, p, PLAYER_BODY.radius, PLAYER_BODY.height, step, resetContact(this.contact))) continue;
      if (Math.hypot(p.x - x, p.y - y, p.z - z) >= PLAYER_BODY.radius + INSIDE_MARGIN) out.inside = true;
    }
    return out;
  }

  /** Do feet moving straight from a to b pass through a structure (a start already inside one doesn't count)? */
  crosses(ax: number, ay: number, az: number, bx: number, by: number, bz: number): boolean {
    const a = this.a, b = this.b;
    a.x = ax; a.y = ay; a.z = az;
    b.x = bx; b.y = by; b.z = bz;
    return this.collider.sweep(a, b, always, PLAYER_BODY) >= 0;
  }
}

const colliderCache = new WeakMap<Terrain, StructureCollider>();

/** The town's structure collider on `terrain`, or null on bodies without a town. Cached per terrain. */
export function structureCollider(terrain: Terrain): StructureCollider | null {
  if (terrain.body.id !== TOWN_BODY) return null;
  let c = colliderCache.get(terrain);
  if (!c) {
    c = new StructureCollider(townSolids(terrain));
    colliderCache.set(terrain, c);
  }
  return c;
}
