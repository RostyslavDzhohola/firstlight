// Player vs breakable props (SPEC §4.3 "prop colliders", §6.9): intact props block walking and can
// be stood on; broken ones don't. Pure and allocation-free so the client controller can run it
// every frame and the server's movement validator can reuse it (BreakableGrid + its broken set).
//
// The player is a vertical cylinder (feet at the position, upright in the prop's frame; a prop's up
// differs from the player's by metres / planet radius, which is negligible). Pushes are sideways in
// the prop's tangent plane, by the shortest way out, so walking into a prop slides along it.

import { BreakableGrid, rayBreakable, segmentNearBreakable, type Breakable } from "./breakables.ts";

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
 * One prop vs the player cylinder (`radius`, `height`) with its feet at `p`.
 * - Feet within `step` below the top (or just above it) with the centre over the footprint: the prop
 *   is a floor; its top (distance from the planet centre) goes into `out.floor` (the max is kept).
 * - Otherwise, overlapping the side: `p` moves out sideways by the shortest way; the push direction
 *   goes into `out`.
 * Returns true if `p` moved.
 */
export function pushOutOfBreakable(b: Breakable, p: XYZ, radius: number, height: number, step: number, out: PropContact): boolean {
  const qx = p.x - b.px, qy = p.y - b.py, qz = p.z - b.pz;
  const ly = qx * b.ux + qy * b.uy + qz * b.uz;
  if (ly >= b.h + TOP_SLACK || ly + height <= 0) return false;
  const lx = qx * b.rx + qy * b.ry + qz * b.rz;
  const lz = qx * b.fx + qy * b.fy + qz * b.fz;
  // Unit escape direction (local x, z), how far to move along it, and how far the centre is
  // outside the footprint (0 inside).
  let dx: number, dz: number, depth: number, outside: number;
  if (b.shape === 0) {
    const cx = Math.max(-b.hx, Math.min(b.hx, lx));
    const cz = Math.max(-b.hz, Math.min(b.hz, lz));
    const ex = lx - cx, ez = lz - cz;
    outside = Math.sqrt(ex * ex + ez * ez);
    if (outside >= radius) return false;
    if (outside > 1e-9) {
      dx = ex / outside;
      dz = ez / outside;
      depth = radius - outside;
    } else {
      // Centre inside the box: leave through the nearest face.
      const gx = b.hx - Math.abs(lx), gz = b.hz - Math.abs(lz);
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
    if (rl >= b.hx + radius) return false;
    outside = Math.max(0, rl - b.hx);
    if (rl > 1e-9) {
      dx = lx / rl;
      dz = lz / rl;
    } else {
      dx = 1;
      dz = 0;
    }
    depth = b.hx + radius - rl;
  }
  if (ly >= b.h - step && outside <= radius * 0.5) {
    // Standing on (or stepping onto) the top.
    const lift = b.h - ly;
    const tx = p.x + b.ux * lift, ty = p.y + b.uy * lift, tz = p.z + b.uz * lift;
    const top = Math.sqrt(tx * tx + ty * ty + tz * tz);
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

/** Every breakable of a body behind a grid: resolves the player against the solid ones near it. */
export class BreakableCollider {
  readonly grid: BreakableGrid;
  readonly list: readonly Breakable[];
  private readonly candidates: number[] = [];

  constructor(list: readonly Breakable[], grid?: BreakableGrid) {
    this.list = list;
    this.grid = grid ?? new BreakableGrid(list);
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
