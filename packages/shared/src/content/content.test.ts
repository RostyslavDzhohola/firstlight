import { describe, expect, it } from "vitest";
import { damageMult, falloff, fallDamageFraction, killXp, levelForXp, maxHp, xpAtLevel, xpToNext } from "./progression.ts";
import { STARTERS, WEAPONS, weapon } from "./weapons.ts";

describe("progression", () => {
  it("level 2 lands with the tutorial's 50 XP, level 5 at 850, cap at 33,570", () => {
    expect(xpToNext(1)).toBe(50);
    expect(xpAtLevel(5)).toBe(850);
    expect(xpAtLevel(20)).toBe(33570);
    expect(levelForXp(49)).toBe(1);
    expect(levelForXp(50)).toBe(2);
    expect(levelForXp(10 ** 9)).toBe(20);
  });

  it("scales HP and damage per the content bible", () => {
    expect(maxHp(1)).toBe(100);
    expect(maxHp(20)).toBe(290);
    expect(damageMult(12)).toBeCloseTo(1.33, 5);
  });

  it("pays kill XP with the difficulty multiplier", () => {
    expect(killXp("regular", 4, 4)).toBe(30);
    expect(killXp("regular", 1, 10)).toBe(Math.round(15 * 0.2));
    expect(killXp("elite", 7, 4)).toBe(225);
  });

  it("fall damage starts at 8 m and is lethal by 20.5 m", () => {
    expect(fallDamageFraction(8)).toBe(0);
    expect(fallDamageFraction(20.5)).toBe(1);
  });

  it("falloff interpolates", () => {
    expect(falloff(20, 25, 45, 0.6)).toBe(1);
    expect(falloff(45, 25, 45, 0.6)).toBe(0.6);
    expect(falloff(35, 25, 45, 0.6)).toBeCloseTo(0.8, 6);
  });
});

/** Seconds from the first hit to the kill for an equal-level target at full HP, ignoring travel time. */
function ttk(id: string, tier: 0 | 1 | 2, level: number): { seconds: number; hits: number } {
  const w = weapon(id);
  const t = w.tiers[tier];
  const hp = maxHp(level);
  let perHit = t.damage * (t.pellets ?? 1) * damageMult(level);
  if (w.delivery === "arrow") perHit = t.damage * damageMult(level);
  const hits = Math.ceil(hp / perHit);
  let seconds = (hits - 1) * (w.delivery === "arrow" ? (t.draw ?? 1) + 0.35 : t.rate);
  if (t.mag && hits > t.mag) seconds += Math.floor((hits - 1) / t.mag) * (t.reload ?? 0);
  return { seconds, hits };
}

describe("PvP time-to-kill (content.md §2.5)", () => {
  const sustained = ["sunbrand", "riverstaff", "axe", "hammer", "hexquill", "stormcoil", "carbine", "scatterpipe", "longbow", "stillshot", "comet"];
  const gates: [0 | 1 | 2, number][] = [[0, 1], [1, 6], [2, 12]];

  it("no weapon one-shots an equal-level player at its gated tier", () => {
    for (const id of sustained) {
      for (const [tier, level] of gates) {
        expect(ttk(id, tier, level).hits, `${id} T${tier + 1} L${level}`).toBeGreaterThanOrEqual(2);
      }
    }
  });

  it("time-to-kill stays inside 1.4–3.6 s for every gated weapon", () => {
    for (const id of sustained) {
      for (const [tier, level] of gates) {
        const s = ttk(id, tier, level).seconds;
        expect(s, `${id} T${tier + 1} L${level}`).toBeGreaterThanOrEqual(1.4);
        expect(s, `${id} T${tier + 1} L${level}`).toBeLessThanOrEqual(3.6);
      }
    }
  });

  it("every starter weapon exists and is tier-1 equippable at level 1", () => {
    for (const s of STARTERS) expect(weapon(s.weapon).tiers[0].level).toBe(1);
    expect(new Set(WEAPONS.map((w) => w.id)).size).toBe(WEAPONS.length);
  });
});
