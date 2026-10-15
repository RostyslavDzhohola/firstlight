import { describe, expect, it } from "vitest";
import { meadowClumpGeometry, meadowMeta, meadowOn, MEADOW, valueNoise } from "./meadow.ts";

describe("meadow prototype", () => {
  it("is off without the ?meadow flag", () => {
    expect(MEADOW).toBe(false);
    expect(Object.values(meadowOn).some(Boolean)).toBe(false);
  });

  it("builds the near and far clumps with matching attributes", () => {
    for (const [lite, tris] of [[false, 22], [true, 8]] as const) {
      const g = meadowClumpGeometry(lite);
      const n = g.getAttribute("position").count;
      expect(g.getAttribute("bl").count).toBe(n);
      expect(g.getAttribute("part").count).toBe(n);
      expect(g.index!.count / 3).toBe(tris);
      for (let i = 0; i < g.index!.count; i++) expect(g.index!.getX(i)).toBeLessThan(n);
      // Exactly one flower head centre per clump.
      const parts = Array.from(g.getAttribute("part").array as Float32Array);
      expect(parts.filter((p) => p === 2).length).toBe(lite ? 5 : 7);
      g.dispose();
    }
  });

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

  it("per-clump data is deterministic and in range", () => {
    const a = new Float32Array(4), b = new Float32Array(4);
    let flowers = 0;
    for (let i = 0; i < 2000; i++) {
      const x = 200 + (i % 50) * 1.7, y = 450, z = -50 + Math.floor(i / 50) * 1.3;
      const r = (i * 0.618) % 1, r2 = (i * 0.414) % 1;
      meadowMeta(x, y, z, r, r2, a, 0);
      meadowMeta(x, y, z, r, r2, b, 0);
      expect(Array.from(a)).toEqual(Array.from(b));
      expect(a[0]).toBeGreaterThanOrEqual(0);
      expect(a[0]).toBeLessThanOrEqual(1);
      expect([0, 1, 2, 3, 4]).toContain(a[1]);
      if (a[1]! > 0) flowers++;
    }
    // Drifts: some flowers, never a carpet.
    expect(flowers).toBeGreaterThan(20);
    expect(flowers).toBeLessThan(1000);
  });
});
