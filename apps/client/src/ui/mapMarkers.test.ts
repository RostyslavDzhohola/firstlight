import { describe, expect, it } from "vitest";
import { BODIES, createTerrain, padDirs, type BodyId } from "@firstlight/shared";
import { MISSIONS } from "@firstlight/shared/content/missions";
import { missionTargets, staticMarkers } from "./mapMarkers.ts";

describe("map markers", () => {
  for (const body of Object.keys(BODIES) as BodyId[]) {
    it(`${body}: every marker is a unit direction with a name`, () => {
      const ms = staticMarkers(body, createTerrain(body));
      expect(new Set(ms.map((m) => m.id)).size).toBe(ms.length);
      for (const m of ms) {
        expect(Math.hypot(...m.dir)).toBeCloseTo(1, 6);
        expect(m.label.length).toBeGreaterThan(2);
      }
    });
  }

  it("Portus: three portals, the Exchange, the Hall and the town's landmarks; no pads", () => {
    const ms = staticMarkers("portus", createTerrain("portus"));
    expect(ms.filter((m) => m.kind === "portal").map((m) => m.to).sort()).toEqual(["arcadia", "hollowmere", "meridian"]);
    expect(ms.some((m) => m.label === "Portus Exchange")).toBe(true);
    expect(ms.some((m) => m.label === "the Keep")).toBe(true);
    expect(ms.some((m) => m.kind === "pad")).toBe(false);
  });

  it("planets: every pad, the portal home, the guide and the boss lair", () => {
    const ms = staticMarkers("arcadia", createTerrain("arcadia"));
    expect(ms.filter((m) => m.kind === "pad")).toHaveLength(padDirs(BODIES.arcadia).length);
    expect(ms.filter((m) => m.kind === "portal").map((m) => m.to)).toEqual(["portus"]);
    expect(ms.find((m) => m.kind === "guide")?.label).toBe("Lark · missions");
    expect(ms.find((m) => m.kind === "lair")?.label).toContain("Tidewrath");
    expect(ms.some((m) => m.kind === "peak" || m.label === "Kestrel Peak")).toBe(true);
  });

  it("points each active mission on this body at its target", () => {
    const active = MISSIONS.filter((m) => m.body === "arcadia" && m.id !== "A1").map((m) => ({ id: m.id }));
    const t = missionTargets("arcadia", [...active, { id: "A1", done: true }]);
    expect(t.length).toBeGreaterThanOrEqual(2);
    expect(t.some((m) => m.id === "A1")).toBe(false);
    expect(missionTargets("hollowmere", active)).toEqual([]);
  });
});
