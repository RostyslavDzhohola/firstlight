// Steering on the sphere (D4: no navmesh). NPCs walk the shared height field: each step moves along a
// tangent, re-projects onto the ground, and is refused when it climbs too steeply, leaves the NPC's
// medium (land / shallows / lake / air), enters a safe zone (a pad's ring, the Portus town) or walks
// into a structure (the shared sites' solids: the Portus town's, a planet outpost's and waystones,
// D-zones-3, D44); refused steps slide sideways, and among structures the NPC follows the obstacle
// round. An NPC that still can't get at its target falls back to D36 (evade after 5 s: brain.ts).

import { nearSafeZone, padDirs, type BodyDef, type Dir, type Terrain } from "@firstlight/shared";
import { structureCollider, type ColliderBody, type StructureCollider } from "@firstlight/shared/planet/sites";
import type { Locomotion } from "@firstlight/shared/content/npcs";
import { NPC_RULES } from "@firstlight/shared/content/npcs";
import type { V3 } from "../geometry.ts";
import { rotateAboutUp } from "./vec.ts";

export interface Ground {
  terrain: Terrain;
  body: BodyDef;
  R: number;
  water: number;
  pads: readonly Dir[];
  /**
   * The body's structures (planet/sites.ts; null if it has none): NPCs walk round the Portus town's
   * crates, trees and towers outside the walls and round a planet outpost's buildings.
   */
  structures: StructureCollider | null;
  /** Follow obstacles everywhere (Portus: its wild land rings the town), not only near a structure. */
  followAll: boolean;
}

export function makeGround(terrain: Terrain): Ground {
  const body = terrain.body;
  const c = structureCollider(terrain);
  const hub = body.terrain.kind === "hub";
  return { terrain, body, R: body.radius, water: body.waterLevel, pads: hub ? [] : padDirs(body), structures: c.solids.length > 0 ? c : null, followAll: hub };
}

/** An NPC's body for the structure queries (its own radius and height, the player's step band). */
export function npcBody(radius: number, height = 1.8): ColliderBody {
  return { radius, height, step: 0.35 };
}

/** Would moving straight from `a` to `b` walk this body into a structure? */
export function blockedByStructure(g: Ground, a: V3, b: V3, body: ColliderBody): boolean {
  return !!g.structures && g.structures.crosses(a[0], a[1], a[2], b[0], b[1], b[2], body);
}

/**
 * `p` (an NPC put down by a spawn, a summon or a leap) pushed out of the structures to the nearest
 * clear spot on its medium, or `p` unchanged when nothing is there (or nowhere clear was found).
 */
export function clearOfStructures(g: Ground, p: V3, loco: Locomotion, hover: number, body: ColliderBody): V3 {
  if (!g.structures) return p;
  const q = { x: p[0], y: p[1], z: p[2] };
  if (g.structures.isClear(q, body)) return p;
  const ground = (x: number, y: number, z: number) => g.R + (feetHeight(g, x, y, z, loco, hover) ?? g.terrain.groundHeight(x, y, z));
  return g.structures.clearSpot(q, ground, body) ? [q.x, q.y, q.z] : p;
}

/** Max rise per metre walked (≈ 48°). */
export const MAX_SLOPE = 1.1;

/** Feet height above the radius for a direction, or null if this locomotion can't stand there. */
export function feetHeight(g: Ground, x: number, y: number, z: number, loco: Locomotion, hover = 0): number | null {
  const h = g.terrain.groundHeight(x, y, z);
  switch (loco) {
    case "ground":
      return h < g.water - 0.6 ? null : h;
    case "wade":
      return h < g.water - 2.4 ? null : h;
    case "swim":
      return h > g.water - 0.8 ? null : Math.max(h, g.water - 2.5);
    case "hover":
      return Math.max(h, g.water) + hover;
  }
}

/** Inside (or within `margin` m of) a safe zone: any pad's ring, or the Portus town (shared zones.ts). */
export function nearSafeRing(g: Ground, x: number, y: number, z: number, margin: number): boolean {
  return nearSafeZone(g.body, x, y, z, margin);
}

/** Place a point on the ground for a locomotion (falls back to the plain ground height). */
export function placeOnGround(g: Ground, p: V3, loco: Locomotion, hover = 0): V3 {
  const l = Math.hypot(p[0], p[1], p[2]);
  const ux = p[0] / l, uy = p[1] / l, uz = p[2] / l;
  const h = feetHeight(g, ux, uy, uz, loco, hover) ?? Math.max(g.terrain.groundHeight(ux, uy, uz), loco === "hover" ? g.water + hover : -1e9);
  const r = g.R + h;
  return [ux * r, uy * r, uz * r];
}

const SLIDES = [0, 35, -35, 70, -70];
/**
 * Among structures an NPC follows the obstacle: it turns further to its preferred side first, as far
 * as sideways and back (a crate's far face, a barn's long wall), before trying the other side; the
 * caller keeps the side it last slid to (Npc.slideSide), so it walks round, not to and fro.
 */
const FOLLOW = [0, 35, 70, 105, 140, -35, -70, -105, -140, 180];
/** On a planet an NPC follows obstacles within this many metres of a structure (elsewhere: SLIDES). */
const FOLLOW_NEAR = 8;

/** Did the last step() use FOLLOW (slideAngle reads it)? */
let followed = false;

/** The angle (degrees, + = the preferred side's turn) the last step() moved at for its return value `i`. */
export function slideAngle(g: Ground, i: number, side = 1): number {
  if (i < 0) return 0;
  return followed && g.structures ? FOLLOW[i]! * side : SLIDES[i]!;
}

/**
 * Move `pos` by `d` metres along tangent `t`. Writes the new position into `out` and returns the
 * index of the direction used (0 = straight, then slides: slideAngle), or -1 if every direction was
 * refused. `side` (±1): which way to turn first round a structure; `height` is the NPC's (with its
 * radius, the body the structures are checked against).
 */
export function step(g: Ground, pos: V3, t: V3, d: number, loco: Locomotion, hover: number, radius: number, out: V3, avoidSafe = true, side = 1, height = 1.8): number {
  const curH = Math.hypot(pos[0], pos[1], pos[2]) - g.R;
  const margin = NPC_RULES.safeMargin + radius;
  const walls = g.structures;
  const body = walls ? npcBody(radius, height) : null;
  followed = !!walls && (g.followAll || walls.near(pos[0], pos[1], pos[2], FOLLOW_NEAR + radius));
  const angles = followed ? FOLLOW : SLIDES;
  for (let i = 0; i < angles.length; i++) {
    const ang = followed ? angles[i]! * side : angles[i]!;
    const dir = ang === 0 ? t : rotateAboutUp(pos, t, ang);
    const qx = pos[0] + dir[0] * d, qy = pos[1] + dir[1] * d, qz = pos[2] + dir[2] * d;
    const l = Math.hypot(qx, qy, qz);
    const ux = qx / l, uy = qy / l, uz = qz / l;
    const fh = feetHeight(g, ux, uy, uz, loco, hover);
    if (fh === null) continue;
    if ((loco === "ground" || loco === "wade") && fh - curH > d * MAX_SLOPE + 0.25) continue;
    if (avoidSafe && nearSafeRing(g, qx, qy, qz, margin)) continue;
    const r = g.R + fh;
    // Not through a structure (a step whose start is already inside one may leave it).
    if (walls && walls.crosses(pos[0], pos[1], pos[2], ux * r, uy * r, uz * r, body!)) continue;
    out[0] = ux * r;
    out[1] = uy * r;
    out[2] = uz * r;
    return i;
  }
  return -1;
}
