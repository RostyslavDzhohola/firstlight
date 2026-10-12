import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EGGS, type EggDef } from "@firstlight/shared/content/secrets";
import { dieAndRejoin } from "./quest-helpers.ts";
import { env } from "../src/env.ts";
import { EGG_LIMITS, EGG_TIMERS } from "../src/world/quests/eggs.ts";
import { npcSystemOf } from "../src/world/npc/index.ts";
import { serverRoom, padAt } from "./quest-helpers.ts";
import { safeLeave, startServer } from "./helpers.ts";
import { bot, harness, invIds, objAt, sleep, tpAndWait, until, type Bot } from "./quest-helpers.ts";

const limits = { ...EGG_LIMITS };
const extras = env.cosmeticsExtras;
beforeEach(async () => { harness.game = await startServer(); });
afterEach(async () => {
  Object.assign(EGG_LIMITS, limits);
  env.cosmeticsExtras = extras;
  for (const r of harness.rooms.splice(0)) await safeLeave(r);
  await harness.game!.close();
});

const lastSend = new WeakMap<Bot, number>();
async function press(b: Bot, target: string, code?: string) {
  await tpAndWait(b, objAt(target));
  const gap = 300 - (Date.now() - (lastSend.get(b) ?? 0));
  if (gap > 0) await sleep(gap);
  lastSend.set(b, Date.now());
  const before = b.toasts.length;
  b.send("interact", { target, ...(code === undefined ? {} : { code }) });
  await until("interaction response", () => b.toasts.length > before);
  return b.toasts.at(-1)!;
}

async function discover(b: Bot, egg: EggDef) {
  if (egg.id === "E10") {
    for (const p of ["root", "dew", "bloom"]) await press(b, `e10_btn_${p}`);
  } else if (egg.id === "E11") {
    for (let i = 1; i <= 3; i++) await press(b, `e11_lantern_${i}`);
    await press(b, "e11_chest");
  } else await press(b, "e12_safe", "3158");
  await until("egg reward", () => invIds(b).includes(egg.item.id));
}

describe("M11 eggs", () => {
  it.each(EGGS.slice(9))("$id grants one life reward, an account medal and the first-finder plaque", async (egg) => {
    const watcher = await bot("observer", "portus");
    const b = await bot("discoverer", egg.body);
    const xp = b.you.xp, coins = b.you.coins;
    await discover(b, egg);
    await until("hidden medal", () => b.you.medals.includes(egg.medal));
    await until("hall inscription", () => watcher.last("hall")?.lines.some((l: { id: string; name: string }) => l.id === egg.id && l.name === "discoverer"));
    expect(b.you.xp).toBe(xp);
    expect(b.you.coins).toBe(coins);
    b.send("title", { medalId: egg.medal });
    await until("wearable title", () => b.you.title === egg.medal);
    await discover(b, egg);
    expect(invIds(b).filter((id: string) => id === egg.item.id)).toHaveLength(1);
    await tpAndWait(b, padAt(egg.body, 0));
    await safeLeave(b.room);
    const home = await bot("discoverer", "portus");
    expect(home.you.medals).toContain(egg.medal);
    expect(home.you.title).toBe(egg.medal);
    await tpAndWait(home, objAt("juno_vale"));
    const slot = [...home.you.hotbar, ...home.you.backpack].findIndex((i: any) => i?.id === egg.item.id);
    home.send("sell", { slot });
    await until("egg sale refused", () => home.last("shop")?.reason === "worthless");
    expect(invIds(home)).toContain(egg.item.id);
    const later = await bot("latecomer", egg.body);
    await discover(later, egg);
    await until("second medal", () => later.you.medals.includes(egg.medal));
    expect(watcher.last("hall").lines.find((l: { id: string }) => l.id === egg.id).name).toBe("discoverer");
  });
});


describe("M11 egg abuse limits", () => {
  it("a wrong dial answer stays locked after switching planets, then reopens without penalty NPCs", async () => {
    EGG_LIMITS.lockMs = 2200;
    const b = await bot("dial_guesser", "arcadia");
    expect(await press(b, "e10_btn_bloom")).toContain("folds shut");
    await tpAndWait(b, padAt("arcadia", 0));
    await safeLeave(b.room);
    const elsewhere = await bot("dial_guesser", "hollowmere");
    await safeLeave(elsewhere.room);
    const back = await bot("dial_guesser", "arcadia");
    expect(await press(back, "e10_btn_root")).toContain("Wait a moment");
    expect(invIds(back)).not.toContain("dewdial_crown");
    expect(npcSystemOf(serverRoom(back))!.spawnedCount("egg")).toBe(0);
    await until("dial unlocked", () => !serverRoom(back).systems.filter((s) => "eggs" in s).some((s: any) => s.eggs.lockedFor("dial_guesser", "E10")), 4000);
    await discover(back, EGGS[9]!);
  });

  it("repeated wicks do not count; an early coffer and an expired window lock without rewards", async () => {
    EGG_LIMITS.lockMs = 1000;
    const b = await bot("wick_guesser", "hollowmere");
    const observer = await bot("wick_observer", "hollowmere");
    for (let i = 0; i < 3; i++) await press(b, "e11_lantern_1");
    expect(b.last("lamp")).toEqual({ id: "e11_lantern_1", on: true });
    expect(observer.count("lamp")).toBe(0);
    expect(await press(b, "e11_chest")).toContain("reeds tighten");
    expect(b.last("lamp")).toEqual({ id: "e11_lantern_1", on: false });
    expect(await press(b, "e11_lantern_2")).toContain("Wait a moment");
    expect(invIds(b)).not.toContain("wickfloat_mantle");
    await until("wick lock expired", () => !EGG_TIMERS.puzzles.has("wick_guesser|E11"));
    EGG_LIMITS.wickWindowMs = 200;
    await press(b, "e11_lantern_1");
    await until("wicks expired", () => b.toasts.some((t) => t.includes("fade into the mist")));
    expect(await press(b, "e11_chest")).toContain("Wait a moment");
    expect(npcSystemOf(serverRoom(b))!.spawnedCount("egg")).toBe(0);
    EGG_LIMITS.wickWindowMs = limits.wickWindowMs;
    await until("expired wick window unlocked", () => !EGG_TIMERS.puzzles.has("wick_guesser|E11"));
    await discover(b, EGGS[10]!);
  });

  it("the timebox locks after five wrong codes, including after reconnecting, then accepts a valid inspection", async () => {
    EGG_LIMITS.keypadLockMs = 2400;
    const b = await bot("timebox_guesser", "meridian");
    for (let i = 0; i < 5; i++) await press(b, "e12_safe", "0000");
    expect(b.toasts.at(-1)).toContain("TIMEBOX LOCKED");
    await tpAndWait(b, padAt("meridian", 0));
    await safeLeave(b.room);
    const back = await bot("timebox_guesser", "meridian");
    expect(await press(back, "e12_safe", "3158")).toContain("TIMEBOX LOCKED");
    expect(invIds(back)).not.toContain("quietshift_lens");
    await until("timebox unlocked", () => !EGG_TIMERS.keypads.has("timebox_guesser|E12"));
    await discover(back, EGGS[11]!);
  });

  it.each(EGGS.slice(9))("$id staged claims leave medals and firsts untouched", async (egg) => {
    const watcher = await bot("records_observer", "portus");
    watcher.send("questSync");
    await until("initial hall", () => watcher.count("hall") > 0);
    const b = await bot("stage_discoverer", egg.body);
    b.send("admin", { cmd: "stage", args: { n: egg.body === "arcadia" ? 5 : egg.body === "hollowmere" ? 3 : 4 } });
    await until("staged scene", () => b.toasts.some((t) => /^Stage [345]/.test(t)));
    await discover(b, egg);
    expect(b.you.medals).not.toContain(egg.medal);
    expect(watcher.last("hall")?.lines.some((l: { id: string }) => l.id === egg.id)).toBe(false);

  });
});


describe("M11 availability and assistance", () => {
  it.each(EGGS.slice(9))("$id admin claims never engrave or award a medal", async (egg) => {
    const watcher = await bot("assistance_observer", "portus");
    watcher.send("questSync");
    await until("initial hall", () => watcher.count("hall") > 0);
    const b = await bot("assisted_discoverer", egg.body);
    b.send("admin", { cmd: "egg", args: { id: egg.id } });
    await until("assisted reward", () => invIds(b).includes(egg.item.id));
    expect(b.you.medals).not.toContain(egg.medal);
    expect(watcher.last("hall").lines.some((l: { id: string }) => l.id === egg.id)).toBe(false);
  });

  it("an assisted copy suppresses the new egg's permanent records through the natural puzzle path", async () => {
    const b = await bot("assisted_copy", "meridian");
    b.send("npc", { cmd: "boss", action: "spawn" });
    await until("assisted boss spawn", () => b.count("bossInfo") > 0);
    await discover(b, EGGS[11]!);
    expect(b.you.medals).not.toContain("off_the_clock");
    b.send("questSync");
    await until("hall", () => b.count("hall") > 0);
    expect(b.last("hall").lines.some((l: { id: string }) => l.id === "E12")).toBe(false);
  });

  it("the flag disables new sources and triggers while owned cosmetics remain wearable", async () => {
    const b = await bot("flag_dresser", "portus");
    expect(b.you.cosmeticsExtras).toBe(true);
    await tpAndWait(b, objAt("juno_vale"));
    b.send("admin", { cmd: "coins", args: { amount: 240 } });
    await until("coins", () => b.you.coins === 240);
    b.send("buy", { itemId: "bracken_stitch_cap" });
    await until("new cap", () => invIds(b).includes("bracken_stitch_cap"));
    env.cosmeticsExtras = false;
    await sleep(300);
    b.send("buy", { itemId: "dockfold_cape" });
    await until("sale unavailable", () => b.last("shop")?.reason === "not sold");
    const slot = [...b.you.hotbar, ...b.you.backpack].findIndex((i: any) => i?.id === "bracken_stitch_cap");
    b.send("wear", { slot });
    await until("owned cap worn", () => b.you.worn?.hat === "bracken_stitch_cap");
    expect(b.you.cosmeticsExtras).toBe(false);
    for (const egg of EGGS.slice(9)) {
      const x = await bot(`disabled_${egg.id}`, egg.body);
      const target = egg.id === "E10" ? "e10_btn_root" : egg.id === "E11" ? "e11_lantern_1" : "e12_safe";
      await tpAndWait(x, objAt(target));
      x.send("interact", { target });
      await until("trigger unavailable", () => x.last("denied")?.reason === "unavailable");
      x.send("admin", { cmd: "egg", args: { id: egg.id } });
      x.send("questSync");
      await until("sync", () => x.count("hall") > 0);
      expect(invIds(x)).not.toContain(egg.item.id);
    }
  });
});


it("rebirth keeps the new egg's medal and title, then allows one fresh life reward", async () => {
  const egg = EGGS[9]!;
  const b = await bot("reborn_tender", "arcadia");
  await discover(b, egg);
  b.send("title", { medalId: egg.medal });
  await until("title", () => b.you.title === egg.medal);
  const { bot: reborn } = await dieAndRejoin(b, "reborn_tender", "arcadia");
  expect(invIds(reborn)).not.toContain(egg.item.id);
  expect(reborn.you.medals).toContain(egg.medal);
  expect(reborn.you.title).toBe(egg.medal);
  await discover(reborn, egg);
  expect(invIds(reborn).filter((id: string) => id === egg.item.id)).toHaveLength(1);
  expect(reborn.count("medal")).toBe(0);
});
