// Inventory slot model shared by the server (giveItem, `move`) and the client's inventory panel.
// Slots are numbered 0–19: 0–3 the hotbar (keys 1–4), 4–19 the backpack (DECISIONS: 4 + 16).

import type { InvItem } from "../net/protocol.ts";
import { BACKPACK_SLOTS, HOTBAR_SLOTS } from "./character.ts";
import { itemStack } from "./items.ts";
import { WEAPON_BY_ID } from "./weapons.ts";

export const INV_SLOTS = HOTBAR_SLOTS + BACKPACK_SLOTS;

export interface Bags {
  hotbar: (InvItem | null)[];
  backpack: (InvItem | null)[];
}

export const isHotbarSlot = (slot: number): boolean => slot >= 0 && slot < HOTBAR_SLOTS;

/**
 * Items that belong in the hotbar: weapons, support items and consumables (anything you attack with
 * or use). The radio, cosmetics, trophies and other loot belong in the backpack.
 */
export function prefersHotbar(item: Pick<InvItem, "id">): boolean {
  const def = WEAPON_BY_ID.get(item.id);
  return !!def && def.delivery !== "none";
}

export function slotItem(b: Bags, slot: number): InvItem | null {
  if (slot < 0 || slot >= INV_SLOTS) return null;
  return (slot < HOTBAR_SLOTS ? b.hotbar[slot] : b.backpack[slot - HOTBAR_SLOTS]) ?? null;
}

function setSlot(b: Bags, slot: number, v: InvItem | null) {
  if (slot < HOTBAR_SLOTS) b.hotbar[slot] = v;
  else b.backpack[slot - HOTBAR_SLOTS] = v;
}

/** Same item kind that may share a slot (stackable, same tier, no unique skin). */
function stacksWith(a: InvItem, b: InvItem): boolean {
  return a.id === b.id && a.tier === b.tier && !a.skin && !b.skin && itemStack(a.id) > 1;
}

/**
 * Store a copy of `item` (mutates `b`): onto a matching stack anywhere if the whole amount fits, else
 * into the first empty slot, the hotbar first for hotbar-worthy items and the backpack first for
 * everything else (junk never takes a weapon slot while the backpack has room). Returns the slot
 * (0–19), or -1 when there is no room.
 */
export function storeItem(b: Bags, item: InvItem): number {
  const stack = itemStack(item.id);
  for (let s = 0; s < INV_SLOTS; s++) {
    const cur = slotItem(b, s);
    if (cur && stacksWith(cur, item) && cur.qty + item.qty <= stack) {
      cur.qty += item.qty;
      return s;
    }
  }
  const hotbar = Array.from({ length: HOTBAR_SLOTS }, (_, i) => i);
  const backpack = Array.from({ length: BACKPACK_SLOTS }, (_, i) => HOTBAR_SLOTS + i);
  for (const s of prefersHotbar(item) ? [...hotbar, ...backpack] : [...backpack, ...hotbar]) {
    if (!slotItem(b, s)) {
      setSlot(b, s, { ...item });
      return s;
    }
  }
  return -1;
}

/**
 * Move the item in `from` to `to` (mutates `b`): into an empty slot, onto a matching stack (up to
 * the stack size; the rest stays behind), or swap the two. Returns false when nothing changed.
 */
export function moveSlot(b: Bags, from: number, to: number): boolean {
  if (from === to || from < 0 || to < 0 || from >= INV_SLOTS || to >= INV_SLOTS) return false;
  const x = slotItem(b, from);
  const y = slotItem(b, to);
  if (!x && !y) return false;
  if (x && y && stacksWith(x, y) && y.qty < itemStack(y.id)) {
    const n = Math.min(x.qty, itemStack(y.id) - y.qty);
    y.qty += n;
    x.qty -= n;
    if (x.qty <= 0) setSlot(b, from, null);
    return true;
  }
  setSlot(b, from, y);
  setSlot(b, to, x);
  return true;
}
