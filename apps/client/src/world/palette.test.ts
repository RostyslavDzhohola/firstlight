import { describe, expect, it } from "vitest";
import { BODIES, padDirs } from "@firstlight/shared";
import { padGrassMask } from "./palette.ts";

describe("grass around landing pads (live smoke test: blades grew through Dawnpad)", () => {
  const arcadia = BODIES.arcadia;
  const pads = padDirs(arcadia);
  const R = arcadia.radius;
  /** A direction `m` metres (arc) from pad 0 along a tangent. */
  const near = (m: number): [number, number, number] => {
    const [x, y, z] = pads[0]!;
    const t = Math.abs(y) < 0.9 ? [z, 0, -x] : [0, -z, y];
    const tl = Math.hypot(t[0]!, t[1]!, t[2]!);
    const a = m / R;
    const d = [x * Math.cos(a) + (t[0]! / tl) * Math.sin(a), y * Math.cos(a) + (t[1]! / tl) * Math.sin(a), z * Math.cos(a) + (t[2]! / tl) * Math.sin(a)];
    return [d[0]!, d[1]!, d[2]!];
  };

  it("is bare on the stone disc, fades in past its rim and is full a few metres out", () => {
    expect(padGrassMask(pads, ...near(0), R)).toBe(0);
    expect(padGrassMask(pads, ...near(8.6), R)).toBe(0);
    const rim = padGrassMask(pads, ...near(10.2), R);
    expect(rim).toBeGreaterThan(0);
    expect(rim).toBeLessThan(1);
    expect(padGrassMask(pads, ...near(14), R)).toBe(1);
  });
});
