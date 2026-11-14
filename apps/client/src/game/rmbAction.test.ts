import { describe, expect, it } from "vitest";
import { WEAPON_BY_ID } from "@firstlight/shared/content/weapons";
import { rmbAction } from "./rmbAction.ts";

const at = (id: string) => {
  const d = WEAPON_BY_ID.get(id)!;
  return rmbAction(d, d.tiers[0]);
};

describe("the right mouse's action on the hotbar (#76)", () => {
  it("names block, charge, draw and aim for the starters' weapons", () => {
    expect(at("riverstaff")).toMatch(/^Hold to block \(\d+% off hits from the front\)$/);
    expect(at("sunbrand")).toMatch(/block|charge/);
    expect(at("carbine")).toBe("Aim");
    expect(at("longbow")).toBe("Hold to draw");
    expect(at("hammer")).toBe("Hold to charge: Slam");
    expect(rmbAction(undefined, undefined)).toBeNull();
  });
});
