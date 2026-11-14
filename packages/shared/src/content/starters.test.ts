// The starters are ids by index (CharacterData.starter, PlayerState.starter): the plain Traveller (#80)
// was appended, listed first and made the new player's default without moving any existing one.

import { describe, expect, it } from "vitest";
import { BASE_MOVE, STARTER_STATS, starterMove, starterSpellPower, starterStats } from "./starters.ts";
import { lookId, PLAIN_STARTER, STARTER_LOOKS, STARTER_ORDER, STARTERS } from "./weapons.ts";
import { maxHp } from "./progression.ts";
import { starterMaxHp } from "./starters.ts";

describe("the plain starter (#80)", () => {
  it("keeps the five existing starters at their indexes and appends the Traveller", () => {
    expect(STARTERS.map((s) => s.id)).toEqual(["hexwick", "ash", "kappa", "unit7", "ninja", "traveller"]);
    expect(STARTER_STATS.map((s) => s.id)).toEqual(STARTERS.map((s) => s.id));
    expect(STARTER_LOOKS).toHaveLength(STARTERS.length);
    expect(STARTERS[PLAIN_STARTER]!.id).toBe("traveller");
  });

  it("is an ordinary traveller: a basic blade and the base numbers everywhere", () => {
    expect(STARTERS[PLAIN_STARTER]!.weapon).toBe("sunbrand");
    expect(starterStats(PLAIN_STARTER)).toMatchObject({ hp: 1, speed: 1, dodgeCooldown: BASE_MOVE.dodgeCooldown, spellPower: 1 });
    expect(starterMove(PLAIN_STARTER)).toEqual({ run: BASE_MOVE.run, sprint: BASE_MOVE.sprint, dodgeCooldown: BASE_MOVE.dodgeCooldown });
    expect(starterMaxHp(PLAIN_STARTER, 10)).toBe(maxHp(10));
    expect(starterSpellPower(PLAIN_STARTER)).toBe(1);
  });

  it("wears an existing body (Brother Ash's) under its own name", () => {
    expect(lookId(PLAIN_STARTER, 0)).toBe("ash");
    expect(STARTER_LOOKS[PLAIN_STARTER]![0]!.name).toBe("Traveller");
  });

  it("is listed first; every starter is offered once", () => {
    expect(STARTER_ORDER[0]).toBe(PLAIN_STARTER);
    expect([...STARTER_ORDER].sort()).toEqual(STARTERS.map((_, i) => i));
  });
});
