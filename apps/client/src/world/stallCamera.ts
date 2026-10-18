// Shop stalls keep the third-person camera out (#22, D-view-5). The counters stand on the shared
// structure solids already (Juno's JUNO_COUNTER_SOLIDS, an outpost stall's whole-stall box), which
// the camera ray stops at like a wall; the rest is camera-only here: Juno's whole stall (its open
// middle let the camera through to look back across the awning) with her awning, counter top and
// crate, and an outpost stall's awning overhang, its valance and its hanging coin sign. Camera-only because the server never sees them: a jump under an awning is not refused, and
// movement, shots and NPC sight stay exactly as they are (no shared change).
//
// The volumes are oriented boxes (an awning is tilted) padded by CAMERA_PAD, so a camera stopped short
// of one along a grazing ray still keeps its near plane (0.3 m) out of the cloth. A head within the
// padding (brushing the hanging sign) stops the ray at the piece itself; a head inside the piece (a jump
// poking it into an awning) doesn't stop the ray at all: pulling the camera into the head would be
// worse than the clipping it would avoid.
//
// One table, KEEPER_STALL, is both what QuestWorld draws for Juno's stall and what blocks here.

import type { BodyId, Terrain } from "@firstlight/shared";
import { OUTPOSTS, type OutpostBody } from "@firstlight/shared/content/padOutposts";
import { plazaFacingPlacement, sitePlacements, TOWN_BODY } from "@firstlight/shared/planet/sites";
import type { TownPlacement } from "@firstlight/shared/planet/townFrame";

/** A box in a stall's frame (m): centre, full size (w along x, h along y, d along z), tilted `tilt` rad about x. */
export interface StallBox {
  x: number;
  y: number;
  z: number;
  w: number;
  h: number;
  d: number;
  /** Rotation about the frame's x axis (three's rotation.x): positive tips +z down. */
  tilt?: number;
}

/**
 * Juno's stall at the Portus Exchange, in her frame (x right, y up from the ground, z toward the plaza:
 * she stands at the origin behind the counter). QuestWorld builds these meshes from it.
 */
export const KEEPER_STALL = {
  counter: { x: 0, y: 0.5, z: 1.1, w: 2.6, h: 1.0, d: 0.8 },
  top: { x: 0, y: 1.04, z: 1.1, w: 2.8, h: 0.08, d: 1.0 },
  awning: { x: 0, y: 2.7, z: 0.6, w: 3.2, h: 0.06, d: 1.8, tilt: -0.18 },
  /** The two posts at ±x (cylinders: radius, full height, centred at half height). */
  post: { x: 1.5, z: 1.4, r: 0.05, h: 2.7 },
  crate: { x: -1.0, y: 1.33, z: 1.1, w: 0.5, h: 0.5, d: 0.5 },
  orb: { x: 0.8, y: 1.3, z: 1.1, r: 0.18 },
  /** The keeper's name and "… · E to trade" sprite. */
  label: { x: 0, y: 3.4, z: 0.6 },
  /** The whole stall: the awning's back edge to the counter's front, side to side, the ground to the awning's top. */
  body: { x: 0, y: 1.45, z: 0.6, w: 3.2, h: 2.9, d: 1.8 },
} as const satisfies Record<string, object>;

/** Padding (m) round every camera-only volume. */
export const CAMERA_PAD = 0.25;

/**
 * Juno's camera-only volumes (her frame): the whole stall, so the camera can't pass through its open
 * middle (under the awning, over the counter) and look back through it; and the awning, counter top
 * and crate on their own, for a player standing in there behind the counter.
 */
export const KEEPER_STALL_CAMERA: readonly StallBox[] = [KEEPER_STALL.body, KEEPER_STALL.awning, KEEPER_STALL.top, KEEPER_STALL.crate];

/**
 * An outpost stall's camera-only volumes in its prefab frame (x right, y up from the base, z front:
 * toward the pad). Beyond its whole-stall solid (±1.8 × ±1.0 m, up to 2.9 m) the striped awning
 * hangs 0.5 m over the front, from 2.25 m there up to 3.0 m at the back, with a valance down to
 * 1.98 m, and the coin sign hangs off the right front post (tools/blender/pads/design.py build_shop).
 * Meridian's stall has a flat roof slab over the top instead.
 */
const OUTPOST_STALL_CAMERA: readonly StallBox[] = [
  { x: 0, y: 2.625, z: 0.2, w: 3.9, h: 0.06, d: Math.hypot(2.6, 0.75), tilt: Math.atan2(0.75, 2.6) }, // cloth
  { x: 0, y: 2.115, z: 1.5, w: 3.9, h: 0.27, d: 0.02 }, // valance
  { x: 1.8, y: 2.585, z: 1.45, w: 0.08, h: 0.07, d: 0.9 }, // sign arm
  { x: 1.8, y: 2.15, z: 1.75, w: 1.12, h: 1.12, d: 0.06 }, // sun sign (rays to 0.56 m)
];
const MERIDIAN_STALL_CAMERA: readonly StallBox[] = [{ x: 0, y: 3.0, z: 0.17, w: 4.0, h: 0.2, d: 2.56 }]; // roof slab and its amber strip

/** A camera-only volume in planet space: centre, unit axes and half extents (padded by `pad` along each axis). */
export interface CameraBox {
  c: readonly [number, number, number];
  a: readonly (readonly [number, number, number])[];
  h: readonly [number, number, number];
  pad: readonly [number, number, number];
}

/** The piece itself: `b` without its padding. */
export function unpadded(b: CameraBox): CameraBox {
  return { ...b, h: [b.h[0] - b.pad[0], b.h[1] - b.pad[1], b.h[2] - b.pad[2]], pad: [0, 0, 0] };
}

/** `boxes` (frame-local) placed by `p`, padded by `pad`. */
export function placeStallBoxes(p: TownPlacement, boxes: readonly StallBox[], padding = CAMERA_PAD): CameraBox[] {
  const s = p.scale;
  return boxes.map((b) => {
    const pad = [padding, padding, padding] as const;
    const t = b.tilt ?? 0;
    const ct = Math.cos(t), st = Math.sin(t);
    // Local axes after the tilt about x (three's convention), then into the planet through the frame.
    const local: [number, number, number][] = [[1, 0, 0], [0, ct, st], [0, -st, ct]];
    const a = local.map(([x, y, z]) => [p.rx * x + p.ux * y + p.fx * z, p.ry * x + p.uy * y + p.fy * z, p.rz * x + p.uz * y + p.fz * z] as const);
    const c = [
      p.px + (p.rx * b.x + p.ux * b.y + p.fx * b.z) * s,
      p.py + (p.ry * b.x + p.uy * b.y + p.fy * b.z) * s,
      p.pz + (p.rz * b.x + p.uz * b.y + p.fz * b.z) * s,
    ] as const;
    return { c, a, h: [(b.w / 2) * s + pad[0], (b.h / 2) * s + pad[1], (b.d / 2) * s + pad[2]] as const, pad };
  });
}

/** The camera-only volumes of `body`'s stall in the stall's own frame (Juno's or the outpost stall's). */
export function stallCameraLocal(body: BodyId): readonly StallBox[] {
  if (body === TOWN_BODY) return KEEPER_STALL_CAMERA;
  return body === "meridian" ? MERIDIAN_STALL_CAMERA : OUTPOST_STALL_CAMERA;
}

const cache = new WeakMap<Terrain, readonly CameraBox[]>();

/**
 * Every stall's camera-only volumes on `terrain` (planet space; cached per terrain): Juno's in her
 * frame on Portus (where QuestWorld turns her: facing the plaza centre), an outpost's in its stall's
 * placement on a planet.
 */
export function stallCameraBoxes(terrain: Terrain): readonly CameraBox[] {
  let boxes = cache.get(terrain);
  if (!boxes) {
    const body = terrain.body.id;
    if (body === TOWN_BODY) {
      const juno = plazaFacingPlacement("juno_vale", terrain);
      boxes = juno ? placeStallBoxes(juno, stallCameraLocal(body)) : [];
    } else {
      const site = OUTPOSTS[body as OutpostBody];
      const stall = site ? sitePlacements(terrain)[site.shop.item] : undefined;
      boxes = stall ? placeStallBoxes(stall, stallCameraLocal(body)) : [];
    }
    cache.set(terrain, boxes);
  }
  return boxes;
}

/**
 * Entry distance of the ray into box `b` shrunk by `shrink` (per axis): -1 when the start is inside,
 * Infinity when the ray misses it (or meets it only behind the start).
 */
function entry(b: CameraBox, shrink: readonly [number, number, number] | null, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number): number {
  const qx = ox - b.c[0], qy = oy - b.c[1], qz = oz - b.c[2];
  let t0 = -Infinity, t1 = Infinity;
  let inside = true;
  for (let k = 0; k < 3; k++) {
    const a = b.a[k]!;
    const o = qx * a[0] + qy * a[1] + qz * a[2];
    const d = dx * a[0] + dy * a[1] + dz * a[2];
    const h = b.h[k]! - (shrink ? shrink[k]! : 0);
    if (o < -h || o > h) inside = false;
    if (Math.abs(d) < 1e-9) {
      if (o < -h || o > h) return Infinity;
      continue;
    }
    let ta = (-h - o) / d, tb = (h - o) / d;
    if (ta > tb) [ta, tb] = [tb, ta];
    if (ta > t0) t0 = ta;
    if (tb < t1) t1 = tb;
  }
  if (inside) return -1;
  return t0 > t1 || t0 < 0 ? Infinity : t0;
}

/**
 * Distance along the ray from (ox, oy, oz), unit (dx, dy, dz), to the first box it enters within
 * `maxT`, or Infinity. From inside a box's padding the ray stops at the piece itself; from inside the
 * piece it passes through (see the header). No allocation.
 */
export function cameraBoxRay(boxes: readonly CameraBox[], ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxT: number): number {
  let best = Infinity;
  for (const b of boxes) {
    let t = entry(b, null, ox, oy, oz, dx, dy, dz);
    if (t < 0) t = entry(b, b.pad, ox, oy, oz, dx, dy, dz);
    if (t >= 0 && t <= maxT && t < best) best = t;
  }
  return best;
}

/** Is (x, y, z) inside any of `boxes` (padding included)? For tests and the e2e hook. */
export function inCameraBox(boxes: readonly CameraBox[], x: number, y: number, z: number): boolean {
  return boxes.some((b) => {
    const qx = x - b.c[0], qy = y - b.c[1], qz = z - b.c[2];
    return b.a.every((a, k) => Math.abs(qx * a[0] + qy * a[1] + qz * a[2]) <= b.h[k]!);
  });
}
