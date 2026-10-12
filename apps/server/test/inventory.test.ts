// Inventory messages the client's inventory panel sends (review B2): move/merge/swap, drop into a
// pile, use consumables from the backpack, and where picked-up items land.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HOTBAR_SLOTS } from "@firstlight/shared/content/character";
import { WEAPON_INDEX } from "@firstlight/shared/content/weapons";
import { actorPos } from "../src/world/actors.ts";
import { supportOf } from "../src/world/support.ts";
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
    const pile = serverRoom(b).createPile(a, [{ id: "wool_tuft", tier: 1, qty: 3 }, { id: "carbine", tier: 2, qty: 1 }, { id: "fox_mask", tier: 1, qty: 1 }, { id: "wool_tuft", tier: 1, qty: 2 }], 0, actorPos(a))!;
    b.send("pickup", { pileId: pile.id });
    await until("picked up", () => b.you.backpack[0]?.id === "wool_tuft" && b.you.hotbar[1]?.id === "carbine");
    expect(ids(b.you.hotbar)).toEqual(["hexquill", "carbine", null, null]); // the default starter, then the weapon
    expect(ids(b.you.backpack.slice(0, 3))).toEqual(["wool_tuft", "fox_mask", null]);
    expect(b.you.backpack[0].qty).toBe(5);
    // The toast says where the loot went and which key opens the backpack (F12 final Sonnet N9).
    await until("toast", () => b.toasts.some((t) => t.startsWith("Picked up")));
    expect(b.toasts.find((t) => t.startsWith("Picked up"))).toBe("Picked up 4 item(s) · 3 in your backpack (I)");
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

/** Put the first `id` into backpack slot `k` the way the inventory panel does (a `move`). */
async function toBackpack(b: Bot, id: string, k: number): Promise<number> {
  const from = [...b.you.hotbar, ...b.you.backpack].findIndex((i: any) => i?.id === id);
  await op(b, "move", { from, to: HOTBAR_SLOTS + k });
  await until(`${id} in backpack ${k}`, () => b.you.backpack[k]?.id === id);
  return HOTBAR_SLOTS + k;
}

/** Ray from b's head to a's chest (a camera-style shot). */
function aimAt(b: Bot, a: Bot) {
  const s = me(b);
  const t = (b.room.state as any).players.get(a.id);
  const l = Math.hypot(s.x, s.y, s.z);
  const o = [s.x + (s.x / l) * 1.6, s.y + (s.y / l) * 1.6, s.z + (s.z / l) * 1.6];
  const tl = Math.hypot(t.x, t.y, t.z);
  const aim = [t.x + (t.x / tl) * 1.0, t.y + (t.y / tl) * 1.0, t.z + (t.z / tl) * 1.0];
  const d = [aim[0]! - o[0]!, aim[1]! - o[1]!, aim[2]! - o[2]!];
  const dl = Math.hypot(d[0]!, d[1]!, d[2]!);
  return { ox: o[0]!, oy: o[1]!, oz: o[2]!, dx: d[0]! / dl, dy: d[1]! / dl, dz: d[2]! / dl };
}

async function outside(b: Bot, metres: number) {
  await tpAndWait(b, offPad("arcadia", 0, metres));
  b.send("admin", { cmd: "unprotect" });
  await until("unprotected", () => actorOf(b).protectedUntil === 0);
}

describe("support items used from the backpack (the inventory's Use)", () => {
  it("a Prism Bubble used from a backpack slot raises a shell that stops a shot", async () => {
    const a = await bot("shellback", "arcadia");
    const b = await bot("sniper", "arcadia");
    await outside(a, 40);
    await outside(b, 50);
    a.send("admin", { cmd: "give", args: { id: "bubble" } });
    b.send("admin", { cmd: "give", args: { id: "carbine" } });
    await until("given", () => a.you.hotbar.some((i: any) => i?.id === "bubble") && b.you.hotbar[1]?.id === "carbine");
    const slot = await toBackpack(a, "bubble", 6);
    await op(a, "use", { slot }); // what the panel sends: the slot index, no target
    await until("bubble up", () => b.count("bubble") === 1 && supportOf(serverRoom(a))!.bubbles.list.length === 1);
    expect(b.last("bubble")).toMatchObject({ by: a.id, hp: 150 });
    b.send("fire", { slot: 1, ...aimAt(b, a), t: Date.now() });
    await until("shell took the shot", () => (supportOf(serverRoom(a))!.bubbles.list[0]?.hp ?? 150) < 150);
    expect(me(a).hp).toBe(me(a).maxHp);
    expect(a.you.backpack[6]).toMatchObject({ id: "bubble", qty: 1 }); // kept (cooldown item)
  });

  it("a Patchkit used from a backpack slot heals yourself and uses one kit", async () => {
    const a = await bot("selfmedic", "arcadia");
    await outside(a, 40);
    a.send("admin", { cmd: "give", args: { id: "patchkit", qty: 2 } });
    await until("given", () => a.you.hotbar.some((i: any) => i?.id === "patchkit"));
    const slot = await toBackpack(a, "patchkit", 3);
    a.send("admin", { cmd: "damage", args: { amount: 60 } });
    await until("hurt", () => me(a).hp === 40);
    await op(a, "use", { slot });
    await until("channel done", () => a.last("channelEnd")?.ok === true, 4000);
    expect(a.last("channel")).toMatchObject({ kind: "patchkit", target: a.id });
    await until("kit used", () => a.you.backpack[3]?.qty === 1);
    await until("healed", () => actorOf(a).heals.length === 0 && me(a).hp === 70, 6000); // 30% of 100
  });
});
