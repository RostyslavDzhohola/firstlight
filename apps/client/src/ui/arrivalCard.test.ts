import { describe, expect, it } from "vitest";
import { BODY_IDS } from "@firstlight/shared/planet/bodies";
import { worldCards } from "../home/homeModel.ts";
import { arrivalCard, ArrivalGate } from "./arrivalCard.ts";

describe("the arrival title card", () => {
  it("names the world with the home page's own line and levels", () => {
    expect(arrivalCard("arcadia")).toEqual({ body: "arcadia", kicker: "Now entering", name: "Arcadia", line: "Golden meadows round Glasswater Lake", levels: "Levels 1–7" });
    expect(arrivalCard("portus")).toMatchObject({ kicker: "The hub", name: "Portus", levels: "Safe · Lv 1–2" });
    const cards = worldCards(null);
    for (const id of BODY_IDS) {
      const c = arrivalCard(id);
      const w = cards.find((x) => x.id === id);
      // Lumen (#6) has no card on the home page (it is found in the game); the others match theirs.
      if (w || id !== "lumen") {
        expect(c.line).toBe(w!.line);
        expect(c.levels).toBe(w!.levels);
      }
      expect(c.line.length, id).toBeLessThanOrEqual(42); // one line under the name at 1280 wide
    }
  });

  it("a card for the first world and every change of world, none for coming back into the same one", () => {
    const g = new ArrivalGate();
    expect(g.arrive("portus")).toBe(true);
    expect(g.arrive("portus")).toBe(false); // reconnect, rejoin after saving
    expect(g.arrive("arcadia")).toBe(true);
    expect(g.arrive("arcadia")).toBe(false);
    expect(g.arrive("portus")).toBe(true);
  });
});
