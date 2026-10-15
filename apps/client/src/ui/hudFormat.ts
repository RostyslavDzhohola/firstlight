// Pure formatting for the HUD and screens (unit-tested; no DOM).

import { WEAPON_BY_ID, type WeaponDef } from "@firstlight/shared/content/weapons";
import { itemName, itemStack } from "@firstlight/shared/content/items";
import type { InvItem } from "@firstlight/shared/net/protocol";
import { features } from "../config.ts";
import { itemSprite } from "./sprites.ts";

export const TIER_NUMERALS = ["", "I", "II", "III"] as const;

/** Items this build hides: the radio while voice is off (D-controls-1). The server still holds them. */
export const HIDDEN_ITEMS: ReadonlySet<string> = new Set(features.voice ? [] : ["radio"]);

/** The item as the HUD and the inventory show it: a hidden item reads as an empty slot. */
export function shownItem<T extends { id: string }>(item: T | null | undefined, hidden: ReadonlySet<string> = HIDDEN_ITEMS): T | null {
  return item && !hidden.has(item.id) ? item : null;
}

// ------------------------------------------------------------------------------------------------ damage numbers

/** normal: white · weak point: yellow, 1.3×, "!" · armour-reduced: grey, small · shield: white, cyan outline. */
export type DamageKind = "normal" | "weak" | "armour" | "shield" | "heal";

export function formatDamage(amount: number, kind: DamageKind = "normal"): { text: string; cls: string } {
  const n = Math.max(0, Math.round(amount));
  switch (kind) {
    case "weak":
      return { text: `${n}!`, cls: "fl-dmg is-weak" };
    case "armour":
      return { text: String(n), cls: "fl-dmg is-armour" };
    case "shield":
      return { text: String(n), cls: "fl-dmg is-shield" };
    case "heal":
      return { text: `+${n}`, cls: "fl-dmg is-heal" };
    default:
      return { text: String(n), cls: "fl-dmg" };
  }
}

// ------------------------------------------------------------------------------------------------ HP

export const LOW_HP = 0.25;

export function isLowHp(hp: number, max: number): boolean {
  return max > 0 && hp > 0 && hp / max < LOW_HP;
}

// ------------------------------------------------------------------------------------------------ prompt

/** "E — take everything from Wren's pile" → key E + text. Lines without a key pass through. */
export function parsePrompt(text: string, key?: string | null): { key: string | null; text: string } {
  if (key) return { key, text };
  const m = /^(\S{1,8})\s+[—–-]\s+(.+)$/.exec(text.trim());
  return m ? { key: m[1]!, text: m[2]! } : { key: null, text };
}

// ------------------------------------------------------------------------------------------------ hotbar

export interface SlotView {
  sprite: string;
  name: string;
  tier: number;
  /** Bottom-right corner text: magazine, stack count or the level gate. */
  corner: string;
  gated: boolean;
  empty: boolean;
  /** Magazine for the ammo readout (guns only). */
  ammo: { cur: number; max: number } | null;
}

export function slotView(item: InvItem | null | undefined, level: number): SlotView {
  if (!item) return { sprite: "fists", name: "Fists", tier: 0, corner: "", gated: false, empty: true, ammo: null };
  const def: WeaponDef | undefined = WEAPON_BY_ID.get(item.id);
  const tier = def?.tiers[item.tier - 1];
  const gated = !!tier && tier.level > level;
  const ammo = tier?.mag !== undefined ? { cur: item.mag ?? tier.mag, max: tier.mag } : null;
  const stack = itemStack(item.id) > 1;
  // Skins (e.g. the Ferryman's Oar) carry their own name instead of "Riverstaff II".
  const showTier = !!def && def.cls !== "item" && !item.skin;
  return {
    sprite: itemSprite(item.id),
    name: `${itemName(item)}${showTier ? ` ${TIER_NUMERALS[item.tier] ?? ""}` : ""}`.trim(),
    tier: def && def.cls !== "item" ? item.tier : 0,
    corner: gated ? `Lv ${tier!.level}` : stack ? `×${item.qty}` : ammo ? String(ammo.cur) : "",
    gated,
    empty: false,
    ammo,
  };
}

// ------------------------------------------------------------------------------------------------ weapon chips (character pick)

const CLASS_LABEL: Record<WeaponDef["cls"], string> = { melee: "Melee", magic: "Magic", ranged: "Ranged", support: "Support", item: "Item" };

export function weaponChips(def: WeaponDef, tierIndex = 0): string[] {
  const t = def.tiers[tierIndex]!;
  const chips = [CLASS_LABEL[def.cls]];
  if (t.pellets) chips.push(`${t.damage}×${t.pellets} dmg`);
  else if (t.damage > 0) chips.push(`${t.damage} dmg`);
  if (def.arc) chips.push(`Arc ${def.arc}°`);
  else if (def.range > 0) chips.push(`${def.range} m`);
  if (t.block) chips.push(`RMB block ${Math.round(t.block * 100)}%`);
  if (t.mag) chips.push(`${t.mag} rounds`);
  if (t.heat) chips.push(`${t.heat} casts`);
  if (t.pierce) chips.push(`Pierce ${t.pierce}`);
  if (t.knockback && def.cls === "melee") chips.push("Knockback");
  return chips;
}

// ------------------------------------------------------------------------------------------------ time

/** 6 m 05 s · 1 h 42 m */
export function aliveParts(ms: number): { value: string; unit: string }[] {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return [{ value: String(h), unit: "h" }, { value: String(m).padStart(2, "0"), unit: "m" }];
  return [{ value: String(m), unit: "m" }, { value: String(sec).padStart(2, "0"), unit: "s" }];
}

// ------------------------------------------------------------------------------------------------ death

/** Meridian Oversight roster (content.md §3.4 + the boss): the only cold, militaristic killer card. */
const OVERSIGHT = /^(the )?(associate|enforcer|collector|auditor|compliance officer|receiver)\b/i;

export type KillerKind = "player" | "party" | "self" | "oversight" | "creature" | "world";

export interface KillerInfo {
  kind: KillerKind;
  name: string;
}

/** "compliance_officer" → "Compliance Officer". */
export function prettyKind(kind: string): string {
  return kind
    .split(/[_\-\s]+/)
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join(" ");
}

/**
 * Who killed us, from the server's death message: players come as a session id + display name, AI as
 * `killerName: "npc:<kind>"`, the world (falls) with `killer: null`. `isParty` (social lane) marks a
 * party member, which gets the joke card. `npcName` may map an NPC kind to its display name.
 */
export function classifyKiller(
  m: { killer?: string | null; killerName: string },
  self: string | null,
  opts: { isParty?: (id: string) => boolean; npcName?: (kind: string) => string | undefined } = {},
): KillerInfo {
  const raw = m.killerName?.trim() ?? "";
  if (raw.startsWith("npc:")) {
    const kind = raw.slice(4);
    const name = opts.npcName?.(kind) ?? prettyKind(kind);
    return { kind: OVERSIGHT.test(name) || OVERSIGHT.test(prettyKind(kind)) ? "oversight" : "creature", name };
  }
  if (m.killer && self && m.killer === self) return { kind: "self", name: raw };
  if (!m.killer) return { kind: "world", name: raw ? raw[0]!.toUpperCase() + raw.slice(1) : "The world" };
  return { kind: opts.isParty?.(m.killer) ? "party" : "player", name: raw || "Another player" };
}
