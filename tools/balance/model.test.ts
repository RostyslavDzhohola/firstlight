import { describe, expect, it } from "vitest";
import { WEAPONS } from "../../packages/shared/src/content/weapons.ts";
import { npcDef } from "../../packages/shared/src/content/npcs.ts";
import { checks } from "./bands.ts";
import { clampHits, closingTime, creatureTimeline, damageBy, dodgeFactor, gatedTier, hitTimeline, progression, pvpCell, timeToKill } from "./model.ts";

const w = (id: string) => WEAPONS.find((x) => x.id === id)!;

describe("weapon timeline (hand-checked against combat.ts consumeAttack)", () => {
  it("magazine: 24 rounds 0.25 s apart, then a 1.4 s reload", () => {
    const hits = hitTimeline(w("carbine"), 0, 1, "plain", 8);
    expect(hits.slice(0, 3).map((h) => h.t)).toEqual([0, 0.25, 0.5]);
    expect(hits[23]!.t).toBeCloseTo(5.75);
    expect(hits[24]!.t).toBeCloseTo(5.75 + 1.4);
    expect(hits.every((h) => h.dmg === 9)).toBe(true);
  });

  it("heat cools one shot per second: Hexquill I overheats on the 20th shot (1 + 0.6 × 19 ≥ 12), then 1.5 s lockout", () => {
    const hits = hitTimeline(w("hexquill"), 0, 1, "plain", 10);
    expect(hits[19]!.t).toBeCloseTo(19 * 0.4);
    expect(hits[20]!.t).toBeCloseTo(19 * 0.4 + 1.5);
  });

  it("the level multiplier rounds per hit: Sunbrand II at L6 hits for round(24 × 1.15) = 28", () => {
    expect(hitTimeline(w("sunbrand"), 1, 6, "plain", 1)[0]!.dmg).toBe(28);
  });

  it("melee hits land after the windup; the primary cadence is the tier rate", () => {
    const hits = hitTimeline(w("sunbrand"), 0, 1, "plain", 1);
    expect(hits.map((h) => +h.t.toFixed(2))).toEqual([0.12, 0.57, 1.02]);
  });

  it("charged heavies open and then wait out their cooldown", () => {
    const hits = hitTimeline(w("axe"), 0, 1, "full", 7);
    expect(hits[0]!.dmg).toBe(66);
    expect(hits.filter((h) => h.dmg === 66).length).toBe(2); // t ≈ 0.25 and again ≥ 6 s later
    expect(hits.find((h, i) => i > 0 && h.dmg === 66)!.t - hits[0]!.t).toBeGreaterThanOrEqual(6);
  });

  it("bows chain full draws at max(rate, draw)", () => {
    const def = w("longbow");
    const hits = hitTimeline(def, 0, 1, "plain", 3);
    expect(hits.map((h) => h.t)).toEqual([0, def.tiers[0].rate, 2 * def.tiers[0].rate]);
    expect(hits[0]!.dmg).toBe(45);
  });
});

describe("damage and burn", () => {
  it("burn burns continuously and refreshes, never stacks", () => {
    expect(timeToKill([{ t: 0, dmg: 24, burn: 4 }], 30)!.t).toBeCloseTo(1.5);
    // Two burning hits 1 s apart: the burn runs 0 → 4 s at 4/s (16), plus the two hits.
    expect(damageBy([{ t: 0, dmg: 10, burn: 4 }, { t: 1, dmg: 10, burn: 4 }], 10)).toBeCloseTo(36);
  });

  it("timeToKill counts direct hits", () => {
    expect(timeToKill([{ t: 0, dmg: 40 }, { t: 1, dmg: 40 }, { t: 2, dmg: 40 }], 100)).toEqual({ t: 2, hits: 3 });
    expect(timeToKill([{ t: 0, dmg: 40 }], 100)).toBeNull();
  });
});

describe("PvP cells match content §2.5 where the content's numbers still hold", () => {
  it.each([
    ["sunbrand", 1, 2.25, 6],
    ["riverstaff", 1, 2.8, 8],
    ["carbine", 1, 2.75, 12],
    ["scatterpipe", 1, 1.8, 3],
    ["stillshot", 1, 2.8, 3],
    ["longbow", 1, 2.7, 3],
    ["longbow", 12, 2.3, 3],
  ] as const)("%s at L%i: %f s / %i hits", (fam, level, t, hits) => {
    const c = pvpCell(fam, level);
    expect(c.ttk).toBeCloseTo(t, 5);
    expect(c.hits).toBe(hits);
  });

  it("gated tiers: T1 below 6, T2 6–11, T3 from 12", () => {
    expect([1, 5, 6, 11, 12, 20].map(gatedTier)).toEqual([0, 0, 1, 1, 2, 2]);
  });
});

describe("creatures and the AI clamps", () => {
  it("one hit ≤ 35% of max HP, any 1.5 s window ≤ 80%", () => {
    const out = clampHits([{ t: 0, dmg: 50 }, { t: 0.5, dmg: 50 }, { t: 1, dmg: 50 }, { t: 2, dmg: 50 }], "regular", 100);
    expect(out.map((h) => h.dmg)).toEqual([35, 35, 10, 35]);
  });

  it("a Hopbit hops on its 1.2 s cooldown, each hop landing 0.5 s after its telegraph starts", () => {
    const hits = creatureTimeline(npcDef("hopbit"), 1, 3);
    expect(hits.map((h) => +h.t.toFixed(2))).toEqual([0.5, 1.7, 2.9]);
    expect(hits[0]!.dmg).toBe(6);
  });
});

describe("duels", () => {
  it("closing: a 2 m melee sprinting 8 m/s at a ranged starter standing 10 m away needs 1 s", () => {
    expect(closingTime(2, 8, 25, 9)).toBeCloseTo(1, 1);
    // Two melee close together: (10 − 2.4) / (8 + 8) ≈ 0.48 s.
    expect(closingTime(2.4, 8, 2.4, 8)).toBeCloseTo(0.48, 1);
  });

  it("rolling: i-frames on half the cooldowns raise effective HP", () => {
    expect(dodgeFactor(1.25)).toBeCloseTo(1 / (1 - 0.1), 5);
  });
});

describe("the shipped catalogues", () => {
  it("level 2 lands at the end of the one-minute tutorial", () => {
    expect(progression()[1]!.reachedAt).toBe(1);
  });

  it("every balance check is in band (run `pnpm balance` for the report)", () => {
    const failed = checks().filter((c) => !c.ok).map((c) => `${c.id}: ${c.value} (band ${c.band}; ${c.source})`);
    expect(failed).toEqual([]);
  });
});
