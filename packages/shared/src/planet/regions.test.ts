// Named regions inside each planet (#7).
import { describe, expect, it } from "vitest";
import { BODIES } from "./bodies.ts";
import { REGION_KINDS, REGION_SPACING, REGION_WOBBLE, regionCells, regionHit, regionLook } from "./regions.ts";

const WILD = ["arcadia", "hollowmere", "meridian", "lumen"] as const;

describe("regions", () => {
  it("Portus has none; every other body is cut into cells of every one of its kinds", () => {
    expect(regionHit("portus", 0, 150, 0)).toBeNull();
    for (const b of WILD) {
      const cells = regionCells(b);
      const R = BODIES[b].radius;
      // Roughly one cell per REGION_SPACING², within a factor of two.
      const expected = (4 * Math.PI * R * R) / (REGION_SPACING * REGION_SPACING);
      expect(cells.length, b).toBeGreaterThan(expected / 2);
      expect(cells.length, b).toBeLessThan(expected * 2);
      const used = new Set(cells.map((c) => c.kind));
      expect(used.size, b).toBe(REGION_KINDS[b].length);
    }
  });

  it("is the same answer every time and the nearest centre wins away from the border", () => {
    for (const b of WILD) {
      const cells = regionCells(b);
      for (let i = 0; i < cells.length; i += 7) {
        const d = cells[i]!.dir;
        const h = regionHit(b, d[0], d[1], d[2])!;
        // The wobble (≤ 45 m) never carries a centre further than a close neighbour's cell.
        const o = cells[h.cell]!.dir;
        expect(Math.hypot(o[0] - d[0], o[1] - d[1], o[2] - d[2]) * BODIES[b].radius, `${b} ${i}`).toBeLessThan(2 * REGION_WOBBLE + 1);
        expect(regionHit(b, d[0], d[1], d[2])).toEqual(h);
      }
    }
  });

  it("a 500 m straight walk crosses at least two region kinds on every planet", () => {
    for (const b of WILD) {
      const R = BODIES[b].radius;
      const walks = 40;
      let ok = 0;
      for (let w = 0; w < walks; w++) {
        const a0 = w * 0.9, tilt = w * 0.37, roll = w * 1.3;
        const seen = new Set<number>();
        for (let m = 0; m <= 500; m += 5) {
          const a = a0 + m / R;
          // A great circle, tilted and rolled differently each walk.
          const x0 = Math.cos(a), y0 = Math.sin(a) * Math.cos(tilt), z0 = Math.sin(a) * Math.sin(tilt);
          const x = x0 * Math.cos(roll) - z0 * Math.sin(roll), z = x0 * Math.sin(roll) + z0 * Math.cos(roll);
          seen.add(regionHit(b, x, y0, z)!.kind);
        }
        if (seen.size >= 2) ok++;
      }
      // The moon is small and has two looks; the planets must nearly always.
      expect(ok / walks, b).toBeGreaterThanOrEqual(b === "lumen" ? 0.8 : 0.95);
    }
  });

  it("neighbouring cells mostly have different kinds", () => {
    for (const b of WILD) {
      const cells = regionCells(b);
      const R = BODIES[b].radius;
      let pairs = 0, same = 0;
      for (let i = 0; i < cells.length; i++) {
        for (let j = i + 1; j < cells.length; j++) {
          const a = cells[i]!.dir, c = cells[j]!.dir;
          const d = Math.hypot(a[0] - c[0], a[1] - c[1], a[2] - c[2]) * R;
          if (d < REGION_SPACING * 1.2) {
            pairs++;
            if (cells[i]!.kind === cells[j]!.kind) same++;
          }
        }
      }
      expect(pairs, b).toBeGreaterThan(0);
      // Two-kind Lumen can't colour a sphere's grid properly; the planets with four kinds nearly can.
      expect(same / pairs, b).toBeLessThan(REGION_KINDS[b].length > 2 ? 0.15 : 0.5);
    }
  });

  it("the look blends across a border and stays in range", () => {
    const R = BODIES.arcadia.radius;
    for (let i = 0; i < 400; i++) {
      const a = i * 0.031, t = i * 0.017;
      const l = regionLook("arcadia", Math.cos(a) * R, Math.sin(a) * Math.cos(t) * R, Math.sin(a) * Math.sin(t) * R);
      for (const v of [l.dry, l.deep, l.gAmt, l.gr, l.gg, l.gb]) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
      expect(l.bloom).toBeGreaterThanOrEqual(0);
    }
  });
});
