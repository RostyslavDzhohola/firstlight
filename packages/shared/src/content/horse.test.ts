import { describe, expect, it } from "vitest";
import { HORSE, HORSE_COATS, HORSE_WHISTLE, hasWhistle, horseCoat, rideSpeed, tooDeepToRide, whistleRefusal } from "./horse.ts";
import { itemName, itemStack, SHOP, shopEntry, unitSellValue } from "./items.ts";
import { WEAPON_BY_ID, WEAPON_INDEX, WEAPONS } from "./weapons.ts";
import { PF } from "../net/schema.ts";

describe("Horse Whistle item and shop (content.md §1.5)", () => {
  it("is sold once, as gear, at the Portus Exchange for 1,500 coins", () => {
    const e = shopEntry(HORSE_WHISTLE, 1);
    expect(e).toMatchObject({ itemId: HORSE_WHISTLE, tier: 1, name: "Horse Whistle", price: 1500, level: 1, category: "gear", stack: 1 });
    expect(shopEntry(HORSE_WHISTLE, 2)).toBeUndefined();
    expect(SHOP.filter((x) => x.itemId === HORSE_WHISTLE)).toHaveLength(1);
    expect(HORSE.price).toBe(e!.price);
  });

  it("is a normal, non-stacking inventory item that sells back for a quarter", () => {
    expect(itemName({ id: HORSE_WHISTLE })).toBe("Horse Whistle");
    expect(itemStack(HORSE_WHISTLE)).toBe(1);
    expect(unitSellValue({ id: HORSE_WHISTLE, tier: 1 })).toBe(375);
    const def = WEAPON_BY_ID.get(HORSE_WHISTLE)!;
    expect(def.cls).toBe("item");
    expect(def.delivery).toBe("none"); // never fires, never damages
  });

  it("was appended at the end so existing PlayerState.weapon indexes keep their meaning", () => {
    // Index 19 for good; later items (the ninja's kunai and seal) were appended after it.
    expect(WEAPON_INDEX.get(HORSE_WHISTLE)).toBe(19);
    expect(WEAPONS.slice(20).map((w) => w.id)).toEqual(["kunai", "ember_seal"]);
    expect(WEAPON_INDEX.get("radio")).toBe(16);
    expect(WEAPON_INDEX.get("tonic_large")).toBe(18);
  });
});

describe("horse rules", () => {
  it("rides faster than a sprint, and the mounted flag fits the uint16 flags field", () => {
    expect(HORSE.speed).toBe(14);
    expect(HORSE.sprint).toBeGreaterThan(HORSE.speed);
    expect(HORSE.speed).toBeGreaterThan(9);
    expect(PF.MOUNTED).toBeLessThan(65536);
    const all = Object.values(PF);
    expect(new Set(all).size).toBe(all.length);
    for (const f of all) expect(Math.log2(f) % 1).toBe(0);
  });

  it("slows the horse under NPC chill/slow, and Cease-and-Desist holds it to a canter", () => {
    expect(rideSpeed(false)).toBe(HORSE.speed);
    expect(rideSpeed(true)).toBe(HORSE.sprint);
    expect(rideSpeed(true, 0.5)).toBe(HORSE.sprint * 0.5);
    expect(rideSpeed(true, 0, true)).toBe(HORSE.speed);
    expect(rideSpeed(true, 0.2, true)).toBeCloseTo(HORSE.speed * 0.8);
    expect(rideSpeed(true, 3)).toBe(0); // clamped
  });

  it("finds a whistle in either the hotbar or the backpack", () => {
    const w = { id: HORSE_WHISTLE, tier: 1 as const, qty: 1 };
    expect(hasWhistle([null, null], [null, w])).toBe(true);
    expect(hasWhistle([w], [])).toBe(true);
    expect(hasWhistle([{ id: "radio", tier: 1, qty: 1 }, null], [null])).toBe(false);
    expect(hasWhistle(undefined)).toBe(false);
  });

  it("refuses the whistle in order: dead, no whistle, safe zone, water, cooldown", () => {
    const ok = { dead: false, hasWhistle: true, safe: false, swimming: false, sinceLastWhistleMs: 1e9 };
    expect(whistleRefusal(ok)).toBeNull();
    expect(whistleRefusal({ ...ok, hasWhistle: false, safe: true })).toBe("no whistle");
    expect(whistleRefusal({ ...ok, safe: true })).toBe("safe zone");
    expect(whistleRefusal({ ...ok, swimming: true })).toBe("water");
    expect(whistleRefusal({ ...ok, sinceLastWhistleMs: 10 })).toBe("cooldown");
    expect(whistleRefusal({ ...ok, dead: true })).toBe("dead");
  });

  it("throws the rider only in water deeper than the wading depth", () => {
    expect(tooDeepToRide(-0.5, 0)).toBe(false);
    expect(tooDeepToRide(-1.5, 0)).toBe(true);
    expect(tooDeepToRide(3, 0)).toBe(false);
  });

  it("gives every owner a stable coat from the six", () => {
    expect(HORSE_COATS).toHaveLength(6);
    expect(horseCoat("user-a")).toBe(horseCoat("user-a"));
    const seen = new Set(Array.from({ length: 200 }, (_, i) => horseCoat(`u${i}`)));
    expect(seen.size).toBe(6);
  });
});
