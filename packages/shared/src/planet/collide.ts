// Player vs breakable props (SPEC §4.3 "prop colliders", §6.9): intact props block walking and can
// be stood on; broken ones don't. Pure and allocation-free so the client controller can run it
// every frame and the server's movement validator can reuse it (BreakableGrid + its broken set).
//
// The player is a vertical cylinder (feet at the position, upright in the prop's frame; a prop's up
// differs from the player's by metres / planet radius, which is negligible). Pushes are sideways in
// the prop's tangent plane, by the shortest way out, so walking into a prop slides along it.

import { BreakableGrid, rayBreakable, segmentNearBreakable, type Breakable, type SolidFrame } from "./breakables.ts";

export interface XYZ {
  x: number;
  y: number;
  z: number;
}

/** Player body for movement collision. Narrower than the 0.45 m hit capsule so cover hugs well. */
export const PLAYER_BODY = {
  radius: 0.38,
  height: 1.8,
  /** Feet within this of a prop's top (and over it) stand on it instead of being shoved off. */
  step: 0.35,
} as const;

/** Feet up to this far above a top still count as standing on it (no hover gap). */
const TOP_SLACK = 0.05;

export interface PropContact {
  /** Did any prop move the player sideways? */
  pushed: boolean;
  /** Unit direction (planet space, tangent) of the last sideways push: slide along it. */
  nx: number;
  ny: number;
  nz: number;
  /** Distance from the planet centre of the highest prop top the feet rest on; 0 = none. */
  floor: number;
}

export function emptyContact(): PropContact {
  return { pushed: false, nx: 0, ny: 0, nz: 0, floor: 0 };
}

export function resetContact(c: PropContact): PropContact {
  c.pushed = false;
  c.nx = c.ny = c.nz = 0;
  c.floor = 0;
  return c;
}

/**
 * One prop vs the player cylinder (`radius`, `height`) with its feet at `p`, solid by solid for a
 * compound collider (main shape, then its extra parts).
 * - Feet within `step` below a solid's top (or just above it) with the centre over its footprint:
 *   that top is a floor; its distance from the planet centre goes into `out.floor` (the max is kept).
 * - Otherwise, overlapping a solid's side: `p` moves out sideways by the shortest way; the push
 *   direction goes into `out`.
 * Returns true if `p` moved.
 */
export function pushOutOfBreakable(b: SolidFrame, p: XYZ, radius: number, height: number, step: number, out: PropContact): boolean {
  let moved = pushOutOfSolid(b, b.shape, b.hx, b.hz, 0, b.h, p, radius, height, step, out);
  if (b.parts) for (const q of b.parts) if (pushOutOfSolid(b, q.shape, q.hx, q.hz, q.y0, q.y1, p, radius, height, step, out)) moved = true;
  return moved;
}

/** Local frame coordinates of `p` relative to a prop's base. */
const _l = { x: 0, y: 0, z: 0 };
function toLocal(b: SolidFrame, p: XYZ) {
  const qx = p.x - b.px, qy = p.y - b.py, qz = p.z - b.pz;
  _l.x = qx * b.rx + qy * b.ry + qz * b.rz;
  _l.y = qx * b.ux + qy * b.uy + qz * b.uz;
  _l.z = qx * b.fx + qy * b.fy + qz * b.fz;
  return _l;
}

/** How far the point (lx, lz) lies outside a solid's footprint (0 inside). */
function outsideFootprint(shape: 0 | 1, hx: number, hz: number, lx: number, lz: number): number {
  if (shape === 0) {
    const ex = lx - Math.max(-hx, Math.min(hx, lx)), ez = lz - Math.max(-hz, Math.min(hz, lz));
    return Math.sqrt(ex * ex + ez * ez);
  }
  return Math.max(0, Math.sqrt(lx * lx + lz * lz) - hx);
}

/** The top of a solid under the feet at `p` (local height ly), as a distance from the planet centre. */
function topRadius(b: SolidFrame, p: XYZ, ly: number, y1: number): number {
  const lift = y1 - ly;
  const tx = p.x + b.ux * lift, ty = p.y + b.uy * lift, tz = p.z + b.uz * lift;
  return Math.sqrt(tx * tx + ty * ty + tz * tz);
}

function pushOutOfSolid(b: SolidFrame, shape: 0 | 1, hx: number, hz: number, y0: number, y1: number, p: XYZ, radius: number, height: number, step: number, out: PropContact): boolean {
  const { x: lx, y: ly, z: lz } = toLocal(b, p);
  if (ly >= y1 + TOP_SLACK || ly + height <= y0) return false;
  // Unit escape direction (local x, z), how far to move along it, and how far the centre is
  // outside the footprint (0 inside).
  let dx: number, dz: number, depth: number;
  const outside = outsideFootprint(shape, hx, hz, lx, lz);
  if (outside >= radius) return false;
  if (shape === 0) {
    if (outside > 1e-9) {
      dx = (lx - Math.max(-hx, Math.min(hx, lx))) / outside;
      dz = (lz - Math.max(-hz, Math.min(hz, lz))) / outside;
      depth = radius - outside;
    } else {
      // Centre inside the box: leave through the nearest face.
      const gx = hx - Math.abs(lx), gz = hz - Math.abs(lz);
      if (gx <= gz) {
        dx = lx >= 0 ? 1 : -1;
        dz = 0;
        depth = gx + radius;
      } else {
        dx = 0;
        dz = lz >= 0 ? 1 : -1;
        depth = gz + radius;
      }
    }
  } else {
    const rl = Math.sqrt(lx * lx + lz * lz);
    if (rl > 1e-9) {
      dx = lx / rl;
      dz = lz / rl;
    } else {
      dx = 1;
      dz = 0;
    }
    depth = hx + radius - rl;
  }
  if (ly >= y1 - step && outside <= radius * 0.5) {
    // Standing on (or stepping onto) the top.
    const top = topRadius(b, p, ly, y1);
    if (top > out.floor) out.floor = top;
    return false;
  }
  const nx = b.rx * dx + b.fx * dz, ny = b.ry * dx + b.fy * dz, nz = b.rz * dx + b.fz * dz;
  p.x += nx * depth;
  p.y += ny * depth;
  p.z += nz * depth;
  out.nx = nx;
  out.ny = ny;
  out.nz = nz;
  out.pushed = true;
  return true;
}

/**
 * The highest top of a prop's solids that feet at `p` stand over: centre over the footprint (within
 * half the body radius, as the client lands) and the feet no deeper than `step` below it. Distance
 * from the planet centre, or 0.
 */
function supportOf(b: SolidFrame, p: XYZ, radius: number, step: number): number {
  let best = 0;
  for (let k = -1; k < (b.parts?.length ?? 0); k++) {
    const q = k < 0 ? null : b.parts![k]!;
    const shape = q ? q.shape : b.shape, hx = q ? q.hx : b.hx, hz = q ? q.hz : b.hz, y1 = q ? q.y1 : b.h;
    const { x: lx, y: ly, z: lz } = toLocal(b, p);
    if (ly < y1 - step || outsideFootprint(shape, hx, hz, lx, lz) > radius * 0.5) continue;
    best = Math.max(best, topRadius(b, p, ly, y1));
  }
  return best;
}

/** A swept path must get this far into a footprint (and below a top's band) to count as crossing it. */
const SWEEP_SLACK = 0.03;

/**
 * Part [t0, t1] of the feet path a→b (prop-local coordinates, t in 0..1) during which the centre is
 * inside a solid's footprint shrunk by SWEEP_SLACK, or null. Written to `_span`.
 */
const _span = { t0: 0, t1: 1 };
function footprintSpan(shape: 0 | 1, hx: number, hz: number, ax: number, az: number, dx: number, dz: number): typeof _span | null {
  const ex = hx - SWEEP_SLACK, ez = hz - SWEEP_SLACK;
  if (ex <= 0 || ez <= 0) return null;
  let t0 = 0, t1 = 1;
  if (shape === 0) {
    for (let k = 0; k < 2; k++) {
      const p = k === 0 ? ax : az, d = k === 0 ? dx : dz, e = k === 0 ? ex : ez;
      if (Math.abs(d) < 1e-12) {
        if (p < -e || p > e) return null;
        continue;
      }
      let ta = (-e - p) / d, tb = (e - p) / d;
      if (ta > tb) [ta, tb] = [tb, ta];
      if (ta > t0) t0 = ta;
      if (tb < t1) t1 = tb;
      if (t0 > t1) return null;
    }
  } else {
    const A = dx * dx + dz * dz, B = 2 * (ax * dx + az * dz), C = ax * ax + az * az - ex * ex;
    if (A < 1e-12) {
      if (C > 0) return null;
    } else {
      const disc = B * B - 4 * A * C;
      if (disc < 0) return null;
      const q = Math.sqrt(disc);
      t0 = Math.max(0, (-B - q) / (2 * A));
      t1 = Math.min(1, (-B + q) / (2 * A));
      if (t0 > t1) return null;
    }
  }
  _span.t0 = t0;
  _span.t1 = t1;
  return _span;
}

/**
 * The feet path a→b against one solid of prop b (local frame): 0 = clear; 1 = it crosses the solid
 * (the centre inside its footprint while the body overlaps it below its standable band: feet more
 * than `step` under its top, head above its bottom); 2 = the start is already inside it that way.
 */
function sweepSolid(b: SolidFrame, shape: 0 | 1, hx: number, hz: number, y0: number, y1: number, a: XYZ, bb: XYZ, height: number, step: number): 0 | 1 | 2 {
  const lo = y0 - height + SWEEP_SLACK, hi = y1 - step - SWEEP_SLACK;
  if (hi <= lo) return 0;
  const { x: ax, y: ay, z: az } = toLocal(b, a);
  const { x: bx, y: by, z: bz } = toLocal(b, bb);
  const span = footprintSpan(shape, hx, hz, ax, az, bx - ax, bz - az);
  if (!span) return 0;
  // Feet height is linear along the path: the times it lies inside (lo, hi).
  const dy = by - ay;
  let s0: number, s1: number;
  if (Math.abs(dy) < 1e-12) {
    if (!(ay > lo && ay < hi)) return 0;
    s0 = -Infinity;
    s1 = Infinity;
  } else {
    s0 = (lo - ay) / dy;
    s1 = (hi - ay) / dy;
    if (s0 > s1) [s0, s1] = [s1, s0];
  }
  const t0 = Math.max(span.t0, s0), t1 = Math.min(span.t1, s1);
  if (!(t0 < t1)) return 0;
  return t0 <= 0 ? 2 : 1;
}

/** How far below the feet a supporting top is looked for (a jump apex is ~1.2 m; slack for slopes). */
const SUPPORT_REACH = 4;
const _p: XYZ = { x: 0, y: 0, z: 0 };

/**
 * For the server's movement validator (height and grounded checks): the highest intact prop top
 * that a player with feet at (x, y, z) stands over — centre over the top's footprint (within half
 * the body radius, the client's landing rule), feet no deeper than `step` below it, any height
 * above it — as a distance from the planet centre; 0 if none. Measure jumps from
 * max(R + terrain height, support): that is where the client stands and lands.
 *
 *   const props = new BreakableCollider(destruction.list, destruction.grid); // once per room
 *   const support = supportHeightAt(props, x, y, z, (i) => !destruction.isBroken(i));
 */
export function supportHeightAt<T extends SolidFrame>(props: BreakableCollider<T>, x: number, y: number, z: number, solid: (index: number) => boolean = () => true, body: { radius: number; step: number } = PLAYER_BODY): number {
  return props.support(x, y, z, solid, body);
}

/**
 * Every breakable of a body (or every town structure solid: planet/town.ts) behind a grid: resolves
 * the player against the solid ones near it.
 */
export class BreakableCollider<T extends SolidFrame = Breakable> {
  readonly grid: BreakableGrid<T>;
  readonly list: readonly T[];
  private readonly candidates: number[] = [];

  constructor(list: readonly T[], grid?: BreakableGrid<T>) {
    this.list = list;
    this.grid = grid ?? new BreakableGrid<T>(list);
  }

  /**
   * The highest solid prop top that feet at (x, y, z) stand over, however far below the feet (a jump
   * from a wall top), as a distance from the planet centre; 0 if none. See supportHeightAt.
   */
  support(x: number, y: number, z: number, solid: (index: number) => boolean, body: { radius: number; step: number } = PLAYER_BODY): number {
    if (this.list.length === 0) return 0;
    _p.x = x;
    _p.y = y;
    _p.z = z;
    const n = this.grid.collect(x, y, z, 0, 0, 0, 0, SUPPORT_REACH, this.candidates);
    let best = 0;
    for (let k = 0; k < n; k++) {
      const i = this.candidates[k]!;
      if (!solid(i)) continue;
      const top = supportOf(this.list[i]!, _p, body.radius, body.step);
      if (top > best) best = top;
    }
    return best;
  }

  /**
   * The first solid prop that feet moving straight from a to b pass through, or -1: the body's
   * centre gets inside one of its solids' footprints (by more than a few centimetres) while the
   * body overlaps that solid below its standable band (feet more than `step` under the top, head
   * above the bottom). A prop the start is already inside that way is ignored, so a body a prop
   * was rebuilt around can walk out. For the server's movement validator: the client moves in
   * short substeps against the same solids and never has its centre inside a footprint below the
   * band, so straight steps between its positions don't cross one; a step through a thin fence
   * with both ends outside it does (F12 final S2).
   */
  sweep(a: XYZ, b: XYZ, solid: (index: number) => boolean, body: { radius: number; height: number; step: number } = PLAYER_BODY): number {
    if (this.list.length === 0) return -1;
    const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (!(len > 1e-6)) return -1;
    const n = this.grid.collect(a.x, a.y, a.z, dx / len, dy / len, dz / len, len, body.radius + body.height, this.candidates);
    let first = -1;
    for (let k = 0; k < n; k++) {
      const i = this.candidates[k]!;
      if (!solid(i)) continue;
      const p = this.list[i]!;
      let hit = false, inside = false;
      for (let s = -1; s < (p.parts?.length ?? 0) && !inside; s++) {
        const q = s < 0 ? null : p.parts![s]!;
        const r = q ? sweepSolid(p, q.shape, q.hx, q.hz, q.y0, q.y1, a, b, body.height, body.step) : sweepSolid(p, p.shape, p.hx, p.hz, 0, p.h, a, b, body.height, body.step);
        if (r === 2) inside = true;
        else if (r === 1) hit = true;
      }
      if (hit && !inside && first < 0) first = i;
    }
    return first;
  }

  /**
   * Distance along a ray (origin o, unit direction d) to the first solid prop within `maxT`, or
   * Infinity (the same test the server's shot occlusion runs).
   */
  raycast(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxT: number, solid: (index: number) => boolean): number {
    if (!(maxT > 0) || this.list.length === 0) return Infinity;
    const n = this.grid.collect(ox, oy, oz, dx, dy, dz, maxT, 0, this.candidates);
    let best = Infinity;
    for (let k = 0; k < n; k++) {
      const i = this.candidates[k]!;
      if (!solid(i)) continue;
      const b = this.list[i]!;
      if (!segmentNearBreakable(b, ox, oy, oz, dx, dy, dz, maxT)) continue;
      const t = rayBreakable(b, ox, oy, oz, dx, dy, dz, Math.min(maxT, best));
      if (t < best) best = t;
    }
    return best;
  }

  /**
   * Push `p` (feet) out of every solid prop near it (`solid(index)`; broken props return false) and
   * report the floor under it. A few relaxation passes settle the player between neighbours.
   * Returns true if `p` moved.
   */
  resolve(p: XYZ, solid: (index: number) => boolean, out: PropContact, body: { radius: number; height: number; step: number } = PLAYER_BODY): boolean {
    resetContact(out);
    if (this.list.length === 0) return false;
    const { radius, height, step } = body;
    let moved = false;
    for (let pass = 0; pass < 4; pass++) {
      const n = this.grid.collect(p.x, p.y, p.z, 0, 0, 0, 0, radius + height, this.candidates);
      let any = false;
      out.floor = 0;
      for (let k = 0; k < n; k++) {
        const i = this.candidates[k]!;
        if (!solid(i)) continue;
        if (pushOutOfBreakable(this.list[i]!, p, radius, height, step, out)) any = true;
      }
      if (!any) break;
      moved = true;
    }
    return moved;
  }
}
