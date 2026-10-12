// Support items (content.md §2.3, F12 review): the Patchkit channels, then heals a share of the
// target's max HP over 2 s, on yourself or an ally in reach, and damage during the channel cancels it
// (kit kept); the Prism Bubble is a shell at your feet that stops hitscan crossing it either way and
// takes the damage instead. Seam 1: SDK clients against the real in-process server.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Room } from "@colyseus/sdk";
import { matchMaker } from "@colyseus/core";
import { BODIES, padDirs } from "@firstlight/shared";
import type { Game } from "../src/app.ts";
import type { BodyRoom } from "../src/world/BodyRoom.ts";
import { supportOf } from "../src/world/support.ts";
import { joinAs, safeLeave, startServer, waitFor as rawWait } from "./helpers.ts";

/** waitFor that names what it waited for when it times out. */
let step = "";
const waitFor = (cond: () => boolean, ms?: number) => rawWait(cond, ms).catch(() => {
  throw new Error(`timed out: ${step || cond.toString().slice(0, 120)}`);
});

let game: Game;
const rooms: Room[] = [];

beforeEach(async () => {
  game = await startServer();
});
afterEach(async () => {
  for (const r of rooms.splice(0)) await safeLeave(r);
  await game.close();
});

/** A point `metres` from Arcadia's main pad along a fixed tangent (outside the 12 m safe ring). */
function awayFromPad(metres: number): [number, number, number] {
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

/** Metres along the surface between a position and a target point (ignores ground height). */
function surfaceGap(q: { x: number; y: number; z: number }, p: readonly number[]): number {
  const lq = Math.hypot(q.x, q.y, q.z), lp = Math.hypot(p[0]!, p[1]!, p[2]!);
  return Math.hypot(q.x / lq - p[0]! / lp, q.y / lq - p[1]! / lp, q.z / lq - p[2]! / lp) * BODIES.arcadia.radius;
}

const st = (r: Room) => r.state as any;
const me = (r: Room) => st(r).players.get(r.sessionId);
const server = (r: Room) => matchMaker.getLocalRoomById(r.roomId) as unknown as BodyRoom;
const actor = (r: Room) => server(r).actors.get(r.sessionId)!;

interface Client {
  room: Room;
  msgs: Map<string, any[]>;
  you: any;
  last(type: string): any;
  count(type: string): number;
}

async function join(userId: string, at: number): Promise<Client> {
  const room = await joinAs(game, userId, "arcadia", { starter: 3 }, "admin");
  rooms.push(room);
  const c: Client = {
    room,
    msgs: new Map(),
    you: null,
    last: (t) => c.msgs.get(t)?.at(-1),
    count: (t) => c.msgs.get(t)?.length ?? 0,
  };
  room.onMessage("*", (type: string | number, m: any) => {
    const k = String(type);
    if (k === "you") c.you = m;
    c.msgs.set(k, [...(c.msgs.get(k) ?? []), m]);
  });
  await waitFor(() => !!me(room) && c.you !== null);
  const p = awayFromPad(at);
  room.send("admin", { cmd: "teleport", args: { x: p[0], y: p[1], z: p[2] } });
  room.send("admin", { cmd: "unprotect" });
  await waitFor(() => surfaceGap(me(room), p) < 1.5 && actor(room).protectedUntil === 0);
  return c;
}

const slotOf = (c: Client, id: string) => [...c.you.hotbar, ...c.you.backpack].findIndex((i: any) => i?.id === id);
const qtyOf = (c: Client, id: string) => [...c.you.hotbar, ...c.you.backpack].find((i: any) => i?.id === id)?.qty ?? 0;

async function give(c: Client, id: string, qty = 1, tier = 1) {
  c.room.send("admin", { cmd: "give", args: { id, qty, tier } });
  await waitFor(() => qtyOf(c, id) >= qty);
}

async function hurtTo(c: Client, hp: number) {
  const now = me(c.room).hp;
  c.room.send("admin", { cmd: "damage", args: { amount: now - hp } });
  await waitFor(() => me(c.room).hp === hp);
}

/** Wait until every heal-over-time on the actor has run out and the client has the final HP. */
async function healsDone(c: Client) {
  step = "heals finished";
  await waitFor(() => actor(c.room).heals.length === 0 && me(c.room).hp === actor(c.room).state.hp, 6000);
  step = "";
}

function aimAt(shooter: Room, target: Room) {
  const s = me(shooter), t = st(shooter).players.get(target.sessionId);
  const l = Math.hypot(s.x, s.y, s.z);
  const o = [s.x + (s.x / l) * 1.6, s.y + (s.y / l) * 1.6, s.z + (s.z / l) * 1.6];
  const tl = Math.hypot(t.x, t.y, t.z);
  const aim = [t.x + (t.x / tl) * 1.0, t.y + (t.y / tl) * 1.0, t.z + (t.z / tl) * 1.0];
  const d = [aim[0]! - o[0]!, aim[1]! - o[1]!, aim[2]! - o[2]!];
  const dl = Math.hypot(d[0]!, d[1]!, d[2]!);
  return { ox: o[0], oy: o[1], oz: o[2], dx: d[0]! / dl, dy: d[1]! / dl, dz: d[2]! / dl };
}

describe("Patchkit", () => {
  it("heals 30% of max HP over 2 s after a 1 s channel, uses one kit, then a 6 s cooldown", async () => {
    const a = await join("medic", 40);
    await give(a, "patchkit", 2);
    await hurtTo(a, 40);
    a.room.send("use", { slot: slotOf(a, "patchkit") });
    await waitFor(() => a.count("channel") === 1);
    expect(a.last("channel")).toMatchObject({ kind: "patchkit", ms: 1000, target: a.room.sessionId });
    expect(me(a.room).hp).toBe(40);
    await waitFor(() => a.count("channelEnd") === 1, 3000);
    expect(a.last("channelEnd")).toMatchObject({ kind: "patchkit", ok: true });
    await waitFor(() => qtyOf(a, "patchkit") === 1);
    await healsDone(a);
    expect(me(a.room).hp).toBe(70); // 30 of 100, not 45
    a.room.send("use", { slot: slotOf(a, "patchkit") });
    await waitFor(() => a.last("denied")?.reason === "cooldown");
    expect(qtyOf(a, "patchkit")).toBe(1);
  });

  it("damage during the channel cancels it and keeps the kit", async () => {
    const a = await join("unlucky", 40);
    await give(a, "patchkit", 1);
    await hurtTo(a, 40);
    a.room.send("use", { slot: slotOf(a, "patchkit") });
    await waitFor(() => a.count("channel") === 1);
    a.room.send("admin", { cmd: "damage", args: { amount: 5 } });
    await waitFor(() => a.count("channelEnd") === 1, 3000);
    expect(a.last("channelEnd")).toMatchObject({ kind: "patchkit", ok: false });
    await healsDone(a);
    expect(me(a.room).hp).toBe(35);
    expect(qtyOf(a, "patchkit")).toBe(1);
  });

  it("heals an ally in reach (strangers included) by the ally's max HP; refuses targets out of reach", async () => {
    const a = await join("samaritan", 40);
    const b = await join("stranger", 42);
    b.room.send("admin", { cmd: "level", args: { level: 6 } }); // 150 max HP
    await waitFor(() => me(b.room).maxHp === 150);
    await give(a, "patchkit", 2);
    await hurtTo(b, 50);
    a.room.send("use", { slot: slotOf(a, "patchkit"), targetId: b.room.sessionId });
    await waitFor(() => a.count("channelEnd") === 1, 3000);
    expect(a.last("channel")).toMatchObject({ target: b.room.sessionId });
    await healsDone(b);
    expect(me(b.room).hp).toBe(95); // 30% of 150
    expect(qtyOf(a, "patchkit")).toBe(1);
    // Out of reach (10 m): refused, nothing used.
    const far = awayFromPad(52);
    b.room.send("admin", { cmd: "teleport", args: { x: far[0], y: far[1], z: far[2] } });
    await waitFor(() => surfaceGap(me(b.room), far) < 1.5);
    actor(a.room).healCooldownUntil = 0;
    a.room.send("use", { slot: slotOf(a, "patchkit"), targetId: b.room.sessionId });
    await waitFor(() => a.last("denied")?.reason === "out of reach");
    expect(qtyOf(a, "patchkit")).toBe(1);
  });
});

describe("Prism Bubble", () => {
  it("stops hitscan crossing the shell either way, takes the damage, and is kept with a cooldown", async () => {
    const a = await join("bubbler", 40);
    const b = await join("gunner", 50);
    await give(a, "bubble");
    await give(a, "carbine");
    await give(b, "carbine");
    let popped = false;
    b.room.onMessage("bubblePop", () => (popped = true));
    a.room.send("use", { slot: slotOf(a, "bubble") });
    await waitFor(() => b.count("bubble") === 1);
    const bubble = b.last("bubble");
    expect(bubble).toMatchObject({ by: a.room.sessionId, r: 3, hp: 150 });
    const shell = () => supportOf(server(a.room))!.bubbles.list[0];
    // In: a shot from outside stops at the shell.
    b.room.send("fire", { slot: slotOf(b, "carbine"), ...aimAt(b.room, a.room), t: Date.now() });
    await waitFor(() => (shell()?.hp ?? 150) < 150);
    expect(shell()!.hp).toBe(141);
    expect(me(a.room).hp).toBe(100);
    // Out: the owner can't shoot through their own shell either.
    a.room.send("fire", { slot: slotOf(a, "carbine"), ...aimAt(a.room, b.room), t: Date.now() });
    await waitFor(() => shell()!.hp < 141);
    expect(st(a.room).players.get(b.room.sessionId).hp).toBe(100);
    // Kept, with a 25 s cooldown.
    expect(qtyOf(a, "bubble")).toBe(1);
    a.room.send("use", { slot: slotOf(a, "bubble") });
    await waitFor(() => a.last("denied")?.reason === "cooldown");
    expect(popped).toBe(false);
  });
});

describe("bubble sync (review S8)", () => {
  it("a late joiner asking for a support snapshot gets the active bubbles with their remaining time and HP", async () => {
    const a = await join("early", 40);
    const b0 = await join("gunner2", 50);
    await give(a, "bubble");
    a.room.send("use", { slot: slotOf(a, "bubble") });
    await waitFor(() => a.count("bubble") === 1);
    // Chip the shell, then someone joins.
    b0.room.send("fire", { slot: 0, ...aimAt(b0.room, a.room), t: Date.now() });
    await waitFor(() => (supportOf(server(a.room))!.bubbles.list[0]?.hp ?? 150) < 150);
    const late = await join("latecomer", 60);
    expect(late.count("bubble")).toBe(0);
    late.room.send("supportSync", {});
    await waitFor(() => late.count("bubble") === 1);
    const snap = late.last("bubble");
    const live = supportOf(server(a.room))!.bubbles.list[0]!;
    expect(snap).toMatchObject({ id: live.id, by: a.room.sessionId, r: 3, hp: live.hp });
    expect(snap.ms).toBeGreaterThan(0);
    expect(snap.ms).toBeLessThan(6000);
  });
});
