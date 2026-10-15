// Seam 1: a failed SQLite save must not leave the room's memory ahead of the database (F12 review
// B6: a rolled-back pickup kept the item in the inventory while the pile still held it).

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { matchMaker } from "@colyseus/core";
import type { Room } from "@colyseus/sdk";
import { BODIES, createTerrain, padDirs } from "@firstlight/shared";
import { PROTOCOL_VERSION, type InvItem } from "@firstlight/shared/net/protocol";
import { CLOSE } from "@firstlight/shared/net/social";
import type { Game } from "../src/app.ts";
import { openGameDb, type Db } from "../src/db/index.ts";
import type { BodyRoom } from "../src/world/BodyRoom.ts";
import { characterRepo } from "../src/world/characters.ts";
import { pileStore } from "../src/world/piles.ts";
import { SqliteCharacterRepo, SqlitePileStore } from "../src/world/sqliteStores.ts";
import { placeDir } from "@firstlight/shared/content/places";
import { maxHp } from "@firstlight/shared/content/progression";
import { bossArena } from "@firstlight/shared/content/arenas";
import { NF } from "@firstlight/shared/content/npcs";
import { NPC_TUNING, npcSystemOf, onNpcEvent, resetTuning } from "../src/world/npc/index.ts";
import { PAYOUT_RETRY } from "../src/world/npc/payouts.ts";
import { emitGameEvent } from "../src/world/events.ts";
import { joinAs, safeLeave, startServer, waitFor } from "./helpers.ts";
import { adminBot, bossInfo, spawnNpc } from "./npc-bots.ts";
import { bot, ground, harness, objAt, serverRoom as questRoom, sleep as qsleep, tpAndWait, type Bot } from "./quest-helpers.ts";

let game: Game;
let dir: string;
let db: Db;
let failing = false;
/** When set, this many more character saves succeed, then every save fails (a second write failing). */
let savesLeft: number | null = null;
/** Character saves that threw (the injected failure was hit). */
let failedSaves = 0;
const rooms: Room[] = [];

beforeEach(async () => {
  game = await startServer();
  dir = mkdtempSync(join(tmpdir(), "fl-rollback-"));
  db = openGameDb(join(dir, "game.db"));
  const repo = new SqliteCharacterRepo(db);
  const save = repo.save.bind(repo);
  repo.save = (userId, data) => {
    if (failing) {
      failedSaves++;
      throw new Error("disk I/O error (test)");
    }
    if (savesLeft !== null && savesLeft-- <= 0) {
      failedSaves++;
      throw new Error("disk I/O error (test, later write)");
    }
    save(userId, data);
  };
  characterRepo.current = repo;
  pileStore.current = new SqlitePileStore(db);
  failing = false;
  savesLeft = null;
  failedSaves = 0;
  harness.game = game;
});
afterEach(async () => {
  failing = false;
  savesLeft = null;
  for (const r of rooms.splice(0)) await safeLeave(r);
  for (const r of harness.rooms.splice(0)) await safeLeave(r);
  await game.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

type V = [number, number, number];
const st = (r: Room) => r.state as any;
const me = (r: Room) => st(r).players.get(r.sessionId);
const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
const serverRoom = (r: Room) => matchMaker.getLocalRoomById(r.roomId) as unknown as BodyRoom;
const actorOf = (r: Room) => serverRoom(r).actors.get(r.sessionId)!;
const slots = (r: Room): (InvItem | null)[] => [...actorOf(r).char.hotbar, ...actorOf(r).char.backpack];
const count = (r: Room, id: string) => slots(r).filter((s) => s?.id === id).reduce((n, s) => n + s!.qty, 0);

/** `metres` east-north-east of Arcadia's main pad (due north is the Dawnpad outpost's barn, D42). */
function outside(metres = 40): V {
  const R = BODIES.arcadia.radius;
  const d = padDirs(BODIES.arcadia)[0]!;
  const ref = Math.abs(d[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  const k = ref[0]! * d[0] + ref[1]! * d[1] + ref[2]! * d[2];
  const n = [ref[0]! - k * d[0], ref[1]! - k * d[1], ref[2]! - k * d[2]];
  const w = [d[1] * n[2]! - d[2] * n[1]!, d[2] * n[0]! - d[0] * n[2]!, d[0] * n[1]! - d[1] * n[0]!];
  const a = (75 * Math.PI) / 180;
  const t = n.map((v, i) => v * Math.cos(a) - w[i]! * Math.sin(a));
  const tl = Math.hypot(t[0]!, t[1]!, t[2]!);
  const v = [d[0] + (t[0]! / tl) * (metres / R), d[1] + (t[1]! / tl) * (metres / R), d[2] + (t[2]! / tl) * (metres / R)];
  const l = Math.hypot(v[0]!, v[1]!, v[2]!);
  return [(v[0]! / l) * R, (v[1]! / l) * R, (v[2]! / l) * R];
}

/** An admin out of the safe ring with an axe in hotbar slot 1, saved to the database. */
async function setup(name: string): Promise<Room> {
  const r = await joinAs(game, name, "arcadia", {}, "admin");
  rooms.push(r);
  await waitFor(() => !!me(r));
  const p = outside();
  r.send("admin", { cmd: "teleport", args: { x: p[0], y: p[1], z: p[2] } });
  r.send("admin", { cmd: "unprotect" });
  r.send("admin", { cmd: "give", args: { id: "axe" } });
  await waitFor(() => count(r, "axe") === 1 && Math.hypot(me(r).x - p[0], me(r).y - p[1], me(r).z - p[2]) < 2 && !(me(r).flags & 3));
  serverRoom(r).saveActor(actorOf(r));
  return r;
}
const axeSlot = (r: Room) => slots(r).findIndex((s) => s?.id === "axe");
const pilesHere = () => pileStore.current.list("arcadia");

describe("a failed save undoes the room's changes (F12 B6)", () => {
  it("a pickup whose save fails leaves the item in the pile only; the retry moves exactly one", async () => {
    const r = await setup("picker");
    r.send("drop", { slot: axeSlot(r) });
    await waitFor(() => pilesHere().length === 1 && count(r, "axe") === 0);
    const pile = pilesHere()[0]!;
    failing = true;
    r.send("pickup", { pileId: pile.id });
    await sleep(300);
    expect(count(r, "axe")).toBe(0);
    expect(pileStore.current.get(pile.id)?.items.map((i) => i.id)).toEqual(["axe"]);
    failing = false;
    await sleep(250); // inventory ops: 5/s
    r.send("pickup", { pileId: pile.id });
    await waitFor(() => count(r, "axe") === 1);
    expect(pileStore.current.get(pile.id)).toBeUndefined();
    expect(characterRepo.current.load("picker")!.hotbar.concat(characterRepo.current.load("picker")!.backpack).filter((s) => s?.id === "axe")).toHaveLength(1);
  });

  it("a drop whose save fails keeps the item in the inventory and makes no pile", async () => {
    const r = await setup("dropper");
    failing = true;
    r.send("drop", { slot: axeSlot(r) });
    await sleep(300);
    expect(count(r, "axe")).toBe(1);
    expect(pilesHere()).toHaveLength(0);
  });

  it("a death whose save fails loses nothing: the player is sent to rejoin from the last save", async () => {
    const r = await setup("unlucky");
    let code = 0;
    r.onLeave((c) => (code = c));
    failing = true;
    r.send("admin", { cmd: "damage", args: { amount: 10_000 } });
    await waitFor(() => code !== 0, 3000);
    expect(code).toBe(CLOSE.STORAGE); // the client backs off and rejoins later
    expect(pilesHere()).toHaveLength(0);
    failing = false;
    const back = await joinAs(game, "unlucky", "arcadia", {}, "admin");
    rooms.push(back);
    await waitFor(() => !!me(back));
    expect(me(back).hp).toBeGreaterThan(0);
    expect(count(back, "axe")).toBe(1);
  });

  it("while saving keeps failing, the account isn't admitted again (no die-rejoin loop); it is once storage recovers (F12 re-review S5)", async () => {
    const r = await setup("stuck");
    let code = 0;
    r.onLeave((c) => (code = c));
    failing = true;
    r.send("admin", { cmd: "damage", args: { amount: 10_000 } });
    await waitFor(() => code === CLOSE.STORAGE, 3000);
    // The failure stays on: /api/play refuses with a clear reason, a seat reserved before is refused too.
    for (let i = 0; i < 3; i++) {
      const res = await fetch(`http://127.0.0.1:${game.port}/api/play`, {
        method: "POST",
        headers: { Authorization: "Bearer dev:stuck:stuck:admin", "Content-Type": "application/json" },
        body: JSON.stringify({ body: "arcadia", v: PROTOCOL_VERSION }),
      });
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ ok: false, error: "storage" });
    }
    failing = false;
    const back = await joinAs(game, "stuck", "arcadia", {}, "admin");
    rooms.push(back);
    await waitFor(() => !!me(back));
    expect(me(back).hp).toBeGreaterThan(0);
    expect(count(back, "axe")).toBe(1);
  });
});

describe("a failed save undoes quest and shop rewards too (F12 B6, Codex re-review)", () => {
  const stored = (userId: string) => characterRepo.current.load(userId)!;
  const storedCount = (userId: string, id: string) => [...stored(userId).hotbar, ...stored(userId).backpack].filter((s) => s?.id === id).reduce((n, s) => n + s!.qty, 0);
  const memCount = (b: Bot, id: string) => {
    const a = questRoom(b).actors.get(b.id)!;
    return [...a.char.hotbar, ...a.char.backpack].filter((s) => s?.id === id).reduce((n, s) => n + s!.qty, 0);
  };
  const actor = (b: Bot) => questRoom(b).actors.get(b.id)!;

  it("a purchase whose save fails keeps the coins and gives nothing; the retry buys exactly once", async () => {
    const b = await bot("buyer", "portus");
    b.send("admin", { cmd: "coins", args: { amount: 500 } });
    await tpAndWait(b, objAt("juno_vale"));
    await waitFor(() => actor(b).char.coins === 500);
    questRoom(b).saveActor(actor(b));
    failing = true;
    b.send("buy", { itemId: "tonic_small", tier: 1, qty: 1 });
    await waitFor(() => b.last("shop") !== undefined);
    expect(b.last("shop")).toMatchObject({ ok: false, action: "buy" });
    expect(actor(b).char.coins).toBe(500);
    expect(memCount(b, "tonic_small")).toBe(0);
    failing = false;
    await qsleep(250);
    b.send("buy", { itemId: "tonic_small", tier: 1, qty: 1 });
    await waitFor(() => memCount(b, "tonic_small") === 1);
    const paid = 500 - actor(b).char.coins;
    expect(paid).toBeGreaterThan(0);
    expect(storedCount("buyer", "tonic_small")).toBe(1);
    expect(stored("buyer").coins).toBe(500 - paid);
  });

  it("a mission whose reward save fails stays open with no XP, coins or items; the next completion pays once", async () => {
    const b = await bot("missioner", "arcadia");
    await tpAndWait(b, objAt("guide_arcadia"));
    b.send("mission", { action: "accept", id: "A1" });
    await waitFor(() => actor(b).char.missions.some((m) => m.id === "A1"));
    const xp0 = actor(b).char.xp;
    questRoom(b).saveActor(actor(b));
    const room = questRoom(b);
    const fields = ground("arcadia", placeDir("clover_fields"));
    failing = true;
    for (let i = 0; i < 8; i++) emitGameEvent(room, { type: "kill", npcKind: "hopbit", killerId: b.id, pos: fields, area: "clover_fields" });
    await qsleep(200);
    const m = () => actor(b).char.missions.find((x) => x.id === "A1")!;
    expect(m().done).toBe(false);
    expect(actor(b).char.xp).toBe(xp0);
    expect(actor(b).char.coins).toBe(0);
    expect(memCount(b, "tonic_small")).toBe(0);
    failing = false;
    emitGameEvent(room, { type: "kill", npcKind: "hopbit", killerId: b.id, pos: fields, area: "clover_fields" });
    await waitFor(() => m().done);
    emitGameEvent(room, { type: "kill", npcKind: "hopbit", killerId: b.id, pos: fields, area: "clover_fields" });
    await qsleep(200);
    expect(actor(b).char.coins).toBe(30);
    expect(actor(b).char.xp).toBe(xp0 + 80);
    expect(memCount(b, "tonic_small")).toBe(2);
    expect(stored("missioner").coins).toBe(30);
    expect(storedCount("missioner", "tonic_small")).toBe(2);
    expect(stored("missioner").missions.find((x) => x.id === "A1")!.done).toBe(true);
  });

  it("an overflow pile from a reward is rolled back with the save; the retry drops exactly one", async () => {
    const b = await bot("overflow", "arcadia");
    for (let i = 0; i < 20; i++) b.send("admin", { cmd: "give", args: { id: "axe" } });
    await waitFor(() => [...actor(b).char.hotbar, ...actor(b).char.backpack].every((x) => !!x)); // bags full
    await tpAndWait(b, objAt("guide_arcadia"));
    b.send("mission", { action: "accept", id: "A1" });
    await waitFor(() => actor(b).char.missions.some((m) => m.id === "A1"));
    questRoom(b).saveActor(actor(b));
    const room = questRoom(b);
    const fields = ground("arcadia", placeDir("clover_fields"));
    const piles0 = pileStore.current.list("arcadia").length;
    failing = true;
    for (let i = 0; i < 8; i++) emitGameEvent(room, { type: "kill", npcKind: "hopbit", killerId: b.id, pos: fields, area: "clover_fields" });
    await qsleep(200);
    expect(pileStore.current.list("arcadia").length).toBe(piles0);
    expect(actor(b).char.coins).toBe(0);
    failing = false;
    emitGameEvent(room, { type: "kill", npcKind: "hopbit", killerId: b.id, pos: fields, area: "clover_fields" });
    await waitFor(() => actor(b).char.missions.find((x) => x.id === "A1")!.done);
    await qsleep(100);
    const piles = pileStore.current.list("arcadia");
    expect(piles.length).toBe(piles0 + 1);
    expect(piles.at(-1)!.items.map((i) => `${i.id}:${i.qty}`)).toEqual(["tonic_small:2"]);
    expect(stored("overflow").coins).toBe(30);
  });
});


describe("mission XP commits with the completion (F12 final B1)", () => {
  const stored = (userId: string) => characterRepo.current.load(userId)!;
  const actor = (b: Bot) => questRoom(b).actors.get(b.id)!;
  const a1 = (b: Bot) => actor(b).char.missions.find((x) => x.id === "A1")!;

  /** Accept A1 at the Arcadia guide and save; returns a function that reports eight Clover Fields hopbit kills. */
  async function onA1(b: Bot) {
    await tpAndWait(b, objAt("guide_arcadia"));
    b.send("mission", { action: "accept", id: "A1" });
    await waitFor(() => actor(b).char.missions.some((m) => m.id === "A1"));
    questRoom(b).saveActor(actor(b));
    const room = questRoom(b);
    const fields = ground("arcadia", placeDir("clover_fields"));
    return (n = 8) => {
      for (let i = 0; i < n; i++) emitGameEvent(room, { type: "kill", npcKind: "hopbit", killerId: b.id, pos: fields, area: "clover_fields" });
    };
  }

  it("below a level-up the XP is in the same save as done=true: a restart right after keeps it", async () => {
    const b = await bot("veteran", "arcadia");
    b.send("admin", { cmd: "level", args: { level: 5 } });
    await waitFor(() => actor(b).char.level === 5);
    const xp0 = actor(b).char.xp;
    const kills = await onA1(b);
    kills();
    await waitFor(() => a1(b).done);
    expect(actor(b).char.xp).toBe(xp0 + 80);
    expect(actor(b).char.level).toBe(5); // no level-up: nothing else saves
    // A restart now reads game.db: the completed mission comes back with its XP.
    const db2 = openGameDb(join(dir, "game.db"));
    const row = new SqliteCharacterRepo(db2).load("veteran")!;
    db2.close();
    expect(row.missions.find((m) => m.id === "A1")!.done).toBe(true);
    expect(row.coins).toBe(30);
    expect(row.xp).toBe(xp0 + 80);
    expect(row.level).toBe(5);
  });

  it("a level-up adds no second write that could fail after the completion committed", async () => {
    const b = await bot("climber", "arcadia");
    const kills = await onA1(b);
    expect(actor(b).char.xp).toBe(0);
    savesLeft = 1; // the completion's save goes through; any later write fails
    kills();
    await waitFor(() => a1(b).done);
    await qsleep(200);
    savesLeft = null;
    expect(stored("climber").missions.find((m) => m.id === "A1")!.done).toBe(true);
    expect(stored("climber").xp).toBe(80);
    expect(stored("climber").level).toBe(2);
    expect(actor(b).char.xp).toBe(80);
    expect(actor(b).char.level).toBe(2);
    expect(me(b.room).level).toBe(2);
    await waitFor(() => b.toasts.includes("Level 2!"));
    // The completion's one save also carries the level-up's HP (F12 confirm Codex N-S1).
    expect(stored("climber").hp).toBe(actor(b).state.hp);
    expect(maxHp(stored("climber").level)).toBe(actor(b).state.maxHp);
    expect(actor(b).state.maxHp).toBe(110);
    // Further triggers pay nothing more.
    kills(1);
    await qsleep(200);
    expect(actor(b).char.xp).toBe(80);
    expect(actor(b).char.coins).toBe(30);
  });

  it("a completion whose save fails pays its XP exactly once on the retry, in the database too", async () => {
    const b = await bot("retrier", "arcadia");
    const kills = await onA1(b);
    failing = true;
    kills();
    await qsleep(200);
    expect(a1(b).done).toBe(false);
    expect(b.toasts).not.toContain("Level 2!");
    failing = false;
    kills(1);
    await waitFor(() => a1(b).done);
    kills(1);
    await qsleep(200);
    expect(actor(b).char.xp).toBe(80);
    expect(stored("retrier").xp).toBe(80);
    expect(stored("retrier").level).toBe(2);
    expect(b.toasts.filter((t) => t === "Level 2!")).toHaveLength(1);
  });
});

describe("kill and boss payouts: committed before anyone hears of them, retried when the save fails (F12 final B1, F12 confirm Sonnet SF1)", () => {
  const retry = [...PAYOUT_RETRY.delaysMs];
  beforeEach(() => {
    PAYOUT_RETRY.delaysMs = [150, 300, 450];
  });
  afterEach(() => {
    PAYOUT_RETRY.delaysMs = [...retry];
    resetTuning();
  });
  const npcs = (r: Room) => npcSystemOf(serverRoom(r))!;
  /** The kill (and its first payout attempt) has happened: onKilled marks the NPC dead first. */
  const dead = (r: Room, id: string) => npcs(r).npcs.get(id)?.dead !== false;
  /** Server time has moved past every retry delay since `t0` (a retry would have run by now). */
  const pastRetries = (r: Room, t0: number) => npcs(r).now > t0 + PAYOUT_RETRY.delaysMs.reduce((a, b) => a + b, 0) + 200;

  /** An admin one XP short of level 2 with listeners for kill news and hunt credit. */
  async function hunter(name: string) {
    const r = await setup(name);
    const a = actorOf(r);
    a.char.xp = 49;
    serverRoom(r).saveActor(a);
    const toasts: string[] = [];
    const kills: any[] = [];
    let credits = 0;
    r.onMessage("toast", (m: any) => toasts.push(m.text));
    r.onMessage("npcKill", (m: any) => kills.push(m));
    const off = onNpcEvent((e) => e.kind === "kill" && e.userIds.includes(name) && credits++);
    offs.push(off);
    const kill = async () => {
      const id = await spawnNpc(r, "hopbit", outside(44), { instant: true });
      r.send("npc", { cmd: "hurt", id, amount: 1e6, as: r.sessionId });
      await waitFor(() => dead(r, id));
    };
    return { r, a, toasts, kills, credits: () => credits, kill };
  }
  const offs: (() => void)[] = [];
  afterEach(() => {
    for (const off of offs.splice(0)) off();
  });

  it("a kill whose save fails pays and announces nothing; once saving works a retry pays it exactly once", async () => {
    const { r, a, toasts, kills, credits, kill } = await hunter("hunter");
    failing = true;
    await kill();
    expect(npcs(r).payouts.size()).toBe(1); // queued for a retry
    expect(toasts).not.toContain("Level 2!");
    expect(kills).toHaveLength(0);
    expect(credits()).toBe(0);
    expect([a.char.xp, a.char.level, a.char.coins, me(r).level]).toEqual([49, 1, 0, 1]);
    failing = false;
    await waitFor(() => kills.length === 1);
    await waitFor(() => toasts.includes("Level 2!"));
    const paid = kills[0];
    expect(paid.xp).toBeGreaterThan(0);
    expect(a.char.xp).toBe(49 + paid.xp);
    expect(a.char.coins).toBe(paid.coins);
    expect(a.char.level).toBe(2);
    expect(credits()).toBe(1); // hunt credit with the payout
    const row = characterRepo.current.load("hunter")!;
    expect([row.xp, row.level, row.coins]).toEqual([a.char.xp, 2, a.char.coins]);
    // Nothing is left to retry, and nothing pays again.
    const t0 = npcs(r).now;
    expect(npcs(r).payouts.size()).toBe(0);
    await waitFor(() => pastRetries(r, t0));
    expect(kills).toHaveLength(1);
    expect(credits()).toBe(1);
    expect(toasts.filter((t) => t === "Level 2!")).toHaveLength(1);
    expect(a.char.xp).toBe(49 + paid.xp);
    expect(characterRepo.current.load("hunter")!.xp).toBe(49 + paid.xp);
  });

  it("a kill whose save works first time is paid once and never retried", async () => {
    const { r, a, kills, credits, kill } = await hunter("oneshot");
    const t0 = npcs(r).now;
    await kill();
    expect(npcs(r).payouts.size()).toBe(0);
    await waitFor(() => kills.length === 1);
    const xp = a.char.xp;
    expect(xp).toBe(49 + kills[0].xp);
    await waitFor(() => pastRetries(r, t0));
    expect(kills).toHaveLength(1);
    expect(credits()).toBe(1);
    expect(a.char.xp).toBe(xp);
    expect(characterRepo.current.load("oneshot")!.xp).toBe(xp);
    expect(failedSaves).toBe(0);
  });

  it("a payout whose saves keep failing is given up after the last retry; nothing arrives late", async () => {
    const { r, a, kills, credits, kill } = await hunter("unpaid");
    failing = true;
    await kill();
    await waitFor(() => failedSaves >= 1 + PAYOUT_RETRY.delaysMs.length && npcs(r).payouts.size() === 0);
    failing = false;
    const t0 = npcs(r).now;
    await waitFor(() => pastRetries(r, t0));
    expect(kills).toHaveLength(0);
    expect(credits()).toBe(0);
    expect([a.char.xp, a.char.coins]).toEqual([49, 0]);
    expect(characterRepo.current.load("unpaid")!.xp).toBe(49);
  });

  it("boss loot whose save fails arrives exactly once on a retry (coins, XP, items)", async () => {
    NPC_TUNING.bosses = true;
    NPC_TUNING.bossAttacks = false;
    NPC_TUNING.bossMechanics = [];
    const ar = bossArena(createTerrain("arcadia"))!;
    const r = await adminBot(game, rooms, "bosskiller", "arcadia", ar.centre as V, 8);
    const a = actorOf(r);
    const xp0 = a.char.xp;
    const kills: any[] = [];
    let defeat = false;
    r.onMessage("npcKill", (m: any) => kills.push(m));
    r.onMessage("boss", (m: any) => m.type === "defeat" && (defeat = true));
    let info: any = null;
    await waitFor(() => {
      void bossInfo(r).then((i) => (info = i));
      return info?.status === "alive" && info.engaged;
    });
    await waitFor(() => !!st(r).npcs?.get(info.id) && !(st(r).npcs.get(info.id).flags & NF.SPAWNING), 3000);
    serverRoom(r).saveActor(a);
    failing = true;
    r.send("npc", { cmd: "hurt", id: info.id, amount: 1e7, as: r.sessionId });
    await waitFor(() => defeat);
    expect(npcs(r).payouts.size()).toBe(1);
    expect(kills).toHaveLength(0);
    expect([a.char.coins, a.char.xp, count(r, "tonic_large")]).toEqual([0, xp0, 0]);
    failing = false;
    await waitFor(() => kills.length === 1);
    expect(kills[0]).toMatchObject({ xp: 2000, coins: 120 });
    expect([a.char.coins, a.char.xp, count(r, "tonic_large")]).toEqual([120, xp0 + 2000, 2]);
    const row = characterRepo.current.load("bosskiller")!;
    expect([row.coins, row.xp]).toEqual([120, xp0 + 2000]);
    expect([...row.hotbar, ...row.backpack].filter((s) => s?.id === "tonic_large").reduce((n, s) => n + s!.qty, 0)).toBe(2);
    const t0 = npcs(r).now;
    await waitFor(() => pastRetries(r, t0));
    expect(kills).toHaveLength(1);
    expect([a.char.coins, a.char.xp, count(r, "tonic_large")]).toEqual([120, xp0 + 2000, 2]);
  }, 30_000);
});

describe("a level-up's extra HP is in the reward's save (F12 confirm Codex N-S1)", () => {
  /** An admin one XP short of level 2, saved, and a hopbit kill that crosses the level. */
  async function oneShort(name: string) {
    const r = await setup(name);
    const a = actorOf(r);
    a.char.xp = 49;
    serverRoom(r).saveActor(a);
    const toasts: string[] = [];
    r.onMessage("toast", (m: any) => toasts.push(m.text));
    const kill = async () => {
      const id = await spawnNpc(r, "hopbit", outside(44), { instant: true });
      r.send("npc", { cmd: "hurt", id, amount: 1e6, as: r.sessionId });
      await waitFor(() => npcSystemOf(serverRoom(r))!.npcs.get(id)?.dead !== false); // killed, payout tried
    };
    return { r, a, toasts, kill };
  }

  it("a kill that crosses a level stores the HP and max HP the player sees", async () => {
    const { r, a, toasts, kill } = await oneShort("healed");
    expect(a.state.hp).toBe(100);
    await kill();
    await waitFor(() => toasts.includes("Level 2!"));
    expect(a.state.level).toBe(2);
    expect(a.state.maxHp).toBe(110);
    expect(a.state.hp).toBe(110);
    // A crash now restarts from game.db: the row carries the healed HP, not the level-1 HP.
    const db2 = openGameDb(join(dir, "game.db"));
    const row = new SqliteCharacterRepo(db2).load("healed")!;
    db2.close();
    expect(row.level).toBe(2);
    expect(row.hp).toBe(a.state.hp);
    expect(maxHp(row.level)).toBe(a.state.maxHp);
    await waitFor(() => me(r).hp === 110 && me(r).maxHp === 110); // published after the commit
  });

  it("a level-up reward whose save fails changes neither the live nor the stored HP", async () => {
    const { a, toasts, kill } = await oneShort("unhealed");
    failing = true;
    await kill();
    expect(failedSaves).toBeGreaterThan(0);
    expect(toasts).not.toContain("Level 2!");
    expect(a.char.level).toBe(1);
    expect(a.char.hp).toBe(100);
    expect([a.state.level, a.state.maxHp, a.state.hp]).toEqual([1, 100, 100]);
    const row = characterRepo.current.load("unhealed")!;
    expect([row.xp, row.level, row.hp]).toEqual([49, 1, 100]);
  });
});

describe("egg offerings are part of the claim's save (F12 final Opus nit)", () => {
  it("E1: a claim whose save fails keeps the coin; the retry takes exactly one coin with the lantern", async () => {
    const b = await bot("offerer", "arcadia");
    const a = questRoom(b).actors.get(b.id)!;
    b.send("admin", { cmd: "coins", args: { amount: 3 } });
    await waitFor(() => a.char.coins === 3);
    await tpAndWait(b, objAt("e1_bowl"));
    questRoom(b).saveActor(a);
    failing = true;
    b.send("interact", { target: "e1_bowl" });
    await qsleep(300);
    expect(a.char.coins).toBe(3);
    expect(a.char.life?.eggs ?? []).not.toContain("E1");
    failing = false;
    await qsleep(250); // quest ops: 5/s
    b.send("interact", { target: "e1_bowl" });
    await waitFor(() => [...a.char.hotbar, ...a.char.backpack].some((s) => s?.id === "lantern_of_lacefall"));
    expect(a.char.coins).toBe(2);
    expect(characterRepo.current.load("offerer")!.coins).toBe(2);
  });
});
