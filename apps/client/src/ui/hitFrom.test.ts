import { describe, expect, it } from "vitest";
import { angleGap, hitAngle } from "./hitFrom.ts";

const eye = { x: 10, y: 0, z: 10 };
const forward = { x: 0, y: 0, z: -1 };
const right = { x: 1, y: 0, z: 0 };
const at = (dx: number, dz: number, dy = 0) => ({ x: eye.x + dx, y: eye.y + dy, z: eye.z + dz });

describe("where a hit came from", () => {
  it("0° ahead, 90° from the right, 180° behind, 270° from the left", () => {
    expect(hitAngle(eye, forward, right, at(0, -5))).toBeCloseTo(0);
    expect(hitAngle(eye, forward, right, at(5, 0))).toBeCloseTo(90);
    expect(Math.abs(hitAngle(eye, forward, right, at(0, 5))!)).toBeCloseTo(180);
    expect(hitAngle(eye, forward, right, at(-5, 0))).toBeCloseTo(270);
    expect(hitAngle(eye, forward, right, at(3, -3))).toBeCloseTo(45);
  });

  it("ignores height, and has no answer for a source on top of us", () => {
    expect(hitAngle(eye, forward, right, at(5, 0, 40))).toBeCloseTo(90);
    expect(hitAngle(eye, forward, right, at(0, 0, 3))).toBeNull();
  });

  it("measures the gap between two bearings the short way round", () => {
    expect(angleGap(10, 350)).toBe(20);
    expect(angleGap(90, 270)).toBe(180);
    expect(angleGap(200, 215)).toBe(15);
  });
});
