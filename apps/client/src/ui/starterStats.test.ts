import { describe, expect, it } from "vitest";
import { STARTERS } from "@firstlight/shared/content/weapons";
import { STARTER_STATS } from "@firstlight/shared/content/starters";
import { PIPS, starterPickStats } from "./starterStats.ts";

describe("starter pick-screen stats (issue #9)", () => {
  const all = STARTERS.map((_, i) => starterPickStats(i));

  it("every starter shows two or three plain words and four bars of 1–5 pips", () => {
    for (const s of all) {
      expect(s.traits.length).toBeGreaterThanOrEqual(2);
      expect(s.traits.length).toBeLessThanOrEqual(3);
      expect(s.bars.map((b) => b.label)).toEqual(["Toughness", "Speed", "Dodge", "Magic"]);
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

  it("the Magic row is the spell power: Hexwick's the most, Brother Ash's the least, Kappa at the base", () => {
    const magic = all.map((s) => s.bars[3]!.pips);
    const at = (id: string) => magic[STARTER_STATS.findIndex((s) => s.id === id)]!;
    expect(at("hexwick")).toBe(PIPS);
    expect(at("ash")).toBe(Math.min(...magic));
    expect(at("ash")).toBeLessThan(3);
    expect(at("kappa")).toBe(3);
    // The order of the pips is the order of the multipliers (1.15, 1.05, 1.00, 0.95, 0.90).
    const byPower = STARTER_STATS.map((s, i) => [s.spellPower ?? 1, magic[i]!] as const).sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < byPower.length; i++) expect(byPower[i]![1]).toBeGreaterThanOrEqual(byPower[i - 1]![1]);
    expect(at("hexwick")).toBeGreaterThan(at("ninja"));
    expect(at("ninja")).toBeGreaterThan(at("kappa"));
  });

  it("no two starters show the same bars", () => {
    const keys = all.map((s) => s.bars.map((b) => b.pips).join(""));
    expect(new Set(keys).size).toBe(keys.length);
  });
});
