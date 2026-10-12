// Items beyond weapons: cosmetics (content.md §8.4), trophies with fixed sell values (§1.5), the
// Portus Exchange shop list and sell-back rules. Weapons, tonics, grenades, patchkits, bubbles and
// the radio live in weapons.ts; this module prices them for the shop.

import type { InvItem } from "../net/protocol.ts";
import { SELL_RATE } from "./progression.ts";
import { WEAPONS, WEAPON_BY_ID } from "./weapons.ts";

export type Rarity = "common" | "uncommon" | "rare" | "legendary";
export type CosmeticSlot = "hat" | "cape" | "mask" | "backpack";
/** Abstract avatar sockets (SPEC §6.2); the characters lane maps them to bones. */
export type Socket = "head" | "back" | "face" | "belt";

export const COSMETIC_SLOTS: readonly CosmeticSlot[] = ["hat", "cape", "mask", "backpack"];
export const COSMETIC_SOCKET: Record<CosmeticSlot, Socket> = { hat: "head", cape: "back", mask: "face", backpack: "back" };

/** Rarity is shown by colour and a shape icon (colour-blind safe). */
export const RARITY_STYLE: Record<Rarity, { color: string; icon: string; label: string }> = {
  common: { color: "#b8b8c0", icon: "●", label: "Common" },
  uncommon: { color: "#5fd38a", icon: "▲", label: "Uncommon" },
  rare: { color: "#5aa8ff", icon: "◆", label: "Rare" },
  legendary: { color: "#ffc94a", icon: "★", label: "Legendary" },
};

export interface CosmeticDef {
  id: string;
  name: string;
  slot: CosmeticSlot;
  rarity: Rarity;
  /** Where it comes from (content.md §8.4). */
  source: string;
  /** Portus Exchange price (common cosmetics only). */
  price?: number;
}

const C = (id: string, name: string, slot: CosmeticSlot, rarity: Rarity, source: string, price?: number): CosmeticDef => ({ id, name, slot, rarity, source, ...(price ? { price } : {}) });

export const COSMETICS: readonly CosmeticDef[] = [
  C("woolly_beanie", "Woolly Beanie", "hat", "common", "Portus shop", 120),
  C("wide_straw_hat", "Wide Straw Hat", "hat", "common", "Portus shop", 120),
  C("winged_cap", "Messenger's Winged Cap", "hat", "uncommon", "any Arcadia enemy 1/150"),
  C("hard_hat", "Hard Hat (Oversight Issue)", "hat", "uncommon", "any Meridian enemy 1/75"),
  C("antler_crown", "Antler Crown", "hat", "rare", "Bramblehorn 1/8"),
  C("heron_plume_hat", "Heron Plume Hat", "hat", "rare", "Fenstalker 1/8"),
  C("coral_crown", "Coral Crown", "hat", "rare", "Tidewrath 1/12"),
  C("hollow_crown", "Hollow Crown", "hat", "legendary", "Hollow King 1/25"),
  C("pixel_halo", "Pixel Halo", "hat", "legendary", "Easter egg E2"),
  C("candle_crown", "Candle Crown", "hat", "legendary", "Easter egg E5"),
  C("ticket_000_helmet", "Ticket #000 Helmet", "hat", "legendary", "Easter egg E9"),
  C("travellers_cloak", "Traveller's Cloak", "cape", "common", "Portus shop", 120),
  C("wolfpelt_cape", "Wolfpelt Cape", "cape", "uncommon", "Dusk Wolf 1/200"),
  C("tide_cape", "Tide Cape", "cape", "rare", "Tidewrath 1/12"),
  C("court_mantle", "Court Mantle", "cape", "rare", "Hollow King 1/12"),
  C("saltplate_mantle", "Saltplate Mantle", "cape", "rare", "Dunebreaker 1/8"),
  C("static_cloak", "Static Cloak", "cape", "legendary", "Easter egg E8"),
  C("fox_mask", "Fox Mask", "mask", "common", "Portus shop", 120),
  C("voxel_visor", "Voxel Visor", "mask", "uncommon", "Blockyard camp chest 1/10"),
  C("crowbeak_mask", "Crowbeak Mask", "mask", "uncommon", "any Hollowmere enemy 1/100"),
  C("funeral_veil", "Funeral Veil", "mask", "rare", "Hollow King 1/12"),
  C("executive_visor", "Executive Visor", "mask", "legendary", "Easter egg E7"),
  C("bedroll", "Bedroll", "backpack", "common", "Portus shop", 120),
  C("woolback_plushie", "Woolback Plushie", "backpack", "uncommon", "Woolback 1/300"),
  C("wind_up_key", "Wind-Up Key", "backpack", "rare", "The Receiver 1/12"),
  C("signal_dish", "Signal Dish", "backpack", "rare", "The Receiver 1/12"),
  C("tidewrath_tooth", "Tidewrath Tooth", "backpack", "legendary", "Tidewrath 1/25"),
  C("receiver_floodlamp", "Receiver Floodlamp", "backpack", "legendary", "The Receiver 1/25"),
  C("lantern_of_lacefall", "Lantern of Lacefall", "backpack", "legendary", "Easter egg E1"),
  C("golden_hopbit", "Golden Hopbit", "backpack", "legendary", "Easter egg E3"),
  C("bone_bell", "Bone Bell", "backpack", "legendary", "Easter egg E6"),
];

export const COSMETIC_BY_ID: ReadonlyMap<string, CosmeticDef> = new Map(COSMETICS.map((c) => [c.id, c]));

export function isCosmetic(id: string): boolean {
  return COSMETIC_BY_ID.has(id);
}

/** Cosmetic sell-back by rarity (content.md §1.5). */
export const RARITY_SELL: Record<Rarity, number> = { common: 30, uncommon: 90, rare: 250, legendary: 500 };

/** Loot the shop doesn't sell, with fixed sell values (content.md §1.5). */
export interface TrophyDef {
  id: string;
  name: string;
  value: number;
  stack: number;
}

export const TROPHIES: readonly TrophyDef[] = [
  { id: "wool_tuft", name: "Wool Tuft", value: 2, stack: 20 },
  { id: "wolf_pelt", name: "Wolf Pelt", value: 8, stack: 10 },
  { id: "bramblehorn_antler", name: "Bramblehorn Antler", value: 120, stack: 1 },
  { id: "fenstalker_plume", name: "Fenstalker Plume", value: 200, stack: 1 },
  { id: "dunebreaker_scale", name: "Dunebreaker Scale", value: 300, stack: 1 },
];
export const TROPHY_BY_ID: ReadonlyMap<string, TrophyDef> = new Map(TROPHIES.map((t) => [t.id, t]));

/**
 * Unique looks for otherwise standard items (InvItem.skin). The Ferryman's Oar (egg E4) is a
 * Riverstaff II with the oar model and a water-wake trail, so combat needs no special case.
 */
export interface SkinDef {
  id: string;
  name: string;
  base: { id: string; tier: 1 | 2 | 3 };
  rarity: Rarity;
  value: number;
}
export const SKINS: readonly SkinDef[] = [{ id: "ferrymans_oar", name: "Ferryman's Oar", base: { id: "riverstaff", tier: 2 }, rarity: "legendary", value: 500 }];
export const SKIN_BY_ID: ReadonlyMap<string, SkinDef> = new Map(SKINS.map((s) => [s.id, s]));

// ---------------------------------------------------------------- Portus Exchange

export const SHOP_KEEPER = "Juno Vale";
export const SHOP_NAME = "Portus Exchange";

export type ShopCategory = "consumables" | "weapons" | "support" | "gear" | "cosmetics";

export interface ShopEntry {
  itemId: string;
  tier: 1 | 2 | 3;
  name: string;
  price: number;
  /** Level needed to equip/use (shown, never enforced at the till). */
  level: number;
  category: ShopCategory;
  stack: number;
}

const NOT_SOLD = new Set(["fists"]);

function buildShop(): ShopEntry[] {
  const out: ShopEntry[] = [];
  for (const w of WEAPONS) {
    if (NOT_SOLD.has(w.id)) continue;
    const gear = w.id === "radio" || w.id === "horse_whistle";
    const category: ShopCategory = w.id.startsWith("tonic") ? "consumables" : gear ? "gear" : w.cls === "support" ? "support" : "weapons";
    const tiers: (1 | 2 | 3)[] = w.id.startsWith("tonic") || gear ? [1] : [1, 2, 3];
    for (const tier of tiers) {
      const t = w.tiers[tier - 1]!;
      if (t.price <= 0) continue;
      out.push({ itemId: w.id, tier, name: w.name, price: t.price, level: t.level, category, stack: w.stack });
    }
  }
  for (const c of COSMETICS) if (c.price) out.push({ itemId: c.id, tier: 1, name: c.name, price: c.price, level: 1, category: "cosmetics", stack: 1 });
  return out;
}

export const SHOP: readonly ShopEntry[] = buildShop();

export function shopEntry(itemId: string, tier: number): ShopEntry | undefined {
  return SHOP.find((e) => e.itemId === itemId && e.tier === tier);
}

/** Display name of an item instance (skins and cosmetics included). */
export function itemName(item: Pick<InvItem, "id"> & { skin?: string }): string {
  if (item.skin) {
    const s = SKIN_BY_ID.get(item.skin);
    if (s) return s.name;
  }
  return WEAPON_BY_ID.get(item.id)?.name ?? COSMETIC_BY_ID.get(item.id)?.name ?? TROPHY_BY_ID.get(item.id)?.name ?? item.id;
}

/** Max stack size for an item id. */
export function itemStack(id: string): number {
  return WEAPON_BY_ID.get(id)?.stack ?? TROPHY_BY_ID.get(id)?.stack ?? 1;
}

/** Sell value of ONE unit: 25% of the shop price (rounded down, minimum 1), or the fixed value. */
export function unitSellValue(item: Pick<InvItem, "id" | "tier"> & { skin?: string }): number {
  if (item.skin) {
    const s = SKIN_BY_ID.get(item.skin);
    if (s) return s.value;
  }
  const trophy = TROPHY_BY_ID.get(item.id);
  if (trophy) return trophy.value;
  const cos = COSMETIC_BY_ID.get(item.id);
  if (cos) return RARITY_SELL[cos.rarity];
  const w = WEAPON_BY_ID.get(item.id);
  if (!w || NOT_SOLD.has(w.id)) return 0;
  const price = w.tiers[Math.max(0, Math.min(2, item.tier - 1))]!.price;
  return price > 0 ? Math.max(1, Math.floor(price * SELL_RATE)) : 0;
}

/** Sell value of `qty` units (default: the whole stack). */
export function sellValue(item: InvItem & { skin?: string }, qty = item.qty): number {
  return unitSellValue(item) * Math.max(0, Math.min(item.qty, qty));
}
