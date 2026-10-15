import { describe, expect, it } from "vitest";
import { TOWN_EAST, TOWN_NORTH } from "@firstlight/shared/planet/townFrame";
import { tangentFrame } from "@firstlight/shared/content/places";
import { townDir } from "@firstlight/shared/planet/townFrame";
import { bearingTo, eastAt, headingOf, nearestDir, northAt, stripX, surfaceDistance, wrapDeg, type V3 } from "./compassMath.ts";

const R = 500;
// On the equator at +X, looking north (+Z, the game's pole frame): east is +Y, to the right.
const pos: V3 = [R, 0, 0];
const north: V3 = [0, 0, 1];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

describe("compass math on a sphere", () => {
  it("north points toward the +Z pole along the surface, with a fallback at the poles", () => {
    expect(northAt(pos)).toEqual([0, 0, 1]);
    expect(eastAt(pos)[1]).toBeCloseTo(1, 9);
    const n = northAt([0, 0, R]);
    expect(Math.hypot(...n)).toBeCloseTo(1, 6);
    expect(Math.abs(n[2])).toBeLessThan(1e-9);
  });

  it("heading is clockwise from north", () => {
    expect(headingOf(pos, north)).toBeCloseTo(0, 6);
    // right = forward × up = (0,0,1) × (1,0,0) = (0,1,0)
    expect(headingOf(pos, [0, 1, 0])).toBeCloseTo(90, 6);
    expect(headingOf(pos, [0, 0, -1])).toBeCloseTo(180, 6);
    expect(headingOf(pos, [0, -1, 0])).toBeCloseTo(270, 6);
  });

  it("bearings to targets are relative to where you look", () => {
    expect(bearingTo(pos, north, [R, 0, 10])).toBeCloseTo(0, 6);
    expect(bearingTo(pos, north, [R, 10, 0])).toBeCloseTo(90, 6);
    expect(bearingTo(pos, north, [R, -10, 0])).toBeCloseTo(-90, 6);
    expect(Math.abs(bearingTo(pos, north, [R, 0, -10]))).toBeCloseTo(180, 6);
  });

  it("distances, nearest pads and the strip", () => {
    expect(surfaceDistance(pos, [0, R, 0], R)).toBeCloseTo((Math.PI / 2) * R, 6);
    expect(nearestDir([R, 1, 0], [[0, 1, 0], [1, 0, 0], [0, 0, 1]])).toBe(1);
    expect(wrapDeg(270)).toBe(-90);
    expect(stripX(0, 90)).toEqual({ x: 0.5, clamped: false });
    expect(stripX(45, 90).x).toBeCloseTo(0.75, 6);
    expect(stripX(-170, 90)).toEqual({ x: 0, clamped: true });
  });
});

describe("one north for the compass, the map and the content (owner: \"the map is inverted\")", () => {
  // Portus sits on the +Y pole. The compass used to take north toward +Y, so at the town centre it
  // fell back to -Z and everywhere around the plaza it pointed back at the centre: facing the castle
  // (town north, +Z) it read S, opposite to the map. The town, the places and the map use the D38
  // pole frame: north +Z, east -X at the pole.
  const PR = 150;
  it("reads N facing the Portus castle and E facing the town's east", () => {
    const spawn: V3 = [0, PR, 0];
    expect(headingOf(spawn, TOWN_NORTH)).toBeCloseTo(0, 6);
    expect(headingOf(spawn, TOWN_EAST)).toBeCloseTo(90, 6);
  });

  it("keeps one north across the whole town instead of pointing at the plaza", () => {
    for (const [e, n] of [[0, 40], [40, 0], [-40, 0], [0, -40], [30, 30], [-60, 20], [5.5, 2.4]] as const) {
      const d = townDir(e, n, PR);
      const p: V3 = [d[0] * PR, d[1] * PR, d[2] * PR];
      // The town's own north at that point: toward the town point 1 m further north.
      const ahead = townDir(e, n + 1, PR);
      const towardTownNorth: V3 = [ahead[0] * PR - p[0], ahead[1] * PR - p[1], ahead[2] * PR - p[2]];
      expect(Math.abs(wrapDeg(headingOf(p, towardTownNorth)))).toBeLessThan(25);
      expect(dot(northAt(p), TOWN_NORTH)).toBeGreaterThan(0.9);
    }
  });

  it("matches the places frame (content north/east offsets) wherever that frame is defined from +Z", () => {
    let checked = 0;
    for (let i = 0; i < 200; i++) {
      const z = -0.89 + (1.78 * i) / 199;
      const a = i * 2.399963;
      const r = Math.sqrt(1 - z * z);
      const d: V3 = [Math.cos(a) * r, Math.sin(a) * r, z];
      const f = tangentFrame(d);
      expect(dot(northAt(d), f.north)).toBeCloseTo(1, 9);
      expect(dot(eastAt(d), f.east)).toBeCloseTo(1, 9);
      checked++;
    }
    expect(checked).toBe(200);
  });
});
