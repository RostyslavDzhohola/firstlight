// What the build-tree panel shows (#81), from `you.tree` and the shared table (content/tree.ts):
// the five branches with their nodes top-down, each node's state and its numbers for this
// character, points left and what a respec costs. Pure, so it is tested without a DOM; the server
// decides every spend and respec, this only explains them early.

import { BRANCHES, nodeLine, pointsLeft, respecCost, spendRefusal, TREE, type BranchId, type SpendRefusal } from "@firstlight/shared/content/tree";

export type NodeState = "taken" | "open" | "locked" | "dear";

export interface NodeView {
  id: string;
  name: string;
  cost: number;
  blurb: string;
  /** The effect in numbers for this character ("Max HP 140 → 157"). */
  line: string;
  state: NodeState;
  /** Why it can't be taken now, in plain words (empty when it can, or is taken). */
  why: string;
}

export interface BranchView {
  id: BranchId;
  name: string;
  blurb: string;
  /** Points spent in this branch. */
  spent: number;
  nodes: NodeView[];
}

export interface TreeView {
  level: number;
  points: number;
  spent: number;
  branches: BranchView[];
  respec: { cost: number; can: boolean; why: string };
}

const WHY: Record<SpendRefusal, string> = {
  unknown: "",
  taken: "",
  locked: "Take the one above first",
  points: "Not enough points yet",
};

/** The panel's content for a character (`safe`: standing in a safe zone; `coins`: purse). */
export function treeView(c: { starter: number; level: number; tree?: readonly string[]; coins: number; safe: boolean }): TreeView {
  const tree = c.tree ?? [];
  const branches = BRANCHES.map((b): BranchView => {
    const nodes = TREE.filter((n) => n.branch === b.id).sort((x, y) => x.row - y.row).map((n): NodeView => {
      const no = spendRefusal(c.level, tree, n.id);
      const state: NodeState = no === "taken" ? "taken" : no === "locked" ? "locked" : no === "points" ? "dear" : "open";
      return { id: n.id, name: n.name, cost: n.cost, blurb: n.blurb, line: nodeLine(n.id, { starter: c.starter, level: c.level, tree }), state, why: no ? WHY[no] : "" };
    });
    return { id: b.id, name: b.name, blurb: b.blurb, spent: nodes.filter((n) => n.state === "taken").reduce((s, n) => s + n.cost, 0), nodes };
  });
  const cost = respecCost(tree);
  const why = !tree.length ? "Nothing to give back" : !c.safe ? "Only in a safe zone (a town or a pad ring)" : c.coins < cost ? `Needs ${cost} ◎` : "";
  return {
    level: c.level,
    points: pointsLeft(c.level, tree),
    spent: tree.length ? branches.reduce((s, b) => s + b.spent, 0) : 0,
    branches,
    respec: { cost, can: !why, why },
  };
}

/** The pause-menu row's second line: "2 points to spend · U" or what is taken. */
export function treeMenuSub(view: Pick<TreeView, "points" | "spent">, keycap: string): string {
  if (view.points > 0) return `${view.points} point${view.points === 1 ? "" : "s"} to spend · ${keycap}`;
  if (view.spent > 0) return `${view.spent} point${view.spent === 1 ? "" : "s"} spent · a point every level · ${keycap}`;
  return `A point every level, spent how you like · ${keycap}`;
}
