import { describe, expect, it } from "vitest";
import { LOD_SLACK, lodBand, lodBlend, lodKeeps } from "./lodFade.ts";

describe("LOD cross-fade (#74)", () => {
  it("puts the band inside the near mesh's reach, with slack on both sides", () => {
    const b = lodBand(30); // Medium
    expect(b.nearTo).toBe(30);
    expect(b.end).toBe(30 - LOD_SLACK);
    expect(b.end - b.start).toBeCloseTo(10.5);
    expect(b.farFrom).toBeCloseTo(b.start - LOD_SLACK);
    expect(lodBand(60).end - lodBand(60).start).toBe(16); // Ultra: capped
    expect(lodBand(0)).toEqual({ start: 0, end: 0, nearTo: 0, farFrom: 0 }); // Low: far cards only
  });

  it("blends smoothly from the near mesh to the far card across the band", () => {
    const b = lodBand(40);
    expect(lodBlend(b.start - 1, b)).toBe(0);
    expect(lodBlend(b.end + 1, b)).toBe(1);
    expect(lodBlend((b.start + b.end) / 2, b)).toBeCloseTo(0.5);
    let prev = -1;
    for (let d = b.start; d <= b.end; d += 0.25) {
      const v = lodBlend(d, b);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });

  it("the two levels share every pixel exactly once at any blend", () => {
    for (const blend of [0, 0.2, 0.5, 0.93, 1])
      for (let i = 0; i < 64; i++) {
        const noise = i / 64;
        expect(Number(lodKeeps(1, noise, blend)) + Number(lodKeeps(2, noise, blend))).toBe(1);
      }
    expect(lodKeeps(0, 0.1, 0.9)).toBe(true);
  });

  it("no instance in the band is missing a level between two refreshes (hysteresis)", () => {
    // The refresh classifies instances by distance from the camera at refresh time; the camera then
    // moves up to 2 m before the next one. Every instance the shader shows partly must be in both sets.
    for (const fullTo of [30, 40, 60]) {
      const b = lodBand(fullTo);
      for (let atRefresh = 0; atRefresh < fullTo + 10; atRefresh += 0.5)
        for (const moved of [-2, -1, 0, 1, 2]) {
          const now = atRefresh + moved;
          const t = lodBlend(now, b);
          if (t < 1) expect(atRefresh < b.nearTo, `near mesh at ${atRefresh} → ${now}`).toBe(true);
          if (t > 0) expect(atRefresh >= b.farFrom, `far card at ${atRefresh} → ${now}`).toBe(true);
        }
    }
  });
});
