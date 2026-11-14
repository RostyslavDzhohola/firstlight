import { describe, expect, it } from "vitest";
import { REGION_CARD_GAP_MS, REGION_ENTER_M, RegionGate, regionCard } from "./regionCard.ts";

const hit = (kind: number, edge = 50) => ({ cell: 0, kind, other: 0, edge });

describe("region card gate (#7)", () => {
  it("names a new region once you are inside it, never the one you arrive in, and spaces cards out", () => {
    const g = new RegionGate(0);
    expect(g.step(hit(0), 100)).toBe(-1); // arrival region: the world's own card names it
    expect(g.step(hit(1, REGION_ENTER_M - 1), REGION_CARD_GAP_MS + 1)).toBe(-1); // on the border
    expect(g.step(hit(1), REGION_CARD_GAP_MS + 2)).toBe(1);
    expect(g.step(hit(1), REGION_CARD_GAP_MS + 3)).toBe(-1); // still there
    expect(g.step(hit(2), REGION_CARD_GAP_MS + 1000)).toBe(-1); // too soon after the last card
    expect(g.step(hit(0), 3 * REGION_CARD_GAP_MS)).toBe(0);
    expect(g.step(null, 9 * REGION_CARD_GAP_MS)).toBe(-1);
  });

  it("the card names the region and its world, with no level chip", () => {
    const c = regionCard("arcadia", 2);
    expect(c).toMatchObject({ kicker: "Arcadia", name: "Thistle Heath", levels: "", region: true });
  });
});
