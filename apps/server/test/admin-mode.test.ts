// Admin mode (D-admin-1, D-admin-3) on the real server path. The switches only exist in an admin's
// sandbox: a private BodyRoom copy of the body that nobody else can join, where nothing is saved.
// The movement check accepts admin flight and double speed only there, god mode takes no damage,
// and travel between bodies stays in the sandbox. The SQLite half (further down) replays each of
// Codex's round-2 leaks against the sandbox and shows game.db unchanged by everything done in one.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@colyseus/sdk";
import { matchMaker } from "@colyseus/core";
import { BODIES, isSafe } from "@firstlight/shared";
import { ADMIN_MODE } from "@firstlight/shared/content/admin";
import { LEVEL_CAP } from "@firstlight/shared/content/progression";
import { CLOSE } from "@firstlight/shared/net/social";
import { PF } from "@firstlight/shared/net/schema";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { motionFields, moveLimits } from "../src/world/movement.ts";
import type { PlayerActor } from "../src/world/actors.ts";
import { adminCheck, adminItems } from "../src/world/adminMode.ts";
import { addAccountStat, getAccountStat, loadCharacter, openGameDb, type Db } from "../src/db/index.ts";
import { ensureAccount } from "../src/db/accounts.ts";
import { setGameDb, stmt } from "../src/db/game-db.ts";
import { rayTerrain } from "../src/world/geometry.ts";
import { characterRepo } from "../src/world/characters.ts";
import { pileStore } from "../src/world/piles.ts";
import { progressStore, SqliteProgressStore } from "../src/world/quests/store.ts";
import { copyStateStore, SqliteCopyStateStore } from "../src/world/copyState.ts";
import { SqliteCharacterRepo, SqlitePileStore } from "../src/world/sqliteStores.ts";
import { QuestSystem } from "../src/world/quests/QuestSystem.ts";
import { EGG_TIMERS } from "../src/world/quests/eggs.ts";
import { hub } from "../src/world/hub.ts";
import { pendingSeats } from "../src/world/reservations.ts";
import { refusedWrites, runIn, SANDBOX, sandboxOf, type Sandbox } from "../src/sandbox.ts";
import { env } from "../src/env.ts";
import { banAccount, isVoiceMuted, kickUser, resetModeration, setVoiceMuted } from "../src/social/moderation.ts";
import { blockedBy, resetMemoryStore, setBlocked, storedVoiceMute, storeReport, memoryReports } from "../src/social/store.ts";
import { onlineCount, play } from "../src/world/matchmaking.ts";
import { onlineSnapshot } from "../src/ops/home.ts";
import { liveRooms } from "../src/social/presence.ts";
import { joinAs, playRequest, safeLeave, startServer, waitFor } from "./helpers.ts";
import { bot, ground, harness, me, offPad, padAt, serverRoom, sleep, tpAndWait, until, type Bot } from "./quest-helpers.ts";

beforeEach(async () => {
  harness.game = await startServer();
});
afterEach(async () => {
  for (const r of harness.rooms.splice(0)) await safeLeave(r);
  await harness.game?.close();
  harness.game = null;
});

type V = [number, number, number];
const up = (p: readonly number[]): V => {
  const l = Math.hypot(p[0]!, p[1]!, p[2]!);
  return [p[0]! / l, p[1]! / l, p[2]! / l];
};
const add = (a: readonly number[], b: readonly number[], k: number): V => [a[0]! + b[0]! * k, a[1]! + b[1]! * k, a[2]! + b[2]! * k];
/** A unit tangent at `p` (any horizontal direction). */
const tangent = (p: readonly number[]): V => {
  const u = up(p);
  const ref = Math.abs(u[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  const k = ref[0]! * u[0] + ref[1]! * u[1] + ref[2]! * u[2];
  return up([ref[0]! - k * u[0], ref[1]! - k * u[1], ref[2]! - k * u[2]]);
};

let seq = 1000;
/** Moves like a client: one input packet per 50 ms along `path`; returns the corrections received. */
async function drive(b: Bot, path: readonly V[]): Promise<number> {
  const before = b.count("correct");
  for (const p of path) {
    b.send("input", { seq: ++seq, x: p[0], y: p[1], z: p[2], fx: 1, fy: 0, fz: 0, anim: 2, t: Date.now() });
    await sleep(50);
  }
  await sleep(200);
  return b.count("correct") - before;
}

const mode = (b: Bot, args: Record<string, unknown>) => b.send("admin", { cmd: "adminmode", args });
const denied = (b: Bot, action: string, reason: string) => (b.msgs.get("denied") ?? []).some((m: { action: string; reason: string }) => m.action === action && m.reason === reason);
const actorOf = (b: Bot) => serverRoom(b).actors.get(b.id)!;
const sandboxOfBot = (b: Bot): Sandbox => serverRoom(b).sandbox!;
const items = (you: { hotbar: unknown[]; backpack: unknown[] }) => JSON.stringify([you.hotbar, you.backpack]);

/** Out on the body, away from the pad ring, unprotected. */
async function outside(b: Bot, body: "arcadia" | "portus" = "arcadia"): Promise<V> {
  const at = offPad(body, 0, 40);
  await tpAndWait(b, at);
  b.send("admin", { cmd: "unprotect" });
  await sleep(200);
  return [me(b).x, me(b).y, me(b).z];
}

/** Join a body as a dev identity without a travel ticket (admins need none). */
async function enter(userId: string, body: "arcadia" | "portus" | "hollowmere", extra: Record<string, unknown> = {}, role = "admin"): Promise<Bot> {
  return bot(userId, body, role, extra, false);
}

/**
 * As the client does it: ask the real-world room, which saves the real character and answers
 * `sandbox`; leave (a handoff); join the sandbox copy of the body through /api/play.
 */
async function intoSandbox(b: Bot, userId: string): Promise<Bot> {
  mode(b, { action: "sandbox" });
  await until("sandbox go-ahead", () => b.count("sandbox") > 0);
  const body = serverRoom(b).bodyDef.id as "arcadia" | "portus";
  await safeLeave(b.room);
  const s = await enter(userId, body, { sandbox: true });
  await until("in the sandbox", () => s.you.adminMode?.sandbox === true);
  return s;
}

/** Back to normal, as the client does it: leave the sandbox, join the real world at home. */
async function backToNormal(s: Bot, userId: string): Promise<Bot> {
  const home = s.you.adminMode.home as "arcadia" | "portus";
  await safeLeave(s.room);
  return enter(userId, home);
}

/** Wait until no room but `keep` (sandboxes, say) is open: the ones left behind have saved and gone. */
async function onlyRooms(keep: (md: { sandbox?: string }) => boolean, ms = 6000) {
  const t0 = Date.now();
  for (;;) {
    const rooms = await matchMaker.query({ name: "body" });
    if (rooms.every((r) => keep((r.metadata ?? {}) as { sandbox?: string }))) return;
    if (Date.now() - t0 > ms) throw new Error("rooms didn't close");
    await sleep(50);
  }
}

describe("admin mode in the real world", () => {
  it("a player's admin-mode commands are dropped; an admin's switches are refused outside the sandbox", async () => {
    const p = await bot("player_am", "arcadia", "");
    expect(p.you.adminMode).toBeUndefined();
    mode(p, { fly: true, god: true, speed: true });
    mode(p, { action: "sandbox" });
    await sleep(400);
    expect(p.you.adminMode).toBeUndefined();
    expect(p.count("sandbox")).toBe(0);
    const a = await bot("admin_am", "arcadia");
    expect(a.you.adminMode).toEqual({ fly: false, god: false, speed: false, sandbox: false });
    mode(a, { fly: true, action: "maxlevel" });
    await until("refused", () => denied(a, "admin", "sandbox only"));
    expect(a.you.adminMode).toEqual({ fly: false, god: false, speed: false, sandbox: false });
    expect(me(a).level).toBe(1);
    expect(moveLimits(actorOf(a), Date.now())).not.toHaveProperty("fly");
  });

  it("movement limits ignore switches without a sandbox, and on a non-admin even in one", () => {
    const sandbox = { switches: { fly: true, god: true, speed: true } } as unknown as Sandbox;
    const actor = { identity: { admin: false }, sandbox, ...motionFields(BODIES.arcadia.radius, 0) } as unknown as PlayerActor;
    expect(moveLimits(actor, 0)).not.toHaveProperty("fly");
    expect(moveLimits(actor, 0)).not.toHaveProperty("boost");
    actor.identity.admin = true;
    expect(moveLimits(actor, 0)).toMatchObject({ fly: true, boost: ADMIN_MODE.speedMult });
    delete actor.sandbox;
    expect(moveLimits(actor, 0)).not.toHaveProperty("fly");
  });
});

describe("the sandbox (D-admin-3)", () => {
  it("is a private copy of the body: a player is refused, and so is another admin holding a seat in it", async () => {
    const a = await bot("owner_sb", "arcadia");
    const s = await intoSandbox(a, "owner_sb");
    const room = serverRoom(s);
    expect(room.sandbox?.owner).toBe("owner_sb");
    expect(room.metadata.sandbox).toBe("owner_sb");
    expect(s.you.adminMode).toEqual({ fly: false, god: false, speed: false, sandbox: true, home: "arcadia" });
    // The sandbox's join ran inside it: the real world's one-actor-per-user hub never saw this body.
    expect(hub.get("owner_sb")).toBeUndefined();
    expect(runIn(room.sandbox!, () => hub.get("owner_sb")?.actor)).toBe(actorOf(s));
    // A player asking /api/play for a sandbox: refused. Public matchmaking never lands in one.
    expect(await playRequest(harness.game!, "dev:nosy:nosy", { body: "arcadia", sandbox: true })).toEqual({ ok: false, error: "forbidden" });
    const p = await bot("public_sb", "arcadia", "");
    expect(p.room.roomId).not.toBe(s.room.roomId);
    // Another admin with a valid seat into the owner's sandbox room (as /api/play would book it): onJoin refuses.
    const [cache] = await matchMaker.query({ roomId: s.room.roomId });
    const reservation = await matchMaker.reserveSeatFor(cache!, { body: "arcadia" }, { userId: "intruder", name: "intruder", admin: true } as never);
    pendingSeats.bind(pendingSeats.claim("intruder", null, "arcadia"), reservation.sessionId, s.room.roomId);
    await expect(new Client(`http://127.0.0.1:${harness.game!.port}`).consumeSeatReservation(reservation as never)).rejects.toThrow(/private sandbox/);
    expect([...room.actors.values()].map((x) => x.identity.userId)).toEqual(["owner_sb"]);
  });

  it("Fly: climbs 12 m, hovers, flies and lands with no correction and no fall damage; not without the switch", async () => {
    const a = await bot("flyer", "arcadia");
    await outside(a);
    const s = await intoSandbox(a, "flyer");
    const start: V = [me(s).x, me(s).y, me(s).z];
    s.send("admin", { cmd: "unprotect" });
    expect(await drive(s, flight(start, 12, ADMIN_MODE.climbSpeed, ADMIN_MODE.flySpeed))).toBeGreaterThan(0); // switch off
    mode(s, { fly: true });
    await until("fly on", () => s.you.adminMode?.fly === true);
    await sleep(300);
    const hp = me(s).hp;
    expect(await drive(s, flight(start, 12, ADMIN_MODE.climbSpeed, ADMIN_MODE.flySpeed))).toBe(0);
    expect(me(s).hp).toBe(hp);
  });

  it("Fly switched off mid-air: the body falls, and the fall hurts from there", async () => {
    const a = await bot("dropper", "arcadia");
    await outside(a);
    const s = await intoSandbox(a, "dropper");
    const start: V = [me(s).x, me(s).y, me(s).z];
    s.send("admin", { cmd: "unprotect" });
    mode(s, { fly: true });
    await until("fly on", () => s.you.adminMode?.fly === true);
    const u = up(start);
    const climb: V[] = [];
    for (let y = 0.4; y <= 14; y += 0.4) climb.push(add(start, u, y));
    expect(await drive(s, climb)).toBe(0);
    const hp = me(s).hp;
    mode(s, { fly: false });
    await until("fly off", () => s.you.adminMode?.fly === false);
    await waitFor(() => Math.hypot(me(s).x, me(s).y, me(s).z) < Math.hypot(...start) + 1, 6000);
    await until("fall damage", () => me(s).hp < hp);
  });

  it("Speed ×2: 16 m/s for 2 s passes with the switch, not without it", async () => {
    const a = await bot("sprinter", "arcadia");
    await outside(a);
    const s = await intoSandbox(a, "sprinter");
    const start: V = [me(s).x, me(s).y, me(s).z];
    expect(await drive(s, shuttle(start, 16, 2))).toBeGreaterThan(0);
    mode(s, { speed: true });
    await until("speed on", () => s.you.adminMode?.speed === true);
    await sleep(400); // the bank refills
    expect(await drive(s, shuttle(start, 16, 2))).toBe(0);
  });

  it("God: no damage; off, it does", async () => {
    const a = await bot("immortal", "arcadia");
    await outside(a);
    const s = await intoSandbox(a, "immortal");
    s.send("admin", { cmd: "unprotect" });
    mode(s, { god: true });
    await until("god on", () => s.you.adminMode?.god === true);
    s.send("admin", { cmd: "damage", args: { target: s.id, amount: 500 } });
    await sleep(400);
    expect(me(s).hp).toBe(me(s).maxHp);
    expect(s.count("death")).toBe(0);
    mode(s, { god: false });
    await until("god off", () => s.you.adminMode?.god === false);
    s.send("admin", { cmd: "damage", args: { target: s.id, amount: 30 } });
    await until("hurt", () => me(s).hp < me(s).maxHp);
  });

  it("travel between bodies stays in the sandbox: the switches and the kit come along, home stays put", async () => {
    const a = await bot("traveller", "arcadia");
    const s = await intoSandbox(a, "traveller");
    mode(s, { fly: true, speed: true, action: "maxlevel" });
    await until("kit", () => s.you.adminMode?.fly === true && me(s).level === LEVEL_CAP);
    // A portal ticket, then the client's travel: it asks /api/play for the sandbox again.
    serverRoom(s).actors.get(s.id)!.char.travelTo = "portus";
    await safeLeave(s.room);
    const t = await enter("traveller", "portus", { sandbox: true });
    expect(serverRoom(t).sandbox).toBe(sandboxOf("traveller"));
    expect(t.you.adminMode).toEqual({ fly: true, god: false, speed: true, sandbox: true, home: "arcadia" });
    expect(me(t).level).toBe(LEVEL_CAP);
    // Back to normal: home (Arcadia), the real character.
    const n = await backToNormal(t, "traveller");
    expect(serverRoom(n).bodyDef.id).toBe("arcadia");
    expect(serverRoom(n).sandbox).toBeNull();
    expect(n.you.adminMode).toEqual({ fly: false, god: false, speed: false, sandbox: false });
    expect(me(n).level).toBe(1);
    expect(sandboxOf("traveller")).toBeUndefined(); // the next one starts fresh
  });

  it("joining the real world in another window closes the sandbox and removes its body", async () => {
    const a = await bot("two_windows", "arcadia");
    const s = await intoSandbox(a, "two_windows");
    let code = 0;
    s.room.onLeave((c: number) => (code = c));
    const other = await enter("two_windows", "arcadia");
    await until("sandbox body gone", () => code === CLOSE.ELSEWHERE);
    expect(sandboxOf("two_windows")).toBeUndefined();
    expect(other.you.adminMode.sandbox).toBe(false);
  });

  it("Codex r3-4: a sandbox isn't the public world (online count, home page, public capacity) and has its own limit", async () => {
    const a = await bot("private_one", "arcadia");
    const s = await intoSandbox(a, "private_one");
    await waitFor(() => !hub.get("private_one"));
    expect(serverRoom(s).actors.size).toBe(1);
    expect(await onlineCount(false)).toBe(0);
    expect(onlineSnapshot(liveRooms as never).total).toBe(0);
    // A global cap of 1 with the sandbox open: a real player still gets in.
    const limits = { maxClients: 40, soloFillLimit: 36, maxCopiesPerBody: 2, globalCap: 1 };
    expect((await play({ userId: "public_one", name: "public_one", admin: false } as never, { body: "portus" }, limits)).ok).toBe(true);
    // Sandboxes have their own limit instead.
    const other = await bot("second_admin", "portus");
    await safeLeave(other.room);
    const max = SANDBOX.MAX_OPEN;
    SANDBOX.MAX_OPEN = 1;
    try {
      expect(await playRequest(harness.game!, "dev:second_admin:second_admin:admin", { body: "portus", sandbox: true })).toEqual({ ok: false, error: "sandboxes full" });
    } finally {
      SANDBOX.MAX_OPEN = max;
    }
  });
});

describe("nothing in a sandbox is saved (D-admin-3, real path: SQLite)", () => {
  let dir = "";
  let db: Db;
  const install = () => {
    db = openGameDb(join(dir, "game.db"));
    characterRepo.current = new SqliteCharacterRepo(db);
    pileStore.current = new SqlitePileStore(db);
    progressStore.current = new SqliteProgressStore(db);
    copyStateStore.current = new SqliteCopyStateStore(db);
    setGameDb(db); // the social store and analytics write game.db too
  };
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "fl-sandbox-"));
    install();
  });
  afterEach(async () => {
    // The server goes first: its last saves (lingering bodies, shutdown) still have the database.
    for (const r of harness.rooms.splice(0)) await safeLeave(r);
    await harness.game?.close();
    harness.game = null;
    setGameDb(null);
    db.close();
    rmSync(dir, { recursive: true, force: true });
    adminCheck.current = () => null;
  });

  /** Every row of every table: the whole of game.db. */
  const snapshot = () => {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[];
    return JSON.stringify(tables.map((t) => [t.name, db.prepare(`SELECT * FROM "${t.name}" ORDER BY rowid`).all()]));
  };

  /** A real admin out on Arcadia, then in their sandbox with the real world closed behind them. */
  async function owner(userId: string): Promise<{ s: Bot; real: { level: number; inv: string; coins: number; xp: number } }> {
    const a = await bot(userId, "arcadia");
    await outside(a);
    const real = { level: a.you.level, inv: items(a.you), coins: a.you.coins, xp: a.you.xp };
    const s = await intoSandbox(a, userId);
    await waitFor(() => !hub.get(userId)); // the real body saved and left the world (a handoff: no linger)
    return { s, real };
  }

  it("the whole kit, kills, loot, props, pads, eggs, a bypassing writer and travel leave game.db as it was", async () => {
    const { s } = await owner("auditor");
    await onlyRooms((md) => md.sandbox === "auditor"); // the real room closed (its last writes done)
    const before = snapshot();
    const refusedBefore = refusedWrites.count;
    const sb = sandboxOfBot(s);
    mode(s, { fly: true, god: true, speed: true, action: "maxlevel" });
    mode(s, { action: "giveall" });
    mode(s, { action: "hand", id: "comet", tier: 3 });
    await until("kit", () => me(s).level === LEVEL_CAP && s.you.hotbar[s.you.selected]?.id === "comet");
    // A kill: XP, coins, loot on the ground (deferred payouts and piles), mission and hunt counters.
    s.send("admin", { cmd: "unprotect" }); // a protected attacker can't hurt
    s.send("npc", { cmd: "spawn", kind: "hopbit", x: me(s).x, y: me(s).y, z: me(s).z, instant: true, req: 1 });
    await until("npc", () => s.count("npcInfo") > 0);
    const npcId = s.last("npcInfo").id as string;
    s.send("npc", { cmd: "hurt", id: npcId, amount: 10_000, as: s.id });
    await until("paid", () => s.toasts.some((t) => /XP/.test(t)) || s.you.coins > 0, 4000).catch(() => {});
    await sleep(500); // the kill's deferred loot
    // A drop (a pile), a prop broken by a real rocket (account counter, copy state).
    s.send("drop", { slot: (s.you.selected + 1) % 4 });
    await until("pile", () => pileStore.current.list("arcadia").length === 0 && runIn(sb, () => pileStore.current.list("arcadia").length) > 0);
    const { shooter, prop } = propInSight(s, "crate");
    await tpAndWait(s, shooter);
    s.send("admin", { cmd: "unprotect" });
    await sleep(200);
    fireAt(s, prop);
    await until("prop broken", () => runIn(sb, () => progressStore.current.stat("auditor", "props_broken")) > 0, 8000);
    // A pad discovered, an egg claimed (item, medal, Hall of Firsts), a wrong answer's lockout.
    await tpAndWait(s, padAt("arcadia", 3));
    await until("pad", () => s.you.pads.includes(3));
    const quests = serverRoom(s).systems.find((x): x is QuestSystem => x instanceof QuestSystem)!;
    runIn(sb, () => quests.claimEgg(actorOf(s), "E2")); // as the room's own puzzle code does
    runIn(sb, () => EGG_TIMERS.puzzles.set("auditor|E5", Date.now() + 60_000));
    // A writer that forgot the sandboxed stores and wrote game.db itself: refused at stmt().
    runIn(sb, () => {
      addAccountStat(db, "auditor", "props_broken", 5);
      stmt(db, "UPDATE character SET level = 20, coins = 999999 WHERE user_id = ?").run("auditor");
    });
    expect(refusedWrites.count).toBeGreaterThan(refusedBefore);
    // Travel to Portus, still in the sandbox; then out of it.
    actorOf(s).char.travelTo = "portus";
    await safeLeave(s.room);
    const t = await enter("auditor", "portus", { sandbox: true });
    expect(me(t).level).toBe(LEVEL_CAP);
    await safeLeave(t.room);
    await onlyRooms(() => false);
    expect(snapshot()).toBe(before);
    expect(EGG_TIMERS.puzzles.size).toBe(0);
    // Back to normal: the real character, as it was, on its own body.
    const n = await enter("auditor", "arcadia");
    expect(me(n).level).toBe(1);
    expect(n.you.pads).not.toContain(3);
    expect(n.you.medals ?? []).toEqual([]);
  });

  it("Codex 1: a boosted Comet fired in the sandbox can't reach a real player, before or after Back to normal", async () => {
    ensureAccount(db, "target"); // a player's saves need the account row (and their travel ticket)
    const p = await bot("target", "arcadia", "");
    const pa = serverRoom(p).actors.get(p.id)!;
    const at = offPad("arcadia", 0, 40);
    pa.state.x = pa.lastX = at[0];
    pa.state.y = pa.lastY = at[1];
    pa.state.z = pa.lastZ = at[2];
    pa.protectedUntil = 0;
    await waitFor(() => (me(p).flags & (PF.SAFE | PF.PROTECTED)) === 0);
    const { s } = await owner("bomber");
    mode(s, { action: "maxlevel" });
    mode(s, { action: "hand", id: "comet", tier: 3 });
    await until("comet", () => s.you.hotbar[s.you.selected]?.id === "comet" && me(s).level === LEVEL_CAP);
    await tpAndWait(s, offPad("arcadia", 0, 46));
    s.send("admin", { cmd: "unprotect" });
    await sleep(200);
    const hp = me(p).hp;
    for (let i = 0; i < 3; i++) {
      fireAt(s, add(at, up(at), 1));
      await sleep(250);
    }
    const n = await backToNormal(s, "bomber"); // with rockets still in the air
    await sleep(2000);
    expect(me(p).hp).toBe(hp);
    expect((p.msgs.get("projectile") ?? []).length).toBe(0); // the real room never saw one
    expect(n.you.adminMode.sandbox).toBe(false);
  });

  it("Codex 2: kill rewards and loot from the sandbox never reach the real character", async () => {
    const { s, real } = await owner("hunter");
    s.send("admin", { cmd: "unprotect" }); // a protected attacker can't hurt
    s.send("npc", { cmd: "spawn", kind: "hopbit", x: me(s).x, y: me(s).y, z: me(s).z, instant: true, req: 2 });
    await until("npc", () => s.count("npcInfo") > 0);
    s.send("npc", { cmd: "hurt", id: s.last("npcInfo").id, amount: 10_000, as: s.id });
    await until("paid in the sandbox", () => s.you.xp > real.xp);
    const n = await backToNormal(s, "hunter");
    await sleep(1500); // any payout retry would have run
    expect(n.you.xp).toBe(real.xp);
    expect(n.you.coins).toBe(real.coins);
    expect(loadCharacter(db, "hunter")!.xp).toBe(real.xp);
    expect(pileStore.current.list("arcadia")).toEqual([]);
  });

  it("Codex 3: egg puzzle state and claims from the sandbox aren't in the real world", async () => {
    const { s } = await owner("egghead");
    const sb = sandboxOfBot(s);
    const quests = serverRoom(s).systems.find((x): x is QuestSystem => x instanceof QuestSystem)!;
    quests.qp(actorOf(s)).seq.E10 = ["root", "bead"];
    runIn(sb, () => quests.claimEgg(actorOf(s), "E2"));
    expect(runIn(sb, () => quests.life(actorOf(s)).eggs)).toContain("E2");
    const n = await backToNormal(s, "egghead");
    const real = serverRoom(n).systems.find((x): x is QuestSystem => x instanceof QuestSystem)!;
    expect(real.qp(actorOf(n)).seq.E10).toEqual([]);
    expect(real.life(actorOf(n)).eggs).toEqual([]);
    expect(progressStore.current.hall()).toEqual([]);
    expect(progressStore.current.medals("egghead")).toEqual([]);
  });

  it("Codex 4: account counters, pads and onboarding flags written in the sandbox stay out of the account", async () => {
    const { s } = await owner("counter");
    const sb = sandboxOfBot(s);
    const pads = progressStore.current.pads("counter", "arcadia");
    await tpAndWait(s, padAt("arcadia", 3));
    await until("pad", () => s.you.pads.includes(3));
    runIn(sb, () => progressStore.current.addStat("counter", "props_broken", 3)); // as the destruction system does
    runIn(sb, () => progressStore.current.addStat("counter", "onboarding", 1));
    expect(runIn(sb, () => progressStore.current.stat("counter", "props_broken"))).toBe(3);
    await backToNormal(s, "counter");
    expect(progressStore.current.pads("counter", "arcadia")).toEqual(pads);
    expect(getAccountStat(db, "counter", "props_broken")).toBe(0);
    expect(getAccountStat(db, "counter", "onboarding")).toBe(0);
  });

  it("Codex 5: a Patchkit in the sandbox can't heal a real player (nobody else can be in it)", async () => {
    ensureAccount(db, "patient");
    const p = await bot("patient", "arcadia", "");
    const pa = serverRoom(p).actors.get(p.id)!;
    pa.state.hp = 40;
    const { s } = await owner("medic");
    mode(s, { action: "hand", id: "patchkit", tier: 3 });
    await until("patchkit", () => s.you.hotbar[s.you.selected]?.id === "patchkit");
    const pp = [pa.state.x, pa.state.y, pa.state.z];
    await tpAndWait(s, ground("arcadia", up(pp)));
    s.send("use", { slot: s.you.selected, targetId: p.id });
    await sleep(3000);
    expect(pa.state.hp).toBe(40);
  });

  it("Codex 6: no sandbox while the real character is dead; the real character stays dead, nothing flips", async () => {
    const a = await bot("ghost", "arcadia");
    await outside(a);
    a.send("admin", { cmd: "damage", args: { target: a.id, amount: 100_000 } });
    await until("dead", () => a.count("death") > 0);
    mode(a, { action: "sandbox" });
    await until("refused", () => denied(a, "sandbox", "respawn first"));
    await safeLeave(a.room);
    await onlyRooms(() => false);
    const r = await fetch(`http://127.0.0.1:${harness.game!.port}/api/play`, {
      method: "POST",
      headers: { Authorization: "Bearer dev:ghost:ghost:admin", "Content-Type": "application/json" },
      body: JSON.stringify({ v: (await import("@firstlight/shared/net/protocol")).PROTOCOL_VERSION, body: "arcadia", sandbox: true }),
    });
    expect(r.status).toBe(403);
    expect(await r.json()).toEqual({ ok: false, error: "respawn first" });
    expect(sandboxOf("ghost")).toBeUndefined();
    const n = await enter("ghost", "arcadia");
    expect(n.count("death")).toBeGreaterThan(0);
    expect(loadCharacter<{ dead?: boolean }>(db, "ghost")!.inventory.dead).toBe(true);
  });

  it("Codex 7: admin rights are asked of the account before every npc tool, and losing them ends the sandbox", async () => {
    const a = await bot("demoted", "arcadia");
    actorOf(a).identity.account = true; // an account identity: checked against the account table
    adminCheck.current = (id) => id !== "demoted";
    a.send("npc", { cmd: "spawn", kind: "hopbit", x: me(a).x, y: me(a).y, z: me(a).z, req: 7 });
    await sleep(500); // well inside the 2 s passive recheck
    expect(a.count("npcInfo")).toBe(0);
    expect(me(a).flags & PF.ADMIN).toBe(0);
    adminCheck.current = () => null;
    const b = await bot("demoted_too", "arcadia");
    const s = await intoSandbox(b, "demoted_too");
    actorOf(s).identity.account = true;
    let code = 0;
    s.room.onLeave((c: number) => (code = c));
    adminCheck.current = (id) => id !== "demoted_too";
    s.send("npc", { cmd: "spawn", kind: "hopbit", x: me(s).x, y: me(s).y, z: me(s).z, req: 8 });
    await until("sent back", () => code === CLOSE.SANDBOX_OVER);
    expect(s.count("npcInfo")).toBe(0);
    expect(sandboxOf("demoted_too")).toBeUndefined();
  });

  it("Codex r3-1: a seat reserved before the sandbox closed is refused; a new sandbox is a new generation", async () => {
    const a = await bot("late_seat", "arcadia");
    const s = await intoSandbox(a, "late_seat");
    mode(s, { god: true, action: "maxlevel" });
    await until("kit", () => me(s).level === LEVEL_CAP && s.you.adminMode?.god === true);
    const oldRoom = serverRoom(s);
    const oldGen = oldRoom.sandbox!.id;
    const spare = await playRequest(harness.game!, "dev:late_seat:late_seat:admin", { body: "arcadia", sandbox: true });
    expect(spare.ok).toBe(true);
    // The real world (another window): the sandbox closes; then the old seat is tried within its timeout.
    const n = await enter("late_seat", "arcadia");
    expect(sandboxOf("late_seat")).toBeUndefined();
    if (!spare.ok) return;
    await expect(new Client(`http://127.0.0.1:${harness.game!.port}`).consumeSeatReservation(spare.reservation as never)).rejects.toThrow(/sandbox closed/);
    expect(oldRoom.actors.size).toBe(0);
    expect(hub.get("late_seat")?.actor).toBe(actorOf(n));
    // The next sandbox: a newer generation, from the real character, switches off.
    const s2 = await intoSandbox(n, "late_seat");
    expect(serverRoom(s2).sandbox!.id).toBeGreaterThan(oldGen);
    expect(serverRoom(s2)).not.toBe(oldRoom);
    expect(s2.you.adminMode.god).toBe(false);
    expect(me(s2).level).toBe(1);
  });

  it("Codex r3-2: voice moderation and the caches beside the store can't change from a sandbox", async () => {
    env.voice = true;
    try {
      const a = await bot("muted_by_sb", "arcadia");
      const s = await intoSandbox(a, "muted_by_sb");
      s.send("voice:mute", { target: s.id, on: true });
      await until("refused", () => (s.msgs.get("voice:denied") ?? []).some((m: { action: string }) => m.action === "voice:mute"));
      expect(me(s).flags & PF.VOICE_MUTED).toBe(0);
      // Code inside the sandbox that calls moderation or the social store itself changes nothing either.
      const sb = sandboxOfBot(s);
      runIn(sb, () => {
        setVoiceMuted("muted_by_sb", true);
        expect(kickUser("bystander_r3")).toBe(false);
        expect(setBlocked("muted_by_sb", "bystander_r3", true)).toBe(false);
      });
      expect(isVoiceMuted("muted_by_sb")).toBe(false);
      expect(storedVoiceMute("muted_by_sb")).toBe(false);
      expect(blockedBy("muted_by_sb")).toEqual([]);
      expect(await playRequest(harness.game!, "dev:bystander_r3:bystander_r3", { body: "portus" })).toMatchObject({ ok: true }); // not kicked
      const n = await backToNormal(s, "muted_by_sb");
      expect(me(n).flags & PF.VOICE_MUTED).toBe(0);
    } finally {
      env.voice = false;
      resetModeration();
    }
  });

  it("Codex r3-3: a kick or a ban reaches a sandbox body at once, closes the sandbox and keeps it out", async () => {
    for (const [uid, action, code] of [["kicked_sb", "kick", CLOSE.KICKED], ["banned_sb", "ban", CLOSE.BANNED]] as const) {
      const a = await bot(uid, "arcadia");
      const s = await intoSandbox(a, uid);
      const room = serverRoom(s);
      let closed = 0;
      s.room.onLeave((c: number) => (closed = c));
      if (action === "kick") expect(kickUser(uid)).toBe(true);
      else expect(banAccount(uid, "test", null)).toBeGreaterThan(0);
      await until(`${action}: removed`, () => closed === code);
      expect(room.actors.size).toBe(0);
      expect(sandboxOf(uid)).toBeUndefined();
      expect(await playRequest(harness.game!, `dev:${uid}:${uid}:admin`, { body: "arcadia", sandbox: true })).toEqual({ ok: false, error: action === "kick" ? "kicked" : "banned" });
    }
    resetModeration();
  });

  it("Codex r4: another admin's in-game mod kick and ban (by account id) reach a sandbox body", async () => {
    const mod = await bot("moderator_r4", "portus");
    for (const [uid, action, code] of [["kick_me_r4", "kick", CLOSE.KICKED], ["ban_me_r4", "ban", CLOSE.BANNED]] as const) {
      const a = await bot(uid, "arcadia");
      const s = await intoSandbox(a, uid);
      const room = serverRoom(s);
      let closed = 0;
      s.room.onLeave((c: number) => (closed = c));
      const toasts = mod.toasts.length;
      mod.send("mod", { action, target: uid, reason: "r4" });
      await until(`${action}: removed`, () => closed === code);
      expect(denied(mod, "mod", "player not found")).toBe(false);
      expect(mod.toasts.length).toBeGreaterThan(toasts);
      expect(room.actors.size).toBe(0);
      expect(sandboxOf(uid)).toBeUndefined();
      expect(await playRequest(harness.game!, `dev:${uid}:${uid}:admin`, { body: "arcadia" })).toEqual({ ok: false, error: action === "kick" ? "kicked" : "banned" });
    }
    resetModeration();
  });

  it("a restart drops the sandbox; the real character is as it was and the next sandbox starts from it", async () => {
    const { s, real } = await owner("restarter");
    mode(s, { fly: true, action: "maxlevel" });
    mode(s, { action: "giveall" });
    await until("kit", () => me(s).level === LEVEL_CAP);
    const before = snapshot();
    // Shut down (rooms save what they hold: the sandbox's into the sandbox) and start again.
    await harness.game!.close();
    harness.rooms.splice(0);
    expect(snapshot()).toBe(before);
    setGameDb(null);
    db.close();
    hub.clear();
    harness.game = await startServer();
    install();
    expect(sandboxOf("restarter")).toBeUndefined();
    const n = await enter("restarter", "arcadia");
    expect({ level: n.you.level, inv: items(n.you), coins: n.you.coins, xp: n.you.xp }).toEqual(real);
    const s2 = await intoSandbox(n, "restarter");
    expect(s2.you.adminMode).toEqual({ fly: false, god: false, speed: false, sandbox: true, home: "arcadia" });
    expect(me(s2).level).toBe(1);
  });
});

describe("the sandbox's write guard (game.db stmt)", () => {
  it("refuses writes inside a sandbox, keeps reads, and writes as usual outside", () => {
    const db = openGameDb(":memory:");
    ensureAccount(db, "u1");
    const sb = { owner: "u1", stores: new Map() } as unknown as Sandbox;
    const n = refusedWrites.count;
    runIn(sb, () => {
      expect(addAccountStat(db, "u1", "x", 2)).toBe(0);
      expect(getAccountStat(db, "u1", "x")).toBe(0);
    });
    expect(refusedWrites.count).toBe(n + 1);
    expect(addAccountStat(db, "u1", "x", 2)).toBe(2);
    db.close();
  });

  it("the social store's memory fallback (no game.db) refuses a sandbox's writes too", () => {
    resetMemoryStore();
    const sb = { owner: "u2", stores: new Map() } as unknown as Sandbox;
    runIn(sb, () => {
      expect(setBlocked("u2", "u3", true)).toBe(false);
      expect(storeReport({ reporter: "u2", target: "u3", body: null, pos: null, reason: "spam" })).toBe(0);
    });
    expect(blockedBy("u2")).toEqual([]);
    expect(memoryReports()).toHaveLength(0);
    expect(setBlocked("u2", "u3", true)).toBe(true); // outside, as before
    resetMemoryStore();
  });

  it("game.db is only reached through stmt(): no raw prepare, exec or pragma elsewhere in the server", async () => {
    const { readdirSync, readFileSync, statSync } = await import("node:fs");
    const root = join(import.meta.dirname, "../src");
    const files: string[] = [];
    const walk = (d: string) => {
      for (const f of readdirSync(d)) {
        const p = join(d, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith(".ts")) files.push(p);
      }
    };
    walk(root);
    // game-db.ts is the entry point; schema.ts migrates at boot; leaderboard.ts explains its plan in a
    // test hook; auth/ holds the sign-in database (auth.db), which no room code reaches.
    const allowed = /\/(db\/game-db|db\/schema|db\/leaderboard)\.ts$|\/auth\//;
    const raw = files.filter((f) => !allowed.test(f) && /\.(prepare|exec|pragma)\(|new Database\(/.test(readFileSync(f, "utf8")));
    expect(raw.map((f) => f.slice(root.length))).toEqual([]);
    const authFromRooms = files.filter((f) => /\/(world|social)\//.test(f) && /authDb/.test(readFileSync(f, "utf8")));
    expect(authFromRooms).toEqual([]);
  });
});

/** Up `h` metres at `climb` m/s, hover a second, sideways and back at `side` m/s, then straight down. */
function flight(start: V, h: number, climb: number, side: number): V[] {
  const u = up(start);
  const t = tangent(start);
  const path: V[] = [];
  for (let y = climb / 20; y <= h; y += climb / 20) path.push(add(start, u, y));
  const top = add(start, u, h);
  for (let i = 0; i < 20; i++) path.push(top);
  for (let x = side / 20; x <= 6; x += side / 20) path.push(add(top, t, x));
  for (let x = 6; x >= 0; x -= side / 20) path.push(add(top, t, x));
  for (let y = h; y >= 0; y -= climb / 20) path.push(add(start, u, y));
  return path;
}

/** Back and forth along a 4 m line at `speed` m/s for `seconds`. */
function shuttle(start: V, speed: number, seconds: number): V[] {
  const t = tangent(start);
  const path: V[] = [];
  let x = 0, dir = 1;
  for (let i = 0; i < seconds * 20; i++) {
    x += (dir * speed) / 20;
    if (x > 4 || x < 0) {
      dir = -dir;
      x += (2 * dir * speed) / 20;
    }
    path.push(add(start, t, x));
  }
  return path;
}

/** Fire the held weapon from the head at `at` (fire rate and reload waived). */
function fireAt(b: Bot, at: readonly number[]) {
  const a = actorOf(b);
  a.lastAttackAt = 0;
  a.reloadEndsAt = 0;
  a.overheatUntil = 0;
  const p = me(b);
  const o = add([p.x, p.y, p.z], up([p.x, p.y, p.z]), 1.6);
  const d = [at[0]! - o[0], at[1]! - o[1], at[2]! - o[2]];
  const l = Math.hypot(d[0]!, d[1]!, d[2]!);
  b.send("fire", { slot: b.you.selected, ox: o[0], oy: o[1], oz: o[2], dx: d[0]! / l, dy: d[1]! / l, dz: d[2]! / l, t: Date.now() });
}

/** A crate with a clear line to it from a spot outside the safe ring (quests-content.test.ts). */
function propInSight(b: Bot, kind: string): { shooter: V; prop: V } {
  const room = serverRoom(b);
  const sys = room.systems.find((x) => "brokenUntil" in x) as unknown as { list: { kind: string; index: number; px: number; py: number; pz: number; cx: number; cy: number; cz: number; rx: number; ry: number; rz: number; fx: number; fy: number; fz: number; foot: number }[] };
  for (const p of sys.list) {
    if (p.kind !== kind) continue;
    for (let k = 0; k < 12; k++) {
      const a = (k / 12) * Math.PI * 2;
      const c = Math.cos(a), s = Math.sin(a), r = p.foot + 7;
      const at = [p.px + (p.rx * c + p.fx * s) * r, p.py + (p.ry * c + p.fy * s) * r, p.pz + (p.rz * c + p.fz * s) * r];
      const shooter = ground("arcadia", up(at));
      if (isSafe(BODIES.arcadia, ...shooter) || Math.hypot(...shooter) < BODIES.arcadia.radius + BODIES.arcadia.waterLevel + 0.5) continue;
      const head = add(shooter, up(shooter), 1.6);
      const centre: V = [p.cx, p.cy, p.cz];
      const v = [centre[0] - head[0], centre[1] - head[1], centre[2] - head[2]];
      const len = Math.hypot(v[0]!, v[1]!, v[2]!);
      const d: V = [v[0]! / len, v[1]! / len, v[2]! / len];
      if (rayTerrain(room.terrain, head, d, len, 0.5) < len) continue;
      if (room.host.props?.raycast(head, d, len + 1)?.index !== p.index) continue;
      return { shooter, prop: centre };
    }
  }
  throw new Error(`no ${kind} in sight`);
}
