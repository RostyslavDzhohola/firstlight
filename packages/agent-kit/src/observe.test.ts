// The observation's text summary stays small enough for a model's context whatever is around, and
// the compass helpers agree with the frame the game's content uses.

import { describe, expect, it } from "vitest";
import { summarize, type Observation } from "./observe.ts";
import { bearingOfDir, bearingTo, compass, dirOfBearing, groundDistance, turn } from "./vec.ts";

function crowded(): Omit<Observation, "summary"> {
  const n = (i: number) => i;
  return {
    status: "playing",
    self: {
      id: "s1", name: "Scout_7_LongName1", agent: true, body: "hollowmere", pos: [395.6, 638.2, -19.3], heading: 271, hp: 77, maxHp: 290, level: 20, xp: 12345, xpToNext: 99999, coins: 123456,
      zone: "danger", zoneKind: "wild", dead: false, swimming: true, inCombat: true, protectedFor: 0,
      weapon: { id: "stillshot", name: "Stillshot Rifle III", slot: 2, kind: "ranged", range: 150, mag: 3, magSize: 5 },
      hotbar: [0, 1, 2, 3].map((slot) => ({ slot, id: "tonic_large", name: "Large Tonic", tier: 1, qty: 10 })),
      backpack: Array.from({ length: 16 }, (_, i) => ({ slot: 4 + i, id: "scatterpipe", name: "Scatterpipe", tier: 3, qty: 1 })),
      cooldowns: { attack: 1400, reload: 2200, overheat: 1500, dodge: 1300, tonic: 8000 },
    },
    creatures: Array.from({ length: 8 }, (_, i) => ({ id: `n${1000 + i}`, kind: "compliance_officer", name: "Compliance Officer", level: 20, hp: 123456, maxHp: 654321, dist: 123.4 + n(i), bearing: 359, hostile: true, boss: i === 0, onMe: i < 3, mission: true })),
    players: Array.from({ length: 8 }, (_, i) => ({ id: `p${i}`, name: `Sixteen_Chars_${i}x`, level: 20, dist: 44.4, bearing: 180, agent: i % 2 === 0, dead: i === 1 })),
    piles: Array.from({ length: 4 }, (_, i) => ({ id: `pile-${i}-abcdef0123456789`, name: "loot pile", dist: 12.3, bearing: 90, coins: 9999, items: 12, yours: true })),
    pads: Array.from({ length: 3 }, (_, i) => ({ id: `pad:${i}`, name: "Lanternfall Crossing", dist: 1234.5, bearing: 12, known: i === 0 })),
    portals: ["arcadia", "hollowmere", "meridian"].map((to) => ({ id: `portal:${to}`, name: `portal to ${to}`, dist: 17, bearing: 30, to })),
    guide: { id: "guide", name: "Sexton Mabry", dist: 300.1, bearing: 200 },
    shops: [{ id: "shop", name: "Lanternfall Stall (Nell Ashgrove)", dist: 310, bearing: 201, inReach: false }],
    safety: { id: "safe", name: "pad 7 Lanternfall Crossing", dist: 99, bearing: 10 },
    missions: ["H1", "H2", "H3"].map((id) => ({ id, name: "A Fairly Long Mission Name", objective: "Kill 6 Bonewalkers and 4 Bone Archers inside the Drowned Chapel grounds", progress: 3, goal: 10, done: false, where: { dist: 450.5, bearing: 77, what: "the hunting ground" } })),
    offers: ["A1", "A2", "A3"].map((id) => ({ id, name: "Another Mission Name Here", objective: "Pick up the Shepherd's Bell at the edge of Lacefall's plunge pool", levels: "13-20" })),
    events: Array.from({ length: 12 }, (_, i) => ({ ago: i * 3.3, type: "toast", text: `Mission complete: Pest Control · +80 XP · +30 ◎ · 2 × Small Tonic (${i})` })),
  };
}

describe("observation summary", () => {
  it("stays well under 2 KB in the busiest scene, and keeps the first lines", () => {
    const text = summarize(crowded());
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(1500);
    expect(text.split("\n")[0]).toContain("Scout_7_LongName1 [AI] L20 on hollowmere: HP 77/290");
    expect(text).toContain("DANGER (wild), swimming, in combat");
    expect(text).toContain("ATTACKING YOU");
    expect(text).toContain("n1000 Compliance Officer");
  });

  it("holds any size it is asked for", () => {
    for (const max of [400, 800, 1200]) expect(Buffer.byteLength(summarize(crowded(), max))).toBeLessThanOrEqual(max);
  });

  it("says what matters in a quiet scene: safety, the dead state, an AI chip on agents", () => {
    const o = crowded();
    o.creatures = [];
    o.players = [{ id: "p1", name: "Mira", level: 3, dist: 5, bearing: 90, agent: false, dead: false }, { id: "p2", name: "Bot_2", level: 2, dist: 9, bearing: 270, agent: true, dead: false }];
    o.self.zone = "safe";
    o.self.zoneKind = "outpost";
    o.self.swimming = false;
    o.self.inCombat = false;
    const text = summarize(o);
    expect(text).toContain("SAFE zone (outpost): no fighting here");
    expect(text).toContain("No creatures in sight.");
    expect(text).toContain("Mira L3 5 m E (90°)");
    expect(text).toContain("Bot_2 [AI] L2 9 m W (270°)");
    o.self.dead = true;
    expect(summarize(o)).toContain("DEAD: call respawn.");
  });
});

describe("compass", () => {
  it("bearings are degrees clockwise from north in the content frame, and round-trip", () => {
    const up: [number, number, number] = [0, 1, 0]; // the Portus pole: north = +Z, east = -X (planet/townFrame.ts)
    expect(bearingOfDir(up, [0, 0, 1])).toBe(0);
    expect(bearingOfDir(up, [-1, 0, 0])).toBe(90);
    expect(bearingOfDir(up, [0, 0, -1])).toBe(180);
    expect(bearingOfDir(up, [1, 0, 0])).toBe(270);
    for (const b of [0, 37, 90, 145, 200, 271, 359]) expect(bearingOfDir(up, dirOfBearing(up, b))).toBe(b);
    expect(bearingOfDir(up, turn(up, dirOfBearing(up, 10), 90))).toBe(100);
    expect(compass(0)).toBe("N");
    expect(compass(44)).toBe("NE");
    expect(compass(225)).toBe("SW");
    expect(compass(350)).toBe("N");
  });

  it("measures along the ground", () => {
    const R = 500;
    const a: [number, number, number] = [0, R, 0];
    const b: [number, number, number] = [0, R * Math.cos(0.1), R * Math.sin(0.1)];
    expect(groundDistance(a, b)).toBeCloseTo(50, 5);
    expect(bearingTo(a, b)).toBe(0);
  });
});
