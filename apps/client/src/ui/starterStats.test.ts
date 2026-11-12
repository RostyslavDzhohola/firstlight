import { describe, expect, it } from "vitest";
import { STARTERS } from "@firstlight/shared/content/weapons";
import { STARTER_STATS } from "@firstlight/shared/content/starters";
import { PIPS, starterPickStats } from "./starterStats.ts";

describe("starter pick-screen stats (issue #9)", () => {
  const all = STARTERS.map((_, i) => starterPickStats(i));

  it("every starter shows two or three plain words and three bars of 1–5 pips", () => {
    for (const s of all) {
      expect(s.traits.length).toBeGreaterThanOrEqual(2);
      expect(s.traits.length).toBeLessThanOrEqual(3);
      expect(s.bars.map((b) => b.label)).toEqual(["Toughness", "Speed", "Dodge"]);
      for (const b of s.bars) expect(b.pips >= 1 && b.pips <= PIPS).toBe(true);
    }
  });

  it("the bars follow the shared table: sturdiest Ash, fastest Hinoko, best roll Kappa", () => {
    const pip = (i: number, k: number) => all[i]!.bars[k]!.pips;
    const ash = STARTER_STATS.findIndex((s) => s.id === "ash");
    const ninja = STARTER_STATS.findIndex((s) => s.id === "ninja");
    const kappa = STARTER_STATS.findIndex((s) => s.id === "kappa");
    expect(pip(ash, 0)).toBe(Math.max(...all.map((_, i) => pip(i, 0))));
    expect(pip(ninja, 1)).toBe(Math.max(...all.map((_, i) => pip(i, 1))));
    expect(pip(kappa, 2)).toBe(Math.max(...all.map((_, i) => pip(i, 2))));
  });

  it("no two starters show the same bars", () => {
    const keys = all.map((s) => s.bars.map((b) => b.pips).join(""));
    expect(new Set(keys).size).toBe(keys.length);
  });
});
