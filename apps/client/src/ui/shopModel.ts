// The shop's catalogue (round 2): every item in the game, grouped, each priced offer either buyable or
// locked with the exact reason ("so people see exactly what is accessible there"). Pure: the panel
// (shop.ts) draws it; the server refuses the same locks (content/shops.ts buyBlock). Items switched
// off in this build (the radio with voice off, horses or the M11 extras when their flags are off)
// stay out entirely, and Easter-egg rewards show only as a count, never by name (spoilers).

import { COSMETICS, isEggItem, RARITY_STYLE, shopEntry, TROPHIES, unitSellValue, type CosmeticDef, type CosmeticSlot, type Rarity } from "@firstlight/shared/content/items";
import { HORSE_WHISTLE } from "@firstlight/shared/content/horse";
import { EGGS } from "@firstlight/shared/content/secrets";
import { buyBlock } from "@firstlight/shared/content/shops";
import { WEAPON_BY_ID, type TierStats, type WeaponDef } from "@firstlight/shared/content/weapons";

export interface ShopContext {
  level: number;
  coins: number;
  /** Server flags (you.horses, you.cosmeticsExtras). */
  horses: boolean;
  extras: boolean;
  /** Items hidden in this build (HIDDEN_ITEMS: the radio while voice is off). */
  hidden: ReadonlySet<string>;
}

export type Lock =
  | { kind: "level"; level: number; text: string }
  | { kind: "coins"; short: number; text: string }
  /** Not sold anywhere: where it comes from. */
  | { kind: "source"; text: string };

export interface Offer {
  itemId: string;
  tier: 1 | 2 | 3;
  /** "I", "II", "III", or "" for single-tier items. */
  label: string;
  price: number;
  level: number;
  stack: number;
  /** The tier's headline number ("18 dmg", "+40 HP"). */
  stat: string;
  lock: Lock | null;
}

export interface ShopRow {
  key: string;
  itemId: string;
  name: string;
  /** Sprite name (ui/sprites.ts itemSprite) or null for the secrets row. */
  sprite: string | null;
  rarity: Rarity | null;
  /** One line: what it is ("Melee · 2.4 m reach"). */
  meta: string;
  offers: Offer[];
  /** Rows nothing in this shop sells (loot, trophies, secrets): why. */
  lock: Lock | null;
  /** What the shop pays for one (sell-only rows), else null. */
  sells: number | null;
}

export interface ShopGroup {
  id: string;
  title: string;
  rows: ShopRow[];
}

const TIER_LABEL = ["", "I", "II", "III"] as const;

const FAMILIES: readonly { id: string; title: string; items: readonly string[] }[] = [
  { id: "melee", title: "Melee weapons", items: ["sunbrand", "riverstaff", "axe", "hammer"] },
  { id: "magic", title: "Magic", items: ["hexquill", "emberglass", "stormcoil"] },
  { id: "ranged", title: "Ranged weapons", items: ["carbine", "scatterpipe", "longbow", "stillshot", "comet"] },
  { id: "support", title: "Support", items: ["grenade", "patchkit", "bubble"] },
  { id: "tonics", title: "Tonics", items: ["tonic_small", "tonic_large"] },
  { id: "gear", title: "Gear", items: [HORSE_WHISTLE, "radio"] },
];

const SLOT_TITLE: Record<CosmeticSlot, string> = { hat: "Cosmetics · hats", cape: "Cosmetics · capes", mask: "Cosmetics · masks", backpack: "Cosmetics · backpacks" };

const n = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(1).replace(/\.0$/, ""));

/** The tier's headline number. */
export function tierStat(w: WeaponDef, t: TierStats): string {
  if (t.pellets) return `${t.damage}×${t.pellets} dmg`;
  if (w.id.startsWith("tonic")) return `+${t.heal} HP`;
  if (t.heal) return `heals ${Math.round(t.heal * 100)}%`;
  if (t.shell) return `${t.shell} shield`;
  if (t.damage > 0) return `${t.damage} dmg`;
  return "";
}

/** One line on what the item is. */
export function itemMeta(w: WeaponDef): string {
  const t = w.tiers[0];
  switch (w.cls) {
    case "melee":
      return `Melee · ${n(w.range)} m reach${t.block ? ` · blocks ${Math.round(t.block * 100)}%` : ""}`;
    case "magic":
      return `Magic · ${n(w.range)} m · overheats after ${t.heat} casts`;
    case "ranged":
      return `Ranged · ${n(w.range)} m${t.mag ? ` · ${t.mag} ${t.mag === 1 ? "round" : "rounds"}` : ""}`;
    case "support":
      return w.id === "grenade" ? `Thrown · ${n(t.radius ?? 0)} m blast · stacks to ${w.stack}` : w.id === "patchkit" ? `Heals you or a friend · stacks to ${w.stack}` : `Shields everyone inside for ${t.duration} s`;
    default:
      if (w.id.startsWith("tonic")) return `Drink to heal over ${t.duration} s · stacks to ${w.stack}`;
      if (w.id === HORSE_WHISTLE) return "Call your horse outside safe zones (H)";
      return "Radio";
  }
}

function lockOf(offer: { level: number; price: number }, ctx: ShopContext, qty = 1): Lock | null {
  const b = buyBlock(offer, ctx, qty);
  if (!b) return null;
  if (b.reason === "level") return { kind: "level", level: b.level, text: `Level ${b.level}` };
  return { kind: "coins", short: b.short, text: `${b.short} ◎ short` };
}

/** "Tidewrath 1/12" → "Not sold · Tidewrath (1 in 12)". */
export function sourceText(source: string): string {
  return `Not sold · ${source.replace(/\s(\d+)\/(\d+)$/, " (1 in $2)").replace(/^Portus shop$/, "the Portus Exchange")}`;
}

function weaponRow(id: string, ctx: ShopContext, qty: (itemId: string) => number): ShopRow | null {
  const w = WEAPON_BY_ID.get(id);
  if (!w) return null;
  const offers: Offer[] = [];
  for (const tier of [1, 2, 3] as const) {
    const e = shopEntry(id, tier);
    if (!e) continue;
    const q = e.stack > 1 ? qty(id) : 1;
    offers.push({ itemId: id, tier, label: w.cls === "item" ? "" : TIER_LABEL[tier], price: e.price, level: e.level, stack: e.stack, stat: tierStat(w, w.tiers[tier - 1]!), lock: lockOf(e, ctx, q) });
  }
  if (!offers.length) return null;
  return { key: id, itemId: id, name: w.name, sprite: id, rarity: null, meta: itemMeta(w), offers, lock: null, sells: null };
}

function cosmeticRow(c: CosmeticDef, ctx: ShopContext): ShopRow {
  const e = c.price ? shopEntry(c.id, 1) : undefined;
  const offers: Offer[] = e ? [{ itemId: c.id, tier: 1, label: "", price: e.price, level: e.level, stack: 1, stat: "", lock: lockOf(e, ctx) }] : [];
  const r = RARITY_STYLE[c.rarity];
  return { key: c.id, itemId: c.id, name: c.name, sprite: c.id, rarity: c.rarity, meta: `${r.icon} ${r.label} ${c.slot}`, offers, lock: e ? null : { kind: "source", text: sourceText(c.source) }, sells: e ? null : unitSellValue({ id: c.id, tier: 1 }) };
}

/** Every item in the game for this player, grouped as the panel shows them. `qty(itemId)` is the chosen stack size. */
export function shopCatalogue(ctx: ShopContext, qty: (itemId: string) => number = () => 1): ShopGroup[] {
  const shown = (id: string) => !ctx.hidden.has(id) && (id !== HORSE_WHISTLE || ctx.horses);
  const groups: ShopGroup[] = [];
  for (const f of FAMILIES) {
    const rows = f.items.filter(shown).map((id) => weaponRow(id, ctx, qty)).filter((r): r is ShopRow => !!r);
    if (rows.length) groups.push({ id: f.id, title: f.title, rows });
  }
  for (const slot of ["hat", "cape", "mask", "backpack"] as const) {
    const rows = COSMETICS.filter((c) => c.slot === slot && (!c.extra || ctx.extras) && !isEggItem({ id: c.id }) && shown(c.id))
      .map((c) => cosmeticRow(c, ctx))
      // On sale first, then by rarity, then by name.
      .sort((a, b) => Number(b.offers.length > 0) - Number(a.offers.length > 0) || RARITY_ORDER[a.rarity!] - RARITY_ORDER[b.rarity!] || a.name.localeCompare(b.name));
    groups.push({ id: `cos-${slot}`, title: SLOT_TITLE[slot], rows });
  }
  groups.push({
    id: "trophies",
    title: "Trophies · sell only",
    rows: TROPHIES.map((t) => ({ key: t.id, itemId: t.id, name: t.name, sprite: t.id, rarity: null, meta: `Stacks to ${t.stack}`, offers: [], lock: { kind: "source", text: "Not sold · taken from wildlife" }, sells: t.value })),
  });
  const secrets = EGGS.filter((e) => ctx.extras || !e.extra).length;
  groups.push({
    id: "secrets",
    title: "Secrets",
    rows: [{ key: "secrets", itemId: "", name: `${secrets} secret rewards`, sprite: null, rarity: "legendary", meta: "One of a kind, once per life. Find them in the world.", offers: [], lock: { kind: "source", text: "Never sold" }, sells: null }],
  });
  return groups;
}

const RARITY_ORDER: Record<Rarity, number> = { common: 0, uncommon: 1, rare: 2, legendary: 3 };

/** Only weapons and support items come in tiers: no "Woolly Beanie I" or "Small Tonic I" in the Sell list. */
export function tiered(it: { id: string; tier: number; skin?: string }): boolean {
  const w = WEAPON_BY_ID.get(it.id);
  return !it.skin && !!w && w.cls !== "item" && it.tier >= 1 && it.tier <= 3;
}

/** Buyable now vs everything priced: "You can buy 23 of 61 offers here". */
export function offerCounts(groups: readonly ShopGroup[]): { open: number; total: number } {
  let open = 0;
  let total = 0;
  for (const g of groups) for (const r of g.rows) for (const o of r.offers) {
    total++;
    if (!o.lock) open++;
  }
  return { open, total };
}
