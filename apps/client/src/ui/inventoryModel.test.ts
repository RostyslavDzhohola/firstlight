import { describe, expect, it } from "vitest";
import type { InvItem } from "@firstlight/shared/net/protocol";
import { DROP_CONFIRM_MS, InvCursor, invSlots, itemActions, itemDetails, quickAction, type InvState } from "./inventoryModel.ts";

const it1 = (id: string, qty = 1, tier: 1 | 2 | 3 = 1, extra: Partial<InvItem> = {}): InvItem => ({ id, tier, qty, ...extra });

function state(over: Partial<InvState> = {}): InvState {
  return {
    hotbar: [it1("carbine", 1, 2, { mag: 21 }), it1("stormcoil", 1, 3), null, it1("tonic_small", 4)],
    backpack: [it1("patchkit", 2), it1("wool_tuft", 7), it1("fox_mask"), it1("sunbrand"), it1("radio"), ...Array(11).fill(null)],
    selected: 0,
    level: 7,
    worn: {},
    ...over,
  };
}

describe("slot views", () => {
  it("lists 20 slots: hotbar with keys 1–4 and the active one, then the backpack", () => {
    const s = invSlots(state());
    expect(s).toHaveLength(20);
    expect(s.slice(0, 4).map((x) => x.key)).toEqual(["1", "2", "3", "4"]);
    expect(s[4]!.key).toBeNull();
    expect(s[0]!.active).toBe(true);
    expect(s[1]!.active).toBe(false);
    expect(s[2]!.empty).toBe(true);
    expect(s[1]!.gated).toBe(true); // Stormcoil III needs level 12
    expect(s[1]!.corner).toBe("Lv 12");
    expect(s[5]!.corner).toBe("×7");
    expect(s[6]!.rarity).toBe("common");
    expect(s[6]!.tier).toBe(0);
  });
});

describe("item details (tooltip)", () => {
  it("names the tier, class and level gate, with stat bars and the sell price", () => {
    const d = itemDetails(it1("stormcoil", 1, 3), state());
    expect(d.name).toBe("Stormcoil III");
    expect(d.tierBadge).toBe("◆◆◆ III");
    expect(d.meta).toContain("Magic");
    expect(d.gate).toBe("Needs level 12 to use. You're level 7.");
    const dmg = d.stats.find((x) => x.label === "Damage")!;
    expect(dmg.value).toBe("35");
    expect(dmg.fill).toBeGreaterThan(0);
    expect(dmg.fill).toBeLessThanOrEqual(1);
    expect(d.sell).toBe(225);
  });

  it("compares damage with the weapon in hand", () => {
    const d = itemDetails(it1("sunbrand", 1, 2), state()); // 24 vs the Carbine II's 12
    expect(d.stats.find((x) => x.label === "Damage")!.delta).toBe(12);
    expect(itemDetails(it1("carbine", 1, 2), state()).stats.find((x) => x.label === "Damage")!.delta).toBeUndefined();
  });

  it("describes consumables, loot, cosmetics and the radio in words", () => {
    expect(itemDetails(it1("tonic_small", 4), state()).stats.map((x) => x.label)).toContain("Heals");
    const tuft = itemDetails(it1("wool_tuft", 7), state());
    expect(tuft.meta).toContain("Loot");
    expect(tuft.sell).toBe(14);
    const mask = itemDetails(it1("fox_mask"), state({ worn: { mask: "fox_mask" } }));
    expect(mask.rarity).toBe("common");
    expect(mask.meta).toContain("Mask");
    expect(mask.note).toMatch(/Wearing it/);
    expect(itemDetails(it1("radio"), state()).note).toMatch(/hold B/i);
    expect(itemDetails(it1("mystery_box"), state()).sell).toBe(0);
  });
});

describe("quick action (right-click / E)", () => {
  it("uses consumables wherever they are", () => {
    expect(quickAction(state(), 4)).toMatchObject({ kind: "use", actions: [{ type: "use", slot: 4 }] });
    expect(quickAction(state(), 3)).toMatchObject({ kind: "use", actions: [{ type: "use", slot: 3 }] });
  });

  it("equips a backpack weapon into the first empty hotbar slot and takes it in hand", () => {
    expect(quickAction(state(), 7)).toMatchObject({ kind: "equip", actions: [{ type: "move", from: 7, to: 2 }, { type: "equip", slot: 2 }] });
    const full = state({ hotbar: [it1("carbine"), it1("axe"), it1("longbow"), it1("hammer")], selected: 1 });
    expect(quickAction(full, 7)).toMatchObject({ actions: [{ type: "move", from: 7, to: 1 }, { type: "equip", slot: 1 }] });
  });

  it("puts a hotbar weapon away in the backpack", () => {
    expect(quickAction(state(), 1)).toMatchObject({ kind: "unequip", actions: [{ type: "move", from: 1, to: 9 }] });
  });

  it("support items and tonics can also be equipped or put away (Use doesn't hide Equip)", () => {
    const s = state({ backpack: [it1("bubble"), it1("patchkit", 2), ...Array(14).fill(null)] });
    expect(itemActions(s, 4).map((a) => a.kind)).toEqual(["use", "equip"]);
    expect(itemActions(s, 4)[1]).toMatchObject({ label: "Equip", actions: [{ type: "move", from: 4, to: 2 }, { type: "equip", slot: 2 }] });
    expect(itemActions(s, 5).map((a) => a.kind)).toEqual(["use", "equip"]);
    expect(itemActions(state(), 3).map((a) => a.kind)).toEqual(["use", "unequip"]); // tonic in the hotbar
    expect(itemActions(state(), 7).map((a) => a.kind)).toEqual(["equip"]);
    expect(itemActions(state(), 5)).toEqual([]);
  });

  it("the Patchkit's card says how it works: channel, heal share, ally vs self, cooldown (F12 final Opus nit)", () => {
    const s = state({ backpack: [it1("patchkit", 2), ...Array(15).fill(null)] });
    const note = itemDetails({ id: "patchkit", tier: 2, qty: 2 }, s).note!;
    expect(note).toContain("Channel 0.9 s");
    expect(note).toContain("40% of their max HP over 2 s");
    expect(note).toContain("Left mouse: the ally in your crosshair (4 m)");
    expect(note).toContain("Right mouse, or E here: yourself");
    expect(note).toContain("6 s between kits");
  });

  it("use from the backpack sends the inventory slot index (4–19) and no target (self)", () => {
    const s = state({ backpack: [null, null, null, null, null, it1("bubble"), ...Array(10).fill(null)] });
    expect(quickAction(s, 9)!.actions).toEqual([{ type: "use", slot: 9 }]);
  });

  it("wears and takes off cosmetics; loot and the radio have none", () => {
    expect(quickAction(state(), 6)).toMatchObject({ kind: "wear", actions: [{ type: "wear", slot: 6 }] });
    expect(quickAction(state({ worn: { mask: "fox_mask" } }), 6)).toMatchObject({ kind: "takeoff", actions: [{ type: "takeoff", cosmeticSlot: "mask" }] });
    expect(quickAction(state(), 5)).toBeNull();
    expect(quickAction(state(), 8)).toBeNull();
    expect(quickAction(state(), 12)).toBeNull();
  });
});

describe("cursor: click to pick, click to place", () => {
  it("picks a filled slot, places on another (move), and un-picks on the same slot", () => {
    const s = state();
    const c = new InvCursor(() => s);
    expect(c.click(5)).toEqual([]);
    expect(c.held).toBe(5);
    expect(c.click(5)).toEqual([]);
    expect(c.held).toBeNull();
    c.click(5);
    expect(c.click(2)).toEqual([{ type: "move", from: 5, to: 2 }]);
    expect(c.held).toBeNull();
  });

  it("ignores clicks on empty slots with nothing held, and drops a held item on the drop zone", () => {
    const c = new InvCursor(() => state());
    expect(c.click(12)).toEqual([]);
    expect(c.held).toBeNull();
    c.click(0);
    expect(c.dropHeld()).toEqual([{ type: "drop", slot: 0 }]);
    expect(c.held).toBeNull();
  });

  it("drag and drop: onto a slot moves, onto the drop zone drops, elsewhere cancels", () => {
    const c = new InvCursor(() => state());
    expect(c.dragDrop(0, 9)).toEqual([{ type: "move", from: 0, to: 9 }]);
    expect(c.dragDrop(0, "drop")).toEqual([{ type: "drop", slot: 0 }]);
    expect(c.dragDrop(0, null)).toEqual([]);
    expect(c.dragDrop(0, 0)).toEqual([]);
    expect(c.dragDrop(2, 9)).toEqual([]); // empty source
  });

  it("forgets a held slot once the server empties it", () => {
    let s = state();
    const c = new InvCursor(() => s);
    c.click(4);
    s = state({ backpack: Array(16).fill(null) });
    c.sync();
    expect(c.held).toBeNull();
  });
});

describe("cursor: keyboard", () => {
  it("arrows walk the 4-wide grid (hotbar row on top) and stop at the edges", () => {
    const c = new InvCursor(() => state());
    expect(c.focus).toBe(0);
    c.key("ArrowLeft");
    expect(c.focus).toBe(0);
    c.key("ArrowRight");
    c.key("ArrowDown");
    expect(c.focus).toBe(5);
    c.key("ArrowRight");
    c.key("ArrowRight");
    c.key("ArrowRight");
    expect(c.focus).toBe(7);
    for (let i = 0; i < 6; i++) c.key("ArrowDown");
    expect(c.focus).toBe(19);
    c.key("ArrowUp");
    expect(c.focus).toBe(15);
  });

  it("Enter picks and places; 1–4 send the focused item to that hotbar slot; E uses; X drops", () => {
    const c = new InvCursor(() => state());
    c.focus = 5;
    expect(c.key("Enter")).toMatchObject({ handled: true, actions: [] });
    c.focus = 2;
    expect(c.key("Space").actions).toEqual([{ type: "move", from: 5, to: 2 }]);
    c.focus = 7;
    expect(c.key("Digit3").actions).toEqual([{ type: "move", from: 7, to: 2 }]);
    c.focus = 4;
    expect(c.key("KeyE").actions).toEqual([{ type: "use", slot: 4 }]);
    expect(c.key("KeyX").actions).toEqual([]); // pointing only: X arms the drop…
    expect(c.key("KeyX").actions).toEqual([{ type: "drop", slot: 4 }]); // …a second X drops
    c.focus = 12;
    expect(c.key("KeyX")).toMatchObject({ handled: true, actions: [] }); // empty
  });

  it("X on a slot that is only pointed at needs a second X within 1.5 s; a picked item drops at once (F12 final Sonnet N9)", () => {
    let now = 10_000;
    const c = new InvCursor(() => state(), () => now);
    c.focus = 5;
    const first = c.key("KeyX");
    expect(first).toMatchObject({ handled: true, actions: [] });
    expect(first.hint).toBe("Press X again to drop it");
    expect(c.dropArmed(5)).toBe(true);
    expect(c.dropArmed(6)).toBe(false);
    // Too late: the second press arms again instead of dropping.
    now += DROP_CONFIRM_MS + 1;
    expect(c.dropArmed(5)).toBe(false);
    expect(c.key("Delete").actions).toEqual([]);
    now += 500;
    expect(c.key("Delete").actions).toEqual([{ type: "drop", slot: 5 }]);
    expect(c.dropArmed(5)).toBe(false);
    // Armed on one slot, then the pointer moves on: X there arms that slot, it doesn't drop the first.
    c.focus = 4;
    c.key("KeyX");
    c.focus = 7;
    expect(c.key("KeyX").actions).toEqual([]);
    expect(c.key("KeyX").actions).toEqual([{ type: "drop", slot: 7 }]);
    // Picked (clicked) first: one X drops it.
    c.click(5);
    expect(c.key("KeyX").actions).toEqual([{ type: "drop", slot: 5 }]);
  });

  it("number keys and X act on the held item when there is one; Esc cancels the hold first", () => {
    const c = new InvCursor(() => state());
    c.click(7);
    c.focus = 16;
    expect(c.key("Digit1").actions).toEqual([{ type: "move", from: 7, to: 0 }]);
    c.click(5);
    expect(c.key("Escape")).toMatchObject({ handled: true, actions: [] });
    expect(c.held).toBeNull();
    expect(c.key("Escape").handled).toBe(false); // nothing held: the panel closes
    expect(c.key("KeyQ").handled).toBe(false);
  });
});
