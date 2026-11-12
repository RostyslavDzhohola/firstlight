// Horizon landmarks (D-gfx-worlds-1): pure visuals that nobody can reach, cheap enough for every tier.
import { describe, expect, it } from "vitest";
import { BODIES } from "@firstlight/shared";
import { buildLandmarks, spreadDirs } from "./landmarks.ts";

describe("horizon landmarks", () => {
  it("the hub has none; each planet has its own set", () => {
    expect(buildLandmarks("portus")).toBeNull();
    const tris = (["arcadia", "hollowmere", "meridian"] as const).map((b) => buildLandmarks(b)!.triangles);
    for (const t of tris) expect(t).toBeGreaterThan(300);
    expect(new Set(tris).size).toBe(3);
  });

  it("every vertex hangs well above anything a player can stand on, and the soup stays small", () => {
    for (const body of ["arcadia", "hollowmere", "meridian"] as const) {
      const b = buildLandmarks(body)!;
      const def = BODIES[body];
      const peak = Math.max(0, ...(def.peaks ?? []).map((p) => p.height));
      let lowest = Infinity;
      for (let i = 0; i < b.pos.length; i += 3) {
        const r = Math.hypot(b.pos[i]!, b.pos[i + 1]!, b.pos[i + 2]!);
        expect(Number.isFinite(r)).toBe(true);
        lowest = Math.min(lowest, r - def.radius);
      }
      // A jump is a couple of metres: 20 m over the highest named peak is out of reach.
      expect(lowest, body).toBeGreaterThan(peak + 20);
      expect(b.triangles, body).toBeLessThan(12_000);
      expect(b.col.length).toBe(b.pos.length);
      expect(b.glow.length).toBe(b.pos.length);
      expect(b.nor.every(Number.isFinite)).toBe(true);
    }
  });

  it("is the same on every client", () => {
    expect(buildLandmarks("arcadia")!.pos).toEqual(buildLandmarks("arcadia")!.pos);
  });

  it("spreads directions evenly: no two closer than a third of the mean spacing", () => {
    const dirs = spreadDirs(13, 0x51a7);
    let min = Infinity;
    for (let i = 0; i < dirs.length; i++) {
      expect(Math.hypot(...dirs[i]!)).toBeCloseTo(1, 6);
      for (let j = 0; j < i; j++) min = Math.min(min, Math.acos(Math.min(1, dirs[i]![0] * dirs[j]![0] + dirs[i]![1] * dirs[j]![1] + dirs[i]![2] * dirs[j]![2])));
    }
    expect(min).toBeGreaterThan(Math.sqrt((4 * Math.PI) / 13) / 3);
  });
});
