// Steering on the sphere (D4: no navmesh). NPCs walk the shared height field: each step moves along a
// tangent, re-projects onto the ground, and is refused when it climbs too steeply, leaves the NPC's
// medium (land / shallows / lake / air) or enters a safe zone (a pad's ring, the Portus town);
// refused steps slide sideways.

import { nearSafeZone, padDirs, type BodyDef, type Dir, type Terrain } from "@firstlight/shared";
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
}

export function makeGround(terrain: Terrain): Ground {
  const body = terrain.body;
  return { terrain, body, R: body.radius, water: body.waterLevel, pads: body.terrain.kind === "hub" ? [] : padDirs(body) };
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
 * Move `pos` by `d` metres along tangent `t`. Writes the new position into `out` and returns the
 * index of the direction used (0 = straight, 1–4 = slid), or -1 if every direction was refused.
 */
export function step(g: Ground, pos: V3, t: V3, d: number, loco: Locomotion, hover: number, radius: number, out: V3, avoidSafe = true): number {
  const curH = Math.hypot(pos[0], pos[1], pos[2]) - g.R;
  const margin = NPC_RULES.safeMargin + radius;
  for (let i = 0; i < SLIDES.length; i++) {
    const dir = SLIDES[i] === 0 ? t : rotateAboutUp(pos, t, SLIDES[i]!);
    const qx = pos[0] + dir[0] * d, qy = pos[1] + dir[1] * d, qz = pos[2] + dir[2] * d;
    const l = Math.hypot(qx, qy, qz);
    const ux = qx / l, uy = qy / l, uz = qz / l;
    const fh = feetHeight(g, ux, uy, uz, loco, hover);
    if (fh === null) continue;
    if ((loco === "ground" || loco === "wade") && fh - curH > d * MAX_SLOPE + 0.25) continue;
    if (avoidSafe && nearSafeRing(g, qx, qy, qz, margin)) continue;
    const r = g.R + fh;
    out[0] = ux * r;
    out[1] = uy * r;
    out[2] = uz * r;
    return i;
  }
  return -1;
}
