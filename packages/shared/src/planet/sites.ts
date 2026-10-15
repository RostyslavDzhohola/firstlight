// Structure sites (D38, D42): placed prefabs with indestructible collider solids, shared so the client
// controller, the server's movement validator, shots, NPC sight and NPC steering all block the same
// walls. Portus' castle town is one site; each planet has its pad-0 outpost and a waystone beside each
// of its other pads. Never in the breakable list (breakable ids and indices are wire/persistence keys).
//
// A site has an anchor (a unit direction on the body) and the anchor's tangent frame: north = +Z
// projected onto the tangent plane (or +X near the Z poles), east = north × up, the frame
// content/places.ts tangentFrame and the portal spots use. At the Portus pole that is the town frame
// (east -X, north +Z). Items stand at geodesic (arc-length) east/north offsets from the anchor, turned
// by their yaw (degrees, counter-clockwise seen from above; 0 = the prefab's front faces south): the
// pole-frame placement of townFrame.ts, rotated onto the anchor (exactly the identity at the pole).

import { OUTPOSTS, WAYSTONE_AT, type OutpostBody, type OutpostSite } from "../content/padOutposts.ts";
import { TOWN_LAYOUT, TOWN_PREFABS, type TownItem, type TownPrefab, type TownSolid } from "../content/portusTown.ts";
import { objectDir, WORLD_OBJECT_BY_ID } from "../content/world.ts";
import { BreakableCollider, emptyContact, PLAYER_BODY, pushOutOfBreakable, resetContact, supportHeightAt, type PropContact, type XYZ } from "./collide.ts";
import { rayBreakable, segmentNearBreakable, type SolidFrame } from "./breakables.ts";
import type { BodyId } from "./bodies.ts";
import { padDirs } from "./pads.ts";
import type { Terrain } from "./terrain.ts";
import { siteAnchor, townFrame, type SiteAnchor, type TownPlacement } from "./townFrame.ts";

export { POLE_ANCHOR, siteAnchor, siteCoords, siteDir, type SiteAnchor } from "./townFrame.ts";

/** The body the Portus town stands on. */
export const TOWN_BODY: BodyId = "portus";

type V3b = [number, number, number];
const _r: V3b = [0, 0, 0];

function rotate(a: SiteAnchor, x: number, y: number, z: number, out: V3b): V3b {
  out[0] = -a.east[0] * x + a.up[0] * y + a.north[0] * z;
  out[1] = -a.east[1] * x + a.up[1] * y + a.north[1] * z;
  out[2] = -a.east[2] * x + a.up[2] * y + a.north[2] * z;
  return out;
}

/**
 * Where a site item stands: its frame (the pole-frame placement at (east, north, yaw), rotated onto the
 * anchor) and its base `baseR` metres from the planet centre. Writes `out`.
 */
export function placeSiteItem(a: SiteAnchor, east: number, north: number, yaw: number, radius: number, baseR: number, out: TownPlacement): TownPlacement {
  townFrame(east, north, yaw, radius, out);
  rotate(a, out.rx, out.ry, out.rz, _r);
  out.rx = _r[0]; out.ry = _r[1]; out.rz = _r[2];
  rotate(a, out.ux, out.uy, out.uz, _r);
  out.ux = _r[0]; out.uy = _r[1]; out.uz = _r[2];
  rotate(a, out.fx, out.fy, out.fz, _r);
  out.fx = _r[0]; out.fy = _r[1]; out.fz = _r[2];
  out.px = out.ux * baseR;
  out.py = out.uy * baseR;
  out.pz = out.uz * baseR;
  return out;
}

function emptyPlacement(item: number, prefab: number, scale: number): TownPlacement {
  return { item, prefab, scale, px: 0, py: 0, pz: 0, rx: 0, ry: 0, rz: 0, ux: 0, uy: 0, uz: 0, fx: 0, fy: 0, fz: 0 };
}

// ------------------------------------------------------------------------------------ the sites of a body

/** The pad outpost site data of a body (null on Portus). */
export function outpostSite(body: BodyId): OutpostSite | null {
  return body === "portus" ? null : OUTPOSTS[body as OutpostBody];
}

/** Pad 0's anchor on a planet (the outpost's frame). */
export function outpostAnchor(terrain: Terrain): SiteAnchor {
  return siteAnchor(padDirs(terrain.body)[0]!);
}

/** Where the Portus town item `item` stands: base on the rendered ground under its centre. */
export function placeTownItem(item: TownItem, index: number, terrain: Terrain): TownPlacement {
  const R = terrain.body.radius;
  const p = emptyPlacement(index, item[0], item[4]);
  townFrame(item[1], item[2], item[3], R, p);
  const base = R + terrain.groundHeight(p.ux, p.uy, p.uz);
  p.px = p.ux * base;
  p.py = p.uy * base;
  p.pz = p.uz * base;
  return p;
}

const placementCache = new WeakMap<Terrain, readonly TownPlacement[]>();

/**
 * Every placed site item on `terrain`, with its prefab table (sitePrefabs): Portus' town layout (in
 * layout order); on a planet the pad-0 outpost's layout (in layout order: `item` = layout index), then
 * the waystones of pads 1..n (`item` = -1 - pad index). Cached per terrain.
 */
export function sitePlacements(terrain: Terrain): readonly TownPlacement[] {
  let list = placementCache.get(terrain);
  if (list) return list;
  const R = terrain.body.radius;
  if (terrain.body.id === TOWN_BODY) {
    list = TOWN_LAYOUT.map((it, i) => placeTownItem(it, i, terrain));
  } else {
    const site = outpostSite(terrain.body.id)!;
    const out: TownPlacement[] = [];
    const a0 = outpostAnchor(terrain);
    site.layout.forEach((it, i) => out.push(placeSiteItem(a0, it[1], it[2], it[3], R, R + it[5], emptyPlacement(i, it[0], it[4]))));
    const pads = padDirs(terrain.body);
    for (let k = 1; k < pads.length; k++) out.push(waystonePlacement(terrain, k, site.waystone));
    list = out;
  }
  placementCache.set(terrain, list);
  return list;
}

/**
 * The waystone beside pad `k` (k >= 1): one fixed offset from the pad's platform frame
 * (padPlatformPlacement), the same at every pad, so the client draws all the pads' platforms and
 * waystones as one instanced mesh. The offset is WAYSTONE_AT placed at the planet radius (its tilt
 * and the curve's drop there), carried up to the pad's height with the platform: the stone stands
 * 9.6 m out on the flattened apron at any pad height.
 */
function waystonePlacement(terrain: Terrain, k: number, prefab: number): TownPlacement {
  const R = terrain.body.radius;
  const a = siteAnchor(padDirs(terrain.body)[k]!);
  const w = placeSiteItem(a, WAYSTONE_AT[0], WAYSTONE_AT[1], WAYSTONE_AT[2], R, R, emptyPlacement(-1 - k, prefab, 1));
  const h = terrain.padHeights[k]!;
  w.px += a.up[0] * h;
  w.py += a.up[1] * h;
  w.pz += a.up[2] * h;
  return w;
}

/** The prefab table the placements of `body` index. */
export function sitePrefabs(body: BodyId): readonly TownPrefab[] {
  return body === TOWN_BODY ? TOWN_PREFABS : outpostSite(body)!.prefabs;
}

/**
 * The landing platform's frame on pad `k` (k >= 1; pad 0's platform is a layout item): the pad's
 * tangent frame at the pad's height (visual only: the platform has no solids).
 */
export function padPlatformPlacement(terrain: Terrain, k: number, out: TownPlacement = emptyPlacement(-1 - k, -1, 1)): TownPlacement {
  const R = terrain.body.radius;
  const site = outpostSite(terrain.body.id);
  out.prefab = site ? site.pad : -1;
  return placeSiteItem(siteAnchor(padDirs(terrain.body)[k]!), 0, 0, 0, R, R + terrain.padHeights[k]!, out);
}

// ------------------------------------------------------------------------------------ solids

/** One indestructible collider solid of a site item (a box or an upright cylinder). */
export interface StructureSolid extends SolidFrame {
  /** Placement item and prefab index it belongs to (-1 for the Hall of Firsts board's stand). */
  item: number;
  prefab: number;
}

/** `solids` (prefab frame: x right, z front, y up from the base) placed by `p`, appended to `out`. */
export function placeSolids(p: TownPlacement, solids: readonly TownSolid[], out: StructureSolid[]): void {
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
 * Every structure solid on `terrain`: the site items' solids in placement order, then (Portus) the
 * Hall of Firsts board's stand (item and prefab -1). Deterministic; cached per terrain.
 */
export function siteSolids(terrain: Terrain): readonly StructureSolid[] {
  let list = solidCache.get(terrain);
  if (!list) {
    const out: StructureSolid[] = [];
    const prefabs = sitePrefabs(terrain.body.id);
    for (const p of sitePlacements(terrain)) placeSolids(p, prefabs[p.prefab]!.solids, out);
    const board = hallBoardPlacement(terrain);
    if (board) placeSolids(board, HALL_STAND_SOLIDS, out);
    list = out;
    solidCache.set(terrain, list);
  }
  return list;
}

// ------------------------------------------------------------------------------------ the collider

/** clearSpot leaves this much room (m) beyond the body's radius. */
const CLEAR_MARGIN = 0.02;

/** Feet this far inside a solid's footprint (and below its top) are inside it, not pressed against it (server rule). */
const INSIDE_MARGIN = 0.1;
const always = (): boolean => true;

/** A body for the collider's queries: radius, height and the step band of a top (the player's by default). */
export interface ColliderBody {
  radius: number;
  height: number;
  step: number;
}

/**
 * The structures as one collider for every side: the client controller resolves the player against
 * them (MoveColliders.resolve), the server's movement validator asks `footing` and `crosses` (the same
 * rules as the breakables in destruction.ts, every solid always solid), shots and NPC sight `raycast`,
 * NPC steering asks `crosses`/`inside` with the NPC's body.
 */
export class StructureCollider {
  readonly solids: readonly StructureSolid[];
  readonly collider: BreakableCollider<StructureSolid>;
  private readonly candidates: number[] = [];
  private readonly rayCandidates: number[] = [];
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

  /**
   * Distance along a ray (unit d) to the first structure within maxT, or Infinity. A solid the ray
   * starts inside is ignored (like the breakables in destruction.ts: a blast or a shot that starts in
   * a wall's surface isn't stopped by that wall from inside).
   */
  raycast(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxT: number): number {
    if (!(maxT > 0) || this.solids.length === 0) return Infinity;
    const n = this.collider.grid.collect(ox, oy, oz, dx, dy, dz, maxT, 0, this.rayCandidates);
    let best = Infinity;
    for (let k = 0; k < n; k++) {
      const b = this.solids[this.rayCandidates[k]!]!;
      if (!segmentNearBreakable(b, ox, oy, oz, dx, dy, dz, maxT)) continue;
      const t = rayBreakable(b, ox, oy, oz, dx, dy, dz, Math.min(maxT, best));
      if (t > 1e-6 && t < best) best = t;
    }
    return best;
  }

  /** Does the segment from a to b pass through a structure (rays leaving a solid they start inside don't count)? */
  blocks(ax: number, ay: number, az: number, bx: number, by: number, bz: number): boolean {
    const dx = bx - ax, dy = by - ay, dz = bz - az;
    const l = Math.hypot(dx, dy, dz);
    if (!(l > 1e-6) || this.solids.length === 0) return false;
    const t = this.raycast(ax, ay, az, dx / l, dy / l, dz / l, l);
    return t > 1e-6 && t < l;
  }

  /**
   * Movement footing at feet (x, y, z): `top` = distance from the planet centre of the highest
   * structure top under the feet (0 = none); `inside` = the feet are deep in a solid (the client
   * would push the body out by more than its radius + 0.1 m). Reused object.
   */
  footing(x: number, y: number, z: number, step: number, body: ColliderBody = PLAYER_BODY): { top: number; inside: boolean } {
    const out = this.footingOut;
    out.top = supportHeightAt(this.collider, x, y, z, always, { radius: body.radius, step });
    out.inside = false;
    if (this.solids.length === 0) return out;
    const n = this.collider.grid.collect(x, y, z, 0, 0, 0, 0, body.radius + body.height, this.candidates);
    for (let k = 0; k < n && !out.inside; k++) {
      const p = this.scratch;
      p.x = x;
      p.y = y;
      p.z = z;
      if (!pushOutOfBreakable(this.solids[this.candidates[k]!]!, p, body.radius, body.height, step, resetContact(this.contact))) continue;
      if (Math.hypot(p.x - x, p.y - y, p.z - z) >= body.radius + INSIDE_MARGIN) out.inside = true;
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
   * otherwise be refused and corrected back inside, forever. `body` defaults to the player's.
   */
  clearSpot(p: XYZ, groundR: (x: number, y: number, z: number) => number, who: ColliderBody = PLAYER_BODY): boolean {
    const x0 = p.x, y0 = p.y, z0 = p.z;
    // A body 2 cm wider: the spot ends a little outside the client's push range, so float rounding of
    // the replicated position can't start a push of its own.
    const body = { radius: who.radius + CLEAR_MARGIN, height: who.height, step: who.step };
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
    if (this.isClear(p, who)) return true;
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
  isClear(p: XYZ, body: ColliderBody = PLAYER_BODY): boolean {
    const q = { x: p.x, y: p.y, z: p.z };
    this.collider.resolve(q, always, this.clearContact, body);
    return Math.hypot(q.x - p.x, q.y - p.y, q.z - p.z) < 1e-6 && !this.footing(p.x, p.y, p.z, PLAYER_BODY.step, body).inside;
  }

  /** Do feet moving straight from a to b pass through a structure (a start already inside one doesn't count)? */
  crosses(ax: number, ay: number, az: number, bx: number, by: number, bz: number, body: ColliderBody = PLAYER_BODY): boolean {
    const a = this.a, b = this.b;
    a.x = ax; a.y = ay; a.z = az;
    b.x = bx; b.y = by; b.z = bz;
    return this.collider.sweep(a, b, always, body) >= 0;
  }
}

const colliderCache = new WeakMap<Terrain, StructureCollider>();

/** The structure collider of `terrain`'s sites (Portus' town, a planet's outpost and waystones). Cached per terrain. */
export function structureCollider(terrain: Terrain): StructureCollider {
  let c = colliderCache.get(terrain);
  if (!c) {
    c = new StructureCollider(siteSolids(terrain));
    colliderCache.set(terrain, c);
  }
  return c;
}
