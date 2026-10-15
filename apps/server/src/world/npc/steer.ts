// Steering on the sphere (D4: no navmesh). NPCs walk the shared height field: each step moves along a
// tangent, re-projects onto the ground, and is refused when it climbs too steeply, leaves the NPC's
// medium (land / shallows / lake / air), enters a pad's safe ring or walks into a structure (the
// shared sites' solids: a pad outpost's buildings, D44); refused steps slide sideways, so NPCs steer
// round buildings. An NPC that still can't reach its target falls back to D36 (evade after 5 s).

import { PAD_SAFE_RADIUS, padDirs, type BodyDef, type Dir, type Terrain } from "@firstlight/shared";
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
  /** The body's structure solids (planet/sites.ts): NPCs don't walk through them. */
  structures: StructureCollider;
}

export function makeGround(terrain: Terrain): Ground {
  const body = terrain.body;
  return { terrain, body, R: body.radius, water: body.waterLevel, pads: body.terrain.kind === "hub" ? [] : padDirs(body), structures: structureCollider(terrain) };
}

/** An NPC's body for the structure queries (the player's step band). */
export function npcBody(radius: number, height = 1.8): ColliderBody {
  return { radius, height, step: 0.35 };
}

/** Would moving straight from `a` to `b` walk this body into a structure? */
export function blockedByStructure(g: Ground, a: V3, b: V3, body: ColliderBody): boolean {
  return g.structures.solids.length > 0 && g.structures.crosses(a[0], a[1], a[2], b[0], b[1], b[2], body);
}

/**
 * `p` (an NPC put down by a spawn, a summon or a leap) pushed out of the structures to the nearest
 * clear spot on its medium, or `p` unchanged when nothing is there (or nowhere clear was found).
 */
export function clearOfStructures(g: Ground, p: V3, loco: Locomotion, hover: number, body: ColliderBody): V3 {
  if (g.structures.solids.length === 0) return p;
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

/** Inside (or within `margin` m of) any pad's safe ring. */
export function nearSafeRing(g: Ground, x: number, y: number, z: number, margin: number): boolean {
  const l = Math.hypot(x, y, z);
  const ux = x / l, uy = y / l, uz = z / l;
  const lim = (PAD_SAFE_RADIUS + margin) / g.R;
  const lim2 = lim * lim;
  for (const p of g.pads) {
    const dx = p[0] - ux, dy = p[1] - uy, dz = p[2] - uz;
    if (dx * dx + dy * dy + dz * dz <= lim2) return true;
  }
  return false;
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
 * Wall following (D44): once a structure has refused a direction, turns on the NPC's preferred side
 * first, out to 140° (along a building's face and a little away from it), then the other side.
 */
const WALL_TURNS = [35, 70, 105, 140, -35, -70, -105, -140];

/** What the last step() met: whether a structure refused a direction, and the side of the turn it took (+1 left, -1 right, 0 straight). */
export const lastStep = { wall: false, side: 0 };

/**
 * Move `pos` by `d` metres along tangent `t`. Writes the new position into `out` and returns the
 * index of the direction used (0 = straight, 1–4 = slid, 5–12 = followed a structure's wall), or -1
 * if every direction was refused. Near no structure this is the plain slide (SLIDES). When a
 * structure refuses the straight way (or every slide), the NPC follows the wall instead (WALL_TURNS),
 * turning to the `prefer` side (+1 / -1) first: an NPC rounding a building keeps the side that first
 * got it past (brain.ts moveDir), so it walks on round the corner instead of stopping where the
 * two sides balance.
 */
export function step(g: Ground, pos: V3, t: V3, d: number, loco: Locomotion, hover: number, radius: number, out: V3, avoidSafe = true, height = 1.8, prefer = 1): number {
  const curH = Math.hypot(pos[0], pos[1], pos[2]) - g.R;
  const margin = NPC_RULES.safeMargin + radius;
  const body = g.structures.solids.length > 0 ? npcBody(radius, height) : null;
  lastStep.wall = false;
  lastStep.side = 0;
  const tryTurn = (turn: number): boolean => {
    const dir = turn === 0 ? t : rotateAboutUp(pos, t, turn);
    const qx = pos[0] + dir[0] * d, qy = pos[1] + dir[1] * d, qz = pos[2] + dir[2] * d;
    const l = Math.hypot(qx, qy, qz);
    const ux = qx / l, uy = qy / l, uz = qz / l;
    const fh = feetHeight(g, ux, uy, uz, loco, hover);
    if (fh === null) return false;
    if ((loco === "ground" || loco === "wade") && fh - curH > d * MAX_SLOPE + 0.25) return false;
    if (avoidSafe && nearSafeRing(g, qx, qy, qz, margin)) return false;
    const r = g.R + fh;
    if (body && g.structures.crosses(pos[0], pos[1], pos[2], ux * r, uy * r, uz * r, body)) {
      lastStep.wall = true;
      return false;
    }
    out[0] = ux * r;
    out[1] = uy * r;
    out[2] = uz * r;
    lastStep.side = Math.sign(turn);
    return true;
  };
  for (let i = 0; i < SLIDES.length; i++) {
    if (tryTurn(SLIDES[i]!)) return i;
    if (i === 0 && lastStep.wall) break;
  }
  if (lastStep.wall) {
    for (let k = 0; k < WALL_TURNS.length; k++) if (tryTurn(WALL_TURNS[k]! * prefer)) return SLIDES.length + k;
  }
  return -1;
}
