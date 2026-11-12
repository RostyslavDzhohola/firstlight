// Skipstep (content §2.6): where a blink along the ground ends. The server walks the path in short
// steps with the same world the movement validator uses (movement.ts MoveWorld: terrain, intact
// props, structures, natural solids) and stops before the first step that isn't allowed: through or
// into something solid, into deep water, or up or off a ledge.

import { SKIPSTEP } from "@firstlight/shared/content/spells";
import { deepWater } from "@firstlight/shared/planet/water";
import type { V3 } from "../geometry.ts";
import { MOVE, type MoveWorld } from "../movement.ts";

export interface SkipstepPath {
  /** Feet position at the end (on the ground). */
  to: V3;
  /** Ground covered (m). */
  dist: number;
  /** Why it ended early, if it did. */
  stopped: "solid" | "water" | "ledge" | null;
}

/**
 * The blink from `from` (feet) along `dir` (any direction: its part along the ground is used; null
 * when it has none, e.g. straight up). `range` metres at most.
 */
export function skipstepPath(w: MoveWorld, from: V3, dir: V3, range: number = SKIPSTEP.rangeM): SkipstepPath | null {
  const fl = Math.hypot(from[0], from[1], from[2]);
  if (!(fl > 0)) return null;
  let ux = from[0] / fl, uy = from[1] / fl, uz = from[2] / fl;
  // The aim, flattened onto the ground plane.
  let k = dir[0] * ux + dir[1] * uy + dir[2] * uz;
  let tx = dir[0] - ux * k, ty = dir[1] - uy * k, tz = dir[2] - uz * k;
  let tl = Math.hypot(tx, ty, tz);
  if (!(tl > 0.15 * Math.hypot(dir[0], dir[1], dir[2]))) return null;
  tx /= tl; ty /= tl; tz /= tl;
  let cur: V3 = [from[0], from[1], from[2]];
  let ground = w.groundAt(from[0], from[1], from[2]);
  let dist = 0;
  let stopped: SkipstepPath["stopped"] = null;
  const steps = Math.round(range / SKIPSTEP.stepM);
  for (let i = 0; i < steps; i++) {
    const px = cur[0] + tx * SKIPSTEP.stepM, py = cur[1] + ty * SKIPSTEP.stepM, pz = cur[2] + tz * SKIPSTEP.stepM;
    const pl = Math.hypot(px, py, pz);
    const g = w.groundAt(px, py, pz);
    if (!Number.isFinite(g) || deepWater(g, w.waterLevel)) {
      stopped = "water";
      break;
    }
    if (Math.abs(g - ground) > SKIPSTEP.maxStepRiseM) {
      stopped = "ledge";
      break;
    }
    const r = w.radius + g + 0.02;
    const next: V3 = [(px / pl) * r, (py / pl) * r, (pz / pl) * r];
    if (w.crosses?.(cur[0], cur[1], cur[2], next[0], next[1], next[2]) || w.footing?.(next[0], next[1], next[2], MOVE.groundedAbove).inside) {
      stopped = "solid";
      break;
    }
    cur = next;
    ground = g;
    dist += SKIPSTEP.stepM;
    // Carry the heading onto the next ground plane.
    ux = px / pl; uy = py / pl; uz = pz / pl;
    k = tx * ux + ty * uy + tz * uz;
    tx -= ux * k; ty -= uy * k; tz -= uz * k;
    tl = Math.hypot(tx, ty, tz) || 1;
    tx /= tl; ty /= tl; tz /= tl;
  }
  return { to: cur, dist, stopped };
}
