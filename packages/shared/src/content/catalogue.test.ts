// Every item id the game can hand out exists in the item catalogue (weapons.ts, items.ts), so drops,
// rewards and starters always have a name, a sell value and (for cosmetics) a slot (F12 review).

import { describe, expect, it } from "vitest";
import { COSMETIC_BY_ID, SHOP, TROPHY_BY_ID, isEggItem, itemName, sellValue, unitSellValue } from "./items.ts";
import { MISSIONS } from "./missions.ts";
import { BOSS_DEFS, DROP_WEAPONS, NPC_AREAS, NPC_DEFS, PLANET_COSMETIC, PLANET_TONIC } from "./npcs.ts";
import { EGGS } from "./secrets.ts";
import { STARTERS, WEAPON_BY_ID } from "./weapons.ts";

const inCatalogue = (id: string) => WEAPON_BY_ID.has(id) || COSMETIC_BY_ID.has(id) || TROPHY_BY_ID.has(id);

/** Every concrete item id referenced by content data, with where it came from. */
function referencedItems(): { id: string; from: string }[] {
  const out: { id: string; from: string }[] = [];
  const add = (id: string, from: string) => out.push({ id, from });
  for (const d of NPC_DEFS) for (const r of d.drops) if (r.kind === "item") add(r.id, `${d.id} drops`);
  for (const id of DROP_WEAPONS) add(id, "DROP_WEAPONS");
  for (const [planet, c] of Object.entries(PLANET_COSMETIC)) add(c.id, `${planet} cosmetic`);
  for (const [planet, t] of Object.entries(PLANET_TONIC)) add(t.id, `${planet} tonic`);
  for (const area of NPC_AREAS) if (area.camp?.chest?.cosmetic) add(area.camp.chest.cosmetic.id, `${area.id} chest`);
  for (const b of BOSS_DEFS) {
    for (const a of b.loot.always) if (a.id !== "weapon") add(a.id, `${b.id} loot`);
    for (const r of b.loot.rolls) for (const id of r.oneOf) if (id !== "weapon") add(id, `${b.id} roll`);
  }
  for (const m of MISSIONS) for (const it of m.reward.items) add(it.id, `${m.id} reward`);
  for (const e of EGGS) add(e.item.id, `${e.id} item`);
  for (const s of STARTERS) add(s.weapon, `${s.id} starter`);
  for (const e of SHOP) add(e.itemId, "shop");
  return out;
}

describe("item catalogue", () => {
  it("defines every item id that drops, is rewarded, sold or given at start", () => {
    const refs = referencedItems();
    expect(refs.length).toBeGreaterThan(60);
    const missing = refs.filter((r) => !inCatalogue(r.id)).map((r) => `${r.from}: ${r.id}`);
    expect(missing).toEqual([]);
    for (const r of refs) expect(itemName({ id: r.id }), r.from).not.toBe(r.id);
  });

  it("every dropped cosmetic or trophy can be sold back", () => {
    for (const r of referencedItems()) {
      if (WEAPON_BY_ID.has(r.id) || isEggItem({ id: r.id })) continue;
      expect(unitSellValue({ id: r.id, tier: 1 }), `${r.from}: ${r.id}`).toBeGreaterThan(0);
    }
  });

  it("Easter-egg items are trophies: once per life, so the Exchange won't buy them", () => {
    for (const e of EGGS) {
      expect(isEggItem(e.item), e.id).toBe(true);
      expect(sellValue({ ...e.item }), e.id).toBe(0);
    }
    // The same cosmetics from other sources keep their rarity value; a plain Riverstaff II still sells.
    expect(unitSellValue({ id: "hollow_crown", tier: 1 })).toBe(500);
    expect(unitSellValue({ id: "riverstaff", tier: 2 })).toBe(75);
  });

  it("the Ember Seal is the Ember Kunai's alt attack, never an item of its own", () => {
    const kunai = WEAPON_BY_ID.get("kunai")!;
    const seal = WEAPON_BY_ID.get(kunai.special!)!;
    expect(seal.hidden).toBe(true);
    expect(seal.destroys).toBe("heavy");
    expect(SHOP.some((e) => e.itemId === seal.id)).toBe(false);
    expect(unitSellValue({ id: seal.id, tier: 3 })).toBe(0);
    expect(STARTERS.find((s) => s.id === "ninja")?.weapon).toBe("kunai");
    // Cooldown and the 0.4 s hand seal live on every kunai tier; the seal def has a tier for each.
    for (let t = 0; t < 3; t++) {
      expect(kunai.tiers[t]!.heavyTime).toBe(0.4);
      expect(kunai.tiers[t]!.cooldown).toBeGreaterThan(0);
      expect(seal.tiers[t]!.splash).toBeGreaterThan(0);
    }
  });
});
