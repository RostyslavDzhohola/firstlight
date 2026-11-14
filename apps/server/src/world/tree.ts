// The build tree on the server (issue #81, content/tree.ts, docs/content.md §1.6): spending points
// and respecs are decided here and saved at once; the owner sees the tree in `you.tree`. What a node
// does is read where the number is used (combat, movement, spells, BodyRoom), all through
// `buildStats(char.tree)`, so nothing here applies effects except the max-HP change of the moment.
// Points come from the level and go with it: a rebirth is a fresh character with no nodes.

import { z } from "zod";
import { normalizeTree, playerMaxHp, respecCost, spendRefusal, TREE, treeYou } from "@firstlight/shared/content/tree";
import type { PlayerActor } from "./actors.ts";
import type { BodyRoom } from "./BodyRoom.ts";
import { emitGameEvent } from "./events.ts";
import type { RoomSystem } from "./systems.ts";

const NODE_IDS = TREE.map((n) => n.id) as [string, ...string[]];

const treeSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("spend"), node: z.enum(NODE_IDS) }),
  z.object({ action: z.literal("respec") }),
]);

export type TreeMsg = z.infer<typeof treeSchema>;

/** Why a respec can't happen now (null = it can). */
export function respecRefusal(a: PlayerActor, safe: boolean): "dead" | "nothing" | "safe zone" | "coins" | null {
  if (a.dead) return "dead";
  const cost = respecCost(a.char.tree);
  if (!a.char.tree?.length) return "nothing";
  if (!safe) return "safe zone";
  if (a.char.coins < cost) return "coins";
  return null;
}

/** Max HP follows the tree at once: a gain adds its HP, a loss caps the HP at the new max. */
function refreshMaxHp(a: PlayerActor) {
  const before = a.state.maxHp;
  a.state.maxHp = playerMaxHp(a.char);
  if (a.state.hp > 0) a.state.hp = Math.max(1, Math.min(a.state.maxHp, a.state.hp + Math.max(0, a.state.maxHp - before)));
}

export function createTreeSystem(room: BodyRoom): RoomSystem {
  const handle = (sessionId: string, m: TreeMsg) => {
    const a = room.playerById(sessionId);
    if (!a || a.superseded) return;
    const deny = (reason: string) => void a.client.send("denied", { action: "tree", reason });
    if (m.action === "spend") {
      if (a.dead) return deny("dead");
      const why = spendRefusal(a.char.level, a.char.tree, m.node);
      if (why) return deny(why);
      a.char.tree = [...(a.char.tree ?? []), m.node];
    } else {
      const why = respecRefusal(a, room.safeNow(a, Date.now()));
      if (why) return deny(why);
      a.char.coins -= respecCost(a.char.tree);
      a.char.tree = [];
    }
    refreshMaxHp(a);
    a.youDirty = true;
    room.saveActor(a); // a choice is durable at once, like a level-up
    emitGameEvent(room, { type: "tree", playerId: a.id, node: m.action === "spend" ? m.node : null });
  };
  room.onMessage("tree", treeSchema, (c, m) => handle(c.sessionId, m));
  return {
    tick() {},
    onPlayerJoin(sessionId) {
      // A save from an older table (or a level an admin lowered) never holds more than it may.
      const a = room.playerById(sessionId);
      if (!a) return;
      a.char.tree = normalizeTree(a.char.level, a.char.tree);
      refreshMaxHp(a);
    },
    decorateYou(a, you) {
      you.tree = treeYou(a.char.level, a.char.tree);
    },
    onAdmin(a, cmd, args) {
      // `tree {reset: true}`: clear the tree for free (staging, tests).
      if (cmd !== "tree") return false;
      if (args.reset) {
        a.char.tree = [];
        refreshMaxHp(a);
        a.youDirty = true;
      }
      return true;
    },
  };
}
