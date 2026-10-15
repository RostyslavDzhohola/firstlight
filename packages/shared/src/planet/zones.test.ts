import { describe, expect, it } from "vitest";
import { TOWN_FIXED, TOWN_LAYOUT, TOWN_PREFABS } from "../content/portusTown.ts";
import { objectDir, WORLD_OBJECT_BY_ID } from "../content/world.ts";
import { dummyDir, TRAINING_DUMMIES } from "../content/onboarding.ts";
import { BODIES } from "./bodies.ts";
import { padDirs, PAD_SAFE_RADIUS } from "./pads.ts";
import { portalSpots } from "./portals.ts";
import { createTerrain } from "./terrain.ts";
import { townCoords, townDir } from "./townFrame.ts";
import { inTownSafe, isSafe, nearestSafeEntry, nearSafeZone, safePadAt, TOWN_GATES, TOWN_SAFE, zoneAt } from "./zones.ts";

const P = BODIES.portus;
const R = P.radius;
const at = (east: number, north: number, lift = 0): [number, number, number] => {
  const d = townDir(east, north, R);
  return [d[0] * (R + lift), d[1] * (R + lift), d[2] * (R + lift)];
};
const prefab = (name: string) => TOWN_PREFABS.findIndex((p) => p.name === name);
const itemsOf = (...names: string[]) => TOWN_LAYOUT.filter((it) => names.includes(TOWN_PREFABS[it[0]]!.name));

describe("Portus: the castle town is safe, outside the walls is wild (D-zones-1)", () => {
  it("the arrival point, the spawn ring, the portals, Juno, the Hall wall and the dummies are inside", () => {
    expect(zoneAt(P, 0, R, 0)).toEqual({ safe: true, kind: "town", pad: 0 });
    for (let r = 2; r <= 6; r++) for (let a = 0; a < 8; a++) expect(isSafe(P, ...at(Math.cos(a) * r, Math.sin(a) * r))).toBe(true);
    for (const s of portalSpots(P, createTerrain("portus"))) expect(isSafe(P, ...s.center)).toBe(true);
    for (const id of ["juno_vale", "hall_wall"]) {
      const d = objectDir(WORLD_OBJECT_BY_ID.get(id)!);
      expect(isSafe(P, d[0] * R, d[1] * R, d[2] * R), id).toBe(true);
    }
    TRAINING_DUMMIES.forEach((_, i) => {
      const d = dummyDir(i);
      expect(isSafe(P, d[0] * R, d[1] * R, d[2] * R)).toBe(true);
    });
    for (const [e, n] of [...Object.values(TOWN_FIXED.portals), TOWN_FIXED.juno, TOWN_FIXED.plaque, ...TOWN_FIXED.dummies]) expect(inTownSafe(e, n)).toBe(true);
  });

  it("every building, court and street inside the walls is safe, the curtain wall and the castle ward included", () => {
    const inside = itemsOf("keep", "market_hall", "hall_of_firsts", "portal_court_arcadia", "portal_court_hollowmere", "portal_court_meridian",
      "house_a", "house_b", "house_c", "house_d", "cottage", "well", "stall_a", "stall_b", "stall_c", "wagon", "weapon_rack", "target",
      "wall_seg", "wall_seg_ivy", "tower_round", "tower_round_roof", "gatehouse", "castle_gate", "wall_stair", "lean_to", "ring_bench");
    expect(inside.length).toBeGreaterThan(80);
    for (const [, e, n] of inside) expect(inTownSafe(e, n), `${e}, ${n}`).toBe(true);
    // The ward's corners, just inside its walls.
    expect(inTownSafe(13.5, 61)).toBe(true);
    expect(inTownSafe(-13.5, 61)).toBe(true);
  });

  it("the road furniture, the paddock fence and the trees outside the walls are on wild land", () => {
    const outside = TOWN_LAYOUT.filter(([p, e, n]) => ["brazier", "signpost", "fence", "tree_pine_tall"].includes(TOWN_PREFABS[p]!.name) && Math.hypot(e, n) > 48);
    expect(outside.length).toBeGreaterThan(12);
    for (const [, e, n] of outside) expect(isSafe(P, ...at(e, n)), `${e}, ${n}`).toBe(false);
    expect(zoneAt(P, ...at(80, 0))).toEqual({ safe: false, kind: "wild", pad: -1 });
    // The far side of the planet.
    expect(isSafe(P, 0, -R, 0)).toBe(false);
  });

  it("the gates are the border: safe in the passage's inner half, wild past its middle", () => {
    expect(TOWN_GATES).toHaveLength(2);
    const gates = itemsOf("gatehouse").map(([, e, n]) => [e, n] as const);
    expect(gates.map(([e]) => Math.sign(e)).sort()).toEqual([-1, 1]);
    for (const [e, n] of gates) {
      const s = Math.sign(e);
      expect(Math.hypot(e, n)).toBeCloseTo(TOWN_SAFE.radius, 0);
      expect(isSafe(P, ...at(s * 44, n))).toBe(true);
      expect(isSafe(P, ...at(s * 45.8, n))).toBe(true);
      expect(isSafe(P, ...at(s * 46.3, n))).toBe(false);
      expect(isSafe(P, ...at(s * 49, n))).toBe(false); // the outer mouth
    }
    // Height doesn't matter (feet, chest, a jump).
    expect(isSafe(P, ...at(30, 0, 3))).toBe(true);
    expect(isSafe(P, ...at(60, 0, 3))).toBe(false);
  });

  it("the wall body itself and the castle ward's walls are inside; just past their outer faces is wild", () => {
    // South wall at north -43.9 (half thickness 1.4): outer face at -45.3.
    expect(isSafe(P, ...at(0, -45))).toBe(true);
    expect(isSafe(P, ...at(0, -46.5))).toBe(false);
    // Ward side walls on east ±15, back wall on north 62.7.
    expect(isSafe(P, ...at(16, 52))).toBe(true);
    expect(isSafe(P, ...at(17, 52))).toBe(false);
    expect(isSafe(P, ...at(0, 64))).toBe(true);
    expect(isSafe(P, ...at(0, 65))).toBe(false);
  });

  it("safePadAt keeps its meaning (0 = the town's arrival point) and fast travel stays off Portus", () => {
    expect(safePadAt(P, ...at(10, 10))).toBe(0);
    expect(safePadAt(P, ...at(70, 10))).toBe(-1);
    expect(P.padLayout).toBe("none");
  });

  it("nearSafeZone widens the town by the margin (NPCs keep out of it)", () => {
    expect(nearSafeZone(P, ...at(48, 0), 0)).toBe(false);
    expect(nearSafeZone(P, ...at(48, 0), 3)).toBe(true);
    expect(nearSafeZone(P, ...at(50, 0), 3.5)).toBe(false);
    expect(nearSafeZone(P, ...at(0, 66), 3)).toBe(true);
  });

  it("the compass's way back is the nearer gate", () => {
    const east = nearestSafeEntry(P, ...at(70, 5));
    const tc = townCoords(east.dir[0], east.dir[1], east.dir[2], R);
    expect(tc[0]).toBeCloseTo(46, 1);
    expect(east.edge).toBe(0);
    const west = townCoords(...nearestSafeEntry(P, ...at(-90, -20)).dir, R);
    expect(west[0]).toBeCloseTo(-46, 1);
  });

  it("has a prefab table with the names the footprint was measured against", () => {
    for (const n of ["gatehouse", "wall_seg", "keep", "castle_gate"]) expect(prefab(n)).toBeGreaterThanOrEqual(0);
  });
});

describe("planets: 12 m pad rings (D15), unchanged", () => {
  it.each(["arcadia", "hollowmere", "meridian"] as const)("%s", (id) => {
    const body = BODIES[id];
    const pads = padDirs(body);
    pads.forEach((d, i) => {
      const r = body.radius + 3;
      expect(zoneAt(body, d[0] * r, d[1] * r, d[2] * r)).toEqual({ safe: true, kind: "pad", pad: i });
    });
    // 12.5 m from pad 0 along any tangent is outside its ring (and no other pad is that close).
    const d = pads[0]!;
    const t = Math.abs(d[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    const k = t[0]! * d[0] + t[1]! * d[1] + t[2]! * d[2];
    const tx = t[0]! - k * d[0], ty = t[1]! - k * d[1], tz = t[2]! - k * d[2];
    const tl = Math.hypot(tx, ty, tz);
    const p = (m: number) => {
      const v = [d[0] + (tx / tl) * (m / body.radius), d[1] + (ty / tl) * (m / body.radius), d[2] + (tz / tl) * (m / body.radius)];
      const l = Math.hypot(v[0]!, v[1]!, v[2]!);
      return [(v[0]! / l) * body.radius, (v[1]! / l) * body.radius, (v[2]! / l) * body.radius] as [number, number, number];
    };
    expect(isSafe(body, ...p(PAD_SAFE_RADIUS - 0.5))).toBe(true);
    expect(zoneAt(body, ...p(PAD_SAFE_RADIUS + 0.5))).toEqual({ safe: false, kind: "wild", pad: -1 });
    expect(nearSafeZone(body, ...p(PAD_SAFE_RADIUS + 2), 3)).toBe(true);
    expect(nearestSafeEntry(body, ...p(40)).edge).toBe(PAD_SAFE_RADIUS);
  });
});
