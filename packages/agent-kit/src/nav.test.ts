// Steering without a server: the walker gets where it is sent on every body, through the walls'
// gates and round what stands in the way, at walking pace (no step longer than the speed allows).

import { describe, expect, it } from "vitest";
import { towardDir } from "@firstlight/shared/content/places";
import { BODY_IDS, type BodyId } from "@firstlight/shared";
import { createNavigator, routeVia } from "./nav.ts";
import { dirOfBearing, groundDistance, norm, type V3 } from "./vec.ts";
import { WALK, Walker } from "./walker.ts";
import { bodyWorld } from "./world.ts";

/** Walk from `from` to `to` in 50 ms steps; returns how it ended. */
function walk(body: BodyId, from: V3, to: V3, speed: number = WALK.sprint, maxSeconds = 90) {
  const w = bodyWorld(body);
  const walker = new Walker(w);
  walker.place(from[0], from[1], from[2]);
  const nav = createNavigator(walker, w, () => to);
  let worst = 0;
  for (let t = 50; t <= maxSeconds * 1000; t += 50) {
    const n = nav(t);
    if (groundDistance(walker.p, to) < 1) return { arrived: true, seconds: t / 1000, worst, inside: w.walled(walker.p) };
    if (n.blocked) return { arrived: false, seconds: t / 1000, worst, inside: w.walled(walker.p), blocked: true };
    walker.step(0.05, n.wish, speed);
    worst = Math.max(worst, walker.lastMoved);
  }
  return { arrived: false, seconds: maxSeconds, worst, inside: w.walled(walker.p) };
}

describe("steering", () => {
  it("leaves every walled safe zone through a gate and comes back in, on every body", () => {
    for (const id of BODY_IDS) {
      const w = bodyWorld(id);
      expect(w.gates.length, id).toBeGreaterThan(0);
      const centre = w.walledCentre!;
      const start = w.onGround(id === "portus" ? towardDir(centre, norm(w.gates[0]!), 6, w.R) : centre);
      for (const bearing of [20, 140, 260]) {
        // A standable point 30 m beyond the wall on this bearing (the first one that is dry and clear).
        let out: V3 | null = null;
        for (let m = 75; m <= 140 && !out; m += 5) {
          const p = w.onGround(towardDir(centre, norm([centre[0] + dirOfBearing(centre, bearing)[0], centre[1] + dirOfBearing(centre, bearing)[1], centre[2] + dirOfBearing(centre, bearing)[2]]), m, w.R));
          if (!w.walled(p) && w.standable(p)) out = p;
        }
        if (!out) continue; // water or cliffs all along this bearing
        expect(routeVia(w, start, out).length, `${id} ${bearing}`).toBeGreaterThan(0);
        const there = walk(id, start, out);
        expect(there, `${id} out at ${bearing}`).toMatchObject({ arrived: true, inside: false });
        const back = walk(id, out, start);
        expect(back, `${id} back from ${bearing}`).toMatchObject({ arrived: true, inside: true });
        // Never faster than the speed asked for (a 50 ms step at 9 m/s is 0.45 m).
        expect(Math.max(there.worst, back.worst)).toBeLessThanOrEqual(WALK.sprint * 0.05 + 0.02);
      }
    }
  }, 120_000);

  it("reaches the guide, the shop and the portal from the pad on each planet", () => {
    for (const id of ["arcadia", "hollowmere", "meridian"] as const) {
      const w = bodyWorld(id);
      const pad = w.pads[0]!.pos;
      const stops: V3[] = [w.guide!.pos, w.shops[0]!.at, [w.portals[0]!.dir[0] * (w.R + w.portals[0]!.h), w.portals[0]!.dir[1] * (w.R + w.portals[0]!.h), w.portals[0]!.dir[2] * (w.R + w.portals[0]!.h)]];
      for (const to of stops) {
        const w2 = new Walker(w);
        w2.place(pad[0], pad[1], pad[2]);
        const nav = createNavigator(w2, w, () => to);
        let ok = false;
        for (let t = 50; t <= 30_000 && !ok; t += 50) {
          const n = nav(t);
          if (groundDistance(w2.p, to) < 3) ok = true;
          else w2.step(0.05, n.wish, WALK.run);
        }
        expect(ok, `${id}`).toBe(true);
      }
    }
  }, 60_000);
});
