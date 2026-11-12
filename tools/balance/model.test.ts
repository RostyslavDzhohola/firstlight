import { describe, expect, it } from "vitest";
import { WEAPONS } from "../../packages/shared/src/content/weapons.ts";
import { npcDef } from "../../packages/shared/src/content/npcs.ts";
import { STARTER_STATS, starterMaxHp } from "../../packages/shared/src/content/starters.ts";
import { checks } from "./bands.ts";
import { clampHits, closingTime, creatureTimeline, damageBy, dodgeFactor, gatedTier, hitTimeline, progression, pvpCell, SERVER_CHARGE_ALLOWANCE, SERVER_RATE_ALLOWANCE, timeToKill } from "./model.ts";

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

  it("melee damage lands on the press, as the server's melee() applies it (review finding 3; the windup is no delay)", () => {
    const hits = hitTimeline(w("sunbrand"), 0, 1, "plain", 1);
    expect(w("sunbrand").windup).toBeGreaterThan(0);
    expect(hits.map((h) => +h.t.toFixed(2))).toEqual([0, 0.45, 0.9]);
    // A charged heavy too: the axe's pre-charged chop lands at t = 0, the next light one rate later.
    const axe = hitTimeline(w("axe"), 0, 1, "full", 1);
    expect(axe.map((h) => [+h.t.toFixed(2), h.dmg])).toEqual([[0, 66], [w("axe").tiers[0].rate, 30]]);
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

describe("the server's accepted cadence (review finding 1)", () => {
  it("consumeAttack lets an attack through at 0.85 × the rate; melee() takes a heavy charged 0.9 × heavyTime", () => {
    expect([SERVER_RATE_ALLOWANCE, SERVER_CHARGE_ALLOWANCE]).toEqual([0.85, 0.9]);
    const carbine = hitTimeline(w("carbine"), 0, 1, "plain", 1, { cadence: "server" });
    expect(carbine.slice(0, 3).map((h) => +h.t.toFixed(4))).toEqual([0, 0.2125, 0.425]);
    // Nothing pre-charged: the first chop needs 0.9 × 0.8 s of charge, the light after it 0.85 × the rate.
    const axe = hitTimeline(w("axe"), 0, 1, "full", 2, { cadence: "server", preheld: false });
    expect(axe.slice(0, 2).map((h) => [+h.t.toFixed(3), h.dmg])).toEqual([[0.72, 66], [+(0.72 + 0.85 * w("axe").tiers[0].rate).toFixed(3), 30]]);
    // Reloads are exact: the Stillshot's 4th shot then a 2.2 s reload, not 0.85 × it.
    const still = hitTimeline(w("stillshot"), 0, 1, "plain", 10, { cadence: "server" });
    expect(still[4]!.t - still[3]!.t).toBeCloseTo(2.2);
  });

  it("the L1 axe's chop + light on an 88-HP Hinoko: 0.68 s at the old 0.8 s rate, ≥ 0.75 s and two hits now", () => {
    const hinoko = STARTER_STATS.findIndex((s) => s.id === "ninja");
    expect(starterMaxHp(hinoko, 1)).toBe(88);
    const c = pvpCell("axe", 1, 88, 0, "server");
    expect(c.openerHits).toBe(2);
    expect(c.openerTtk).toBeCloseTo(0.85 * w("axe").tiers[0].rate, 5);
    expect(c.openerTtk).toBeGreaterThanOrEqual(0.75);
    expect(0.85 * 0.8).toBeLessThan(0.75); // the old rate, under the floor
    expect(pvpCell("axe", 1, 88).openerTtk).toBeCloseTo(w("axe").tiers[0].rate, 5); // the shipped client's cadence
  });
});

describe("the Ember Seal (review finding 2, D-balance-7)", () => {
  const kunai = w("kunai");
  const seal = w("ember_seal");
  const isSeal = (h: { dmg: number }) => h.dmg === seal.tiers[0].damage;

  it("after a seal the next dart waits the rate gate (castSpecial calls markAttack)", () => {
    const rate = kunai.tiers[0].rate;
    const hits = hitTimeline(kunai, 0, 1, "full", 20);
    expect([hits[0]!.t, hits[0]!.dmg]).toEqual([0, seal.tiers[0].damage]); // pre-held, cast at t = 0
    expect(hits[1]!.t).toBeCloseTo(rate); // not at once
    const server = hitTimeline(kunai, 0, 1, "full", 20, { cadence: "server" });
    expect(server[1]!.t).toBeCloseTo(0.85 * rate);
    // Every seal after the opener: held 0.4 s after the last dart, and the next dart a full rate after it.
    const seals = hits.map((h, i) => [h, i] as const).filter(([h]) => isSeal(h)).slice(1);
    expect(seals.length).toBeGreaterThan(0);
    for (const [h, i] of seals) {
      expect(h.t - hits[i - 1]!.t).toBeGreaterThanOrEqual(kunai.tiers[0].heavyTime! - 1e-9);
      expect(hits[i + 1]!.t - h.t).toBeGreaterThanOrEqual(rate - 1e-9);
      expect(h.t - seals[0]![0].t).toBeGreaterThanOrEqual(0); // and on its 8 s cooldown
    }
    expect(seals[0]![0].t).toBeGreaterThanOrEqual(kunai.tiers[0].cooldown!);
  });

  it("nothing pre-held (a duel): darts first, the seal 0.4 s after a dart once the hold is done", () => {
    const hits = hitTimeline(kunai, 0, 1, "full", 2, { preheld: false });
    expect(hits[0]!.t).toBe(0);
    expect(isSeal(hits[0]!)).toBe(false);
    const first = hits.findIndex(isSeal);
    expect(hits[first]!.t - hits[first - 1]!.t).toBeCloseTo(kunai.tiers[0].heavyTime!);
  });
});

describe("the headshot floor (review finding 4, D-balance-8)", () => {
  it("every weapon's best-play TTK (headshots, heavies, specials) is gated at every level against §2.5's 1.4 s", () => {
    const all = checks();
    for (const f of ["scatterpipe", "longbow", "stillshot", "kunai", "carbine"]) {
      for (const l of [1, 6, 12, 20]) expect(all.find((c) => c.id === `pvp.best.${f} L${l}`)?.ok).toBe(true);
    }
    // And the hard floor counts headshots against every starter body at the server's cadence.
    expect(all.some((c) => c.id === "pvp.floor.kunai L12.ninja" && c.what.includes("headshots"))).toBe(true);
  });

  it("the L1 Scatterpipe: two ×1.5 head volleys (63 each) killed in 0.9 s; pellets take no head bonus now", () => {
    const sp = w("scatterpipe");
    expect(sp.tiers.map((t) => t.headMult)).toEqual([1, 1, 1]);
    const c = pvpCell("scatterpipe", 1);
    expect([c.bestTtk, c.bestHits]).toEqual([c.ttk, c.hits]); // best play is the body volley: 1.8 s / 3
    expect(c.bestTtk).toBeGreaterThanOrEqual(1.4);
  });

  it("the gate catches a weapon under the floor (the old ×1.5 pellets)", () => {
    const sp = w("scatterpipe") as { tiers: { headMult?: number }[] };
    try {
      for (const t of sp.tiers) t.headMult = 1.5;
      const c = pvpCell("scatterpipe", 1);
      expect([+c.bestTtk.toFixed(2), c.bestHits]).toEqual([0.9, 2]);
      expect(checks().find((x) => x.id === "pvp.best.scatterpipe L1")?.ok).toBe(false);
    } finally {
      for (const t of sp.tiers) t.headMult = 1;
    }
  });

  it("the Ember Seal's fireball head hit takes the seal's own headMult, 1 for an explosive", () => {
    const seal = w("ember_seal");
    expect(seal.tiers.map((t) => t.headMult)).toEqual([1, 1, 1]);
    const best = hitTimeline(w("kunai"), 0, 1, "best", 1);
    expect(best[0]!.dmg).toBe(seal.tiers[0].damage);
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
    ["longbow", 1, 2.8, 3], // rate 1.4 (D-balance-8; §2.5 listed 2.7)
    ["longbow", 12, 2.8, 3], // §2.5 listed 2.3
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
