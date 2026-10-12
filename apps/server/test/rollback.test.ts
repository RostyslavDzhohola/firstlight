// Seam 1: a failed SQLite save must not leave the room's memory ahead of the database (F12 review
// B6: a rolled-back pickup kept the item in the inventory while the pile still held it).

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { matchMaker } from "@colyseus/core";
import type { Room } from "@colyseus/sdk";
import { BODIES, padDirs } from "@firstlight/shared";
import { PROTOCOL_VERSION, type InvItem } from "@firstlight/shared/net/protocol";
import { CLOSE } from "@firstlight/shared/net/social";
import type { Game } from "../src/app.ts";
import { openGameDb, type Db } from "../src/db/index.ts";
import type { BodyRoom } from "../src/world/BodyRoom.ts";
import { characterRepo } from "../src/world/characters.ts";
import { pileStore } from "../src/world/piles.ts";
import { SqliteCharacterRepo, SqlitePileStore } from "../src/world/sqliteStores.ts";
import { placeDir } from "@firstlight/shared/content/places";
import { emitGameEvent } from "../src/world/events.ts";
import { joinAs, safeLeave, startServer, waitFor } from "./helpers.ts";
import { bot, ground, harness, objAt, serverRoom as questRoom, sleep as qsleep, tpAndWait, type Bot } from "./quest-helpers.ts";

let game: Game;
let dir: string;
let db: Db;
let failing = false;
const rooms: Room[] = [];

beforeEach(async () => {
  game = await startServer();
  dir = mkdtempSync(join(tmpdir(), "fl-rollback-"));
  db = openGameDb(join(dir, "game.db"));
  const repo = new SqliteCharacterRepo(db);
  const save = repo.save.bind(repo);
  repo.save = (userId, data) => {
    if (failing) throw new Error("disk I/O error (test)");
    save(userId, data);
  };
  characterRepo.current = repo;
  pileStore.current = new SqlitePileStore(db);
  failing = false;
  harness.game = game;
});
afterEach(async () => {
  failing = false;
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

function outside(metres = 40): V {
  const R = BODIES.arcadia.radius;
  const d = padDirs(BODIES.arcadia)[0]!;
  const ref = Math.abs(d[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  const k = ref[0]! * d[0] + ref[1]! * d[1] + ref[2]! * d[2];
  const t = [ref[0]! - k * d[0], ref[1]! - k * d[1], ref[2]! - k * d[2]];
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
    for (let i = 0; i < 8; i++) emitGameEvent(room, { type: "kill", npcKind: "hopbit", killerId: b.id, pos: fields });
    await qsleep(200);
    const m = () => actor(b).char.missions.find((x) => x.id === "A1")!;
    expect(m().done).toBe(false);
    expect(actor(b).char.xp).toBe(xp0);
    expect(actor(b).char.coins).toBe(0);
    expect(memCount(b, "tonic_small")).toBe(0);
    failing = false;
    emitGameEvent(room, { type: "kill", npcKind: "hopbit", killerId: b.id, pos: fields });
    await waitFor(() => m().done);
    emitGameEvent(room, { type: "kill", npcKind: "hopbit", killerId: b.id, pos: fields });
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
    for (let i = 0; i < 8; i++) emitGameEvent(room, { type: "kill", npcKind: "hopbit", killerId: b.id, pos: fields });
    await qsleep(200);
    expect(pileStore.current.list("arcadia").length).toBe(piles0);
    expect(actor(b).char.coins).toBe(0);
    failing = false;
    emitGameEvent(room, { type: "kill", npcKind: "hopbit", killerId: b.id, pos: fields });
    await waitFor(() => actor(b).char.missions.find((x) => x.id === "A1")!.done);
    await qsleep(100);
    const piles = pileStore.current.list("arcadia");
    expect(piles.length).toBe(piles0 + 1);
    expect(piles.at(-1)!.items.map((i) => `${i.id}:${i.qty}`)).toEqual(["tonic_small:2"]);
    expect(stored("overflow").coins).toBe(30);
  });
});

