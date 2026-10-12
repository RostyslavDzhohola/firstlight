// Seam 1: how a player's actor enters and leaves rooms (F12 review B2 takeover state, B3
// combat-tagged leave and travel tickets, B4 leave hooks exactly once).

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { matchMaker } from "@colyseus/core";
import type { Room } from "@colyseus/sdk";
import { BODIES, createTerrain, padDirs, portalSpots, type BodyId } from "@firstlight/shared";
import { bossArena } from "@firstlight/shared/content/arenas";
import { NF } from "@firstlight/shared/content/npcs";
import { CLOSE } from "@firstlight/shared/net/social";
import type { Game } from "../src/app.ts";
import { accountLinks } from "../src/auth/links.ts";
import { RULES, type BodyRoom } from "../src/world/BodyRoom.ts";
import { NPC_TUNING, npcSystemOf, resetTuning } from "../src/world/npc/index.ts";
import { SYSTEM_FACTORIES, type SystemFactory } from "../src/world/systems.ts";
import { grantTravel, joinAs, playRequest, safeLeave, startServer, waitFor } from "./helpers.ts";

let game: Game;
const rooms: Room[] = [];

// A spy system: counts leave hooks per session id.
const leaves = new Map<string, number>();
const spy: SystemFactory = () => ({
  tick() {},
  onPlayerLeave(sid: string) {
    leaves.set(sid, (leaves.get(sid) ?? 0) + 1);
  },
});
beforeAll(() => {
  SYSTEM_FACTORIES.push(spy);
});
afterAll(() => {
  SYSTEM_FACTORIES.splice(SYSTEM_FACTORIES.indexOf(spy), 1);
});

beforeEach(async () => {
  game = await startServer();
  leaves.clear();
});
afterEach(async () => {
  for (const r of rooms.splice(0)) await safeLeave(r);
  await game.close();
  resetTuning();
});

type V = [number, number, number];
const st = (r: Room) => r.state as any;
const me = (r: Room) => st(r).players.get(r.sessionId);
const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
const serverRoom = (r: Room) => matchMaker.getLocalRoomById(r.roomId) as unknown as BodyRoom;
const actorOf = (r: Room) => serverRoom(r).actors.get(r.sessionId)!;

/** A ground point `metres` from a body's main pad (outside its 12 m safe ring when > 12). */
function nearPad(body: BodyId, metres: number, sideways = 0): V {
  const R = BODIES[body].radius;
  const d = padDirs(BODIES[body])[0]!;
  return offset([d[0] * R, d[1] * R, d[2] * R], metres, sideways, R);
}
function offset(p: readonly number[], metres: number, sideways: number, R: number): V {
  const l = Math.hypot(p[0]!, p[1]!, p[2]!);
  const d = [p[0]! / l, p[1]! / l, p[2]! / l];
  const ref = Math.abs(d[2]!) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  const k = ref[0]! * d[0]! + ref[1]! * d[1]! + ref[2]! * d[2]!;
  const t = [ref[0]! - k * d[0]!, ref[1]! - k * d[1]!, ref[2]! - k * d[2]!];
  const tl = Math.hypot(t[0]!, t[1]!, t[2]!);
  for (let i = 0; i < 3; i++) t[i]! /= tl;
  const s = [d[1]! * t[2]! - d[2]! * t[1]!, d[2]! * t[0]! - d[0]! * t[2]!, d[0]! * t[1]! - d[1]! * t[0]!];
  const v = [d[0]! + (t[0]! * metres + s[0]! * sideways) / R, d[1]! + (t[1]! * metres + s[1]! * sideways) / R, d[2]! + (t[2]! * metres + s[2]! * sideways) / R];
  const vl = Math.hypot(v[0]!, v[1]!, v[2]!);
  return [(v[0]! / vl) * R, (v[1]! / vl) * R, (v[2]! / vl) * R];
}
/** Within `m` metres of `p` along the ground (heights differ: teleports land on the terrain). */
const near = (r: Room, p: readonly number[], m = 2) => {
  const a = me(r), la = Math.hypot(a.x, a.y, a.z), lp = Math.hypot(p[0]!, p[1]!, p[2]!);
  const cos = (a.x * p[0]! + a.y * p[1]! + a.z * p[2]!) / (la * lp);
  return Math.acos(Math.min(1, cos)) * lp < m;
};

async function join(name: string, body: BodyId = "arcadia", role = "admin"): Promise<Room> {
  const r = await joinAs(game, name, body, {}, role);
  rooms.push(r);
  await waitFor(() => !!me(r));
  return r;
}
function place(r: Room, p: readonly number[], target?: string) {
  r.send("admin", { cmd: "teleport", args: { x: p[0], y: p[1], z: p[2], ...(target ? { target } : {}) } });
}
/** Out of the safe ring, unprotected, then hit once (combat-tagged). */
async function tagged(r: Room) {
  place(r, nearPad("arcadia", 40));
  r.send("admin", { cmd: "unprotect" });
  await waitFor(() => near(r, nearPad("arcadia", 40), 3) && !(me(r).flags & 3));
  r.send("admin", { cmd: "damage", args: { amount: 5 } });
  await waitFor(() => !!(me(r).flags & 256)); // IN_COMBAT
}
let reqSeq = 0;
/** Send an admin `npc` command and wait for the reply of `type`. */
function ask<T = any>(r: Room, type: string, msg: Record<string, unknown>): Promise<T> {
  const req = ++reqSeq;
  return new Promise((ok, fail) => {
    const off = r.onMessage(type, (m: any) => {
      if (m.req !== req) return;
      (off as unknown as () => void)?.();
      ok(m);
    });
    r.send("npc", { ...msg, req });
    setTimeout(() => fail(new Error(`no ${type} reply`)), 3000);
  });
}
const bossInfo = (r: Room) => ask<any>(r, "bossInfo", { cmd: "boss", action: "info" });

async function leaveRoom(r: Room) {
  await r.leave(true);
  rooms.splice(rooms.indexOf(r), 1);
}

describe("leave hooks run exactly once (F12 B4)", () => {
  it("a takeover by a second session runs the old session's leave hooks once", async () => {
    const first = await join("twin");
    const old = first.sessionId;
    let closed = 0;
    first.onLeave((c) => (closed = c));
    await join("twin");
    await waitFor(() => closed === CLOSE.ELSEWHERE);
    await sleep(150);
    expect(leaves.get(old)).toBe(1);
  });

  it("an account merge retires the guest and runs its leave hooks once", async () => {
    const g = await join("guesty", "arcadia", "");
    const sid = g.sessionId;
    let closed = 0;
    g.onLeave((c) => (closed = c));
    accountLinks.emit({ fromUserId: "guesty", toUserId: "acct-guesty", name: "guesty", character: "guest", merged: false, moved: null, displaced: null });
    await waitFor(() => closed === CLOSE.MERGED);
    await sleep(150);
    expect(leaves.get(sid)).toBe(1);
  });

  it("leaving, lingering and the linger ending run the hooks once in total", async () => {
    const saved = RULES.LINGER_MS;
    try {
      RULES.LINGER_MS = 300;
      const watcher = await join("watcher");
      const r = await join("lingerer");
      place(r, nearPad("arcadia", 40));
      await waitFor(() => near(r, nearPad("arcadia", 40), 3));
      const sid = r.sessionId;
      await leaveRoom(r);
      await waitFor(() => !st(watcher).players.has(sid), 3000);
      await sleep(100);
      expect(leaves.get(sid)).toBe(1);
    } finally {
      RULES.LINGER_MS = saved;
    }
  });
});

describe("takeovers keep runtime state (F12 B2)", () => {
  it("a new session keeps the old protection expiry, cooldowns, burn, heals, slows and combat tag", async () => {
    const first = await join("keeper", "arcadia", "");
    const a = actorOf(first);
    const now = Date.now();
    const expectedProtection = a.protectedUntil;
    a.burn = { perSec: 2, until: now + 3000, by: "someone" };
    a.heals = [{ perSec: 5, until: now + 2000 }];
    a.healCooldownUntil = now + 4000;
    a.tonicCooldownUntil = now + 5000;
    a.lastAttackAt = now - 10;
    a.reloadEndsAt = now + 1200;
    a.heat = 3;
    a.overheatUntil = now + 900;
    a.specialReadyAt = now + 7000;
    a.lastDodgeAt = now - 50;
    a.npcFx = { slow: 0.5, slowUntil: now + 1500, noSprintUntil: now + 2500, pull: null };
    await sleep(300);
    const second = await join("keeper", "arcadia", "");
    const b = actorOf(second);
    expect(b).not.toBe(a);
    expect(b.protectedUntil).toBe(expectedProtection);
    expect(b.burn).toEqual(a.burn);
    expect(b.heals).toEqual(a.heals);
    expect(b.healCooldownUntil).toBe(now + 4000);
    expect(b.tonicCooldownUntil).toBe(now + 5000);
    expect(b.lastAttackAt).toBe(now - 10);
    expect(b.reloadEndsAt).toBe(now + 1200);
    expect(b.heat).toBe(3);
    expect(b.overheatUntil).toBe(now + 900);
    expect(b.specialReadyAt).toBe(now + 7000);
    expect(b.lastDodgeAt).toBe(now - 50);
    expect(b.npcFx).toEqual({ slow: 0.5, slowUntil: now + 1500, noSprintUntil: now + 2500, pull: null });
  });

  it("rejoining over and over never renews spawn protection", async () => {
    let r = await join("renewer", "arcadia", "");
    const until = actorOf(r).protectedUntil;
    for (let i = 0; i < 3; i++) {
      await sleep(200);
      r = await join("renewer", "arcadia", "");
      expect(actorOf(r).protectedUntil).toBe(until);
    }
  });

  it("a marked Royal Judgement participant who swaps session and runs still takes it", async () => {
    NPC_TUNING.bosses = true;
    NPC_TUNING.bossAttacks = false;
    NPC_TUNING.bossMechanics = ["royal_judgement"];
    NPC_TUNING.firstMechanicMs = 300;
    const ar = bossArena(createTerrain("hollowmere"))!;
    const A = await join("swapper", "hollowmere");
    A.send("admin", { cmd: "level", args: { level: 14 } });
    place(A, ar.centre);
    A.send("admin", { cmd: "unprotect" });
    await waitFor(() => near(A, ar.centre) && !(me(A).flags & 3));
    let circle: any = null;
    A.onMessage("boss", (m: any) => m.type === "mechanic" && m.mech === "royal_judgement" && (circle = m));
    let info: any = null;
    await waitFor(() => {
      void bossInfo(A).then((i) => (info = i));
      return info?.status === "alive" && info.engaged;
    }, 6000);
    await waitFor(() => !!st(A).npcs?.get(info.id) && !(st(A).npcs.get(info.id).flags & NF.SPAWNING), 3000);
    await waitFor(() => circle !== null, 6000);
    // Swap the session and run far out of the Nave before the stamp lands.
    const B = await join("swapper", "hollowmere");
    let died = false;
    B.onMessage("death", (m: any) => m.victim === B.sessionId && (died = true));
    place(B, offset(ar.centre, 0, 140, BODIES.hollowmere.radius));
    await waitFor(() => died, 5000);
  }, 30_000);
});

describe("combat-tagged leaving and travel tickets (F12 B3)", () => {
  it("closing the game in a safe zone while combat-tagged leaves the body for the linger time", async () => {
    const saved = RULES.LINGER_MS;
    try {
      RULES.LINGER_MS = 500;
      const watcher = await join("watcher2");
      const r = await join("fleeing");
      await tagged(r);
      place(r, nearPad("arcadia", 3)); // back inside the pad's safe ring, still tagged
      await waitFor(() => near(r, nearPad("arcadia", 3), 3));
      const sid = r.sessionId;
      await leaveRoom(r);
      await sleep(150);
      expect(st(watcher).players.has(sid)).toBe(true);
      await waitFor(() => !st(watcher).players.has(sid), 3000);
    } finally {
      RULES.LINGER_MS = saved;
    }
  });

  it("holding a travel ticket doesn't skip the linger while combat-tagged", async () => {
    const saved = RULES.LINGER_MS;
    try {
      RULES.LINGER_MS = 500;
      const watcher = await join("watcher3");
      const r = await join("ticketed");
      await tagged(r);
      grantTravel("ticketed", "portus");
      const sid = r.sessionId;
      await leaveRoom(r);
      await sleep(150);
      expect(st(watcher).players.has(sid)).toBe(true);
    } finally {
      RULES.LINGER_MS = saved;
    }
  });

  it("the server refuses a travel ticket while combat-tagged", async () => {
    const spot = portalSpots(BODIES.arcadia, createTerrain(BODIES.arcadia))[0]!;
    const R = BODIES.arcadia.radius + spot.h;
    const at: V = [spot.dir[0] * R, spot.dir[1] * R, spot.dir[2] * R];
    const r = await join("portalfighter");
    place(r, at);
    await waitFor(() => near(r, at, 3));
    actorOf(r).combatUntil = Date.now() + 10_000;
    const answer = new Promise<string>((ok) => {
      r.onMessage("denied", (m: { action: string; reason: string }) => m.action === "travel" && ok(m.reason));
      r.onMessage("travelOk", () => ok("ticket issued"));
    });
    r.send("travel", { to: spot.to });
    expect(await answer).toBe("in combat");
  });

  it("travel tickets expire", async () => {
    const saved = RULES.TRAVEL_TICKET_MS;
    try {
      RULES.TRAVEL_TICKET_MS = 300;
      const spot = portalSpots(BODIES.arcadia, createTerrain(BODIES.arcadia))[0]!;
      const R = BODIES.arcadia.radius + spot.h;
      const at: V = [spot.dir[0] * R, spot.dir[1] * R, spot.dir[2] * R];
      const admin = await join("porter");
      const r = await join("tourist", "arcadia", "");
      place(admin, at, r.sessionId);
      await waitFor(() => near(r, at, 3));
      const ok = new Promise<{ to: string }>((res) => r.onMessage("travelOk", res));
      r.send("travel", { to: spot.to });
      expect((await ok).to).toBe(spot.to);
      expect((await playRequest(game, "dev:tourist:tourist", { body: spot.to })).ok).toBe(true);
      await sleep(450);
      expect(await playRequest(game, "dev:tourist:tourist", { body: spot.to })).toEqual({ ok: false, error: "travel", body: "arcadia" });
    } finally {
      RULES.TRAVEL_TICKET_MS = saved;
    }
  });
});

describe("bodies and NPCs (F12 Opus should-fix 9)", () => {
  it("NPCs can hit a lingering body, and let go of it once it is gone", async () => {
    const saved = RULES.LINGER_MS;
    try {
      RULES.LINGER_MS = 4000; // long enough for the first hit (notice, chase, 0.5 s telegraph)
      const watcher = await join("npcwatch");
      const r = await join("bait");
      const at = nearPad("arcadia", 70);
      place(r, at);
      r.send("admin", { cmd: "unprotect" });
      await waitFor(() => near(r, at, 3) && !(me(r).flags & 3));
      const sys = npcSystemOf(serverRoom(r))!;
      const reply = new Promise<{ id: string }>((ok) => r.onMessage("npcInfo", ok));
      const R = BODIES.arcadia.radius;
      const spot = offset(at, 2.5, 0, R);
      r.send("npc", { cmd: "spawn", kind: "hopbit", x: spot[0], y: spot[1], z: spot[2], level: 1, instant: true, req: 1 });
      const { id } = await reply;
      const npc = () => sys.npcs.get(id)!;
      const body = actorOf(r);
      await waitFor(() => npc().target === body, 6000);
      const sid = r.sessionId;
      await leaveRoom(r); // lingers: outside the safe ring
      const hp0 = body.state.hp;
      await waitFor(() => body.state.hp < hp0 || body.dead, 3500); // still attacked while it lingers
      await waitFor(() => !st(watcher).players.has(sid), 6000);
      await waitFor(() => npc().target !== body, 1000);
    } finally {
      RULES.LINGER_MS = saved;
    }
  }, 25_000);
});

describe("fast travel (F12 Opus should-fix 7)", () => {
  it("pads refuse fast travel while combat-tagged", async () => {
    const r = await join("padhopper");
    const pads = padDirs(BODIES.arcadia);
    const R = BODIES.arcadia.radius;
    const pad0: V = [pads[0]![0] * R, pads[0]![1] * R, pads[0]![2] * R];
    place(r, pad0);
    await waitFor(() => near(r, pad0, 4));
    actorOf(r).combatUntil = Date.now() + 10_000;
    const denied = new Promise<string>((ok) => r.onMessage("denied", (m: { action: string; reason: string }) => m.action === "fastTravel" && ok(m.reason)));
    r.send("fastTravel", { pad: 1 });
    expect(await denied).toBe("in combat");
  });
});

