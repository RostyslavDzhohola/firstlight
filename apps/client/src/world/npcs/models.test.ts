import { describe, expect, it } from "vitest";
import { NPC_DEFS } from "@firstlight/shared/content/npcs";
import { buildModels } from "./models.ts";

describe("NPC models", () => {
  it("every def has a procedural model about the size of its hitbox, within the part budget", () => {
    for (const body of ["arcadia", "hollowmere", "meridian"] as const) {
      const models = buildModels(body);
      expect(models.length).toBe(NPC_DEFS.length);
      NPC_DEFS.forEach((d, i) => {
        const m = models[i]!;
        const top = Math.max(...m.parts.map((p) => p.p[1] + p.s[1] / 2));
        expect(top / d.height, d.id).toBeGreaterThan(0.75);
        expect(top / d.height, d.id).toBeLessThan(1.35);
        expect(m.parts.length, d.id).toBeLessThanOrEqual(40);
        if (d.tier !== "critter") expect(m.parts.some((p) => p.m === "glow"), `${d.id} has an emissive accent`).toBe(true);
      });
    }
  });

  it("Woolback wool takes the planet's colour", () => {
    const wool = (b: "arcadia" | "hollowmere" | "meridian") => buildModels(b)[NPC_DEFS.findIndex((d) => d.id === "woolback")]!.parts[0]!.c;
    expect(new Set([wool("arcadia"), wool("hollowmere"), wool("meridian")]).size).toBe(3);
  });
});
