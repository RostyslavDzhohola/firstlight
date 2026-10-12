import { describe, expect, it } from "vitest";
import { BODIES } from "../planet/bodies.ts";
import { portalSpots } from "../planet/portals.ts";
import { createTerrain } from "../planet/terrain.ts";
import { MEDAL_BY_ID } from "./medals.ts";
import { dummyPos, ONBOARDING, TRAINING_DUMMIES } from "./onboarding.ts";
import { xpToNext } from "./progression.ts";
import { objectPos, WORLD_OBJECT_BY_ID } from "./world.ts";

describe("onboarding", () => {
  it("pays 3 × 10 + 20 = 50 XP: exactly level 2 (content.md §1.1), and the Spark medal exists", () => {
    expect(TRAINING_DUMMIES.length * ONBOARDING.DUMMY_XP + ONBOARDING.DONE_XP).toBe(50);
    expect(xpToNext(1)).toBe(50);
    expect(MEDAL_BY_ID.get("spark")?.condition).toBe("Finish onboarding");
  });

  it("puts the dummies on the Portus plaza floor, clear of the portals, Juno and the Hall wall", () => {
    const t = createTerrain(BODIES.portus);
    const gh = (x: number, y: number, z: number) => t.groundHeight(x, y, z);
    const pos = TRAINING_DUMMIES.map((_, i) => dummyPos(i, gh));
    const dist = (a: readonly number[], b: readonly number[]) => Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!);
    const centre = [0, BODIES.portus.radius, 0];
    for (const p of pos) {
      const d = dist(p, centre);
      expect(d).toBeGreaterThan(7); // out of the 2–6 m arrival scatter
      expect(d).toBeLessThan(25); // on the flat floor (the rim starts at 30 m)
      for (const s of portalSpots(BODIES.portus, t)) expect(dist(p, s.center)).toBeGreaterThan(9);
      for (const id of ["juno_vale", "hall_wall"]) expect(dist(p, objectPos(WORLD_OBJECT_BY_ID.get(id)!, gh))).toBeGreaterThan(9);
    }
    expect(dist(pos[0]!, pos[1]!)).toBeGreaterThan(2);
    expect(dist(pos[1]!, pos[2]!)).toBeGreaterThan(2);
  });
});
