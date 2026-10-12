import { describe, expect, it } from "vitest";
import { COSMETIC_BY_ID, COSMETICS, isEggItem, shopEntry, unitSellValue } from "@firstlight/shared/content/items";
import { MEDAL_BY_ID } from "@firstlight/shared/content/medals";
import { MISSION_BY_ID } from "@firstlight/shared/content/missions";
import { EGGS, PLAQUES } from "@firstlight/shared/content/secrets";

describe("M11 cosmetic catalogue", () => {
  it("appends eight priced, sourced cosmetics across the wardrobe", () => {
    const expected = [
      ["bracken_stitch_cap", "hat", "common", 30],
      ["dockfold_cape", "cape", "common", 30],
      ["petalwake_mask", "mask", "uncommon", 90],
      ["fenweave_cape", "cape", "rare", 250],
      ["copper_orbit_pack", "backpack", "rare", 250],
      ["dewdial_crown", "hat", "legendary", 0],
      ["wickfloat_mantle", "cape", "legendary", 0],
      ["quietshift_lens", "mask", "legendary", 0],
    ] as const;
    expect(COSMETICS.slice(31).map((c) => c.id)).toEqual(expected.map(([id]) => id));
    for (const [id, slot, rarity, sell] of expected) {
      expect(COSMETIC_BY_ID.get(id)).toMatchObject({ slot, rarity });
      expect(COSMETIC_BY_ID.get(id)?.source.length).toBeGreaterThan(0);
      expect(unitSellValue({ id, tier: 1 })).toBe(sell);
    }
    for (const id of ["bracken_stitch_cap", "dockfold_cape"]) expect(shopEntry(id, 1)?.price).toBe(120);
    expect(MISSION_BY_ID.get("M3")?.reward.items).toContainEqual({ id: "copper_orbit_pack", tier: 1, qty: 1 });
  });

  it("pairs every egg with a hidden medal, unsellable reward and first-finder plaque", () => {
    expect(EGGS).toHaveLength(12);
    for (const egg of EGGS) {
      expect(MEDAL_BY_ID.get(egg.medal)).toMatchObject({ ref: egg.id, hidden: true });
      expect(isEggItem(egg.item)).toBe(true);
      expect(unitSellValue(egg.item)).toBe(0);
      expect(PLAQUES.some((p) => p.id === egg.id)).toBe(true);
    }
    expect(PLAQUES.slice(9, 12).map((p) => p.id)).toEqual(["boss:tidewrath", "boss:hollow_king", "boss:receiver"]);
  });
});
