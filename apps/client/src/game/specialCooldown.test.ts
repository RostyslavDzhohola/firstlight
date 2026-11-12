// The client mirrors the server's special cooldown (combat.ts specialReadyAt) and its charged-heavy rules, so a
// chop that isn't ready is never sent or animated and never resets the light-attack timer (review finding 5).

import { describe, expect, it } from "vitest";
import { WEAPON_BY_ID } from "@firstlight/shared/content/weapons";
import { heavyName, heavyRelease, PENDING_MS, SpecialCooldown } from "./specialCooldown.ts";

const AXE = WEAPON_BY_ID.get("axe")!;
const T1 = AXE.tiers[0];

describe("axe chop on the client", () => {
  it("the catalogue chop has the 6 s cooldown this mirrors", () => {
    expect(T1.cooldown).toBe(6);
    expect(heavyName(AXE)).toBe("Chop");
    expect(heavyName(WEAPON_BY_ID.get("hammer")!)).toBe("Slam");
  });

  it("a full charge after the rate gate is sent at once; the cooldown then holds the next one for 6 s", () => {
    const cd = new SpecialCooldown();
    const r = heavyRelease(10_000, 9_000, 8_000, T1, cd);
    expect(r).toEqual({ send: true, at: 10_000 });
    cd.started(10_000, T1.cooldown!);
    expect(cd.ready(15_999)).toBe(false);
    expect(cd.remaining(13_000)).toBeCloseTo(3);
    // Charged again within the 6 s: nothing to send (and the caller leaves lastFire alone).
    expect(heavyRelease(15_000, 14_000, 10_000, T1, cd)).toEqual({ send: false, why: "cooling" });
    expect(cd.ready(16_000)).toBe(true);
    expect(heavyRelease(16_500, 15_600, 10_000, T1, cd).send).toBe(true);
  });

  it("released early, or after a light swing reset the charge: nothing is sent", () => {
    const cd = new SpecialCooldown();
    expect(heavyRelease(10_500, 10_000, 0, T1, cd)).toEqual({ send: false, why: "short" });
    expect(heavyRelease(11_000, 10_000, 10_200, T1, cd)).toEqual({ send: false, why: "broken" });
  });

  it("a ready chop inside the light-attack rate waits for the gate (the server would drop it silently)", () => {
    const cd = new SpecialCooldown();
    const T3 = AXE.tiers[2]; // a 0.7 s charge under the 0.9 s rate
    const r = heavyRelease(10_710, 10_005, 10_000, T3, cd);
    expect(r).toEqual({ send: true, at: 10_000 + T3.rate * 1000 });
  });

  it("a refusal right after a sent heavy gives the cooldown back; a later one, or a primary-only reason, doesn't", () => {
    const cd = new SpecialCooldown();
    cd.started(1_000, 6);
    cd.refused(1_000 + PENDING_MS + 1, "not charged");
    expect(cd.ready(2_000)).toBe(false);
    cd.started(10_000, 6);
    cd.refused(10_200, "reloading");
    expect(cd.ready(10_300)).toBe(false);
    cd.refused(10_300, "cooldown"); // the server's own clock still runs
    expect(cd.ready(10_400)).toBe(false);
    cd.started(20_000, 6);
    cd.refused(20_200, "not charged");
    expect(cd.ready(20_300)).toBe(true);
  });
});
