import { describe, expect, it } from "vitest";
import { SPELL_BY_ID, SPELLS, spellDamage, FROSTBLOOM } from "@firstlight/shared/content/spells";
import { starterSpellPower } from "@firstlight/shared/content/starters";
import { STARTERS } from "@firstlight/shared/content/weapons";
import { spellCost, spellEffect, spellGains, spellPower, spellTooltip } from "./spellInfo.ts";

const s = (id: string) => SPELL_BY_ID.get(id)!;

describe("spell numbers at your level (#79)", () => {
  it("uses the server's formula with the starter's spell power", () => {
    for (const starter of STARTERS.keys()) {
      expect(spellPower(s("frostbloom"), 7, starter)!.value).toBe(Math.round(spellDamage(FROSTBLOOM.damage, 7, starterSpellPower(starter))));
    }
    expect(spellPower(s("skipstep"), 5, 0)).toBeNull();
  });

  it("grows with level and says so on the level-up", () => {
    expect(spellPower(s("frostbloom"), 12, 1)!.value).toBeGreaterThan(spellPower(s("frostbloom"), 3, 1)!.value);
    expect(spellGains(5, 6, 1)).toMatch(/^Frostbloom \d+ → \d+$/); // Wishfall unlocks at 6: its own banner
    expect(spellGains(9, 10, 1)).toMatch(/Wishfall \d+ → \d+ · Glasswing Ward \d+ → \d+/); // a +3% step can round to no change for Frostbloom
    expect(spellGains(1, 2, 1)).toBe(""); // only Skipstep, which doesn't scale
  });

  it("tooltips name the numbers, or the unlock level", () => {
    expect(spellTooltip(s("frostbloom"), 1, 0)).toMatch(/unlocks at level 3/);
    expect(spellTooltip(s("frostbloom"), 4, 0)).toMatch(/damage in a 5 m ring · slows 40% for 3 s\. 30 aether · 10 s cooldown\./);
    expect(spellEffect(s("glasswing"), 9, 2)).toMatch(/^A \d+ HP shell for 4 s$/);
  });
});

describe("spell numbers follow the build tree (#81)", () => {
  it("Attuned raises the damage and the shell, Quickened cuts the cooldowns, Far Step stretches Skipstep", () => {
    const frost = SPELLS.find((s) => s.id === "frostbloom")!;
    const skip = SPELLS.find((s) => s.id === "skipstep")!;
    expect(spellPower(frost, 5, 3, ["magic_attuned"])!.value).toBeGreaterThan(spellPower(frost, 5, 3)!.value);
    expect(spellCost(frost)).toBe(`${frost.cost} aether · ${frost.cooldownS} s cooldown`);
    expect(spellCost(frost, ["magic_attuned", "magic_quickened"])).toBe(`${frost.cost} aether · ${frost.cooldownS * 0.75} s cooldown`);
    expect(spellEffect(skip, 5, 3, ["travel_stride", "travel_far_step"])).toBe("Blink up to 15 m the way you look");
  });
});
