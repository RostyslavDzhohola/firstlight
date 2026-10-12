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

  it("Meridian Associates are matte slate with one amber slit visor, nothing like Unit 7's ivory plates (content §3.4, §8.2)", () => {
    const models = buildModels("meridian");
    const luma = (c: number) => (0.2126 * ((c >> 16) & 255) + 0.7152 * ((c >> 8) & 255) + 0.0722 * (c & 255)) / 255;
    for (const id of ["associate", "enforcer", "compliance_officer", "ticket_000"]) {
      const i = NPC_DEFS.findIndex((d) => d.id === id);
      if (i < 0) continue;
      const m = models[i]!;
      const plates = m.parts.filter((p) => p.m !== "glow");
      // No ivory/white armour (Unit 7 is #E9E4D8): every plate is mid-to-dark grey.
      for (const p of plates) expect(luma(p.c), `${id} plate ${p.c.toString(16)}`).toBeLessThan(0.55);
      expect(plates.some((p) => p.m === "metal" && p.g !== "cyl" && p.p[1] > 1.5), `${id}: matte helmet`).toBe(false);
      // Accents are amber, never the old red visor.
      for (const p of m.parts.filter((q) => q.m === "glow")) {
        const r = (p.c >> 16) & 255, g = (p.c >> 8) & 255, b = p.c & 255;
        expect(r > 200 && g > 120 && b < 120, `${id} glow ${p.c.toString(16)}`).toBe(true);
      }
      // One visor: a single thin glowing slit at head height.
      expect(m.parts.filter((p) => p.m === "glow" && p.p[1] > 1.6 && p.p[1] < 1.85 && p.p[2] < 0.3 && !p.tag)).toHaveLength(1);
    }
  });
});
