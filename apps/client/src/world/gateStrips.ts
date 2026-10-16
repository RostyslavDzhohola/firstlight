// The safe-zone border across a walled outpost's gate passages (D-b2-1): a glowing strip on the
// ground in the pad rings' colour, one per gate, draped on the rendered terrain like the path decals
// (outpostPaths.ts): a row every STRIP_STEP m along the passage, each vertex STRIP_LIFT m over the
// ground plus however far a crease of the terrain rises above the straight line to its neighbours,
// so the strip neither floats nor sinks where the ground slopes across a gate. It lies over the
// gate's path decal (above every path's lift).

import type { Terrain } from "@firstlight/shared";
import { OUTPOSTS, type OutpostBody } from "@firstlight/shared/content/padOutposts";
import { outpostAnchor, siteDir } from "@firstlight/shared/planet/sites";
import { PATH_LIFT } from "./outpostPaths.ts";

/** The strip's length along the wall (the gate opening is 4.2 m) and its width across the passage. */
export const STRIP_LENGTH = 3.9;
export const STRIP_WIDTH = 0.22;
/** Row spacing along the strip (m). */
export const STRIP_STEP = 0.25;

/** Lift (m) off the ground: over the highest path decal (paths stack 4 mm apart, outpostPaths.ts). */
export function stripLift(body: OutpostBody): number {
  return PATH_LIFT + 0.004 * OUTPOSTS[body].paths.length + 0.01;
}

/**
 * Triangle positions (world space, non-indexed, counter-clockwise from above) of every gate strip of
 * `body`'s outpost, or an empty array without a wall.
 */
export function outpostGateStrips(body: OutpostBody, terrain: Terrain): Float32Array {
  const wall = OUTPOSTS[body]?.wall;
  if (!wall) return new Float32Array(0);
  const R = terrain.body.radius;
  const anchor = outpostAnchor(terrain);
  const lift = stripLift(body);
  const at: [number, number, number] = [0, 0, 0];
  const groundAt = (e: number, n: number) => {
    siteDir(anchor, e, n, R, at);
    return terrain.groundHeight(at[0], at[1], at[2]);
  };
  const out: number[] = [];
  const rows = Math.ceil(STRIP_LENGTH / STRIP_STEP);
  for (const bearing of wall.gates) {
    const b = (bearing * Math.PI) / 180;
    // Site frame: the gate's centre on the ring, along the wall (t) and across it (u, outward).
    const ce = Math.sin(b) * wall.radius, cn = Math.cos(b) * wall.radius;
    const te = Math.cos(b), tn = -Math.sin(b);
    const ue = Math.sin(b), un = Math.cos(b);
    const vertex = (x: number, z: number): [number, number, number] => {
      const e = ce + te * x + ue * z, n = cn + tn * x + un * z;
      const g0 = groundAt(e, n);
      // The terrain's crease toward the neighbouring vertices (along and across).
      let crease = 0;
      for (const [de, dn] of [[te * STRIP_STEP, tn * STRIP_STEP], [ue * STRIP_WIDTH, un * STRIP_WIDTH]] as const) {
        for (const k of [1, -1]) crease = Math.max(crease, groundAt(e + (k * de) / 2, n + (k * dn) / 2) - (g0 + groundAt(e + k * de, n + k * dn)) / 2);
      }
      const d = siteDir(anchor, e, n, R);
      const r = R + g0 + crease + lift;
      return [d[0] * r, d[1] * r, d[2] * r];
    };
    const row = (i: number) => {
      const x = -STRIP_LENGTH / 2 + (STRIP_LENGTH * i) / rows;
      return [vertex(x, -STRIP_WIDTH / 2), vertex(x, STRIP_WIDTH / 2)] as const;
    };
    let prev = row(0);
    for (let i = 1; i <= rows; i++) {
      const next = row(i);
      // Quad (prev inner, next inner, next outer, prev outer) as two triangles.
      out.push(...prev[0], ...next[0], ...next[1], ...prev[0], ...next[1], ...prev[1]);
      prev = next;
    }
  }
  return new Float32Array(out);
}
