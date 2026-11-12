// Meadow grass (D-gfx-worlds-1): the clump meshes and the per-clump data the CPU writes.
import { describe, expect, it } from "vitest";
import { MEADOW_FAR_KEEP, MEADOW_TRIANGLES, meadowCellFields, meadowClumpGeometry, meadowKeep, meadowMeta } from "./meadow.ts";
import { WORLD_LOOKS } from "./worldLooks.ts";

describe("meadow clumps", () => {
  it("builds the near and far clumps with matching attributes", () => {
    for (const [lite, tris] of [[false, MEADOW_TRIANGLES.full], [true, MEADOW_TRIANGLES.lite]] as const) {
      const g = meadowClumpGeometry(lite);
      const n = g.getAttribute("position").count;
      expect(g.getAttribute("bl").count).toBe(n);
      expect(g.getAttribute("part").count).toBe(n);
      expect(g.index!.count / 3).toBe(tris);
      for (let i = 0; i < g.index!.count; i++) expect(g.index!.getX(i)).toBeLessThan(n);
      // One head per clump: its centre and rim.
      const parts = Array.from(g.getAttribute("part").array as Float32Array);
      expect(parts.filter((p) => p === 2).length).toBe(lite ? 5 : 7);
      g.dispose();
    }
  });

  it("thins with distance: everything near, MEADOW_FAR_KEEP of the clumps at the rim, never more with distance", () => {
    expect(meadowKeep(0, 40)).toBe(1);
    expect(meadowKeep(5, 40)).toBe(1);
    expect(meadowKeep(40, 40)).toBeCloseTo(MEADOW_FAR_KEEP, 6);
    let prev = 1;
    for (let d = 0; d <= 60; d += 1) {
      const k = meadowKeep(d, 40);
      expect(k).toBeLessThanOrEqual(prev);
      prev = k;
    }
  });

  /** Clumps over forty 85 × 52 m fields spread across a planet, each with the slow fields of a cell round it. */
  function field(body: keyof typeof WORLD_LOOKS) {
    const look = WORLD_LOOKS[body].meadow;
    const cell = new Float32Array(12);
    const a = new Float32Array(4), b = new Float32Array(4);
    let flowers = 0, dry = 0;
    const species = new Set<number>();
    const N = 2000;
    for (let i = 0; i < N; i++) {
      const x = 200 + (i % 50) * 1.7 + Math.floor(i / 50) * 97, y = 450 - Math.floor(i / 50) * 61, z = -50 + Math.floor(i / 50) * 1.3;
      meadowCellFields([x - 4, y, z - 4, x + 4, y, z - 4, x - 4, y, z + 4, x + 4, y, z + 4], cell);
      const r = (i * 0.618) % 1, r2 = (i * 0.414) % 1;
      meadowMeta(x, y, z, 0.5, 0.5, cell, r, r2, a, 0, look);
      meadowMeta(x, y, z, 0.5, 0.5, cell, r, r2, b, 0, look);
      expect(Array.from(a)).toEqual(Array.from(b));
      expect(a[0]).toBeGreaterThanOrEqual(0);
      expect(a[0]).toBeLessThanOrEqual(1);
      expect([0, 1, 2, 3, 4]).toContain(a[1]);
      if (a[1]! > 0) {
        flowers++;
        species.add(a[1]!);
      }
      dry += a[0]!;
    }
    return { flowers, dry: dry / N, species };
  }

  it("per-clump data is deterministic and in range; heads grow in drifts, never a carpet", () => {
    for (const body of ["arcadia", "hollowmere", "meridian", "portus"] as const) {
      const f = field(body);
      expect(f.flowers, body).toBeGreaterThan(10);
      expect(f.flowers, body).toBeLessThan(1000);
    }
  });

  it("each planet's ground cover is its own: Meridian is dry, Arcadia mostly lush", () => {
    expect(field("meridian").dry).toBeGreaterThan(field("arcadia").dry + 0.3);
    // Hollowmere's fungi and ghost blooms light themselves; Arcadia's flowers and Meridian's seed heads don't.
    expect(Math.max(...WORLD_LOOKS.hollowmere.meadow.glow)).toBeGreaterThan(1);
    expect(Math.max(...WORLD_LOOKS.arcadia.meadow.glow, ...WORLD_LOOKS.meridian.meadow.glow)).toBe(0);
  });
});
