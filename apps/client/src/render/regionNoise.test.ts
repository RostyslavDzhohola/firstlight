// Regions inside a planet (#7): the noise both the ground colour and the grass read.
import { describe, expect, it } from "vitest";
import { BODIES } from "@firstlight/shared";
import { regionAt, valueNoise } from "./regionNoise.ts";

describe("region noise", () => {
  it("value noise stays in [0, 1) and is continuous", () => {
    let prev = valueNoise(0.1, 2.3, -4.2);
    for (let i = 1; i < 500; i++) {
      const v = valueNoise(0.1 + i * 0.01, 2.3, -4.2);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
      expect(Math.abs(v - prev)).toBeLessThan(0.1);
      prev = v;
    }
  });

  it("is the same answer every time (the worker and the grass must agree)", () => {
    const a = regionAt(123.4, -56.7, 480.2);
    const b = regionAt(123.4, -56.7, 480.2);
    expect(a).toEqual(b);
    expect(a.dry).toBeGreaterThanOrEqual(0);
    expect(a.dry).toBeLessThanOrEqual(1);
    expect(a.deep).toBeGreaterThanOrEqual(0);
    expect(a.deep).toBeLessThanOrEqual(1);
    expect(Math.abs(a.patch)).toBeLessThanOrEqual(1);
  });

  it("a 500 m walk in a straight line crosses visibly different regions on every planet (#7)", () => {
    for (const body of ["arcadia", "hollowmere", "meridian"] as const) {
      const R = BODIES[body].radius;
      let crossed = 0;
      const walks = 24;
      for (let w = 0; w < walks; w++) {
        // A great-circle walk from a different start and heading each time.
        const a0 = w * 0.9, tilt = w * 0.37;
        let lo = 1, hi = 0;
        for (let m = 0; m <= 500; m += 5) {
          const a = a0 + m / R;
          const x = Math.cos(a) * R, y = Math.sin(a) * Math.cos(tilt) * R, z = Math.sin(a) * Math.sin(tilt) * R;
          const r = regionAt(x, y, z);
          const v = r.dry - r.deep; // lush-deep … dry: the axis the ground colour and the grass move along
          lo = Math.min(lo, v);
          hi = Math.max(hi, v);
        }
        if (hi - lo > 0.5) crossed++;
      }
      expect(crossed / walks, body).toBeGreaterThan(0.8);
    }
  });
});
