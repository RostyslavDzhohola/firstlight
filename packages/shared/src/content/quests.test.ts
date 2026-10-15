// Data consistency for the quests lane: missions, medals, eggs, places, world objects, the shop and
// cosmetics agree with each other and with docs/content.md.

import { describe, expect, it } from "vitest";
import { BODIES, PLANET_IDS } from "../planet/bodies.ts";
import { padDirs } from "../planet/pads.ts";
import { createTerrain } from "../planet/terrain.ts";
import { COSMETIC_BY_ID, COSMETICS, isCosmetic, SHOP, SKIN_BY_ID, TROPHIES, itemName, sellValue, shopEntry, unitSellValue } from "./items.ts";
import { MEDAL_BY_ID, MEDALS } from "./medals.ts";
import { GUIDES, huntCredit, huntTargetIndex, MISSION_BY_ID, MISSIONS, missionGoal, trackedMission } from "./missions.ts";
import { arcMetres, BOSS_LAIRS, MAIN_PAD, PLACE_BY_ID, PLACES, padName, placeDir } from "./places.ts";
import { EGGS, PLAQUES } from "./secrets.ts";
import { NPC_AREAS, PLANET_WILDS } from "./npcs.ts";
import { WEAPON_BY_ID } from "./weapons.ts";
import { inReach, objectPos, WORLD_OBJECT_BY_ID, WORLD_OBJECTS } from "./world.ts";

const unique = (xs: string[]) => new Set(xs).size === xs.length;
const itemExists = (id: string) => WEAPON_BY_ID.has(id) || COSMETIC_BY_ID.has(id) || TROPHIES.some((t) => t.id === id);

describe("missions (content.md §5)", () => {
  it("has 9 unique missions, one hunt, find and reach per planet", () => {
    expect(MISSIONS).toHaveLength(9);
    expect(unique(MISSIONS.map((m) => m.id))).toBe(true);
    for (const body of PLANET_IDS) {
      const ms = MISSIONS.filter((m) => m.body === body);
      expect(ms.map((m) => m.type).sort()).toEqual(["find", "hunt", "reach"]);
      expect(ms.every((m) => m.guide === GUIDES[body].name)).toBe(true);
    }
  });

  it("pays positive rewards totalling 10,280 XP and 1,630 coins", () => {
    for (const m of MISSIONS) {
      expect(m.reward.xp, m.id).toBeGreaterThan(0);
      expect(m.reward.coins, m.id).toBeGreaterThan(0);
      for (const it of m.reward.items) expect(itemExists(it.id), `${m.id} ${it.id}`).toBe(true);
    }
    expect(MISSIONS.reduce((s, m) => s + m.reward.xp, 0)).toBe(10280);
    expect(MISSIONS.reduce((s, m) => s + m.reward.coins, 0)).toBe(1630);
  });

  it("hunt targets spawn where the hunt counts them (the NPC lane reports kills by spawn area)", () => {
    const kinds = (a: (typeof NPC_AREAS)[number]) => [
      ...a.groups.flatMap((g) => g.members.map((m) => m.kind)),
      ...(a.camp?.members.map((m) => m.kind) ?? []),
      ...(a.singles?.map((m) => m.kind) ?? []),
    ];
    for (const m of MISSIONS) {
      if (!m.hunt) continue;
      const areas = NPC_AREAS.filter((a) => a.planet === m.body && (!m.hunt!.place || a.id === m.hunt!.place));
      expect(areas.length, `${m.id}: an NPC spawn area for ${m.hunt.place ?? m.body}`).toBeGreaterThan(0);
      const spawnable = new Set([...areas.flatMap(kinds), ...(m.hunt.place ? [] : PLANET_WILDS[m.body].groups.flatMap((g) => g.members.map((x) => x.kind)))]);
      for (const t of m.hunt.targets) expect(spawnable.has(t.npcKind), `${m.id}: ${t.npcKind} spawns in ${m.hunt.place ?? m.body}`).toBe(true);
    }
  });

  it("points at places and objects that exist on the mission's planet", () => {
    for (const m of MISSIONS) {
      const n = Number(!!m.hunt) + Number(!!m.find) + Number(!!m.reach);
      expect(n, m.id).toBe(1);
      expect(m[m.type], `${m.id} has data for its type`).toBeTruthy();
      if (m.hunt?.place) expect(PLACE_BY_ID.get(m.hunt.place)?.body).toBe(m.body);
      if (m.reach) expect(PLACE_BY_ID.get(m.reach.place)?.body).toBe(m.body);
      if (m.find) {
        const o = WORLD_OBJECT_BY_ID.get(m.find.object);
        expect(o?.body, m.id).toBe(m.body);
        expect(o?.mission).toBe(m.id);
      }
      expect(missionGoal(m)).toBeGreaterThan(0);
    }
    expect(missionGoal(MISSION_BY_ID.get("A1")!)).toBe(8);
    expect(missionGoal(MISSION_BY_ID.get("M1")!)).toBe(7);
  });
});

describe("medals (content.md §7)", () => {
  it("has 20 medals plus 12 hidden egg medals, unique ids and titles", () => {
    expect(MEDALS).toHaveLength(32);
    expect(MEDALS.filter((m) => !m.hidden)).toHaveLength(20);
    expect(MEDALS.filter((m) => m.hidden)).toHaveLength(12);
    expect(unique(MEDALS.map((m) => m.id))).toBe(true);
    for (const m of MEDALS) {
      expect(m.title.length, m.id).toBeGreaterThan(0);
      expect(m.condition.length, m.id).toBeGreaterThan(0);
    }
    expect(MEDALS.filter((m) => !m.hidden).map((m) => Number(m.ref))).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
  });
});

describe("Easter eggs (content.md §6)", () => {
  it("has 4 eggs per planet, each with an existing item, place and hidden medal", () => {
    expect(EGGS).toHaveLength(12);
    for (const body of PLANET_IDS) expect(EGGS.filter((e) => e.body === body)).toHaveLength(4);
    for (const e of EGGS) {
      const medal = MEDAL_BY_ID.get(e.medal);
      expect(medal?.hidden, e.id).toBe(true);
      expect(medal?.ref).toBe(e.id);
      expect(PLACE_BY_ID.get(e.place)?.body, e.id).toBe(e.body);
      expect(itemExists(e.item.id), e.id).toBe(true);
      if (e.item.skin) expect(SKIN_BY_ID.has(e.item.skin)).toBe(true);
      expect(itemName(e.item)).toBe(e.itemName);
      expect(WORLD_OBJECTS.some((o) => o.egg === e.id), `${e.id} has world objects`).toBe(true);
    }
  });

  it("has one Hall of Firsts plaque per egg and per boss", () => {
    expect(PLAQUES).toHaveLength(15);
    expect(unique(PLAQUES.map((p) => p.id))).toBe(true);
  });
});

describe("places and world objects", () => {
  it("resolves every place to a unit direction on its own body", () => {
    expect(unique(PLACES.map((p) => p.id))).toBe(true);
    for (const p of PLACES) {
      const d = placeDir(p);
      expect(Math.hypot(...d), p.id).toBeCloseTo(1, 9);
    }
    for (const [b, id] of Object.entries(MAIN_PAD)) expect(arcMetres(placeDir(id), padDirs(BODIES[b as "arcadia"])[0]!, 1)).toBeCloseTo(0, 9);
    for (const lair of Object.values(BOSS_LAIRS)) expect(PLACE_BY_ID.get(lair.place)?.kind).toBe("lair");
  });

  it("places objects on their own body at finite positions, with guides on every main pad", () => {
    expect(unique(WORLD_OBJECTS.map((o) => o.id))).toBe(true);
    const terrains = new Map(PLANET_IDS.map((b) => [b, createTerrain(b)] as const));
    for (const o of WORLD_OBJECTS) {
      expect(PLACE_BY_ID.get(o.place)?.body, o.id).toBe(o.body);
      if (o.body === "portus") continue;
      const t = terrains.get(o.body)!;
      const p = objectPos(o, (x, y, z) => t.groundHeight(x, y, z));
      expect(p.every(Number.isFinite), o.id).toBe(true);
      expect(inReach(p, p, Math.max(0.1, o.range))).toBe(true);
    }
    for (const body of PLANET_IDS) {
      const guide = WORLD_OBJECT_BY_ID.get(GUIDES[body].id)!;
      expect(guide.body).toBe(body);
      expect(arcMetres(placeDir(MAIN_PAD[body]), placeDir(guide.place), BODIES[body].radius)).toBeLessThan(12);
    }
  });

  it("names every pad", () => {
    for (const body of PLANET_IDS) for (let i = 0; i < padDirs(BODIES[body]).length; i++) expect(padName(body, i).length).toBeGreaterThan(2);
    expect(padName("arcadia", 0)).toBe("Dawnpad");
  });
});

describe("Portus Exchange and cosmetics (content.md §1.5, §8.4)", () => {
  it("prices weapons, support, tonics, the radio and common cosmetics per the bible", () => {
    expect(shopEntry("carbine", 1)?.price).toBe(60);
    expect(shopEntry("carbine", 2)?.price).toBe(300);
    expect(shopEntry("carbine", 3)?.price).toBe(900);
    expect([1, 2, 3].map((t) => shopEntry("stillshot", t)?.price)).toEqual([90, 450, 1350]);
    expect([1, 2, 3].map((t) => shopEntry("comet", t)?.price)).toEqual([90, 450, 1350]);
    expect([1, 2, 3].map((t) => shopEntry("grenade", t)?.price)).toEqual([15, 40, 90]);
    expect([1, 2, 3].map((t) => shopEntry("patchkit", t)?.price)).toEqual([25, 60, 120]);
    expect([1, 2, 3].map((t) => shopEntry("bubble", t)?.price)).toEqual([120, 400, 1000]);
    expect(shopEntry("tonic_small", 1)?.price).toBe(10);
    expect(shopEntry("tonic_large", 1)?.price).toBe(35);
    expect(shopEntry("radio", 1)?.price).toBe(100);
    expect(shopEntry("fists", 1)).toBeUndefined();
    const commons = SHOP.filter((e) => e.category === "cosmetics");
    expect(commons).toHaveLength(7);
    expect(commons.every((e) => e.price === 120)).toBe(true);
    expect(SHOP.every((e) => e.price > 0 && itemExists(e.itemId))).toBe(true);
    expect(unique(SHOP.map((e) => `${e.itemId}:${e.tier}`))).toBe(true);
  });

  it("buys back at 25% rounded down (minimum 1) or the fixed value", () => {
    expect(unitSellValue({ id: "carbine", tier: 1 })).toBe(15);
    expect(unitSellValue({ id: "stillshot", tier: 3 })).toBe(337);
    expect(unitSellValue({ id: "tonic_small", tier: 1 })).toBe(2);
    expect(sellValue({ id: "tonic_small", tier: 1, qty: 4 })).toBe(8);
    expect(unitSellValue({ id: "wool_tuft", tier: 1 })).toBe(2);
    expect(unitSellValue({ id: "woolly_beanie", tier: 1 })).toBe(30);
    expect(unitSellValue({ id: "hollow_crown", tier: 1 })).toBe(500);
    // Easter-egg items are claimable once per life, so the Exchange won't buy them (catalogue.test.ts).
    expect(unitSellValue({ id: "pixel_halo", tier: 1 })).toBe(0);
    expect(unitSellValue({ id: "riverstaff", tier: 2, skin: "ferrymans_oar" })).toBe(0);
    expect(unitSellValue({ id: "fists", tier: 1 })).toBe(0);
  });

  it("lists the 39 cosmetics across hat, cape, mask and backpack", () => {
    expect(COSMETICS).toHaveLength(39);
    expect(unique(COSMETICS.map((c) => c.id))).toBe(true);
    const bySlot = (s: string) => COSMETICS.filter((c) => c.slot === s).length;
    expect([bySlot("hat"), bySlot("cape"), bySlot("mask"), bySlot("backpack")]).toEqual([13, 9, 7, 10]);
    expect(COSMETICS.every((c) => !WEAPON_BY_ID.has(c.id) && isCosmetic(c.id))).toBe(true);
  });
});

describe("hunt credit and the tracked mission (D-zones-2)", () => {
  const A1 = MISSION_BY_ID.get("A1")!;
  const M1 = MISSION_BY_ID.get("M1")!;
  it("counts the right kind in the mission's place only", () => {
    expect(huntTargetIndex(A1, "hopbit", "clover_fields")).toBe(0);
    expect(huntTargetIndex(A1, "hopbit", null)).toBe(-1);
    expect(huntTargetIndex(A1, "hopbit", "lacefall")).toBe(-1);
    expect(huntTargetIndex(A1, "woolback", "clover_fields")).toBe(-1);
    expect(huntTargetIndex(MISSION_BY_ID.get("H1")!, "cantor", null)).toBe(0); // no place: anywhere
    expect(huntTargetIndex(MISSION_BY_ID.get("A2")!, "hopbit", "clover_fields")).toBe(-1); // not a hunt
  });

  it("stops crediting a target once its quota is full, in either completion order (M1)", () => {
    const at = "checkpoint_seven";
    // Six Associates first: Associates no longer count, the Compliance Officer still does.
    expect(huntCredit(M1, [5, 0], "associate", at)).toBe(0);
    expect(huntCredit(M1, [6, 0], "associate", at)).toBe(-1);
    expect(huntCredit(M1, [6, 0], "compliance_officer", at)).toBe(1);
    // The Compliance Officer first: Associates still count, a second Officer doesn't.
    expect(huntCredit(M1, [0, 1], "compliance_officer", at)).toBe(-1);
    expect(huntCredit(M1, [0, 1], "associate", at)).toBe(0);
    expect(huntCredit(M1, undefined, "associate", at)).toBe(0);
    expect(huntCredit(M1, [0, 0], "associate", null)).toBe(-1);
  });

  it("tracks the first open mission given out here, else the first open one", () => {
    const list = [{ id: "A1", done: true }, { id: "H1", done: false }, { id: "A3", done: false }];
    expect(trackedMission(list, "arcadia")?.id).toBe("A3");
    expect(trackedMission(list, "meridian")?.id).toBe("H1");
    expect(trackedMission([{ id: "A1", done: true }], "arcadia")).toBeNull();
  });
});
