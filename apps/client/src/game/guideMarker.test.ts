import { describe, expect, it } from "vitest";
import { guideToVisit } from "./guideMarker.ts";

describe("the guide on the compass", () => {
  it("points a newcomer on Arcadia at Lark", () => {
    expect(guideToVisit("arcadia", [], false)).toEqual({ id: "guide_arcadia", name: "Lark" });
  });
  it("gives way to a tracked mission's marker, and never in Portus", () => {
    expect(guideToVisit("arcadia", [], true)).toBeNull();
    expect(guideToVisit("portus", [], false)).toBeNull();
  });
  it("stops once every mission the guide gives is taken or done", () => {
    const all = ["A1", "A2", "A3", "A4", "L1"].map((id) => ({ id, done: id === "A1" }));
    expect(guideToVisit("arcadia", all, false)).toBeNull();
    expect(guideToVisit("arcadia", all.slice(1), false)).not.toBeNull();
  });
});
