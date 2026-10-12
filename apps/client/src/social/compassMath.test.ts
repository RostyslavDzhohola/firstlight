import { describe, expect, it } from "vitest";
import { bearingTo, headingOf, nearestDir, northAt, stripX, surfaceDistance, wrapDeg, type V3 } from "./compassMath.ts";

const R = 500;
// On the equator at +X, looking north (+Y): east is to the right.
const pos: V3 = [R, 0, 0];
const north: V3 = [0, 1, 0];

describe("compass math on a sphere", () => {
  it("north points toward +Y along the surface, with a fallback at the poles", () => {
    expect(northAt(pos)).toEqual([0, 1, 0]);
    const n = northAt([0, R, 0]);
    expect(Math.hypot(...n)).toBeCloseTo(1, 6);
    expect(Math.abs(n[1])).toBeLessThan(1e-9);
  });

  it("heading is clockwise from north", () => {
    expect(headingOf(pos, north)).toBeCloseTo(0, 6);
    const east = [0, 0, 0] as [number, number, number];
    // right = forward × up = (0,1,0) × (1,0,0) = (0,0,-1)
    east[2] = -1;
    expect(headingOf(pos, east)).toBeCloseTo(90, 6);
    expect(headingOf(pos, [0, -1, 0])).toBeCloseTo(180, 6);
    expect(headingOf(pos, [0, 0, 1])).toBeCloseTo(270, 6);
  });

  it("bearings to targets are relative to where you look", () => {
    expect(bearingTo(pos, north, [R, 10, 0])).toBeCloseTo(0, 6);
    expect(bearingTo(pos, north, [R, 0, -10])).toBeCloseTo(90, 6);
    expect(bearingTo(pos, north, [R, 0, 10])).toBeCloseTo(-90, 6);
    expect(Math.abs(bearingTo(pos, north, [R, -10, 0]))).toBeCloseTo(180, 6);
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
