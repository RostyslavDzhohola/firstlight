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

import { TOWN_LAYOUT, TOWN_PREFABS, type TownItem, type TownSolid } from "../content/portusTown.ts";
import { objectDir, WORLD_OBJECT_BY_ID } from "../content/world.ts";
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
  /** Layout index and prefab index it belongs to (-1 for the Hall of Firsts board's stand). */
  item: number;
  prefab: number;
}

/** The structure solids of one placed item, appended to `out` (indices continue from out.length). */
export function itemSolids(p: TownPlacement, out: StructureSolid[]): void {
  placeSolids(p, TOWN_PREFABS[p.prefab]!.solids, out);
}

/** `solids` (prefab frame: x right, z front, y up from the base) placed by `p`, appended to `out`. */
function placeSolids(p: TownPlacement, solids: readonly TownSolid[], out: StructureSolid[]): void {
  const s = p.scale;
  for (const sol of solids) {
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

/**
 * The Hall of Firsts board (world object `hall_wall`, drawn by the client's QuestWorld) in its own
 * frame: x right, y up from the ground, z toward the plaza centre. The painted face is `w` × `h` m
 * with its lower edge at `bottom`.
 */
export const HALL_BOARD = { w: 4.0, h: 3.0, bottom: 0.9 } as const;

/**
 * The board's stand as solids in the board frame (round 2, S4): the plinth, the backing with the
 * face and brass frame, the two stone posts and the cornice; QuestWorld draws exactly these volumes.
 */
export const HALL_STAND_SOLIDS: readonly TownSolid[] = (() => {
  const { w, h, bottom } = HALL_BOARD;
  const top = bottom + h;
  const postX = w / 2 + 0.28;
  return [
    [0, 0, 0, (w + 0.9) / 2, 0.23, 0, bottom - 0.2, 0], // plinth
    [0, 0, 0.025, (w + 0.42) / 2, 0.085, bottom - 0.2, top + 0.17, 0], // backing, face and brass frame
    [0, -postX, 0, 0.17, 0.17, 0, top + 0.45, 0], // posts
    [0, postX, 0, 0.17, 0.17, 0, top + 0.45, 0],
    [0, 0, 0, (w + 1.1) / 2, 0.25, top + 0.45, top + 0.67, 0], // cornice
  ];
})();

/** The board's frame on `terrain` (where QuestWorld puts it): at `hall_wall`, facing the plaza centre. */
export function hallBoardPlacement(terrain: Terrain): TownPlacement | null {
  const o = WORLD_OBJECT_BY_ID.get("hall_wall");
  if (!o || o.body !== terrain.body.id) return null;
  const d = objectDir(o);
  const up = [d[0], d[1], d[2]];
  // Toward the plaza centre (+Y): the tangent part of +Y at the board.
  let fx = -up[1]! * up[0]!, fy = 1 - up[1]! * up[1]!, fz = -up[1]! * up[2]!;
  const fl = Math.hypot(fx, fy, fz);
  fx /= fl; fy /= fl; fz /= fl;
  // right = up × toward (QuestWorld's basis).
  const rx = up[1]! * fz - up[2]! * fy, ry = up[2]! * fx - up[0]! * fz, rz = up[0]! * fy - up[1]! * fx;
  const base = terrain.body.radius + terrain.groundHeight(d[0], d[1], d[2]);
  return {
    item: -1, prefab: -1, scale: 1,
    px: up[0]! * base, py: up[1]! * base, pz: up[2]! * base,
    rx, ry, rz, ux: up[0]!, uy: up[1]!, uz: up[2]!, fx, fy, fz,
  };
}

const solidCache = new WeakMap<Terrain, readonly StructureSolid[]>();

/**
 * Every structure solid of the town on `terrain` (empty off Portus): the layout's prefabs, then the
 * Hall of Firsts board's stand (item and prefab -1). Deterministic; cached per terrain.
 */
export function townSolids(terrain: Terrain): readonly StructureSolid[] {
  if (terrain.body.id !== TOWN_BODY) return [];
  let list = solidCache.get(terrain);
  if (!list) {
    const out: StructureSolid[] = [];
    for (const p of townPlacements(terrain)) itemSolids(p, out);
    const board = hallBoardPlacement(terrain);
    if (board) placeSolids(board, HALL_STAND_SOLIDS, out);
    list = out;
    solidCache.set(terrain, list);
  }
  return list;
}

/** clearSpot leaves this much room (m) beyond the player's radius. */
const CLEAR_MARGIN = 0.02;

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
  private readonly clearContact: PropContact = emptyContact();
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

  /**
   * Where a body put down at feet `p` (on the ground) can stand. First the client controller's own
   * push-out (resolve, re-snapped to the ground by `groundR(dirX, dirY, dirZ)`: the radius its feet
   * rest at) until nothing moves it; where that can't settle (pushed back and forth between touching
   * solids, like a keep and its front steps), the nearest clear spot on rings around `p` (0.5 m apart,
   * 24 bearings, out to 30 m). Writes `p`; returns false if nothing clear was found. The server places
   * joining and teleported bodies with this (round-1 B1): a push longer than the move budget would
   * otherwise be refused and corrected back inside, forever.
   */
  clearSpot(p: XYZ, groundR: (x: number, y: number, z: number) => number): boolean {
    const x0 = p.x, y0 = p.y, z0 = p.z;
    // A body 2 cm wider than the player's: the spot ends a little outside the client's push range,
    // so float rounding of the replicated position can't start a push of its own.
    const body = { radius: PLAYER_BODY.radius + CLEAR_MARGIN, height: PLAYER_BODY.height, step: PLAYER_BODY.step };
    const snap = (q: XYZ) => {
      const l = Math.hypot(q.x, q.y, q.z);
      const r = groundR(q.x / l, q.y / l, q.z / l) / l;
      q.x *= r;
      q.y *= r;
      q.z *= r;
    };
    for (let k = 0; k < 12; k++) {
      const px = p.x, py = p.y, pz = p.z;
      this.collider.resolve(p, always, this.clearContact, body);
      snap(p);
      if (Math.hypot(p.x - px, p.y - py, p.z - pz) < 1e-4) break;
    }
    if (this.isClear(p)) return true;
    // Rings round the original spot, in its tangent plane (a fixed, deterministic order).
    const l0 = Math.hypot(x0, y0, z0);
    const ux = x0 / l0, uy = y0 / l0, uz = z0 / l0;
    const ref = Math.abs(uz) < 0.9 ? [0, 0, 1] : [1, 0, 0];
    const k0 = ref[0]! * ux + ref[1]! * uy + ref[2]! * uz;
    let ax = ref[0]! - k0 * ux, ay = ref[1]! - k0 * uy, az = ref[2]! - k0 * uz;
    const al = Math.hypot(ax, ay, az);
    ax /= al; ay /= al; az /= al;
    const bx = uy * az - uz * ay, by = uz * ax - ux * az, bz = ux * ay - uy * ax;
    const q: XYZ = { x: 0, y: 0, z: 0 };
    for (let ring = 1; ring <= 60; ring++) {
      const d = ring * 0.5;
      for (let i = 0; i < 24; i++) {
        const a = (i / 24) * Math.PI * 2;
        const c = Math.cos(a) * d, sn = Math.sin(a) * d;
        q.x = x0 + ax * c + bx * sn;
        q.y = y0 + ay * c + by * sn;
        q.z = z0 + az * c + bz * sn;
        snap(q);
        if (!this.isClear(q, body)) continue;
        p.x = q.x;
        p.y = q.y;
        p.z = q.z;
        return true;
      }
    }
    return false;
  }

  /** Nothing pushes feet at `p` and they aren't inside a solid (for `body`, default the player). */
  private isClear(p: XYZ, body: { radius: number; height: number; step: number } = PLAYER_BODY): boolean {
    const q = { x: p.x, y: p.y, z: p.z };
    this.collider.resolve(q, always, this.clearContact, body);
    return Math.hypot(q.x - p.x, q.y - p.y, q.z - p.z) < 1e-6 && !this.footing(p.x, p.y, p.z, PLAYER_BODY.step).inside;
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
