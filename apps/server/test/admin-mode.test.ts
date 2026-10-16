// Admin mode (D-admin-1) on the real server path: the switches only work for admin accounts, the
// movement check accepts admin flight and double speed only with the switch on, god mode takes no
// damage but changes nothing about who the admin can hurt, and max level / every item / back to
// normal round-trip the character (also across a rejoin).

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BODIES } from "@firstlight/shared";
import { ADMIN_MODE } from "@firstlight/shared/content/admin";
import { LEVEL_CAP } from "@firstlight/shared/content/progression";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { motionFields, moveLimits } from "../src/world/movement.ts";
import type { PlayerActor } from "../src/world/actors.ts";
import { ADMIN_RECHECK_MS, adminCheck, adminItems } from "../src/world/adminMode.ts";
import { openGameDb, loadCharacter, type Db } from "../src/db/index.ts";
import { ensureAccount, setDisplayName } from "../src/db/accounts.ts";
import { topLevels } from "../src/db/leaderboard.ts";
import { characterRepo } from "../src/world/characters.ts";
import { pileStore } from "../src/world/piles.ts";
import { SqliteCharacterRepo, SqlitePileStore } from "../src/world/sqliteStores.ts";
import { QuestSystem } from "../src/world/quests/QuestSystem.ts";
import { hub } from "../src/world/hub.ts";
import { safeLeave, startServer, waitFor } from "./helpers.ts";
import { bot, harness, me, objAt, offPad, serverRoom, sleep, tpAndWait, until, type Bot } from "./quest-helpers.ts";

beforeEach(async () => {
  harness.game = await startServer();
});
afterEach(async () => {
  for (const r of harness.rooms.splice(0)) await safeLeave(r);
  await harness.game!.close();
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

/** Out on Arcadia, away from the pad ring, unprotected. */
async function outside(b: Bot): Promise<V> {
  const at = offPad("arcadia", 0, 40);
  await tpAndWait(b, at);
  b.send("admin", { cmd: "unprotect" });
  await sleep(200);
  return [me(b).x, me(b).y, me(b).z];
}

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

/** Back and forth along a 4 m line at `speed` m/s for `seconds` (no props in the way, the charge is the same). */
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

describe("admin mode switches", () => {
  it("only admins get them: a player's admin command is dropped and `you` has no admin mode", async () => {
    const p = await bot("player_am", "arcadia", "");
    expect(p.you.adminMode).toBeUndefined();
    mode(p, { fly: true, god: true, speed: true });
    await sleep(400);
    expect(p.you.adminMode).toBeUndefined();
    expect(serverRoom(p).actors.get(p.id)!.adminMode).toBeUndefined();
    const a = await bot("admin_am", "arcadia");
    expect(a.you.adminMode).toEqual({ fly: false, god: false, speed: false, session: false });
    mode(a, { fly: true });
    await until("fly on", () => a.you.adminMode?.fly === true);
  });

  it("movement limits ignore switches on a non-admin actor (even if one were set)", () => {
    const actor = { identity: { admin: false }, adminMode: { fly: true, god: true, speed: true }, ...motionFields(BODIES.arcadia.radius, 0) } as unknown as PlayerActor;
    expect(moveLimits(actor, 0)).not.toHaveProperty("fly");
    expect(moveLimits(actor, 0)).not.toHaveProperty("boost");
    actor.identity.admin = true;
    expect(moveLimits(actor, 0)).toMatchObject({ fly: true, boost: ADMIN_MODE.speedMult });
  });
});

describe("admin flight and speed, as the movement check sees them", () => {
  it("an admin with Fly on climbs 12 m, hovers, flies and lands: no correction, no fall damage", async () => {
    const a = await bot("flyer", "arcadia");
    const start = await outside(a);
    mode(a, { fly: true });
    await until("fly on", () => a.you.adminMode?.fly === true);
    const hp = me(a).hp;
    expect(await drive(a, flight(start, 12, ADMIN_MODE.climbSpeed, ADMIN_MODE.flySpeed))).toBe(0);
    expect(me(a).hp).toBe(hp);
  });

  it("the same flight is refused without the switch, and for a player", async () => {
    const a = await bot("grounded_admin", "arcadia");
    const start = await outside(a);
    expect(await drive(a, flight(start, 12, ADMIN_MODE.climbSpeed, ADMIN_MODE.flySpeed))).toBeGreaterThan(0);
    const p = await bot("would_fly", "arcadia", "");
    const pStart = await (async () => {
      const at = offPad("arcadia", 0, 46);
      p.send("admin", { cmd: "teleport", args: { x: at[0], y: at[1], z: at[2] } }); // dropped: not an admin
      await sleep(300);
      return [me(p).x, me(p).y, me(p).z] as V;
    })();
    mode(p, { fly: true });
    expect(await drive(p, flight(pStart, 12, ADMIN_MODE.climbSpeed, ADMIN_MODE.flySpeed))).toBeGreaterThan(0);
  });

  it("Fly switched off mid-air: the body falls, and the fall hurts from there", async () => {
    const a = await bot("dropper", "arcadia");
    const start = await outside(a);
    mode(a, { fly: true });
    await until("fly on", () => a.you.adminMode?.fly === true);
    const u = up(start);
    const climb: V[] = [];
    for (let y = 0.4; y <= 14; y += 0.4) climb.push(add(start, u, y));
    expect(await drive(a, climb)).toBe(0);
    const hp = me(a).hp;
    mode(a, { fly: false });
    await until("fly off", () => a.you.adminMode?.fly === false);
    // Silent client: the server's own gravity brings it down and charges the fall.
    await waitFor(() => Math.hypot(me(a).x, me(a).y, me(a).z) < Math.hypot(...start) + 1, 6000);
    await until("fall damage", () => me(a).hp < hp);
  });

  it("Speed ×2: 16 m/s for 2 s passes for an admin with the switch, not without it or for a player", async () => {
    const a = await bot("sprinter", "arcadia");
    const start = await outside(a);
    expect(await drive(a, shuttle(start, 16, 2))).toBeGreaterThan(0); // switch off: corrected
    mode(a, { speed: true });
    await until("speed on", () => a.you.adminMode?.speed === true);
    await sleep(400); // the bank refills
    expect(await drive(a, shuttle(start, 16, 2))).toBe(0);
    const p = await bot("would_sprint", "arcadia", "");
    mode(p, { speed: true });
    await sleep(300);
    expect(await drive(p, shuttle([me(p).x, me(p).y, me(p).z], 16, 2))).toBeGreaterThan(0);
  });
});

describe("god mode", () => {
  it("an admin with God on takes no damage; off, it does", async () => {
    const a = await bot("immortal", "arcadia");
    await outside(a);
    mode(a, { god: true });
    await until("god on", () => a.you.adminMode?.god === true);
    a.send("admin", { cmd: "damage", args: { target: a.id, amount: 500 } });
    await sleep(400);
    expect(me(a).hp).toBe(me(a).maxHp);
    expect(a.count("death")).toBe(0);
    mode(a, { god: false });
    await until("god off", () => a.you.adminMode?.god === false);
    a.send("admin", { cmd: "damage", args: { target: a.id, amount: 30 } });
    await until("hurt", () => me(a).hp < me(a).maxHp);
  });

  it("God doesn't let the admin hurt a player in a safe zone", async () => {
    const a = await bot("god_shooter", "arcadia", "admin", { starter: 3 }); // carbine
    const p = await bot("on_the_pad", "arcadia", "");
    await outside(a);
    mode(a, { god: true });
    await until("god on", () => a.you.adminMode?.god === true);
    await waitFor(() => (me(p).flags & 1) !== 0); // the player stands in the arrival ring: safe
    const hp = me(p).hp;
    const o = add([me(a).x, me(a).y, me(a).z], up([me(a).x, me(a).y, me(a).z]), 1.6);
    const t = add([me(p).x, me(p).y, me(p).z], up([me(p).x, me(p).y, me(p).z]), 1);
    const d = [t[0] - o[0], t[1] - o[1], t[2] - o[2]];
    const l = Math.hypot(d[0]!, d[1]!, d[2]!);
    for (let i = 0; i < 3; i++) {
      a.send("fire", { slot: 0, ox: o[0], oy: o[1], oz: o[2], dx: d[0]! / l, dy: d[1]! / l, dz: d[2]! / l, t: Date.now() });
      await sleep(300);
    }
    expect(me(p).hp).toBe(hp);
  });
});

describe("test sessions: test state is never canonical (D-admin-2)", () => {
  let dir = "";
  let db: Db;
  beforeEach(() => {
    // The real path: SQLite characters and piles (startServer gave memory stores).
    dir = mkdtempSync(join(tmpdir(), "fl-admin-"));
    db = openGameDb(join(dir, "game.db"));
    characterRepo.current = new SqliteCharacterRepo(db);
    pileStore.current = new SqlitePileStore(db);
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
    adminCheck.current = () => null;
  });

  const items = (you: { hotbar: unknown[]; backpack: unknown[] }) => JSON.stringify([you.hotbar, you.backpack]);
  const actorOf = (b: Bot) => serverRoom(b).actors.get(b.id)!;

  it("max level and every item stay out of the database and the board; Back to normal restores", async () => {
    const a = await bot("tester", "portus", "admin", { starter: 0 });
    setDisplayName(db, "tester", "Tester_A");
    const before = { level: a.you.level, inv: items(a.you) };
    mode(a, { action: "maxlevel" });
    mode(a, { action: "giveall" });
    const all = adminItems().map((w) => w.id);
    await until("every item", () => me(a).level === LEVEL_CAP && [...a.you.hotbar, ...a.you.backpack].filter(Boolean).length === Math.min(all.length, 20));
    expect(a.you.adminMode.session).toBe(true);
    const have = [...a.you.hotbar, ...a.you.backpack].filter(Boolean) as { id: string; tier: number }[];
    expect(have.map((x) => x.id)).toEqual(all.slice(0, 20));
    expect(have.find((x) => x.id === "carbine")?.tier).toBe(3); // max level: the top tier
    mode(a, { action: "hand", id: "stillshot", tier: 2 });
    await until("in hand", () => a.you.hotbar[a.you.selected]?.id === "stillshot");
    mode(a, { action: "hand", id: "fox_mask" });
    await until("worn", () => a.you.worn?.mask === "fox_mask");
    // Saves during the session write the real character: the database and the public board say level 1.
    serverRoom(a).saveActor(actorOf(a));
    hub.flush("tester"); // what an account merge does first
    const row = loadCharacter<{ hotbar: unknown[]; backpack: unknown[] }>(db, "tester")!;
    expect(row.level).toBe(before.level);
    expect(JSON.stringify([row.inventory.hotbar, row.inventory.backpack])).toBe(before.inv);
    expect(topLevels(db).find((r) => r.name === "Tester_A")?.level).toBe(before.level);
    mode(a, { action: "normal", fly: true }); // "normal" wins: everything off
    await until("normal", () => a.you.adminMode?.session === false && me(a).level === before.level);
    expect(a.you.adminMode).toEqual({ fly: false, god: false, speed: false, session: false });
    expect(items(a.you)).toBe(before.inv);
    expect(a.you.worn ?? {}).toEqual({});
  });

  it("leaving (or another window taking over) ends the session: the next join is the real character", async () => {
    const a = await bot("leaver", "portus", "admin", { starter: 0 });
    const before = { level: a.you.level, inv: items(a.you) };
    mode(a, { action: "maxlevel" });
    mode(a, { action: "giveall" });
    await until("boosted", () => me(a).level === LEVEL_CAP);
    const b = await bot("leaver", "portus"); // a second window takes over
    expect(b.you.level).toBe(before.level);
    expect(items(b.you)).toBe(before.inv);
    expect(b.you.adminMode).toEqual({ fly: false, god: false, speed: false, session: false });
  });

  it("nothing leaves a session: no drop, no pickup, no pile, and a sale's coins go at Back to normal", async () => {
    ensureAccount(db, "pile_owner"); // SQLite saves need the account row (the travel ticket for a player)
    const owner = await bot("pile_owner", "arcadia", "");
    const a = await bot("trader", "arcadia", "admin", { starter: 3 });
    const at = await outside(a);
    mode(a, { action: "hand", id: "comet", tier: 3 });
    await until("in hand", () => a.you.hotbar[a.you.selected]?.id === "comet");
    a.send("drop", { slot: a.you.selected });
    await until("drop refused", () => (a.msgs.get("denied") ?? []).some((m: { action: string; reason: string }) => m.action === "drop" && m.reason === "test session"));
    expect(pileStore.current.list("arcadia")).toEqual([]);
    expect(serverRoom(a).createPile(actorOf(a), [{ id: "carbine", tier: 3, qty: 1 }], 0, at)).toBeNull(); // a tester leaves no pile
    // Someone else's pile at the tester's feet stays put.
    const pile = serverRoom(a).createPile(serverRoom(owner).actors.get(owner.id)!, [{ id: "tonic_small", tier: 1, qty: 1 }], 7, at)!;
    a.send("pickup", { pileId: pile.id });
    await until("pickup refused", () => (a.msgs.get("denied") ?? []).some((m: { action: string; reason: string }) => m.action === "pickup" && m.reason === "test session"));
    expect(pileStore.current.get(pile.id)).toBeTruthy();
  });

  it("a test weapon sold at the Exchange: the coins don't outlive the session", async () => {
    const a = await bot("seller", "portus", "admin", { starter: 0 });
    await tpAndWait(a, objAt("juno_vale"));
    const coins = a.you.coins;
    mode(a, { action: "hand", id: "carbine", tier: 3 });
    await until("in hand", () => a.you.hotbar[a.you.selected]?.id === "carbine");
    a.send("sell", { slot: a.you.selected });
    await until("sold", () => a.you.coins > coins);
    serverRoom(a).saveActor(actorOf(a));
    expect(loadCharacter(db, "seller")!.coins).toBe(coins);
    mode(a, { action: "normal" });
    await until("normal", () => a.you.adminMode?.session === false);
    expect(a.you.coins).toBe(coins);
    expect(a.you.hotbar[0]?.id).toBe("hexquill");
  });

  it("dying in a session isn't a death: no pile, alive at full health, the real character back", async () => {
    const a = await bot("faller", "arcadia", "admin", { starter: 0 });
    await outside(a);
    const before = { level: a.you.level, inv: items(a.you) };
    mode(a, { action: "giveall" });
    await until("kit", () => [...a.you.hotbar, ...a.you.backpack].filter(Boolean).length > 10);
    a.send("admin", { cmd: "damage", args: { target: a.id, amount: 100_000 } });
    await until("over", () => a.you.adminMode?.session === false);
    expect(a.count("death")).toBe(0);
    expect(me(a).hp).toBe(me(a).maxHp);
    expect(me(a).flags & 32).toBe(0); // PF.DEAD
    expect(items(a.you)).toBe(before.inv);
    expect(pileStore.current.list("arcadia")).toEqual([]);
    expect(loadCharacter(db, "faller")!.level).toBe(before.level);
  });

  it("a tester can't hurt other players and earns no medals; after Back to normal the same shots land", async () => {
    const a = await bot("pvp_tester", "arcadia", "admin", { starter: 3 });
    ensureAccount(db, "bystander");
    const p = await bot("bystander", "arcadia", "");
    const at = await outside(a);
    // A player can't teleport: put the bystander 3 m from the tester by hand, out of protection.
    const pa = serverRoom(p).actors.get(p.id)!;
    pa.state.x = pa.lastX = at[0] + 3;
    pa.state.y = pa.lastY = at[1];
    pa.state.z = pa.lastZ = at[2];
    pa.protectedUntil = 0;
    mode(a, { god: true });
    await until("session", () => a.you.adminMode?.session === true);
    await waitFor(() => (me(p).flags & 3) === 0); // outside the ring, unprotected
    const hp = me(p).hp;
    const o = add([me(a).x, me(a).y, me(a).z], up([me(a).x, me(a).y, me(a).z]), 1.6);
    const t = add([me(p).x, me(p).y, me(p).z], up([me(p).x, me(p).y, me(p).z]), 1);
    const d = [t[0] - o[0], t[1] - o[1], t[2] - o[2]];
    const l = Math.hypot(d[0]!, d[1]!, d[2]!);
    for (let i = 0; i < 3; i++) {
      a.send("fire", { slot: 0, ox: o[0], oy: o[1], oz: o[2], dx: d[0]! / l, dy: d[1]! / l, dz: d[2]! / l, t: Date.now() });
      await sleep(300);
    }
    expect(me(p).hp).toBe(hp);
    const quests = serverRoom(a).systems.find((s): s is QuestSystem => s instanceof QuestSystem)!;
    expect(quests.award(actorOf(a), "spark")).toBe(false);
    // Control: once the session is over, the same shots land (PvP outside safe zones is normal).
    mode(a, { action: "normal" });
    await until("normal", () => a.you.adminMode?.session === false);
    for (let i = 0; i < 3 && me(p).hp === hp; i++) {
      a.send("fire", { slot: 0, ox: o[0], oy: o[1], oz: o[2], dx: d[0]! / l, dy: d[1]! / l, dz: d[2]! / l, t: Date.now() });
      await sleep(300);
    }
    expect(me(p).hp).toBeLessThan(hp);
  });

  it("losing admin while playing takes the switches and the session away within a couple of seconds", async () => {
    const a = await bot("demoted", "arcadia", "admin", { starter: 0 });
    await outside(a);
    actorOf(a).identity.account = true; // an account identity: checked against the account table
    const before = { level: a.you.level };
    mode(a, { action: "maxlevel", fly: true, god: true, speed: true });
    await until("on", () => a.you.adminMode?.fly === true && me(a).level === LEVEL_CAP);
    adminCheck.current = (id) => id !== "demoted";
    await until("revoked", () => a.you.adminMode === undefined && me(a).level === before.level, ADMIN_RECHECK_MS + 3000);
    expect(me(a).flags & 128).toBe(0); // PF.ADMIN
    expect(actorOf(a).adminMode).toEqual({ fly: false, god: false, speed: false });
    mode(a, { fly: true });
    await sleep(400);
    expect(actorOf(a).adminMode?.fly).toBe(false);
  });
});
