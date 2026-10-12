// F12 B2: per-copy world state outlives the room instance. A copy that empties auto-disposes and the
// next /api/play opens a fresh room on the same copy number; a deploy restarts the process. Boss
// respawn timers (SPEC §6.5: 10 min per copy), cleared spawn groups (packs, camps, beasts, egg NPCs)
// and broken props must survive both (SPEC §5.1: flush boss timers and destruction state).

import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Room } from "@colyseus/sdk";
import { BODIES, createTerrain } from "@firstlight/shared";
import { bossArena, walk } from "@firstlight/shared/content/arenas";
import { NF } from "@firstlight/shared/content/npcs";
import { BodyState, PF } from "@firstlight/shared/net/schema";
import type { Game } from "../src/app.ts";
import { openGameDb, type Db } from "../src/db/index.ts";
import { copyStateStore, MemoryCopyStateStore, SqliteCopyStateStore } from "../src/world/copyState.ts";
import type { BodyRoom } from "../src/world/BodyRoom.ts";
import { DestructionSystem } from "../src/world/destruction.ts";
import { dealDamage } from "../src/world/combat.ts";
import { NPC_TUNING, resetTuning } from "../src/world/npc/index.ts";
import { tempDir } from "./auth-helpers.ts";
import { safeLeave, startServer, waitFor } from "./helpers.ts";
import { adminBot, bossInfo, me, nearPad, noBodyRooms, place, serverRoom, st, type V } from "./npc-bots.ts";
import { fakeWorld, type FakeWorld } from "./npcWorld.ts";

let game: Game | null = null;
const rooms: Room[] = [];
const dirs: string[] = [];
const dbs: Db[] = [];

beforeEach(() => {
  copyStateStore.current = new MemoryCopyStateStore();
});
afterEach(async () => {
  for (const r of rooms.splice(0)) await safeLeave(r);
  await game?.close();
  game = null;
  for (const db of dbs.splice(0)) if (db.open) db.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  copyStateStore.current = new MemoryCopyStateStore();
  resetTuning();
});

function bossTuning() {
  NPC_TUNING.bosses = true;
  NPC_TUNING.bossAttacks = false;
  NPC_TUNING.bossMechanics = [];
}

/** Wait until the boss is up and past its 1 s materialise. */
async function bossUp(r: Room) {
  let info: any = null;
  await waitFor(() => {
    void bossInfo(r).then((i) => (info = i));
    return info?.status === "alive" && info.engaged;
  }, 6000);
  await waitFor(() => !!st(r).npcs?.get(info.id) && !(st(r).npcs.get(info.id).flags & NF.SPAWNING), 3000);
  return info;
}

/** Kill Tidewrath (copy 0 of Arcadia) and return its info right after the kill. */
async function killTidewrath(name: string): Promise<{ r: Room; dead: any }> {
  const ar = bossArena(createTerrain("arcadia"))!;
  const r = await adminBot(game!, rooms, name, "arcadia", ar.centre as V, 8);
  const boss = await bossUp(r);
  let defeat = false;
  r.onMessage("boss", (m: any) => m.type === "defeat" && (defeat = true));
  r.send("npc", { cmd: "hurt", id: boss.id, amount: 1e7, as: r.sessionId });
  await waitFor(() => defeat, 3000);
  const dead = await bossInfo(r);
  expect(dead.status).toBe("dead");
  expect(dead.respawnIn).toBeGreaterThan(NPC_TUNING.bossRespawnMs - 10_000);
  return { r, dead };
}

/** Log out on the main pad (no linger) and wait for the copy's room to dispose. */
async function emptyTheCopy(r: Room) {
  place(r, nearPad("arcadia", 0, 2));
  await waitFor(() => !!(me(r).flags & PF.SAFE), 3000);
  await safeLeave(r);
  rooms.splice(rooms.indexOf(r), 1);
  await noBodyRooms();
}

describe("boss respawn timers outlive the room (F12 B2)", () => {
  it("a killed boss is still dead, with the remaining timer, after its copy empties and reopens", async () => {
    game = await startServer();
    copyStateStore.current = new MemoryCopyStateStore();
    bossTuning();
    const { r, dead } = await killTidewrath("slayer");
    const roomId = r.roomId;
    await emptyTheCopy(r);
    const again = await adminBot(game, rooms, "slayer", "arcadia", nearPad("arcadia", 0, 2), 8);
    expect(again.roomId).not.toBe(roomId); // a fresh room on copy 0
    expect(st(again).copy).toBe(0);
    const info = await bossInfo(again);
    expect(info.status).toBe("dead");
    expect(info.respawnIn).toBeLessThanOrEqual(dead.respawnIn);
    expect(info.respawnIn).toBeGreaterThan(580_000);
  }, 30_000);

  it("…and after a graceful restart on the same game.db", async () => {
    const dir = tempDir();
    dirs.push(dir);
    const path = join(dir, "game.db");
    const db1 = openGameDb(path);
    dbs.push(db1);
    game = await startServer();
    copyStateStore.current = new SqliteCopyStateStore(db1);
    bossTuning();
    const { dead } = await killTidewrath("restarter");
    await game.close(); // SIGTERM path: rooms shut down and flush their copy state
    game = null;
    rooms.splice(0);
    db1.close();
    // A new process: nothing in memory, only game.db.
    const db2 = openGameDb(path);
    dbs.push(db2);
    game = await startServer();
    copyStateStore.current = new SqliteCopyStateStore(db2);
    bossTuning();
    const r = await adminBot(game, rooms, "restarter", "arcadia", nearPad("arcadia", 0, 2), 8);
    const info = await bossInfo(r);
    expect(info.status).toBe("dead");
    expect(info.respawnIn).toBeLessThanOrEqual(dead.respawnIn);
    expect(info.respawnIn).toBeGreaterThan(580_000);
  }, 30_000);

  it("an expired timer brings the boss back as usual", async () => {
    game = await startServer();
    copyStateStore.current = new MemoryCopyStateStore();
    bossTuning();
    NPC_TUNING.bossRespawnMs = 1500;
    const { r } = await killTidewrath("patient");
    await emptyTheCopy(r);
    await new Promise((ok) => setTimeout(ok, 1600));
    const ar = bossArena(createTerrain("arcadia"))!;
    const again = await adminBot(game, rooms, "patient", "arcadia", ar.centre as V, 8);
    const boss = await bossUp(again);
    expect(boss.hp).toBe(boss.maxHp);
  }, 30_000);
});

describe("spawn groups outlive the room (F12 B2)", () => {
  it("a cleared camp stays cleared (no second chest) and a part-killed pack stays short, counting down while away", () => {
    NPC_TUNING.ambient = true;
    const w1 = fakeWorld("arcadia", { copyKey: "arcadia:0" });
    const camp = w1.sys.groups.find((g) => g.point.kind === "camp")!;
    const pack = w1.sys.groups.find((g) => g.point.kind === "pack" && g.point.members.length >= 3)!;
    // Wake both groups with a player nearby, then kill the whole camp and one pack member.
    for (const g of [camp, pack]) {
      w1.addPlayer(`p${g.point.id}`, g.point.pos);
      for (let i = 0; i < 12 && !g.active; i++) w1.step(500);
      expect(g.active).toBe(true);
    }
    for (let i = 0; i < 30; i++) w1.step(100); // past the 1 s materialise
    for (const m of camp.members) if (m) dealDamage(w1.world.host, null, m, 1e7, false);
    dealDamage(w1.world.host, null, pack.members[0]!, 1e7, false);
    expect(camp.cleared).toBe(true);
    const left = camp.respawnLeft;
    w1.sys.dispose(); // the room goes away
    // Two minutes later a new room opens on the same copy.
    const w2 = fakeWorld("arcadia", { copyKey: "arcadia:0", start: w1.clock.t + 120_000 });
    const camp2 = w2.sys.groups[camp.point.id]!;
    const pack2 = w2.sys.groups[pack.point.id]!;
    expect(camp2.cleared).toBe(true);
    expect(camp2.respawnLeft).toBeCloseTo(left - 120, 0);
    expect(pack2.cleared).toBe(false);
    expect(pack2.dead).toEqual(pack.point.members.map((_, i) => i === 0));
    // Another copy is untouched.
    const other = fakeWorld("arcadia", { copyKey: "arcadia:1" });
    expect(other.sys.groups[camp.point.id]!.cleared).toBe(false);
    // Long enough away and the camp is back.
    const w3 = fakeWorld("arcadia", { copyKey: "arcadia:0", start: w1.clock.t + (left + 1) * 1000 });
    expect(w3.sys.groups[camp.point.id]!.cleared).toBe(false);
    expect(w3.sys.groups[camp.point.id]!.dead.some((d) => d)).toBe(false);
  });
});

describe("crash recovery (no dispose)", () => {
  it("a camp cleared while a player stays beside it keeps its slowed countdown (Codex S1)", () => {
    NPC_TUNING.ambient = true;
    const w1 = fakeWorld("arcadia", { copyKey: "arcadia:0", immortal: true });
    const camp = w1.sys.groups.find((g) => g.point.kind === "camp")!;
    w1.addPlayer("camper", camp.point.pos);
    for (let i = 0; i < 12 && !camp.active; i++) w1.step(500);
    for (let i = 0; i < 30; i++) w1.step(100);
    for (const m of camp.members) if (m) dealDamage(w1.world.host, null, m, 1e7, false);
    expect(camp.cleared).toBe(true);
    const left = camp.respawnLeft;
    // 100 s beside it: the countdown runs at half speed (content §3.1: ×2 while a player is within 60 m).
    for (let i = 0; i < 200; i++) w1.step(500);
    expect(camp.respawnLeft).toBeCloseTo(left - 50, 0);
    // The process dies here: no dispose. A new room on the same copy restores what was last saved.
    const w2 = fakeWorld("arcadia", { copyKey: "arcadia:0", start: w1.clock.t });
    const camp2 = w2.sys.groups[camp.point.id]!;
    expect(camp2.cleared).toBe(true);
    expect(Math.abs(camp2.respawnLeft - camp.respawnLeft)).toBeLessThan(1.5);
  });
});

/** The slice of a room a DestructionSystem uses (Arcadia copy 0), with its own synced state. */
function propRoom(): BodyRoom {
  const state = new BodyState();
  state.body = "arcadia";
  state.copy = 0;
  return { bodyDef: BODIES.arcadia, terrain: createTerrain("arcadia"), state, metadata: { body: "arcadia", copy: 0, loadtest: false }, host: {}, broadcastNear() {} } as unknown as BodyRoom;
}

describe("crash recovery: broken props (no dispose)", () => {
  it("a broken prop is checkpointed within a second (Codex S2)", () => {
    const dir = tempDir();
    dirs.push(dir);
    const path = join(dir, "game.db");
    const db1 = openGameDb(path);
    dbs.push(db1);
    copyStateStore.current = new SqliteCopyStateStore(db1);
    let now = 5_000_000;
    const clock = () => now;
    const a = new DestructionSystem(propRoom(), clock);
    const prop = a.list.find((b) => b.hp < 400)!;
    a.damage(prop.index, 1e6, "heavy", "", [1, 0, 0]);
    expect(a.isBroken(prop.index)).toBe(true);
    now += 1000;
    a.tick(1000, now);
    db1.close(); // the process dies: no dispose
    const db2 = openGameDb(path);
    dbs.push(db2);
    copyStateStore.current = new SqliteCopyStateStore(db2);
    const room = propRoom();
    const b = new DestructionSystem(room, clock);
    expect(b.isBroken(prop.index)).toBe(true);
    expect(room.state.broken.has(prop.id)).toBe(true);
    expect(b.brokenUntil[prop.index]).toBe(a.brokenUntil[prop.index]);
  });
});

describe("broken props outlive the room (F12 B2)", () => {
  it("a prop broken before the copy emptied is still broken (and synced) in the new room", async () => {
    game = await startServer();
    copyStateStore.current = new MemoryCopyStateStore();
    const r = await adminBot(game, rooms, "wrecker", "arcadia", nearPad("arcadia", 0, 2));
    const sys = serverRoom(r).systems.find((s) => s instanceof DestructionSystem) as DestructionSystem;
    const prop = sys.list.find((b) => b.hp < 400)!;
    sys.damage(prop.index, 1e6, "heavy", "", [1, 0, 0]);
    await waitFor(() => st(r).broken?.has(prop.id), 2000);
    await emptyTheCopy(r);
    const again = await adminBot(game, rooms, "wrecker", "arcadia", nearPad("arcadia", 0, 2));
    await waitFor(() => st(again).broken?.has(prop.id), 2000);
    const sys2 = serverRoom(again).systems.find((s) => s instanceof DestructionSystem) as DestructionSystem;
    expect(sys2.isBroken(prop.index)).toBe(true);
    expect(sys2.raycast([prop.cx + 5, prop.cy, prop.cz], [-1, 0, 0], 10)?.index ?? -1).not.toBe(prop.index);
  }, 30_000);
});

// ------------------------------------------------------------------------------------ active fights

/** A ground point `a` m along the arena axis and `b` m to its side from the arena centre. */
function arenaAt(w: FakeWorld, a: number, b = 0): V {
  const ar = w.sys.arena!;
  return w.world.snapToGround(walk(ar.up, ar.axis, a, ar.side, b, w.world.body.radius)) as V;
}

function runFor(w: FakeWorld, ms: number, until?: () => boolean): number {
  for (let t = 0; t < ms; t += 50) {
    w.step(50);
    if (until?.()) return t + 50;
  }
  return -1;
}

/** Tidewrath up (copy arcadia:0) with a player at the arena centre. */
function tidewrathUp(start?: number) {
  NPC_TUNING.bosses = true;
  NPC_TUNING.bossAttacks = false;
  NPC_TUNING.bossMechanics = [];
  const w = fakeWorld("arcadia", { copyKey: "arcadia:0", immortal: true, ...(start ? { start } : {}) });
  const a = w.addPlayer("a", arenaAt(w, 0, 0), 8);
  const boss = w.sys.boss!;
  expect(runFor(w, 3000, () => !!boss.npc && !(boss.npc.state.flags & NF.INVULN))).toBeGreaterThan(0);
  return { w, a, boss, n: boss.npc! };
}

/** Tidewrath at 11,800 / 12,000 with one Coral Pillar broken. */
function hurtTidewrath() {
  const t = tidewrathUp();
  dealDamage(t.w.world.host, t.a, t.n, 1000, false); // 20% through the shell
  expect(t.n.state.hp).toBe(11_800);
  const coral = t.boss.cover[0]!;
  t.boss.coverHit(coral.def.pos, "heavy", 1000);
  expect(coral.broken).toBe(true);
  return t;
}

describe("active boss fights outlive a quick room recreation (Codex S3)", () => {
  it("recreated 1 s later, Tidewrath keeps its HP, broken cover and damage credit", () => {
    const { w } = hurtTidewrath();
    w.sys.dispose();
    const t = tidewrathUp(w.clock.t + 1000);
    expect(t.n.state.hp).toBe(11_800);
    expect(t.boss.cover[0]!.broken).toBe(true);
    expect(t.boss.engaged).toBe(true);
    expect(t.n.damage.get("u-a")?.amount).toBe(200);
  });

  it("recreated 31 s after the arena emptied, it is reset (full HP, cover rebuilt)", () => {
    const { w, a } = hurtTidewrath();
    w.movePlayer(a, arenaAt(w, -150));
    const emptied = w.clock.t;
    runFor(w, 5000); // the room lingers a little, then goes away
    w.sys.dispose();
    const t = tidewrathUp(emptied + 31_000);
    expect(t.n.state.hp).toBe(12_000);
    expect(t.boss.cover[0]!.broken).toBe(false);
  });

  it("recreated 20 s after the arena emptied (no dispose), it resumes, then resets when 30 s are up", () => {
    const { w, a } = hurtTidewrath();
    w.movePlayer(a, arenaAt(w, -150));
    const emptied = w.clock.t;
    runFor(w, 2000); // the vacancy is checkpointed; then the process dies
    const w2 = fakeWorld("arcadia", { copyKey: "arcadia:0", immortal: true, start: emptied + 20_000 });
    w2.addPlayer("b", arenaAt(w2, -80), 8); // near the lair, not inside the arena
    const boss = w2.sys.boss!;
    expect(runFor(w2, 3000, () => !!boss.npc && !(boss.npc.state.flags & NF.INVULN))).toBeGreaterThan(0);
    const n = boss.npc!;
    expect(n.state.hp).toBe(11_800);
    expect(runFor(w2, 12_000, () => n.state.hp === n.state.maxHp)).toBeGreaterThan(0);
    expect(w2.clock.t - emptied).toBeGreaterThanOrEqual(30_000);
    expect(w2.clock.t - emptied).toBeLessThan(31_000);
  });
});
