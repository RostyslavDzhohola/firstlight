import { describe, expect, it } from "vitest";
import { COSMETICS, isEggItem, TROPHIES } from "@firstlight/shared/content/items";
import { WEAPONS } from "@firstlight/shared/content/weapons";
import { offerCounts, shopCatalogue, sourceText, tiered, type ShopContext } from "./shopModel.ts";

const ctx = (o: Partial<ShopContext> = {}): ShopContext => ({ level: 1, coins: 100, horses: true, extras: true, hidden: new Set(), ...o });
const rows = (c: ShopContext, qty?: (id: string) => number) => shopCatalogue(c, qty).flatMap((g) => g.rows);
const row = (c: ShopContext, id: string, qty?: (id: string) => number) => rows(c, qty).find((r) => r.itemId === id);

describe("shop catalogue", () => {
  it("lists every item in the game once (eggs only as a count)", () => {
    const ids = rows(ctx()).map((r) => r.itemId).filter(Boolean);
    expect(new Set(ids).size).toBe(ids.length);
    const expected = [...WEAPONS.map((w) => w.id).filter((id) => id !== "fists"), ...COSMETICS.filter((c) => !isEggItem({ id: c.id })).map((c) => c.id), ...TROPHIES.map((t) => t.id)];
    expect(ids.sort()).toEqual(expected.sort());
    const secrets = rows(ctx()).find((r) => r.key === "secrets")!;
    expect(secrets.name).toBe("12 secret rewards");
    expect(JSON.stringify(shopCatalogue(ctx()))).not.toMatch(/Pixel Halo|pixel_halo|Ferryman/);
  });

  it("groups weapons by family with their three tiers, then support, tonics, gear, cosmetics by slot, trophies, secrets", () => {
    const g = shopCatalogue(ctx());
    expect(g.map((x) => x.id)).toEqual(["melee", "magic", "ranged", "support", "tonics", "gear", "cos-hat", "cos-cape", "cos-mask", "cos-backpack", "trophies", "secrets"]);
    expect(g[0]!.rows.map((r) => r.itemId)).toEqual(["sunbrand", "riverstaff", "axe", "hammer"]);
    const sun = row(ctx(), "sunbrand")!;
    expect(sun.offers.map((o) => [o.label, o.price, o.level, o.stat])).toEqual([["I", 60, 1, "18 dmg"], ["II", 300, 6, "24 dmg"], ["III", 900, 12, "31 dmg"]]);
    expect(sun.meta).toBe("Melee · 2.4 m reach · blocks 70%");
    expect(row(ctx(), "scatterpipe")!.offers[0]!.stat).toBe("6×7 dmg");
    expect(row(ctx(), "tonic_large")!.offers.map((o) => [o.label, o.stat])).toEqual([["", "+120 HP"]]);
  });

  it("locks what you can't use or afford yet, with the reason", () => {
    const sun = row(ctx({ level: 1, coins: 100 }), "sunbrand")!;
    expect(sun.offers.map((o) => o.lock?.text ?? null)).toEqual([null, "Level 6", "Level 12"]);
    expect(row(ctx({ level: 1, coins: 100 }), "bubble")!.offers[0]!.lock).toEqual({ kind: "coins", short: 20, text: "20 ◎ short" });
    expect(row(ctx({ level: 6, coins: 0 }), "sunbrand")!.offers[1]!.lock?.kind).toBe("coins"); // the level is there, the coins aren't
    expect(row(ctx({ level: 12, coins: 5000 }), "sunbrand")!.offers.every((o) => !o.lock)).toBe(true);
    // A stack is priced for the chosen size.
    expect(row(ctx({ coins: 50 }), "tonic_small", () => 10)!.offers[0]!.lock).toEqual({ kind: "coins", short: 50, text: "50 ◎ short" });
    expect(row(ctx({ coins: 50 }), "tonic_small", () => 5)!.offers[0]!.lock).toBeNull();
    // Loot the shop never sells: shown with where it comes from and what it fetches here.
    const coral = row(ctx(), "coral_crown")!;
    expect(coral.offers).toEqual([]);
    expect(coral.lock).toEqual({ kind: "source", text: "Not sold · Tidewrath (1 in 12)" });
    expect(coral.sells).toBe(250);
    expect(row(ctx({ coins: 500 }), "woolly_beanie")!.offers[0]).toMatchObject({ price: 120, lock: null });
    expect(row(ctx(), "wolf_pelt")).toMatchObject({ sells: 8, offers: [] });
  });

  it("keeps switched-off items out: the radio with voice off, horses, the M11 extras", () => {
    expect(row(ctx({ hidden: new Set(["radio"]) }), "radio")).toBeUndefined();
    expect(row(ctx(), "radio")).toBeTruthy();
    expect(row(ctx({ horses: false }), "horse_whistle")).toBeUndefined();
    expect(row(ctx({ extras: false }), "dockfold_cape")).toBeUndefined();
    expect(row(ctx({ extras: false }), "fenweave_cape")).toBeUndefined();
    expect(rows(ctx({ extras: false })).find((r) => r.key === "secrets")!.name).toBe("9 secret rewards");
  });

  it("counts what's open now", () => {
    const poor = offerCounts(shopCatalogue(ctx({ level: 1, coins: 0 })));
    const rich = offerCounts(shopCatalogue(ctx({ level: 20, coins: 1e6 })));
    expect(poor.open).toBe(0);
    expect(rich.open).toBe(rich.total);
    expect(poor.total).toBe(rich.total);
    expect(sourceText("any Arcadia enemy 1/150")).toBe("Not sold · any Arcadia enemy (1 in 150)");
    expect(sourceText("Site Visit mission M3")).toBe("Not sold · Site Visit mission M3");
  });

  it("names tiers only for tiered items (the Sell list)", () => {
    expect(tiered({ id: "sunbrand", tier: 2 })).toBe(true);
    expect(tiered({ id: "grenade", tier: 1 })).toBe(true);
    expect(tiered({ id: "woolly_beanie", tier: 1 })).toBe(false);
    expect(tiered({ id: "tonic_small", tier: 1 })).toBe(false);
    expect(tiered({ id: "horse_whistle", tier: 1 })).toBe(false);
    expect(tiered({ id: "wolf_pelt", tier: 1 })).toBe(false);
    expect(tiered({ id: "riverstaff", tier: 2, skin: "ferrymans_oar" })).toBe(false);
  });
});
