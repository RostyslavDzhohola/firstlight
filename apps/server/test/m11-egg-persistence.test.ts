import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EGGS, type EggDef } from "@firstlight/shared/content/secrets";
import { openGameDb, type Db } from "../src/db/index.ts";
import { characterRepo } from "../src/world/characters.ts";
import { pileStore } from "../src/world/piles.ts";
import { SqliteCharacterRepo, SqlitePileStore } from "../src/world/sqliteStores.ts";
import { progressStore, SqliteProgressStore } from "../src/world/quests/store.ts";
import { safeLeave, startServer } from "./helpers.ts";
import { bot, harness, invIds, objAt, sleep, tpAndWait, until, type Bot } from "./quest-helpers.ts";

let dir: string;
let db: Db;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "fl-egg-claim-"));
  await start();
});
afterEach(async () => {
  await stop();
  rmSync(dir, { recursive: true, force: true });
});

async function start() {
  harness.game = await startServer();
  db = openGameDb(join(dir, "game.db"));
  characterRepo.current = new SqliteCharacterRepo(db);
  pileStore.current = new SqlitePileStore(db);
  progressStore.current = new SqliteProgressStore(db);
}
async function stop() {
  for (const r of harness.rooms.splice(0)) await safeLeave(r);
  await harness.game!.close();
  db.close();
}

async function prepare(b: Bot, egg: EggDef) {
  if (egg.id === "E1") {
    b.send("admin", { cmd: "coins", args: { amount: 3 } });
    await until("offering coins", () => b.you.coins === 3);
    await tpAndWait(b, objAt("e1_bowl"));
    return { target: "e1_bowl" };
  }
  const steps = egg.id === "E10" ? ["e10_btn_root", "e10_btn_dew"]
    : egg.id === "E11" ? ["e11_lantern_1", "e11_lantern_2", "e11_lantern_3"] : [];
  for (const target of steps) {
    await tpAndWait(b, objAt(target));
    const before = b.toasts.length;
    b.send("interact", { target });
    await until("preparation response", () => b.toasts.length > before);
    await sleep(250); // Quest message pacing.
  }
  const message = egg.id === "E10" ? { target: "e10_btn_bloom" }
    : egg.id === "E11" ? { target: "e11_chest" } : { target: "e12_safe", code: "3158" };
  await tpAndWait(b, objAt(message.target));
  return message;
}

function storedItems(userId: string) {
  const c = characterRepo.current.load(userId)!;
  return [...c.hotbar, ...c.backpack].filter(Boolean).map((i) => i!.id);
}

function failMedalWrite() {
  let failures = 0;
  db.function("record_failure", () => ++failures);
  db.exec("CREATE TEMP TRIGGER fail_medal BEFORE INSERT ON medal BEGIN SELECT record_failure(); SELECT RAISE(ABORT, 'injected medal failure'); END");
  return () => failures;
}

describe("egg claims commit all rewards together", () => {
  const claims = [EGGS[0]!, ...EGGS.slice(9)];
  it.each(claims)("$id medal-write failure pays nothing and a same-session retry pays once", async (egg) => {
    const watcher = await bot("watcher", "portus");
    const b = await bot("claimant", egg.body);
    const message = await prepare(b, egg);
    const failed = failMedalWrite();
    b.send("interact", message);
    await until("injected failure", () => failed() === 1);
    expect(storedItems("claimant")).not.toContain(egg.item.id);
    expect(characterRepo.current.load("claimant")!.life!.eggs).not.toContain(egg.id);
    expect(progressStore.current.medals("claimant")).not.toContain(egg.medal);
    expect(progressStore.current.hall()).toHaveLength(0);
    if (egg.id === "E1") expect(characterRepo.current.load("claimant")!.coins).toBe(3);
    expect(invIds(b)).not.toContain(egg.item.id);
    expect(b.count("medal")).toBe(0);
    expect(watcher.last("hall")?.lines ?? []).toHaveLength(0);
    db.exec("DROP TRIGGER fail_medal");
    await sleep(250); // Quest message pacing.
    b.send("interact", message);
    await until("complete retry", () => b.you.medals.includes(egg.medal) && invIds(b).includes(egg.item.id));
    expect(storedItems("claimant").filter((id) => id === egg.item.id)).toHaveLength(1);
    expect(characterRepo.current.load("claimant")!.life!.eggs.filter((id) => id === egg.id)).toHaveLength(1);
    expect(progressStore.current.hall().filter((e) => e.secretId === egg.id).map((e) => e.userId)).toEqual(["claimant"]);
    expect(b.count("medal")).toBe(1);
    if (egg.id === "E1") expect(characterRepo.current.load("claimant")!.coins).toBe(2);
    await until("committed hall broadcast", () => watcher.last("hall")?.lines.some((l: { id: string }) => l.id === egg.id));
    const repeat = egg.id === "E10" || egg.id === "E11" ? await prepare(b, egg) : message;
    await sleep(250); // Quest message pacing.
    const before = b.toasts.length;
    b.send("interact", repeat);
    await until("duplicate claim refused", () => b.toasts.length > before);
    expect(b.toasts.at(-1)).toContain("already took");
    expect(storedItems("claimant").filter((id) => id === egg.item.id)).toHaveLength(1);
    expect(b.count("medal")).toBe(1);
    if (egg.id === "E1") expect(characterRepo.current.load("claimant")!.coins).toBe(2);
  });

  it.each(claims)("$id failed medal claim stays unpaid after restart and retries completely", async (egg) => {
    const b = await bot("restarter", egg.body);
    const message = await prepare(b, egg);
    const failed = failMedalWrite();
    b.send("interact", message);
    await until("injected failure", () => failed() === 1);
    await stop();
    await start();
    expect(storedItems("restarter")).not.toContain(egg.item.id);
    expect(characterRepo.current.load("restarter")!.life!.eggs).not.toContain(egg.id);
    expect(progressStore.current.medals("restarter")).not.toContain(egg.medal);
    expect(progressStore.current.hall()).toHaveLength(0);
    const back = await bot("restarter", egg.body);
    back.send("interact", await prepare(back, egg));
    await until("restart retry", () => back.you.medals.includes(egg.medal) && invIds(back).includes(egg.item.id));
    expect(storedItems("restarter").filter((id) => id === egg.item.id)).toHaveLength(1);
    expect(progressStore.current.hall().map((e) => e.userId)).toEqual(["restarter"]);
    await stop();
    await start();
    expect(storedItems("restarter").filter((id) => id === egg.item.id)).toHaveLength(1);
    expect(progressStore.current.medals("restarter")).toContain(egg.medal);
    expect(progressStore.current.hall().map((e) => e.userId)).toEqual(["restarter"]);
  });

  it.each(claims)("$id a failed final save rolls back records and sends no Hall or medal news", async (egg) => {
    const watcher = await bot("watcher", "portus");
    const b = await bot("late_failure", egg.body);
    const message = await prepare(b, egg);
    const repo = characterRepo.current;
    const save = repo.save.bind(repo);
    let failed = 0;
    repo.save = () => { failed++; throw new Error("injected character save failure"); };
    b.send("interact", message);
    await until("final save failure", () => failed > 0);
    repo.save = save;
    expect(storedItems("late_failure")).not.toContain(egg.item.id);
    expect(characterRepo.current.load("late_failure")!.life!.eggs).not.toContain(egg.id);
    expect(progressStore.current.medals("late_failure")).not.toContain(egg.medal);
    expect(progressStore.current.hall()).toHaveLength(0);
    const hallCount = watcher.count("hall");
    watcher.send("questSync");
    b.send("questSync");
    await until("sync after rollback", () => watcher.count("hall") > hallCount);
    expect(watcher.last("hall").lines).toHaveLength(0);
    expect(b.count("medal")).toBe(0);
    expect(b.toasts.some((t) => t.includes("Secret found"))).toBe(false);
    await sleep(250); // Quest message pacing.
    b.send("interact", message);
    await until("final save retry", () => b.you.medals.includes(egg.medal) && invIds(b).includes(egg.item.id));
    expect(b.count("medal")).toBe(1);
    await until("committed hall broadcast", () => watcher.last("hall")?.lines.some((l: { id: string }) => l.id === egg.id));
  });

  it.each(claims)("$id simultaneous finishers get rewards with exactly one durable first-finder", async (egg) => {
    const a = await bot("first_candidate", egg.body);
    const b = await bot("second_candidate", egg.body);
    const ma = await prepare(a, egg), mb = await prepare(b, egg);
    a.send("interact", ma);
    b.send("interact", mb);
    await until("both claims committed", () => a.you.medals.includes(egg.medal) && b.you.medals.includes(egg.medal));
    const hall = progressStore.current.hall().filter((e) => e.secretId === egg.id);
    expect(hall).toHaveLength(1);
    expect(["first_candidate", "second_candidate"]).toContain(hall[0]!.userId);
    for (const userId of ["first_candidate", "second_candidate"]) {
      expect(storedItems(userId).filter((id) => id === egg.item.id)).toHaveLength(1);
      expect(characterRepo.current.load(userId)!.life!.eggs).toContain(egg.id);
    }
    await stop();
    await start();
    expect(progressStore.current.hall().filter((e) => e.secretId === egg.id)).toEqual(hall);
  });
});
