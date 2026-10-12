// Egg puzzle abuse limits (F12 review B1): a wrong E2/E5 answer raises penalty NPCs, but the puzzle
// then locks for that account, penalty NPCs are capped per account and per room, they dissolve after
// a TTL, and their repeat-kill XP decay is keyed on the egg. The E7 keypad locks out after 5 wrong
// codes. Seam 1: SDK bots against the real in-process server.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NF } from "@firstlight/shared/content/npcs";
import { npcSystemOf } from "../src/world/npc/index.ts";
import { EGG_LIMITS, EGG_TIMERS } from "../src/world/quests/eggs.ts";
import { matchMaker } from "@colyseus/core";
import { pileStore } from "../src/world/piles.ts";
import type { QuestSystem } from "../src/world/quests/QuestSystem.ts";
import { safeLeave, startServer } from "./helpers.ts";
import { bot, harness, invIds, objAt, padAt, serverRoom, sleep, tpAndWait, until, type Bot } from "./quest-helpers.ts";

const saved = { ...EGG_LIMITS };
beforeEach(async () => {
  harness.game = await startServer();
});
afterEach(async () => {
  Object.assign(EGG_LIMITS, saved);
  for (const r of harness.rooms.splice(0)) await safeLeave(r);
  await harness.game!.close();
});

const actorOf = (b: Bot) => serverRoom(b).actors.get(b.id)!;
const quests = (b: Bot) => serverRoom(b).systems.find((s) => "eggs" in s) as QuestSystem;
const penaltyNpcs = (b: Bot, userId?: string) =>
  [...npcSystemOf(serverRoom(b))!.npcs.values()].filter((n) => n.spawned?.reason === "egg" && !n.dead && (userId === undefined || n.spawned.userId === userId));

const lastSend = new WeakMap<Bot, number>();
/** Send one interaction and wait for its toast. Quest actions are rate-limited to 5/s, so sends are paced. */
async function press(b: Bot, target: string, code?: string): Promise<string> {
  const gap = 210 - (Date.now() - (lastSend.get(b) ?? 0));
  if (gap > 0) await sleep(gap);
  lastSend.set(b, Date.now());
  const before = b.toasts.length;
  b.send("interact", code === undefined ? { target } : { target, code });
  await until(`toast for ${target}`, () => b.toasts.length > before);
  return b.toasts[b.toasts.length - 1]!;
}

describe("egg penalties", () => {
  it("a wrong answer locks the puzzle for that account; it reopens after the lockout", async () => {
    EGG_LIMITS.lockMs = 1500;
    const b = await bot("presser", "arcadia");
    await tpAndWait(b, objAt("e2_btn_leaf")); // every button is in reach from here
    expect(await press(b, "e2_btn_flame")).toContain("GAME OVER");
    await until("3 hopbits", () => penaltyNpcs(b).length === 3);
    // Locked: neither wrong presses nor the right order do anything.
    expect(await press(b, "e2_btn_flame")).toContain("rebooting");
    expect(await press(b, "e2_btn_rain")).toContain("rebooting");
    expect(penaltyNpcs(b)).toHaveLength(3);
    await until("unlocked", () => quests(b).eggs.lockedFor("presser", "E2") === 0, 4000);
    for (const btn of ["rain", "leaf", "sun", "flame"]) await press(b, `e2_btn_${btn}`);
    await until("pixel halo", () => invIds(b).includes("pixel_halo"));
  });

  it("penalty NPCs are capped per account and per room", async () => {
    EGG_LIMITS.lockMs = 0;
    const bots = [await bot("greedy1", "arcadia"), await bot("greedy2", "arcadia"), await bot("greedy3", "arcadia")];
    for (const b of bots) await tpAndWait(b, objAt("e2_btn_flame"));
    const [a, b, c] = bots as [Bot, Bot, Bot];
    for (let i = 0; i < 4; i++) await press(a, "e2_btn_flame");
    await until("account cap", () => penaltyNpcs(a, "greedy1").length === EGG_LIMITS.perPlayer);
    for (let i = 0; i < 4; i++) await press(b, "e2_btn_flame");
    await until("room cap", () => penaltyNpcs(b).length === EGG_LIMITS.perBody);
    await press(c, "e2_btn_flame");
    expect(penaltyNpcs(a, "greedy1")).toHaveLength(EGG_LIMITS.perPlayer);
    expect(penaltyNpcs(b, "greedy2")).toHaveLength(EGG_LIMITS.perBody - EGG_LIMITS.perPlayer);
    expect(penaltyNpcs(c, "greedy3")).toHaveLength(0);
  });

  it("penalty NPCs dissolve after their TTL, without rewards", async () => {
    EGG_LIMITS.ttlMs = 1200;
    const b = await bot("waiter", "hollowmere");
    await tpAndWait(b, objAt("e5_rope_lantern"));
    expect(await press(b, "e5_rope_candle")).toContain("bones rise");
    await until("2 bonewalkers", () => penaltyNpcs(b).length === 2);
    const npcs = npcSystemOf(serverRoom(b))!;
    await until("dissolved and removed", () => [...npcs.npcs.values()].every((n) => !n.spawned), 6000);
    expect(b.count("npcKill")).toBe(0);
  });

  it("penalty kills pay nothing: no XP, no coins, no drops (they're a penalty, not a farm)", async () => {
    EGG_LIMITS.lockMs = 0;
    const b = await bot("farmer", "arcadia");
    await tpAndWait(b, objAt("e2_btn_flame"));
    b.send("admin", { cmd: "unprotect" });
    const before = { xp: actorOf(b).char.xp, coins: b.you.coins, piles: pileStore.current.list("arcadia").length };
    const npcs = npcSystemOf(serverRoom(b))!;
    for (let round = 0; round < 2; round++) {
      await press(b, "e2_btn_flame");
      await until("spawned", () => penaltyNpcs(b).length === 3);
      const wave = penaltyNpcs(b);
      await until("materialised", () => wave.every((n) => (n.state.flags & NF.INVULN) === 0));
      for (const n of wave) b.send("npc", { cmd: "hurt", id: n.id, as: b.id, amount: 5000 });
      await until("wave dead", () => wave.every((n) => n.dead || !npcs.npcs.has(n.id)));
    }
    await until("a tick later", () => penaltyNpcs(b).length === 0);
    expect(actorOf(b).char.xp).toBe(before.xp);
    expect(actorOf(b).char.coins).toBe(before.coins);
    expect(pileStore.current.list("arcadia")).toHaveLength(before.piles);
    expect(b.count("npcKill")).toBe(0);
  });
});

describe("E7 keypad", () => {
  it("five wrong codes lock the account out; the right code works again after the lockout", async () => {
    EGG_LIMITS.keypadLockMs = 1500;
    const m = await bot("guesser", "meridian");
    await tpAndWait(m, objAt("e7_safe"));
    for (let i = 0; i < 4; i++) expect(await press(m, "e7_safe", `000${i}`)).toBe("ACCESS DENIED");
    expect(await press(m, "e7_safe", "0004")).toContain("KEYPAD LOCKED");
    // Even the right code is refused while locked out, and so is opening the keypad.
    expect(await press(m, "e7_safe", "7041")).toContain("KEYPAD LOCKED");
    expect(await press(m, "e7_safe")).toContain("KEYPAD LOCKED");
    expect(invIds(m)).not.toContain("executive_visor");
    await until("lockout over", () => !quests(m).eggs.keypadLocked("guesser"), 4000);
    await press(m, "e7_safe", "7041");
    await until("visor", () => invIds(m).includes("executive_visor"));
  });
});

describe("account timers outlive rooms (review S2, N1)", () => {
  it("puzzle and keypad lockouts follow the account to a recreated room", async () => {
    EGG_LIMITS.lockMs = 60_000;
    const b = await bot("hopper", "arcadia");
    await tpAndWait(b, objAt("e2_btn_leaf"));
    expect(await press(b, "e2_btn_flame")).toContain("GAME OVER");
    const m = await bot("hopper2", "meridian");
    await tpAndWait(m, objAt("e7_safe"));
    for (let i = 0; i < 5; i++) await press(m, "e7_safe", `999${i}`);
    expect(m.toasts.at(-1)).toContain("KEYPAD LOCKED");
    // Both log out from a pad and their rooms go away; new rooms start for the same copies.
    for (const [x, body] of [[b, "arcadia"], [m, "meridian"]] as const) {
      const old = serverRoom(x);
      await tpAndWait(x, padAt(body, 0));
      await safeLeave(x.room);
      harness.rooms.splice(harness.rooms.indexOf(x.room), 1);
      await until("disposed", () => !matchMaker.getLocalRoomById(old.roomId), 8000);
    }
    const b2 = await bot("hopper", "arcadia");
    await tpAndWait(b2, objAt("e2_btn_leaf"));
    expect(await press(b2, "e2_btn_rain")).toContain("rebooting");
    const m2 = await bot("hopper2", "meridian");
    await tpAndWait(m2, objAt("e7_safe"));
    expect(await press(m2, "e7_safe", "7041")).toContain("KEYPAD LOCKED");
  }, 30_000);

  it("a Prism Bubble cooldown follows the account to another planet", async () => {
    const a = await bot("shieldy", "arcadia");
    a.send("admin", { cmd: "give", args: { id: "bubble", tier: 1 } });
    await until("bubble", () => invIds(a).includes("bubble"));
    const slot = [...a.you.hotbar, ...a.you.backpack].findIndex((i: any) => i?.id === "bubble");
    a.send("use", { slot });
    await until("deployed", () => a.count("bubble") === 1);
    await safeLeave(a.room);
    harness.rooms.splice(harness.rooms.indexOf(a.room), 1);
    const h = await bot("shieldy", "hollowmere");
    h.send("use", { slot });
    await until("cooldown", () => h.last("denied")?.reason === "cooldown");
  });

  it("idle partial keypad counters are forgotten; lockouts are kept while they last", async () => {
    const m = await bot("forgetful", "meridian");
    await tpAndWait(m, objAt("e7_safe"));
    await press(m, "e7_safe", "1111");
    expect(EGG_TIMERS.keypads.has("forgetful")).toBe(true);
    EGG_LIMITS.keypadIdleMs = 0;
    await until("pruned", () => !EGG_TIMERS.keypads.has("forgetful"), 3000);
  });
});
