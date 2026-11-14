// The agent's world model on the moon's path (sky review sweep, 2026-11-14): Lark gives L1 as well as
// her own missions, and L1's spot on Lumen is the Quietfall Wreck, where the Cratermaw nests.

import { describe, expect, it } from "vitest";
import { wildSitePlacements } from "@firstlight/shared/planet/wildSites";
import { bodyWorld } from "./world.ts";

describe("the agent's world on the moon path", () => {
  it("Arcadia's guide offers L1 among her missions; Lumen's has none of her own", () => {
    expect(bodyWorld("arcadia").missions().map((m) => m.id)).toContain("L1");
    expect(bodyWorld("lumen").missions()).toEqual([]);
  });

  it("L1's spot on Lumen is the Quietfall Wreck; on Arcadia there is none", () => {
    const moon = bodyWorld("lumen");
    const spot = moon.missionSpot("L1");
    const wreck = wildSitePlacements(moon.terrain).find((w) => w.site.id === "quietfall_wreck")!;
    const l = Math.hypot(...spot!.pos);
    expect(Math.hypot(spot!.pos[0] / l - wreck.dir[0], spot!.pos[1] / l - wreck.dir[1], spot!.pos[2] / l - wreck.dir[2]) * moon.R).toBeLessThan(2);
    expect(spot!.what).toContain("The Quietfall Wreck");
    expect(bodyWorld("arcadia").missionSpot("L1")).toBeNull();
  });
});
