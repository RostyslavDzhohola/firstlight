import { describe, expect, it } from "vitest";
import { maxHp } from "./progression.ts";
import { STARTER_STATS, starterStats } from "./starters.ts";
import { BRANCHES, buildStats, NEUTRAL_BUILD, nodeLine, normalizeTree, playerMaxHp, pointsLeft, reloadMs, respecCost, ROLL_GAP_MS, rollReady, spendRefusal, spentPoints, TREE, treePoints, treeYou } from "./tree.ts";

describe("build tree (#81)", () => {
  it("has five branches, rows from 1 with costs 1, 2, 3, 3, and about half the tree at level 20", () => {
    expect(BRANCHES.map((b) => b.id)).toEqual(["body", "blade", "aim", "magic", "travel"]);
    for (const b of BRANCHES) {
      const rows = TREE.filter((n) => n.branch === b.id).sort((x, y) => x.row - y.row);
      expect(rows.map((n) => n.row)).toEqual(rows.map((_, i) => i + 1));
      expect(rows.map((n) => n.cost)).toEqual([1, 2, 3, 3].slice(0, rows.length));
    }
    expect(TREE.length).toBeGreaterThanOrEqual(16);
    expect(treePoints(1)).toBe(0);
    expect(treePoints(20)).toBe(19);
    const all = spentPoints(TREE.map((n) => n.id));
    expect(treePoints(20) / all).toBeGreaterThan(0.4);
    expect(treePoints(20) / all).toBeLessThan(0.6);
    for (const n of TREE) expect(nodeLine(n.id, { starter: 0, level: 10 }).length, n.id).toBeGreaterThan(5);
  });

  it("refuses unknown, taken, out-of-order and unaffordable nodes", () => {
    expect(spendRefusal(5, [], "nope")).toBe("unknown");
    expect(spendRefusal(5, [], "blade_cleave")).toBe("locked");
    expect(spendRefusal(1, [], "blade_edge")).toBe("points");
    expect(spendRefusal(2, [], "blade_edge")).toBeNull();
    expect(spendRefusal(5, ["blade_edge"], "blade_edge")).toBe("taken");
    expect(spendRefusal(3, ["blade_edge"], "blade_cleave")).toBe("points");
    expect(spendRefusal(4, ["blade_edge"], "blade_cleave")).toBeNull();
    expect(pointsLeft(4, ["blade_edge", "blade_cleave"])).toBe(0);
    expect(respecCost(["blade_edge", "blade_cleave"])).toBe(30);
    expect(treeYou(4, ["blade_edge"])).toEqual({ nodes: ["blade_edge"], points: 2, respec: 10 });
  });

  it("normalizes a saved tree: unknown ids, orphans and duplicates go, and it never holds more than the level gives", () => {
    expect(normalizeTree(20, ["blade_cleave", "x", "blade_edge", "blade_edge", 7])).toEqual(["blade_edge"]);
    expect(normalizeTree(3, ["body_hardy", "body_second_roll", "travel_stride"])).toEqual(["body_hardy"]);
    expect(normalizeTree(1, ["body_hardy"])).toEqual([]);
    expect(normalizeTree(10, undefined)).toEqual([]);
  });

  it("reads every effect through buildStats, and max HP follows Hardy", () => {
    expect(buildStats([])).toEqual(NEUTRAL_BUILD);
    expect(buildStats(["body_hardy", "body_second_roll"]).dodgeCharges).toBe(2);
    expect(buildStats(["travel_stride", "travel_far_step"]).skipstepM).toBe(15);
    expect(playerMaxHp({ starter: 1, level: 10 })).toBe(Math.round(maxHp(10) * starterStats(1).hp));
    expect(playerMaxHp({ starter: 1, level: 10, tree: ["body_hardy"] })).toBe(Math.round(maxHp(10) * starterStats(1).hp * 1.12));
  });

  it("holds one roll or two: each charge comes back a cooldown after it was used", () => {
    expect(rollReady([], 1000, 1200, 1)).toBe(true);
    expect(rollReady([500], 1000, 1200, 1)).toBe(false);
    expect(rollReady([500], 1000, 1200, 2)).toBe(true);
    expect(rollReady([500, 900], 1000, 1200, 2)).toBe(false);
    expect(rollReady([-300, 500], 1000, 1200, 2)).toBe(true);
  });

  it("never starts a roll within ROLL_GAP_MS of the last, so a roll's own packets don't spend a charge", () => {
    expect(ROLL_GAP_MS).toBeGreaterThan(300); // a roll's length (PlayerController MOVE.dodgeTime)
    for (const s of STARTER_STATS) expect(s.dodgeCooldown * 1000).toBeGreaterThan(ROLL_GAP_MS); // one charge never notices
    expect(rollReady([1000 - ROLL_GAP_MS + 1], 1000, 1200, 2)).toBe(false);
    expect(rollReady([1000 - ROLL_GAP_MS], 1000, 1200, 2)).toBe(true);
    expect(rollReady([-300, 1000 - ROLL_GAP_MS + 1], 1000, 1200, 2)).toBe(false);
  });

  it("one reload time for every path: the tier's, Quick Hands cuts it for ranged weapons only", () => {
    const quick = buildStats(["aim_steady", "aim_quick_hands"]);
    expect(reloadMs({ cls: "ranged" }, { reload: 1.4 }, NEUTRAL_BUILD)).toBe(1400);
    expect(reloadMs({ cls: "ranged" }, { reload: 1.4 }, quick)).toBeCloseTo(980, 6);
    expect(reloadMs({ cls: "ranged" }, {}, quick)).toBeCloseTo(1050, 6); // unset: 1.5 s
    expect(reloadMs({ cls: "magic" }, { reload: 1.4 }, quick)).toBe(1400);
  });
});
