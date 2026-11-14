// The watchtowers' stairs (review 2026-11-13 world sites, finding 1): the client's real controller
// walks from the ground at the foot of the stair, round the tower and onto the lookout, without a
// jump, and every 20 Hz packet of the walk goes through the server's movement validator, as Net
// sends them. Before the fix the first riser stopped the walk: the side push started at an overlap,
// a top only counted as floor with the centre within half the body radius of its edge.

import { describe, expect, it } from "vitest";
import { BODIES, createTerrain } from "@firstlight/shared";
import { prefabPoint, wildSitePlacements } from "@firstlight/shared/planet/wildSites";
import type { PlayerActor } from "../src/world/actors.ts";
import { motionFields, validateMove } from "../src/world/movement.ts";
import { controller, keys, moveWorld, T0, toward, type V3 } from "./controller-helpers.ts";

/** The stair's path in the prefab frame (x right, z front): the foot, each flight's end, the walkway, the gap, the lookout. */
const ROUTES = {
  bellwether_watch: { body: "arcadia", path: [[-4, 2.35], [2.35, 2.35], [2.35, -2.35], [0.45, -2.35], [0.45, -0.6], [0, 0]] },
  relay_mast_four: { body: "meridian", path: [[-4.2, 2.55], [2.55, 2.55], [2.55, -2.55], [-0.4, -2.55], [-0.4, -1.3], [1.2, -0.6]] },
} as const;

async function climb(id: keyof typeof ROUTES, fps: number) {
  const route = ROUTES[id];
  const body = route.body;
  const R = BODIES[body].radius;
  const terrain = createTerrain(body);
  const site = wildSitePlacements(terrain).find((p) => p.site.id === id)!;
  const pc = await controller(body);
  const world = moveWorld(body);
  const onGround = (x: number, z: number): V3 => {
    const q = prefabPoint(site.frame, x, z, 0);
    const l = Math.hypot(q[0], q[1], q[2]);
    const g = R + terrain.groundHeight(q[0] / l, q[1] / l, q[2] / l);
    return [(q[0] / l) * g, (q[1] / l) * g, (q[2] / l) * g];
  };
  pc.teleport(...onGround(route.path[0][0], route.path[0][1]));
  const dt = 1 / fps;
  for (let i = 0; i < 6; i++) pc.update(dt, keys([]), false);
  const a = { lastX: pc.pos.x, lastY: pc.pos.y, lastZ: pc.pos.z, ...motionFields(pc.pos.length(), T0) } as unknown as PlayerActor;
  const walk = keys(["KeyW"]);
  const refused: string[] = [];
  const log: string[] = [];
  let reached = 0, t = 0, lastSend = -Infinity;
  for (let w = 1; w < route.path.length; w++) {
    const [x, z] = route.path[w]!;
    const goal = prefabPoint(site.frame, x, z, 0);
    let ok = false;
    for (let spent = 0; spent < 6; spent += dt, t += dt) {
      const l = pc.pos.length();
      const along = [goal[0] - pc.pos.x, goal[1] - pc.pos.y, goal[2] - pc.pos.z];
      const up = (along[0]! * pc.pos.x + along[1]! * pc.pos.y + along[2]! * pc.pos.z) / l;
      if (Math.hypot(along[0]! - (up * pc.pos.x) / l, along[1]! - (up * pc.pos.y) / l, along[2]! - (up * pc.pos.z) / l) < 0.15) {
        ok = true;
        break;
      }
      pc.camForward.set(...toward(pc.pos, goal));
      pc.update(dt, walk, false);
      const now = T0 + Math.round((t + dt) * 1000);
      if (now - lastSend < 50) continue;
      lastSend = now;
      const r = validateMove(a, { x: pc.pos.x, y: pc.pos.y, z: pc.pos.z, anim: pc.anim }, world, { speed: 1, dodge: 1 }, now);
      if (!r.ok) {
        refused.push(`${r.reason} at ${now - T0} ms (waypoint ${w})`);
        pc.correct(a.lastX, a.lastY, a.lastZ);
        continue;
      }
      a.lastX = pc.pos.x;
      a.lastY = pc.pos.y;
      a.lastZ = pc.pos.z;
    }
    log.push(`waypoint ${w} [${x}, ${z}]: ${ok ? "reached" : "stuck"} at height ${(pc.pos.length() - R - site.base).toFixed(2)}`);
    if (!ok) break;
    reached = w;
  }
  return { reached, log, refused, height: pc.pos.length() - R - site.base, onGround: pc.onGround, site, route };
}

describe("climbing a watchtower by walking: the real controller, every packet through the server's validator", () => {
  for (const id of Object.keys(ROUTES) as (keyof typeof ROUTES)[]) {
    for (const fps of [20, 60]) {
      it(`${id} at ${fps} fps: from the ground to the lookout, never refused`, async () => {
        const r = await climb(id, fps);
        expect(r.reached, r.log.join("\n")).toBe(r.route.path.length - 1);
        expect(r.refused, r.log.join("\n")).toEqual([]);
        expect(r.height).toBeCloseTo(r.site.prefab.lookout[2], 1);
        expect(r.onGround).toBe(true);
        // The walk ends on the prefab's lookout spot.
        expect(r.route.path.at(-1)).toEqual([r.site.prefab.lookout[0], r.site.prefab.lookout[1]]);
      }, 30_000);
    }
  }
});
