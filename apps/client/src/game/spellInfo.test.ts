import { describe, expect, it } from "vitest";
import { SPELL_BY_ID, spellDamage, FROSTBLOOM } from "@firstlight/shared/content/spells";
import { starterSpellPower } from "@firstlight/shared/content/starters";
import { spellEffect, spellGains, spellPower, spellTooltip } from "./spellInfo.ts";

const s = (id: string) => SPELL_BY_ID.get(id)!;

describe("spell numbers at your level (#79)", () => {
  it("uses the server's formula with the starter's spell power", () => {
    for (const starter of [0, 1, 2, 3, 4]) {
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
