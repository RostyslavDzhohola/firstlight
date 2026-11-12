import { describe, expect, it } from "vitest";
import { damageMult, maxHp } from "./progression.ts";
import { AETHER, aetherAt, castBlock, FROSTBLOOM, GLASSWING, SPELL_BY_ID, SPELL_INDEX, SPELLS, spellDamage, WISHFALL } from "./spells.ts";
import { WEAPON_BY_ID } from "./weapons.ts";

describe("spell catalogue (content.md §2.7)", () => {
  it("lists the four spells in their append-only order, each on its own key", () => {
    expect(SPELLS.map((s) => s.id)).toEqual(["skipstep", "frostbloom", "wishfall", "glasswing"]);
    expect(SPELLS.map((s) => s.code)).toEqual(["KeyQ", "KeyF", "KeyX", "KeyZ"]);
    expect(new Set(SPELLS.map((s) => s.code)).size).toBe(SPELLS.length);
    expect(SPELLS.map((s) => [s.level, s.cost, s.cooldownS])).toEqual([[1, 20, 6], [3, 30, 10], [6, 45, 14], [9, 35, 18]]);
    for (const s of SPELLS) {
      expect(SPELL_INDEX.get(s.id)).toBe(SPELLS.indexOf(s));
      expect(SPELL_BY_ID.get(s.id)).toBe(s);
      expect(s.cost).toBeLessThanOrEqual(AETHER.max);
    }
  });

  it("a full book can't pay for all four at once", () => {
    expect(SPELLS.reduce((n, s) => n + s.cost, 0)).toBeGreaterThan(AETHER.max);
  });

  it("aether waits out the pause, then refills at 6 a second up to the max", () => {
    const s = { aether: 10, t: 1000, regenAt: 2500 };
    expect(aetherAt(s, 1000)).toBe(10);
    expect(aetherAt(s, 2500)).toBe(10);
    expect(aetherAt(s, 3500)).toBeCloseTo(16);
    expect(aetherAt(s, 1e9)).toBe(AETHER.max);
    // A value stored after the pause refills from its own time.
    expect(aetherAt({ aether: 50, t: 5000, regenAt: 2500 }, 6000)).toBeCloseTo(56);
  });

  it("castBlock: level, then cooldown, then aether", () => {
    const frost = SPELL_BY_ID.get("frostbloom")!;
    const book = { aether: 100, t: 0, regenAt: 0, ready: [0, 0, 0, 0] };
    expect(castBlock(frost, 2, book, 0)).toBe("level");
    expect(castBlock(frost, 3, book, 0)).toBeNull();
    expect(castBlock(frost, 3, { ...book, ready: [0, 500, 0, 0] }, 100)).toBe("cooldown");
    expect(castBlock(frost, 3, { ...book, aether: 29 }, 0)).toBe("aether");
    expect(castBlock(frost, 3, null, 0)).toBeNull();
  });

  it("spell damage scales with level like weapons", () => {
    for (const l of [1, 6, 12, 20]) expect(spellDamage(60, l)).toBeCloseTo(60 * damageMult(l));
  });

  // The balance rules §2.7 states, checked against the weapon table.
  it("no damage spell at level 1 (the level-1 TTK floors stand untouched)", () => {
    for (const s of SPELLS) if (s.harmful) expect(s.level).toBeGreaterThan(1);
  });

  it("no spell hit comes near a one-shot at equal level: Wishfall's centre stays under half the target's HP", () => {
    for (let l = SPELL_BY_ID.get("wishfall")!.level; l <= 20; l++) {
      expect(spellDamage(WISHFALL.damage, l) / maxHp(l)).toBeLessThan(0.5);
      expect(spellDamage(FROSTBLOOM.damage, l) / maxHp(l)).toBeLessThan(0.25);
    }
    // And well under the largest single weapon hit (a Stillshot headshot, 73–86% of HP).
    const still = WEAPON_BY_ID.get("stillshot")!.tiers[0]!;
    expect(WISHFALL.damage).toBeLessThan(still.damage * (still.headMult ?? 1.5));
  });

  it("an opening Frostbloom + Wishfall adds 25–35% to what a sustained weapon deals in a 5 s fight", () => {
    // Sustained weapons at their gate (§2.5): Hexquill, Sunbrand, Pocket Carbine, Bearded Axe.
    const tierAt = (l: number) => (l >= 12 ? 2 : l >= 6 ? 1 : 0);
    for (const l of [6, 9, 12, 20]) {
      const dps = ["hexquill", "sunbrand", "carbine", "axe"].map((id) => {
        const t = WEAPON_BY_ID.get(id)!.tiers[tierAt(l)]!;
        return (t.damage * damageMult(l)) / t.rate;
      });
      const weapon = (dps.reduce((a, b) => a + b, 0) / dps.length) * 5;
      const spells = spellDamage(FROSTBLOOM.damage + WISHFALL.damage, l);
      expect(spells / weapon, `level ${l}`).toBeGreaterThan(0.18);
      expect(spells / weapon, `level ${l}`).toBeLessThan(0.36);
    }
  });

  it("the ward is worth 30% of max HP", () => {
    expect(GLASSWING.absorbPer100MaxHp).toBe(30);
    expect(Math.round((GLASSWING.absorbPer100MaxHp / 100) * maxHp(9))).toBe(54);
  });
});
