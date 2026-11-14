import { describe, expect, it } from "vitest";
import { playerMaxHp, RESPEC, TREE } from "@firstlight/shared/content/tree";
import { pointToast } from "../game/TreeClient.ts";
import { treeMenuSub, treeView } from "./treeModel.ts";

const base = { starter: 3, coins: 0, safe: false };

describe("build tree panel model (#81)", () => {
  it("shows five branches top-down, only the first row open, every node's numbers", () => {
    const v = treeView({ ...base, level: 3 });
    expect(v.branches.map((b) => b.name)).toEqual(["Body", "Blade", "Bow and gun", "Magic", "Travel"]);
    expect(v.branches.reduce((n, b) => n + b.nodes.length, 0)).toBe(TREE.length);
    expect(v.points).toBe(2);
    for (const b of v.branches) {
      expect(b.nodes[0]!.state).toBe("open");
      expect(b.nodes.slice(1).every((n) => n.state === "locked")).toBe(true);
      for (const n of b.nodes) expect(n.line.length, n.id).toBeGreaterThan(5);
    }
    const hardy = v.branches[0]!.nodes[0]!;
    expect(hardy.line).toBe(`Max HP ${playerMaxHp({ starter: 3, level: 3 })} → ${playerMaxHp({ starter: 3, level: 3, tree: ["body_hardy"] })}`);
  });

  it("marks taken, too dear and newly open nodes, and explains the respec", () => {
    const v = treeView({ ...base, level: 3, tree: ["body_hardy"] });
    const body = v.branches[0]!.nodes;
    expect(body.map((n) => n.state)).toEqual(["taken", "dear", "locked", "locked"]);
    expect(body[1]!.why).toBe("Not enough points yet");
    expect(v.points).toBe(1);
    expect(v.respec).toEqual({ cost: RESPEC.coinsPerPoint, can: false, why: "Only in a safe zone (a town or a pad ring)" });
    expect(treeView({ ...base, level: 3, tree: ["body_hardy"], safe: true }).respec.why).toBe(`Needs ${RESPEC.coinsPerPoint} ◎`);
    expect(treeView({ ...base, level: 3, tree: ["body_hardy"], safe: true, coins: 99 }).respec.can).toBe(true);
    expect(treeView({ ...base, level: 3, safe: true, coins: 99 }).respec.can).toBe(false);
  });

  it("says points are waiting when they grow, not when they are spent or unchanged", () => {
    expect(pointToast(undefined, { nodes: [], points: 1, respec: 0 }, "U")).toBe("1 build point to spend: press U (or Esc → Build)");
    expect(pointToast({ nodes: [], points: 1, respec: 0 }, { nodes: [], points: 2, respec: 0 }, "U")).toContain("2 build points");
    expect(pointToast({ nodes: [], points: 2, respec: 0 }, { nodes: ["body_hardy"], points: 1, respec: 10 }, "U")).toBeNull();
    expect(pointToast({ nodes: [], points: 1, respec: 0 }, { nodes: [], points: 1, respec: 0 }, "U")).toBeNull();
    expect(treeMenuSub({ points: 2, spent: 0 }, "U")).toBe("2 points to spend · U");
  });
});
