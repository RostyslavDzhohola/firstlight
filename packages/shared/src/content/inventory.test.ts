import { describe, expect, it } from "vitest";
import type { InvItem } from "../net/protocol.ts";
import { BACKPACK_SLOTS, HOTBAR_SLOTS } from "./character.ts";
import { INV_SLOTS, moveSlot, prefersHotbar, slotItem, storeItem, type Bags } from "./inventory.ts";

function bags(hotbar: (InvItem | null)[] = [], backpack: (InvItem | null)[] = []): Bags {
  return {
    hotbar: Array.from({ length: HOTBAR_SLOTS }, (_, i) => hotbar[i] ?? null),
    backpack: Array.from({ length: BACKPACK_SLOTS }, (_, i) => backpack[i] ?? null),
  };
}
const it1 = (id: string, qty = 1, tier: 1 | 2 | 3 = 1): InvItem => ({ id, tier, qty });

describe("hotbar-worthy items", () => {
  it("are weapons, support items and consumables; not the radio, cosmetics or loot", () => {
    for (const id of ["sunbrand", "carbine", "hexquill", "grenade", "patchkit", "bubble", "tonic_small", "tonic_large"]) expect(prefersHotbar({ id }), id).toBe(true);
    for (const id of ["radio", "wool_tuft", "wolf_pelt", "fox_mask", "golden_hopbit", "mystery"]) expect(prefersHotbar({ id }), id).toBe(false);
  });
});

describe("storeItem (where picked-up and bought items land)", () => {
  it("puts weapons in the first empty hotbar slot", () => {
    const b = bags([it1("hexquill")]);
    expect(storeItem(b, it1("carbine"))).toBe(1);
    expect(b.hotbar[1]?.id).toBe("carbine");
  });

  it("puts loot and cosmetics in the backpack, even with hotbar slots free (review B2)", () => {
    const b = bags([it1("hexquill")]);
    expect(storeItem(b, it1("wool_tuft", 3))).toBe(HOTBAR_SLOTS);
    expect(storeItem(b, it1("fox_mask"))).toBe(HOTBAR_SLOTS + 1);
    expect(storeItem(b, it1("radio"))).toBe(HOTBAR_SLOTS + 2);
    expect(b.hotbar.slice(1)).toEqual([null, null, null]);
  });

  it("stacks onto a matching stack anywhere, loot included", () => {
    const b = bags([null, it1("tonic_small", 4)], [it1("wool_tuft", 5)]);
    expect(storeItem(b, it1("tonic_small", 3))).toBe(1);
    expect(b.hotbar[1]?.qty).toBe(7);
    expect(storeItem(b, it1("wool_tuft", 2))).toBe(HOTBAR_SLOTS);
    expect(b.backpack[0]?.qty).toBe(7);
  });

  it("doesn't stack different tiers, skins or overfull stacks", () => {
    const b = bags([it1("grenade", 4, 1)]);
    expect(storeItem(b, it1("grenade", 1, 2))).toBe(1);
    expect(storeItem(b, it1("grenade", 2, 1))).toBe(2); // 4 + 2 > 5
    expect(b.hotbar[0]?.qty).toBe(4);
  });

  it("falls back to the other area when the preferred one is full, and fails when both are", () => {
    const full = Array.from({ length: BACKPACK_SLOTS }, () => it1("wolf_pelt", 10));
    const b = bags([it1("hexquill")], full);
    expect(storeItem(b, it1("wolf_pelt"))).toBe(1); // backpack full: the hotbar beats the ground
    const w = bags([it1("a"), it1("b"), it1("c"), it1("d")]);
    expect(storeItem(w, it1("carbine"))).toBe(HOTBAR_SLOTS);
    const none = bags([it1("a"), it1("b"), it1("c"), it1("d")], full);
    expect(storeItem(none, it1("carbine"))).toBe(-1);
  });

  it("copies the item (callers keep their own object)", () => {
    const b = bags();
    const x = it1("carbine");
    storeItem(b, x);
    expect(b.hotbar[0]).toEqual(x);
    expect(b.hotbar[0]).not.toBe(x);
  });
});

describe("moveSlot (the `move` message)", () => {
  it("moves into an empty slot and swaps occupied ones, across hotbar and backpack", () => {
    const b = bags([it1("hexquill"), it1("carbine")], [it1("wool_tuft", 3)]);
    expect(moveSlot(b, 0, 7)).toBe(true);
    expect(b.hotbar[0]).toBeNull();
    expect(slotItem(b, 7)?.id).toBe("hexquill");
    expect(moveSlot(b, 1, HOTBAR_SLOTS)).toBe(true);
    expect(b.hotbar[1]?.id).toBe("wool_tuft");
    expect(b.backpack[0]?.id).toBe("carbine");
  });

  it("merges matching stacks up to the stack size and leaves the rest", () => {
    const b = bags([it1("tonic_small", 7)], [it1("tonic_small", 6)]);
    expect(moveSlot(b, HOTBAR_SLOTS, 0)).toBe(true);
    expect(b.hotbar[0]?.qty).toBe(10);
    expect(b.backpack[0]?.qty).toBe(3);
    const c = bags([it1("grenade", 2)], [it1("grenade", 3)]);
    moveSlot(c, HOTBAR_SLOTS, 0);
    expect(c.hotbar[0]?.qty).toBe(5);
    expect(c.backpack[0]).toBeNull();
  });

  it("swaps full stacks and different tiers instead of merging", () => {
    const b = bags([it1("grenade", 5, 1)], [it1("grenade", 2, 1), it1("grenade", 1, 3)]);
    moveSlot(b, HOTBAR_SLOTS, 0);
    expect(b.hotbar[0]?.qty).toBe(2);
    expect(b.backpack[0]?.qty).toBe(5);
    moveSlot(b, HOTBAR_SLOTS + 1, 0);
    expect(b.hotbar[0]?.tier).toBe(3);
  });

  it("ignores no-ops and out-of-range slots", () => {
    const b = bags([it1("hexquill")]);
    expect(moveSlot(b, 0, 0)).toBe(false);
    expect(moveSlot(b, 1, 2)).toBe(false); // both empty
    expect(moveSlot(b, 0, INV_SLOTS)).toBe(false);
    expect(moveSlot(b, -1, 2)).toBe(false);
    expect(b.hotbar[0]?.id).toBe("hexquill");
  });
});
