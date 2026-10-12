// Pure logic behind the inventory panel (ui/inventory.ts; unit-tested, no DOM): the 20 slot views,
// the item tooltip, the quick action per item (right-click / E), and the cursor that turns clicks,
// drags and keys into the server's inventory messages (move, drop, use, wear, equip).
// Slots: 0–3 hotbar (keys 1–4), 4–19 backpack, laid out 4 wide (row 0 is the hotbar).

import { BACKPACK_SLOTS, HOTBAR_SLOTS } from "@firstlight/shared/content/character";
import { INV_SLOTS, isHotbarSlot, prefersHotbar, slotItem } from "@firstlight/shared/content/inventory";
import { COSMETIC_BY_ID, SKIN_BY_ID, TROPHY_BY_ID, itemName, itemStack, sellValue, type CosmeticSlot, type Rarity } from "@firstlight/shared/content/items";
import { WEAPONS, WEAPON_BY_ID, type TierStats, type WeaponDef } from "@firstlight/shared/content/weapons";
import type { InvItem } from "@firstlight/shared/net/protocol";
import { slotView, TIER_NUMERALS, type SlotView } from "./hudFormat.ts";

export const GRID_COLS = 4;

/** What the panel needs from the `you` message. */
export interface InvState {
  hotbar: (InvItem | null)[];
  backpack: (InvItem | null)[];
  /** Hotbar slot in hand. */
  selected: number;
  level: number;
  worn?: Partial<Record<CosmeticSlot, string>>;
}

export type InvAction =
  | { type: "move"; from: number; to: number }
  | { type: "drop"; slot: number }
  | { type: "use"; slot: number }
  | { type: "wear"; slot: number }
  | { type: "takeoff"; cosmeticSlot: CosmeticSlot }
  | { type: "equip"; slot: number };

const itemAt = (s: InvState, slot: number) => slotItem(s, slot);

// ------------------------------------------------------------------------------------------------ slots

export interface InvSlot extends SlotView {
  slot: number;
  /** "1"–"4" on the hotbar. */
  key: string | null;
  /** The hotbar slot in hand. */
  active: boolean;
  rarity: Rarity | null;
  qty: number;
}

function rarityOf(item: InvItem): Rarity | null {
  if (item.skin) return SKIN_BY_ID.get(item.skin)?.rarity ?? null;
  return COSMETIC_BY_ID.get(item.id)?.rarity ?? null;
}

export function invSlots(s: InvState): InvSlot[] {
  const out: InvSlot[] = [];
  for (let slot = 0; slot < INV_SLOTS; slot++) {
    const item = itemAt(s, slot);
    const v = slotView(item, s.level);
    const rarity = item ? rarityOf(item) : null;
    out.push({
      ...v,
      // A skin shows its rarity, not tier pips (both sit bottom-left).
      tier: rarity ? 0 : v.tier,
      slot,
      key: isHotbarSlot(slot) ? String(slot + 1) : null,
      active: slot === s.selected,
      rarity,
      qty: item?.qty ?? 0,
    });
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ tooltip

export interface StatRow {
  label: string;
  value: string;
  /** 0–1 against the best of that stat in the whole catalogue. */
  fill: number;
  /** Damage compared with the weapon in hand (omitted when equal or not comparable). */
  delta?: number;
}

export interface ItemDetails {
  name: string;
  sprite: string;
  /** "◆◆◇ II" for weapons with tiers. */
  tierBadge: string | null;
  meta: string[];
  rarity: Rarity | null;
  gate: string | null;
  stats: StatRow[];
  note: string | null;
  /** Whole-stack sell price at the Portus Exchange (0 = Juno won't buy it). */
  sell: number;
}

const CLASS_LABEL: Record<WeaponDef["cls"], string> = { melee: "Melee", magic: "Magic", ranged: "Ranged", support: "Support", item: "Item" };
const SLOT_LABEL: Record<CosmeticSlot, string> = { hat: "Hat", cape: "Cape", mask: "Mask", backpack: "Backpack" };

interface RawStat {
  label: string;
  n: number;
  value: string;
}

/** Numeric stats of one weapon tier, in display order. */
function rawStats(def: WeaponDef, t: TierStats): RawStat[] {
  const out: RawStat[] = [];
  const s = (label: string, n: number | undefined, value: (n: number) => string) => {
    if (n !== undefined && n > 0) out.push({ label, n, value: value(n) });
  };
  if (def.delivery === "heal" && def.cls === "item") {
    s("Heals", t.heal, (n) => `${n} HP${t.duration ? ` over ${t.duration} s` : ""}`);
    return out;
  }
  if (def.delivery === "heal") {
    s("Heals", t.heal, (n) => `${Math.round(n * 100)}% HP`);
    s("Cooldown", t.cooldown, (n) => `${n} s`);
    return out;
  }
  if (def.delivery === "bubble") {
    s("Shield", t.shell, (n) => `${n} / 100 HP`);
    s("Lasts", t.duration, (n) => `${n} s`);
    s("Cooldown", t.cooldown, (n) => `${n} s`);
    return out;
  }
  if (def.delivery === "none") return out;
  s("Damage", t.damage * (t.pellets ?? 1), () => (t.pellets ? `${t.damage}×${t.pellets}` : String(t.damage)));
  s("Heavy", t.heavy, (n) => String(n));
  s("Attacks / s", t.rate > 0 ? 1 / t.rate : undefined, (n) => n.toFixed(1));
  s("Range", def.delivery === "thrown" ? undefined : (def.falloffTo ?? def.range), (n) => `${n} m`);
  s("Radius", def.delivery === "thrown" ? t.radius : undefined, (n) => `${n} m`);
  s("Magazine", t.mag, (n) => String(n));
  s("Casts before heat", t.heat, (n) => String(n));
  s("Block", t.block, (n) => `${Math.round(n * 100)}%`);
  return out;
}

let maxima: Map<string, number> | null = null;
function maxOf(label: string): number {
  if (!maxima) {
    maxima = new Map();
    for (const d of WEAPONS) for (const t of d.tiers) for (const r of rawStats(d, t)) maxima.set(r.label, Math.max(maxima.get(r.label) ?? 0, r.n));
  }
  return maxima.get(label) ?? 1;
}

function weaponTier(item: Pick<InvItem, "id" | "tier">): { def: WeaponDef; t: TierStats } | null {
  const def = WEAPON_BY_ID.get(item.id);
  if (!def) return null;
  return { def, t: def.tiers[Math.max(0, Math.min(2, item.tier - 1))]! };
}

/** Total damage per attack of the weapon in hand (fists when the slot is empty). */
function handDamage(s: InvState): { id: string; tier: number; dmg: number } | null {
  const hand = s.hotbar[s.selected] ?? { id: "fists", tier: 1 as const, qty: 1 };
  const w = weaponTier(hand);
  if (!w || w.t.damage <= 0) return null;
  return { id: hand.id, tier: hand.tier, dmg: w.t.damage * (w.t.pellets ?? 1) };
}

function weaponNote(def: WeaponDef, t: TierStats): string | null {
  switch (def.delivery) {
    case "thrown":
      return `Left mouse throws one. It goes off after ${def.fuse ?? 1.6} s.`;
    case "heal":
      return def.cls === "item" ? "Left mouse with it in hand, or E here. 8 s between tonics." : "Heals you over 2 s. Left mouse with it in hand, or E here.";
    case "bubble":
      return "A shield of light around you and anyone close.";
    case "none":
      return null;
  }
  const bits: string[] = [];
  if (t.jumps) bits.push(`Arcs on to ${t.jumps} more targets.`);
  if (t.burn) bits.push(`Sets targets alight (${t.burn} a second for 3 s).`);
  if (t.pierce) bits.push(`Goes through ${t.pierce} target${t.pierce > 1 ? "s" : ""}.`);
  if (t.splash) bits.push(`Splash ${t.splash} within ${t.radius} m.`);
  if (t.heavy) bits.push("Hold right mouse for a heavy swing.");
  else if (t.block) bits.push("Right mouse blocks from the front.");
  if (def.destroys !== "none") bits.push(def.destroys === "heavy" ? "Breaks heavy props too." : "Breaks light props.");
  return bits.join(" ") || null;
}

export function itemDetails(item: InvItem, s: InvState): ItemDetails {
  const view = slotView(item, s.level);
  const rarity = rarityOf(item);
  const stack = itemStack(item.id);
  const qty = stack > 1 ? [`${item.qty} of ${stack}`] : [];
  const base = { name: view.name, sprite: view.sprite, rarity, sell: sellValue(item) };
  const w = weaponTier(item);
  if (w) {
    const { def, t } = w;
    const tiered = def.cls !== "item" && !item.skin;
    const hand = handDamage(s);
    const sameAsHand = !!hand && hand.id === item.id && hand.tier === item.tier;
    const stats: StatRow[] = rawStats(def, t).map((r) => {
      const row: StatRow = { label: r.label, value: r.value, fill: Math.max(0, Math.min(1, r.n / maxOf(r.label))) };
      if (r.label === "Damage" && hand && !sameAsHand && r.n !== hand.dmg) row.delta = Math.round(r.n - hand.dmg);
      return row;
    });
    const skin = item.skin ? SKIN_BY_ID.get(item.skin) : undefined;
    return {
      ...base,
      tierBadge: tiered ? `${"◆".repeat(item.tier)}${"◇".repeat(3 - item.tier)} ${TIER_NUMERALS[item.tier]}` : null,
      meta: [skin ? `${def.name} ${TIER_NUMERALS[item.tier]}` : CLASS_LABEL[def.cls], ...qty],
      gate: t.level > s.level ? `Needs level ${t.level} to use. You're level ${s.level}.` : null,
      stats,
      note:
        def.id === "radio"
          ? "Hold B to talk on your channel anywhere on a planet. Pick a channel in Esc → Voice & radio."
          : skin
            ? `A ${def.name} ${TIER_NUMERALS[item.tier]} with a look of its own. ${weaponNote(def, t) ?? ""}`.trim()
            : weaponNote(def, t),
    };
  }
  const cos = COSMETIC_BY_ID.get(item.id);
  if (cos) {
    const worn = s.worn?.[cos.slot] === cos.id;
    return { ...base, tierBadge: null, meta: ["Cosmetic", SLOT_LABEL[cos.slot]], gate: null, stats: [], note: `${cos.source[0]!.toUpperCase()}${cos.source.slice(1)}. ${worn ? "Wearing it: E takes it off." : "E to wear it."}` };
  }
  if (TROPHY_BY_ID.has(item.id)) {
    return { ...base, tierBadge: null, meta: ["Loot", ...qty], gate: null, stats: [], note: "Sell it to Juno Vale at the Portus Exchange, or drop it for someone else." };
  }
  return { ...base, tierBadge: null, meta: ["Item", ...qty], gate: null, stats: [], note: null };
}

// ------------------------------------------------------------------------------------------------ quick action

export interface QuickAction {
  kind: "use" | "equip" | "unequip" | "wear" | "takeoff";
  label: string;
  actions: InvAction[];
}

function firstEmpty(s: InvState, from: number, to: number): number {
  for (let i = from; i < to; i++) if (!itemAt(s, i)) return i;
  return -1;
}

/** Move between hotbar and backpack: equip a backpack item (and take it in hand) or put a hotbar item away. */
function placeAction(s: InvState, slot: number): QuickAction | null {
  if (isHotbarSlot(slot)) {
    const to = firstEmpty(s, HOTBAR_SLOTS, HOTBAR_SLOTS + BACKPACK_SLOTS);
    return to < 0 ? null : { kind: "unequip", label: "Put away", actions: [{ type: "move", from: slot, to }] };
  }
  const empty = firstEmpty(s, 0, HOTBAR_SLOTS);
  const to = empty >= 0 ? empty : s.selected;
  return { kind: "equip", label: "Equip", actions: [{ type: "move", from: slot, to }, { type: "equip", slot: to }] };
}

/**
 * Everything you can do with a slot, the one-press action (right-click / E) first: use a tonic,
 * Patchkit or Prism Bubble (`use` with the slot index, 4–19 in the backpack, no target = yourself),
 * then equip it or put it away; equip/put away a weapon; wear or take off a cosmetic. Loot and the
 * radio have none.
 */
export function itemActions(s: InvState, slot: number): QuickAction[] {
  const item = itemAt(s, slot);
  if (!item) return [];
  const cos = COSMETIC_BY_ID.get(item.id);
  if (cos) {
    if (s.worn?.[cos.slot] === cos.id) return [{ kind: "takeoff", label: "Take off", actions: [{ type: "takeoff", cosmeticSlot: cos.slot }] }];
    return [{ kind: "wear", label: "Wear", actions: [{ type: "wear", slot }] }];
  }
  if (!prefersHotbar(item)) return [];
  const out: QuickAction[] = [];
  const def = WEAPON_BY_ID.get(item.id);
  if (def && (def.delivery === "heal" || def.delivery === "bubble")) out.push({ kind: "use", label: def.cls === "item" ? "Drink" : "Use", actions: [{ type: "use", slot }] });
  const place = placeAction(s, slot);
  if (place) out.push(place);
  return out;
}

/** The one-press action for a slot (right-click / E). */
export function quickAction(s: InvState, slot: number): QuickAction | null {
  return itemActions(s, slot)[0] ?? null;
}

// ------------------------------------------------------------------------------------------------ cursor

export interface KeyResult {
  /** The panel consumed the key (stop it reaching the game). */
  handled: boolean;
  actions: InvAction[];
  /** A line to show the player now (X pressed once on a slot that is only pointed at). */
  hint?: string;
}

const NOT_MINE: KeyResult = { handled: false, actions: [] };
const done = (actions: InvAction[] = []): KeyResult => ({ handled: true, actions });

/** X (or Delete) on a slot that is only pointed at must be pressed again within this to drop it (F12 final Sonnet N9). */
export const DROP_CONFIRM_MS = 1500;
export const DROP_CONFIRM_HINT = "Press X again to drop it";

/**
 * Focus (hover / keyboard) and the held slot (click-to-pick). Methods return the messages to send;
 * the panel re-renders from the next `you`.
 */
export class InvCursor {
  focus = 0;
  held: number | null = null;
  private readonly state: () => InvState;
  private readonly now: () => number;
  /** A first X on a pointed-at slot: the slot and when (a second X there within DROP_CONFIRM_MS drops). */
  private armed: { slot: number; at: number } | null = null;

  constructor(state: () => InvState, now: () => number = () => Date.now()) {
    this.state = state;
    this.now = now;
  }

  /** Is a drop of `slot` waiting for its second X? (The panel shows DROP_CONFIRM_HINT.) */
  dropArmed(slot: number): boolean {
    return !!this.armed && this.armed.slot === slot && this.now() - this.armed.at <= DROP_CONFIRM_MS && this.has(slot);
  }

  private has(slot: number): boolean {
    return !!itemAt(this.state(), slot);
  }

  hover(slot: number): boolean {
    if (slot === this.focus) return false;
    this.focus = slot;
    return true;
  }

  /** Click (or Enter): pick a filled slot, place the held item on another, or un-pick. */
  click(slot: number): InvAction[] {
    this.focus = slot;
    if (this.held === null) {
      if (this.has(slot)) this.held = slot;
      return [];
    }
    const from = this.held;
    this.held = null;
    return from === slot ? [] : [{ type: "move", from, to: slot }];
  }

  dropHeld(): InvAction[] {
    const from = this.held;
    this.held = null;
    return from !== null && this.has(from) ? [{ type: "drop", slot: from }] : [];
  }

  /** A finished drag from `from` onto a slot, the drop zone, or nowhere. */
  dragDrop(from: number, to: number | "drop" | null): InvAction[] {
    this.held = null;
    if (!this.has(from) || to === null || to === from) return [];
    if (to === "drop") return [{ type: "drop", slot: from }];
    this.focus = to;
    return [{ type: "move", from, to }];
  }

  cancel() {
    this.held = null;
  }

  /** After a new `you`: forget a held slot that is empty now. */
  sync() {
    if (this.held !== null && !this.has(this.held)) this.held = null;
    this.focus = Math.max(0, Math.min(INV_SLOTS - 1, this.focus));
  }

  key(code: string): KeyResult {
    const src = this.held ?? this.focus;
    switch (code) {
      case "ArrowLeft":
        if (this.focus % GRID_COLS > 0) this.focus--;
        return done();
      case "ArrowRight":
        if (this.focus % GRID_COLS < GRID_COLS - 1) this.focus++;
        return done();
      case "ArrowUp":
        if (this.focus >= GRID_COLS) this.focus -= GRID_COLS;
        return done();
      case "ArrowDown":
        if (this.focus + GRID_COLS < INV_SLOTS) this.focus += GRID_COLS;
        return done();
      case "Enter":
      case "NumpadEnter":
      case "Space":
        return done(this.click(this.focus));
      case "Digit1":
      case "Digit2":
      case "Digit3":
      case "Digit4": {
        const to = Number(code.slice(5)) - 1;
        this.held = null;
        return done(this.has(src) && src !== to ? [{ type: "move", from: src, to }] : []);
      }
      case "KeyE":
        this.held = null;
        return done(quickAction(this.state(), src)?.actions ?? []);
      case "KeyX":
      case "Delete":
      case "Backspace": {
        // A picked item drops at once; one that is only pointed at (an idle cursor) needs a second
        // press, so a stray X can't throw an item on the ground.
        const picked = this.held !== null;
        this.held = null;
        if (!this.has(src)) return done();
        if (picked || this.dropArmed(src)) {
          this.armed = null;
          return done([{ type: "drop", slot: src }]);
        }
        this.armed = { slot: src, at: this.now() };
        return { handled: true, actions: [], hint: DROP_CONFIRM_HINT };
      }
      case "Escape":
        if (this.held === null) return NOT_MINE;
        this.held = null;
        return done();
      default:
        return NOT_MINE;
    }
  }
}
