// Inventory messages the client's inventory panel sends (review B2): move/merge/swap, drop into a
// pile, use consumables from the backpack, and where picked-up items land.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HOTBAR_SLOTS } from "@firstlight/shared/content/character";
import { WEAPON_INDEX } from "@firstlight/shared/content/weapons";
import { actorPos } from "../src/world/actors.ts";
import { safeLeave, startServer } from "./helpers.ts";
import { bot, harness, me, offPad, serverRoom, sleep, tpAndWait, until, type Bot } from "./quest-helpers.ts";

beforeEach(async () => {
  harness.game = await startServer();
});
afterEach(async () => {
  for (const r of harness.rooms.splice(0)) await safeLeave(r);
  await harness.game!.close();
});

const actorOf = (b: Bot) => serverRoom(b).actors.get(b.id)!;
const ids = (list: ({ id: string } | null)[]) => list.map((i) => i?.id ?? null);
/** Inventory ops are capped at 5/s per player: space them out. */
const op = async (b: Bot, type: string, msg: unknown) => {
  b.send(type, msg);
  await sleep(220);
};

describe("inventory", () => {
  it("picked-up loot goes to the backpack and weapons to the hotbar; trophies stack", async () => {
    const b = await bot("looter", "arcadia");
    const a = actorOf(b);
    const pile = serverRoom(b).createPile(a, [{ id: "wool_tuft", tier: 1, qty: 3 }, { id: "carbine", tier: 2, qty: 1 }, { id: "fox_mask", tier: 1, qty: 1 }, { id: "wool_tuft", tier: 1, qty: 2 }], 0, actorPos(a));
    b.send("pickup", { pileId: pile.id });
    await until("picked up", () => b.you.backpack[0]?.id === "wool_tuft" && b.you.hotbar[1]?.id === "carbine");
    expect(ids(b.you.hotbar)).toEqual(["hexquill", "carbine", null, null]); // the default starter, then the weapon
    expect(ids(b.you.backpack.slice(0, 3))).toEqual(["wool_tuft", "fox_mask", null]);
    expect(b.you.backpack[0].qty).toBe(5);
  });

  it("move swaps across hotbar and backpack, merges stacks and re-equips the selected slot", async () => {
    const b = await bot("mover", "arcadia");
    b.send("admin", { cmd: "give", args: { id: "carbine" } });
    b.send("admin", { cmd: "give", args: { id: "tonic_small", qty: 6 } });
    await until("given", () => b.you.hotbar[2]?.id === "tonic_small");
    // The starter from hotbar 1 into the backpack: the hand is empty (fists).
    await op(b, "move", { from: 0, to: HOTBAR_SLOTS + 3 });
    await until("moved", () => b.you.hotbar[0] === null && b.you.backpack[3]?.id === "hexquill");
    expect(me(b).weapon).toBe(WEAPON_INDEX.get("fists"));
    // Swap the carbine into the selected slot: it's in hand.
    await op(b, "move", { from: 1, to: 0 });
    await until("swapped", () => b.you.hotbar[0]?.id === "carbine" && b.you.hotbar[1] === null);
    await until("equipped", () => me(b).weapon === WEAPON_INDEX.get("carbine"));
    // Split stacks merge up to the stack size (10); the rest stays behind.
    actorOf(b).char.backpack[0] = { id: "tonic_small", tier: 1, qty: 7 };
    await op(b, "move", { from: HOTBAR_SLOTS, to: 2 });
    await until("merged", () => b.you.hotbar[2]?.qty === 10 && b.you.backpack[0]?.qty === 3);
  });

  it("drop leaves the item in a pile in front of you that anyone can pick up", async () => {
    const b = await bot("dropper", "arcadia");
    actorOf(b).char.backpack[5] = { id: "wolf_pelt", tier: 1, qty: 4 };
    await op(b, "drop", { slot: HOTBAR_SLOTS + 5 });
    await until("dropped", () => b.you.backpack[5] === null);
    const room = serverRoom(b);
    const pos = actorPos(actorOf(b));
    let found: { id: string; d: number } | null = null;
    for (const [id, p] of room.state.piles) {
      const d = Math.hypot(p.x - pos[0], p.y - pos[1], p.z - pos[2]);
      if (p.owner === "dropper" && d < 3) found = { id, d };
    }
    expect(found).not.toBeNull();
    // Picking it back up returns it to the backpack.
    b.send("pickup", { pileId: found!.id });
    await until("back", () => b.you.backpack[0]?.id === "wolf_pelt" && b.you.backpack[0]?.qty === 4);
  });

  it("use drinks a tonic from the backpack (not just the hotbar)", async () => {
    const b = await bot("drinker", "arcadia");
    await tpAndWait(b, offPad("arcadia", 0, 40));
    b.send("admin", { cmd: "unprotect" });
    await sleep(150);
    b.send("admin", { cmd: "damage", args: { amount: 60 } });
    await until("hurt", () => me(b).hp <= 41);
    actorOf(b).char.backpack[9] = { id: "tonic_small", tier: 1, qty: 2 };
    const hp = me(b).hp;
    await op(b, "use", { slot: HOTBAR_SLOTS + 9 });
    await until("drank", () => b.you.backpack[9]?.qty === 1);
    await until("healing", () => me(b).hp > hp + 10, 4000);
  });
});
