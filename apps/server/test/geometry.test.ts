import { describe, expect, it } from "vitest";
import { rayCapsule, type V3 } from "../src/world/geometry.ts";

// A capsule standing on a planet of radius 1000 at the +Y pole: feet at (0, 1000, 0), up = +Y.
const feet: V3 = [0, 1000, 0];
const R = 0.45, H = 1.8;

describe("rayCapsule", () => {
  it("hits head-on through the middle", () => {
    const hit = rayCapsule([-5, 1001, 0], [1, 0, 0], 20, feet, R, H);
    expect(hit).not.toBeNull();
    expect(hit!.t).toBeCloseTo(5 - R, 3);
    expect(hit!.heightAboveFeet).toBeCloseTo(1, 3);
  });

  it("misses when passing beside the capsule", () => {
    expect(rayCapsule([-5, 1001, 0.6], [1, 0, 0], 20, feet, R, H)).toBeNull();
  });

  it("respects the segment length (stops short)", () => {
    expect(rayCapsule([-5, 1001, 0], [1, 0, 0], 4, feet, R, H)).toBeNull();
  });

  it("a short oblique segment that enters the cylinder near its start is a hit (review #12)", () => {
    // Start just outside the surface, travel 0.3 m diagonally inwards and downwards.
    const o: V3 = [-0.5, 1001.2, 0.1];
    const d0: V3 = [1, -0.4, 0.1];
    const l = Math.hypot(...d0);
    const d: V3 = [d0[0] / l, d0[1] / l, d0[2] / l];
    const hit = rayCapsule(o, d, 0.3, feet, R, H);
    expect(hit).not.toBeNull();
    expect(hit!.t).toBeLessThan(0.3);
  });

  it("hits the top cap from above (weak point height)", () => {
    const hit = rayCapsule([0, 1004, 0], [0, -1, 0], 10, feet, R, H);
    expect(hit).not.toBeNull();
    expect(hit!.heightAboveFeet).toBeCloseTo(H, 2);
  });

  it("hits when the ray starts inside the capsule", () => {
    const hit = rayCapsule([0, 1001, 0], [1, 0, 0], 5, feet, R, H);
    expect(hit).not.toBeNull();
    expect(hit!.t).toBe(0);
  });
});
