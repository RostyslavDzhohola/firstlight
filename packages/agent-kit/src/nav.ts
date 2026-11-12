// Steering: how the agent gets from here to there without a navmesh. It walks straight at the
// target, probes the shared solids a couple of metres ahead (walker.probe: the same push-out the
// movement uses), and when the way is shut goes round on one side until the straight line opens
// again. A walled safe zone (the Portus town, a planet's arrival outpost) is crossed through its
// nearest gate.

import { towardDir } from "@firstlight/shared/content/places";
import { dist, groundDistance, norm, sub, tangent, turn, type V3 } from "./vec.ts";
import type { Walker } from "./walker.ts";
import type { BodyWorld } from "./world.ts";

export interface NavStep {
  /** Unit tangent to walk along now (null: nowhere to go). */
  wish: V3 | null;
  /** Metres still to walk along the route. */
  remaining: number;
  /** No way round found for a long while. */
  blocked: boolean;
  /** The target is gone (a creature died, a pile was taken). */
  gone: boolean;
}

export type Navigator = (now: number) => NavStep;

/** How far either side of a gate's centre the route's waypoints sit (metres, along the line through the centre). */
const GATE_APPROACH = 9;

/** Waypoints through the nearest gate when one end is inside the walls and the other outside. */
export function routeVia(w: BodyWorld, from: V3, to: V3): V3[] {
  const centre = w.walledCentre;
  if (!centre || !w.gates.length) return [];
  const a = w.walled(from), b = w.walled(to);
  if (a === b) return [];
  let gate = w.gates[0]!, best = Infinity;
  for (const g of w.gates) {
    const d = groundDistance(from, g) + groundDistance(g, to);
    if (d < best) (best = d), (gate = g);
  }
  const gd = norm(gate);
  const inner = w.onGround(towardDir(gd, centre, GATE_APPROACH, w.R));
  const outer = w.onGround(towardDir(gd, centre, -GATE_APPROACH, w.R));
  return a ? [inner, w.onGround(gd), outer] : [outer, w.onGround(gd), inner];
}

const ANGLES = [25, 50, 75, 100, 130, 160];

/** A steering function towards a (possibly moving) point. Call it once per movement tick. */
export function createNavigator(walker: Walker, w: BodyWorld, dest: () => V3 | null): Navigator {
  let path: V3[] | null = null;
  let routedFor: V3 | null = null;
  let side = 0;
  let sideSince = 0;
  let best = Infinity;
  let bestAt = 0;
  let flips = 0;
  return (now) => {
    const final = dest();
    if (!final) return { wish: null, remaining: 0, blocked: false, gone: true };
    const pos = walker.p;
    if (!path || !routedFor || dist(routedFor, final) > 6) {
      path = routeVia(w, pos, final);
      routedFor = final;
      best = Infinity;
      bestAt = now;
      flips = 0;
    }
    // A waypoint is done with when we stand on it, and the whole gate detour once we are on the
    // target's side of the wall (a waypoint may sit in something: a statue outside the gate).
    while (path.length && groundDistance(pos, path[0]!) < 1.6) path.shift();
    if (path.length && w.walled(pos) === w.walled(final) && groundDistance(pos, path[path.length - 1]!) < GATE_APPROACH * 2 + 4) path.length = 0;
    const target = path[0] ?? final;
    let remaining = groundDistance(pos, target);
    for (let i = 0; i < path.length; i++) remaining += groundDistance(path[i]!, path[i + 1] ?? final);
    if (remaining < best - 0.5) (best = remaining), (bestAt = now);
    const up = norm(pos);
    const direct = tangent(up, sub(target, pos));
    if (!direct) return { wish: null, remaining, blocked: false, gone: false };
    const d = groundDistance(pos, target);
    const L = Math.min(2.4, Math.max(0.5, d));
    const wet = walker.swimming || w.deepAt(final) || w.deepAt(target);
    const clear = (dir: V3) => walker.probe(dir, L, wet) >= L * 0.8;
    let wish: V3 | null = null;
    if (clear(direct) && (side === 0 || now - sideSince > 400)) {
      side = 0;
      wish = direct;
    } else {
      if (side === 0) {
        for (const a of ANGLES) {
          const r = clear(turn(up, direct, a)), l = clear(turn(up, direct, -a));
          if (r || l) {
            side = r && l ? (flips % 2 === 0 ? 1 : -1) : r ? 1 : -1;
            break;
          }
        }
        if (side === 0) side = 1;
        sideSince = now;
      }
      for (const a of ANGLES) {
        const dir = turn(up, direct, side * a);
        if (clear(dir)) {
          wish = dir;
          break;
        }
      }
      if (!wish) {
        // Boxed in on this side: try the other way round.
        side = -side;
        sideSince = now;
        flips++;
        wish = turn(up, direct, side * 160);
      }
    }
    // Going round something the wrong way for a long while: turn about.
    if (side !== 0 && now - bestAt > 6000 && now - sideSince > 6000) {
      side = -side;
      sideSince = now;
      flips++;
    }
    return { wish, remaining, blocked: now - bestAt > 20_000 || flips > 8, gone: false };
  };
}
