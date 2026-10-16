import { describe, expect, it } from "vitest";
import { TOWN_FIXED, TOWN_LAYOUT, TOWN_PREFABS } from "../content/portusTown.ts";
import { objectDir, WORLD_OBJECT_BY_ID } from "../content/world.ts";
import { dummyDir, TRAINING_DUMMIES } from "../content/onboarding.ts";
import { BODIES } from "./bodies.ts";
import { padDirs, PAD_SAFE_RADIUS } from "./pads.ts";
import { portalSpots } from "./portals.ts";
import { createTerrain } from "./terrain.ts";
import { townCoords, townDir } from "./townFrame.ts";
import { inTownSafe, inWalledZone, isSafe, nearestSafeEntry, nearSafeZone, protectsAtOnce, safeGates, safePadAt, TOWN_GATES, TOWN_SAFE, zoneAt } from "./zones.ts";
import { OUTPOSTS, type OutpostBody } from "../content/padOutposts.ts";
import { siteAnchor, siteDir } from "./townFrame.ts";

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

describe("planets: 12 m pad rings (D15) and the walled arrival outpost round pad 0 (D-b2-1)", () => {
  /** A point `m` metres from pad 0 at `bearing` degrees (north toward east) in the outpost's frame. */
  const fromPad0 = (id: OutpostBody, bearing: number, m: number, lift = 0): [number, number, number] => {
    const body = BODIES[id];
    const a = siteAnchor(padDirs(body)[0]!);
    const b = (bearing * Math.PI) / 180;
    const d = siteDir(a, Math.sin(b) * m, Math.cos(b) * m, body.radius);
    const r = body.radius + lift;
    return [d[0] * r, d[1] * r, d[2] * r];
  };

  it.each(["arcadia", "hollowmere", "meridian"] as const)("%s: the other pads keep their 12 m rings", (id) => {
    const body = BODIES[id];
    const pads = padDirs(body);
    pads.forEach((d, i) => {
      if (i === 0) return;
      const r = body.radius + 3;
      expect(zoneAt(body, d[0] * r, d[1] * r, d[2] * r)).toEqual({ safe: true, kind: "pad", pad: i });
    });
  });

  it.each(["arcadia", "hollowmere", "meridian"] as const)("%s: inside the wall ring is safe at once, outside is wild; the gates are the way in", (id) => {
    const body = BODIES[id];
    const wall = OUTPOSTS[id].wall;
    expect(wall.radius).toBeGreaterThan(PAD_SAFE_RADIUS + 15);
    expect(wall.gates.length).toBeGreaterThanOrEqual(2);
    const d0 = padDirs(body)[0]!;
    const r = body.radius + 3;
    // Pad 0's ring is inside: the outpost's zone (its `pad` still names the ring you stand in).
    expect(zoneAt(body, d0[0] * r, d0[1] * r, d0[2] * r)).toEqual({ safe: true, kind: "outpost", pad: 0 });
    for (let b = 0; b < 360; b += 15) {
      expect(zoneAt(body, ...fromPad0(id, b, PAD_SAFE_RADIUS + 3))).toEqual({ safe: true, kind: "outpost", pad: -1 });
      expect(isSafe(body, ...fromPad0(id, b, wall.radius - 0.5))).toBe(true);
      expect(inWalledZone(body, ...fromPad0(id, b, wall.radius - 0.5))).toBe(true);
      expect(zoneAt(body, ...fromPad0(id, b, wall.radius + 0.5))).toEqual({ safe: false, kind: "wild", pad: -1 });
      expect(nearSafeZone(body, ...fromPad0(id, b, wall.radius + 2), 3)).toBe(true);
      expect(nearSafeZone(body, ...fromPad0(id, b, wall.radius + 4), 3)).toBe(false);
    }
    expect(protectsAtOnce("outpost")).toBe(true);
    expect(protectsAtOnce("pad")).toBe(false);
    // The portal home, the guide and the shop's keeper stand inside.
    const terrain = createTerrain(id);
    for (const s of portalSpots(body, terrain)) expect(zoneAt(body, ...s.center).kind).toBe("outpost");
    const [se, sn] = OUTPOSTS[id].shop.at;
    expect(Math.hypot(se, sn)).toBeLessThan(wall.radius - 3);
    // Outside, the compass points at the nearest gate (edge 0: the border runs through it).
    for (const g of wall.gates) {
      const entry = nearestSafeEntry(body, ...fromPad0(id, g, wall.radius + 20));
      const want = safeGates(body)[wall.gates.indexOf(g)]!;
      expect(entry.edge).toBe(0);
      expect(Math.hypot(entry.dir[0] - want[0], entry.dir[1] - want[1], entry.dir[2] - want[2])).toBeLessThan(1e-9);
    }
  });

  it("Portus' gates are its safe gates", () => {
    expect(safeGates(P)).toBe(TOWN_GATES);
  });
});
