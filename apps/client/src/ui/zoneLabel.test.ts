import { describe, expect, it } from "vitest";
import { BODIES, padDirs, zoneAt } from "@firstlight/shared";
import { townDir } from "@firstlight/shared/planet/townFrame";
import { padName } from "@firstlight/shared/content/places";
import { zoneInfo } from "./zoneLabel.ts";

const portus = (east: number, north: number) => {
  const d = townDir(east, north, 150);
  return zoneAt(BODIES.portus, d[0] * 150, d[1] * 150, d[2] * 150);
};

describe("zone label (D-zones-1)", () => {
  it("Portus: safe in the castle town, danger outside the walls", () => {
    expect(zoneInfo("portus", portus(5, 5), true)).toMatchObject({ zone: "safe", label: "Safe", place: "Portus town" });
    const out = zoneInfo("portus", portus(60, 0), false);
    expect(out).toMatchObject({ zone: "danger", label: "Danger", place: "Outside the walls", title: "Leaving the safe zone" });
    expect(out.sub).toMatch(/creeps/i);
  });

  it("the label follows the server's flag: inside the town but combat-tagged is still danger", () => {
    expect(zoneInfo("portus", portus(5, 5), false)).toMatchObject({ zone: "danger", place: "In combat" });
  });

  it("planets: the walled arrival outpost by its pad's name, other pads' rings by name, the wilds outside", () => {
    const pads = padDirs(BODIES.arcadia);
    const r = BODIES.arcadia.radius + 1;
    const home = zoneAt(BODIES.arcadia, pads[0]![0] * r, pads[0]![1] * r, pads[0]![2] * r);
    expect(zoneInfo("arcadia", home, true)).toMatchObject({ zone: "safe", place: "Dawnpad outpost" });
    const ring = zoneAt(BODIES.arcadia, pads[1]![0] * r, pads[1]![1] * r, pads[1]![2] * r);
    expect(zoneInfo("arcadia", ring, true)).toMatchObject({ zone: "safe", place: `${padName("arcadia", 1)} pad ring` });
    expect(zoneInfo("arcadia", { safe: false, kind: "wild", pad: -1 }, false)).toMatchObject({ zone: "danger", place: "The wilds" });
  });
});
