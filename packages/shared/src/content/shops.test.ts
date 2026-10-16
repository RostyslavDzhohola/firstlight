import { describe, expect, it } from "vitest";
import { BODIES, BODY_IDS } from "../planet/bodies.ts";
import { padDirs } from "../planet/pads.ts";
import { structureCollider } from "../planet/sites.ts";
import { createTerrain } from "../planet/terrain.ts";
import { isSafe } from "../planet/zones.ts";
import { buyBlock, SHOP_SPOTS, shopSpotAt } from "./shops.ts";
import { objectPos, WORLD_OBJECT_BY_ID } from "./world.ts";

type V3 = [number, number, number];
const len = (p: readonly number[]) => Math.hypot(p[0]!, p[1]!, p[2]!);
const scale = (p: readonly number[], r: number): V3 => {
  const l = len(p);
  return [(p[0]! / l) * r, (p[1]! / l) * r, (p[2]! / l) * r];
};
/** A point `metres` along the ground from `p`, in some tangent direction `angle`. */
function along(p: readonly number[], metres: number, angle: number): V3 {
  const r = len(p);
  const up = scale(p, 1);
  const ref = Math.abs(up[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const e = scale([up[1] * ref[2]! - up[2] * ref[1]!, up[2] * ref[0]! - up[0] * ref[2]!, up[0] * ref[1]! - up[1] * ref[0]!], 1);
  const n = [up[1] * e[2] - up[2] * e[1], up[2] * e[0] - up[0] * e[2], up[0] * e[1] - up[1] * e[0]];
  const t = metres / r;
  const dir = [0, 1, 2].map((i) => up[i]! * Math.cos(t) + (e[i]! * Math.cos(angle) + n[i]! * Math.sin(angle)) * Math.sin(t));
  return scale(dir, r);
}

describe("shops in every safe zone (round 2)", () => {
  it("has one shop on every body, each with its keeper standing at the spot", () => {
    for (const b of BODY_IDS) expect(SHOP_SPOTS.filter((s) => s.body === b), b).toHaveLength(1);
    expect(new Set(SHOP_SPOTS.map((s) => s.id)).size).toBe(SHOP_SPOTS.length);
    for (const s of SHOP_SPOTS) {
      const keeper = WORLD_OBJECT_BY_ID.get(s.id)!;
      expect(keeper, s.id).toBeTruthy();
      expect(keeper).toMatchObject({ body: s.body, look: "keeper", trigger: "interact" });
      expect(keeper.range).toBeLessThan(s.radius); // whoever can press E can trade
      const t = createTerrain(s.body);
      const p = objectPos(keeper, (x, y, z) => t.groundHeight(x, y, z));
      expect(Math.hypot(p[0] - s.pos[0], p[1] - s.pos[1], p[2] - s.pos[2]), s.id).toBeLessThan(0.05);
    }
  });

  it("puts every till inside a safe zone, all the way round its radius", () => {
    for (const s of SHOP_SPOTS) {
      const body = BODIES[s.body];
      expect(isSafe(body, ...s.pos), s.id).toBe(true);
      for (let a = 0; a < 12; a++) expect(isSafe(body, ...along(s.pos, s.radius, (a / 12) * Math.PI * 2)), `${s.id} edge ${a}`).toBe(true);
    }
  });

  it("can walk from a planet's main pad up to its shop's counter without going through a building", () => {
    for (const s of SHOP_SPOTS.filter((x) => x.body !== "portus")) {
      const t = createTerrain(s.body);
      const R = BODIES[s.body].radius;
      const pad = padDirs(BODIES[s.body])[0]!;
      const g = t.groundHeight(pad[0], pad[1], pad[2]);
      const from = scale(pad, R + g + 0.1);
      // The keeper stands behind the stall's counter (D-b2-3), which faces the pad: walk up to 2.5 m
      // in front of the keeper, well inside the till's radius.
      const u = scale(s.pos, 1);
      const toPad = [pad[0] - u[0], pad[1] - u[1], pad[2] - u[2]];
      const k = 2.5 / (len(toPad) * R);
      const v = [u[0] + toPad[0] * k, u[1] + toPad[1] * k, u[2] + toPad[2] * k];
      const lv = len(v);
      const front = [v[0] / lv, v[1] / lv, v[2] / lv] as const;
      const to = scale(front, R + t.groundHeight(front[0], front[1], front[2]) + 0.1);
      expect(Math.hypot(to[0] - s.pos[0], to[1] - s.pos[1], to[2] - s.pos[2]), s.id).toBeLessThan(s.radius - 2);
      expect(structureCollider(t).crosses(...from, ...to), s.id).toBe(false);
    }
  });

  it("opens the till within the radius, on that body only", () => {
    for (const s of SHOP_SPOTS) {
      expect(shopSpotAt(s.body, s.pos)).toBe(s);
      expect(shopSpotAt(s.body, along(s.pos, s.radius - 0.2, 1))).toBe(s);
      expect(shopSpotAt(s.body, along(s.pos, s.radius + 0.5, 1))).toBeNull();
      expect(shopSpotAt(s.body, scale(s.pos, len(s.pos) + 6))).toBeNull(); // far above (a roof, a jump pad)
      expect(shopSpotAt(s.body, scale(s.pos, len(s.pos) + 1.5))).toBe(s); // a step up
      for (const other of BODY_IDS) if (other !== s.body) expect(shopSpotAt(other, s.pos)).toBeNull();
    }
  });

  it("sells only what you can use and afford", () => {
    const sword = { level: 6, price: 300 };
    expect(buyBlock(sword, { level: 5, coins: 1000 })).toEqual({ reason: "level", level: 6 });
    expect(buyBlock(sword, { level: 6, coins: 299 })).toEqual({ reason: "coins", need: 300, short: 1 });
    expect(buyBlock(sword, { level: 6, coins: 300 })).toBeNull();
    expect(buyBlock({ level: 1, price: 10 }, { level: 1, coins: 25 }, 3)).toEqual({ reason: "coins", need: 30, short: 5 });
  });
});
