import { describe, expect, it } from "vitest";
import { WEAPON_BY_ID } from "@firstlight/shared/content/weapons";
import { aliveParts, classifyKiller, formatDamage, isLowHp, parsePrompt, prettyKind, slotView, weaponChips } from "./hudFormat.ts";

describe("damage numbers", () => {
  it("formats each kind with text and shape cues, not colour alone", () => {
    expect(formatDamage(31)).toEqual({ text: "31", cls: "fl-dmg" });
    expect(formatDamage(47.4, "weak")).toEqual({ text: "47!", cls: "fl-dmg is-weak" });
    expect(formatDamage(6, "armour")).toEqual({ text: "6", cls: "fl-dmg is-armour" });
    expect(formatDamage(12, "shield")).toEqual({ text: "12", cls: "fl-dmg is-shield" });
    expect(formatDamage(30, "heal").text).toBe("+30");
    expect(formatDamage(-3).text).toBe("0");
  });
});

describe("hp", () => {
  it("is low under 25%, not at 0 (dead) or full", () => {
    expect(isLowHp(38, 160)).toBe(true);
    expect(isLowHp(40, 160)).toBe(false);
    expect(isLowHp(0, 160)).toBe(false);
    expect(isLowHp(5, 0)).toBe(false);
  });
});

describe("prompt", () => {
  it("splits a leading key", () => {
    expect(parsePrompt("E — take everything from Wren's pile")).toEqual({ key: "E", text: "take everything from Wren's pile" });
    expect(parsePrompt("Hold still")).toEqual({ key: null, text: "Hold still" });
    expect(parsePrompt("talk to Juno", "E")).toEqual({ key: "E", text: "talk to Juno" });
  });
});

describe("hotbar slots", () => {
  it("shows fists for an empty slot", () => {
    expect(slotView(null, 1)).toMatchObject({ sprite: "fists", empty: true, gated: false });
  });
  it("shows magazine, tier numeral and the level gate", () => {
    const gun = slotView({ id: "carbine", tier: 2, qty: 1, mag: 21 }, 7);
    expect(gun).toMatchObject({ sprite: "carbine", name: "Pocket Carbine II", tier: 2, corner: "21", gated: false, ammo: { cur: 21, max: 28 } });
    const gated = slotView({ id: "sunbrand", tier: 3, qty: 1 }, 7);
    expect(gated).toMatchObject({ gated: true, corner: "Lv 12", ammo: null });
    expect(slotView({ id: "grenade", tier: 1, qty: 3 }, 1).corner).toBe("×3");
    expect(slotView({ id: "radio", tier: 1, qty: 1 }, 1)).toMatchObject({ name: "Radio", tier: 0 });
  });
});

describe("weapon chips", () => {
  it("summarises the starter weapons", () => {
    expect(weaponChips(WEAPON_BY_ID.get("sunbrand")!)).toEqual(["Melee", "18 dmg", "Arc 110°", "RMB block 70%"]);
    expect(weaponChips(WEAPON_BY_ID.get("carbine")!)).toEqual(["Ranged", "9 dmg", "25 m", "24 rounds"]);
    expect(weaponChips(WEAPON_BY_ID.get("hexquill")!)).toContain("12 casts");
  });
});

describe("time alive", () => {
  it("uses minutes and seconds under an hour, hours and minutes above", () => {
    expect(aliveParts(365_000)).toEqual([{ value: "6", unit: "m" }, { value: "05", unit: "s" }]);
    expect(aliveParts(6_120_000)).toEqual([{ value: "1", unit: "h" }, { value: "42", unit: "m" }]);
  });
});

describe("killer", () => {
  it("classifies players, party members, Oversight, creatures and the world", () => {
    expect(classifyKiller({ killer: "abc", killerName: "Vexa_77" }, "me")).toEqual({ kind: "player", name: "Vexa_77" });
    expect(classifyKiller({ killer: "abc", killerName: "Mara" }, "me", { isParty: (id) => id === "abc" }).kind).toBe("party");
    expect(classifyKiller({ killer: "me", killerName: "Wren" }, "me").kind).toBe("self");
    expect(classifyKiller({ killer: "n1", killerName: "npc:compliance_officer" }, "me")).toEqual({ kind: "oversight", name: "Compliance Officer" });
    expect(classifyKiller({ killer: "n2", killerName: "npc:receiver" }, "me").kind).toBe("oversight");
    expect(classifyKiller({ killer: "n3", killerName: "npc:dusk_wolf" }, "me")).toEqual({ kind: "creature", name: "Dusk Wolf" });
    expect(classifyKiller({ killer: null, killerName: "the fall" }, "me")).toEqual({ kind: "world", name: "The fall" });
    expect(prettyKind("hollow-king")).toBe("Hollow King");
  });
});
