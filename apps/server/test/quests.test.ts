// Quests and economy (seam 1): SDK bots against the real in-process server. Pads, fast travel,
// the Portus Exchange, missions, medals and titles, Easter eggs and the Hall of Firsts, cosmetics
// and admin staged scenes — all checked through messages and room state the client sees.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { matchMaker } from "@colyseus/core";
import type { Room } from "@colyseus/sdk";
import { BODIES, createTerrain, padDirs, type BodyId } from "@firstlight/shared";
import { placeDir } from "@firstlight/shared/content/places";
import { objectPos, WORLD_OBJECT_BY_ID } from "@firstlight/shared/content/world";
import type { Game } from "../src/app.ts";
import type { BodyRoom } from "../src/world/BodyRoom.ts";
import { emitGameEvent, onGameEvent, type GameEvent } from "../src/world/events.ts";
import { pileStore } from "../src/world/piles.ts";
import { progressStore } from "../src/world/quests/store.ts";
import { joinAs, safeLeave, startServer, waitFor } from "./helpers.ts";

let game: Game;
const rooms: Room[] = [];

beforeEach(async () => {
  game = await startServer();
});
afterEach(async () => {
  for (const r of rooms.splice(0)) await safeLeave(r);
  await game.close();
});

interface Bot {
  room: Room;
  id: string;
  you: any;
  toasts: string[];
  msgs: Map<string, any[]>;
  send(type: string, msg?: unknown): void;
  last(type: string): any;
  count(type: string): number;
}

async function bot(userId: string, body: BodyId, role = "admin", extra: Record<string, unknown> = {}): Promise<Bot> {
  const room = await joinAs(game, userId, body, extra, role);
  rooms.push(room);
  const b: Bot = {
    room,
    id: room.sessionId,
    you: null,
    toasts: [],
    msgs: new Map(),
    send: (type, msg = {}) => room.send(type, msg as never),
    last: (type) => b.msgs.get(type)?.at(-1),
    count: (type) => b.msgs.get(type)?.length ?? 0,
  };
  room.onMessage("*", (type: string | number, m: any) => {
    const k = String(type);
    if (k === "you") b.you = m;
    if (k === "toast") b.toasts.push(m.text);
    const l = b.msgs.get(k) ?? [];
    l.push(m);
    b.msgs.set(k, l);
  });
  await waitFor(() => (room.state as any).players?.get(room.sessionId) !== undefined && b.you !== null);
  return b;
}

const me = (b: Bot) => (b.room.state as any).players.get(b.id);
const serverRoom = (b: Bot) => matchMaker.getLocalRoomById(b.room.roomId) as unknown as BodyRoom;

const terrains = new Map<BodyId, ReturnType<typeof createTerrain>>();
function terrain(body: BodyId) {
  let t = terrains.get(body);
  if (!t) terrains.set(body, (t = createTerrain(body)));
  return t;
}

/** Ground position for a unit direction on a body (same snapping as the server). */
function ground(body: BodyId, d: readonly number[]): [number, number, number] {
  const def = BODIES[body];
  const g = Math.max(terrain(body).groundHeight(d[0]!, d[1]!, d[2]!), def.waterLevel - 1.05);
  const r = def.radius + g + 0.02;
  return [d[0]! * r, d[1]! * r, d[2]! * r];
}

function objAt(id: string): [number, number, number] {
  const o = WORLD_OBJECT_BY_ID.get(id)!;
  return objectPos(o, (x, y, z) => terrain(o.body).groundHeight(x, y, z));
}

function padAt(body: BodyId, i: number) {
  return ground(body, padDirs(BODIES[body])[i]!);
}

/** A point `metres` along the surface from pad `i` (outside its safe ring for metres > 12). */
function offPad(body: BodyId, i: number, metres: number): [number, number, number] {
  const R = BODIES[body].radius;
  const d = padDirs(BODIES[body])[i]!;
  const ref = Math.abs(d[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  const k = ref[0]! * d[0] + ref[1]! * d[1] + ref[2]! * d[2];
  const t = [ref[0]! - k * d[0], ref[1]! - k * d[1], ref[2]! - k * d[2]];
  const tl = Math.hypot(t[0]!, t[1]!, t[2]!);
  const v = [d[0] + (t[0]! / tl) * (metres / R), d[1] + (t[1]! / tl) * (metres / R), d[2] + (t[2]! / tl) * (metres / R)];
  const l = Math.hypot(v[0]!, v[1]!, v[2]!);
  return ground(body, [v[0]! / l, v[1]! / l, v[2]! / l]);
}

function tp(b: Bot, p: readonly number[]) {
  b.send("admin", { cmd: "teleport", args: { x: p[0], y: p[1], z: p[2] } });
}

async function tpAndWait(b: Bot, p: readonly number[]) {
  tp(b, p);
  await waitFor(() => Math.hypot(me(b).x - p[0]!, me(b).y - p[1]!, me(b).z - p[2]!) < 1.5);
}

const near = (b: Bot, p: readonly number[], m: number) => Math.hypot(me(b).x - p[0]!, me(b).y - p[1]!, me(b).z - p[2]!) <= m;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** waitFor with a label in the failure message. */
async function until(label: string, cond: () => boolean, ms = 3000) {
  await waitFor(cond, ms).catch(() => {
    throw new Error(`timed out waiting for: ${label}`);
  });
}
const invIds = (b: Bot) => [...b.you.hotbar, ...b.you.backpack].filter(Boolean).map((i: any) => i.id);

/** Kill a bot outside the safe ring, rebirth and rejoin `body` (as the client does). */
async function dieAndRejoin(b: Bot, userId: string, body: BodyId, pad = 0): Promise<{ bot: Bot; pileId: string }> {
  await tpAndWait(b, offPad(body, pad, 40));
  b.send("admin", { cmd: "unprotect" });
  await sleep(120);
  b.send("admin", { cmd: "damage", args: { amount: 5000 } });
  await waitFor(() => b.count("death") > 0);
  const pileId = b.last("death").pileId as string;
  b.send("respawn", { starter: 1, palette: 0 });
  await waitFor(() => b.count("reborn") > 0);
  await safeLeave(b.room);
  const portus = await bot(userId, "portus");
  await safeLeave(portus.room);
  return { bot: await bot(userId, body), pileId };
}

describe("pads and fast travel", () => {
  it("discovers pads by touch and keeps them across death", async () => {
    const b = await bot("pathfinder", "arcadia");
    await waitFor(() => b.you.pads.includes(0)); // arrival on the main pad
    await tpAndWait(b, padAt("arcadia", 3));
    await waitFor(() => b.you.pads.includes(3));
    expect(b.toasts.some((t) => t.startsWith("Pad discovered"))).toBe(true);
    const { bot: again } = await dieAndRejoin(b, "pathfinder", "arcadia");
    expect(again.you.level).toBe(1);
    expect(again.you.pads).toEqual(expect.arrayContaining([0, 3]));
    expect(progressStore.current.pads("pathfinder", "arcadia").sort()).toEqual([0, 3]);
  });

  it("refuses fast travel off a pad and to undiscovered pads; travels pad to pad", async () => {
    const b = await bot("traveller", "arcadia");
    await waitFor(() => b.you.pads.includes(0));
    b.send("fastTravel", { pad: 5 });
    await waitFor(() => b.count("denied") > 0);
    expect(b.last("denied")).toEqual({ action: "fastTravel", reason: "undiscovered" });

    await tpAndWait(b, padAt("arcadia", 5));
    await waitFor(() => b.you.pads.includes(5));
    await tpAndWait(b, offPad("arcadia", 5, 40));
    b.send("fastTravel", { pad: 0 });
    await waitFor(() => b.count("denied") > 1);
    expect(b.last("denied").reason).toBe("stand on a pad");

    await tpAndWait(b, padAt("arcadia", 5));
    b.send("fastTravel", { pad: 0 });
    await waitFor(() => near(b, padAt("arcadia", 0), 6));
    expect(b.count("correct")).toBeGreaterThan(0);
  });
});

describe("Portus Exchange", () => {
  it("buys and sells with coin checks, only at Juno Vale", async () => {
    const b = await bot("shopper", "portus");
    await tpAndWait(b, objAt("juno_vale"));
    b.send("buy", { itemId: "carbine", tier: 1 });
    await waitFor(() => b.count("shop") === 1);
    expect(b.last("shop")).toMatchObject({ ok: false, reason: "coins" });

    b.send("admin", { cmd: "coins", args: { amount: 400 } });
    await waitFor(() => b.you.coins === 400);
    b.send("buy", { itemId: "carbine", tier: 1 });
    await waitFor(() => b.you.coins === 340);
    expect(invIds(b)).toContain("carbine");

    b.send("buy", { itemId: "tonic_small", qty: 3 });
    await waitFor(() => b.you.coins === 310);
    expect([...b.you.hotbar, ...b.you.backpack].find((i: any) => i?.id === "tonic_small")?.qty).toBe(3);

    // Level gates are shown, not enforced: a level-1 player may buy a tier-2 weapon.
    b.send("buy", { itemId: "axe", tier: 2 });
    await waitFor(() => b.you.coins === 10);
    expect([...b.you.hotbar, ...b.you.backpack].some((i: any) => i?.id === "axe" && i.tier === 2)).toBe(true);

    // Sell the carbine back at 25% (60 → 15).
    const slot = [...b.you.hotbar, ...b.you.backpack].findIndex((i: any) => i?.id === "carbine");
    b.send("sell", { slot });
    await waitFor(() => b.you.coins === 25);
    expect(invIds(b)).not.toContain("carbine");

    // Away from the keeper nothing trades.
    await tpAndWait(b, ground("portus", placeDir("portus_plaza")));
    b.send("buy", { itemId: "tonic_small" });
    await waitFor(() => b.last("shop")?.reason === "too far");
    expect(b.you.coins).toBe(25);
  });
});

describe("missions", () => {
  it("hunt (via the event bus), find and reach missions complete with rewards; once per life", async () => {
    const b = await bot("errand", "arcadia");
    await tpAndWait(b, objAt("guide_arcadia"));
    for (const id of ["A1", "A2", "A3"]) b.send("mission", { action: "accept", id });
    await waitFor(() => b.you.missions.length === 3);
    expect(b.you.missions.map((m: any) => m.goal)).toEqual([8, 1, 1]);

    // Hunt: 8 Hopbits inside Clover Fields; kills elsewhere or of other kinds don't count.
    const room = serverRoom(b);
    const fields = ground("arcadia", placeDir("clover_fields"));
    emitGameEvent(room, { type: "kill", npcKind: "hopbit", killerId: b.id, pos: padAt("arcadia", 9) });
    emitGameEvent(room, { type: "kill", npcKind: "sparkfly", killerId: b.id, pos: fields });
    for (let i = 0; i < 7; i++) emitGameEvent(room, { type: "kill", npcKind: "hopbit", killerId: b.id, pos: fields });
    await waitFor(() => b.you.missions.find((m: any) => m.id === "A1").progress === 7);
    emitGameEvent(room, { type: "kill", npcKind: "hopbit", killerId: null, creditIds: [b.id], pos: fields });
    await waitFor(() => b.you.missions.find((m: any) => m.id === "A1").done);
    expect(b.last("missionDone")).toEqual({ id: "A1", xp: 80, coins: 30 });
    expect(b.you.coins).toBe(30);
    expect([...b.you.hotbar, ...b.you.backpack].find((i: any) => i?.id === "tonic_small")?.qty).toBe(2);

    // Find: the Shepherd's Bell at Lacefall.
    await tpAndWait(b, objAt("a2_bell"));
    b.send("interact", { target: "a2_bell" });
    await waitFor(() => b.you.missions.find((m: any) => m.id === "A2").done);

    // Reach: the Gull Point overlook trigger.
    await tpAndWait(b, ground("arcadia", placeDir("gull_point_overlook")));
    await waitFor(() => b.you.missions.find((m: any) => m.id === "A3").done);
    expect(b.you.coins).toBe(30 + 40 + 60);

    // Once per life.
    await tpAndWait(b, objAt("guide_arcadia"));
    b.send("mission", { action: "accept", id: "A2" });
    await waitFor(() => b.last("denied")?.action === "mission");
    expect(b.last("denied").reason).toBe("done this life");

    // Mission progress is lost with the life.
    const { bot: reborn } = await dieAndRejoin(b, "errand", "arcadia");
    expect(reborn.you.missions).toEqual([]);
  });

  it("accepting needs the guide; abandoning drops progress", async () => {
    const b = await bot("wanderer", "arcadia");
    await tpAndWait(b, offPad("arcadia", 0, 40));
    b.send("mission", { action: "accept", id: "A1" });
    await waitFor(() => b.count("denied") > 0);
    expect(b.last("denied").reason).toBe("too far");
    await tpAndWait(b, objAt("guide_arcadia"));
    b.send("mission", { action: "accept", id: "A1" });
    await waitFor(() => b.you.missions.length === 1);
    b.send("mission", { action: "abandon", id: "A1" });
    await waitFor(() => b.you.missions.length === 0);
  });
});

describe("medals and titles", () => {
  it("awards a medal once and shows the worn title on PlayerState", async () => {
    const b = await bot("veteran", "arcadia");
    const watcher = await bot("onlooker", "arcadia");
    b.send("admin", { cmd: "level", args: { level: 10 } });
    await waitFor(() => b.you.medals.includes("ten_down"));
    await sleep(1300); // a second level check pass
    b.send("admin", { cmd: "level", args: { level: 11 } });
    await sleep(1300);
    expect(b.msgs.get("medal")?.filter((m) => m.id === "ten_down").length).toBe(1);
    expect(progressStore.current.medals("veteran")).toEqual(["ten_down"]);

    b.send("title", { medalId: "firstlight" }); // not earned
    await waitFor(() => b.last("denied")?.action === "title");
    b.send("title", { medalId: "ten_down" });
    await waitFor(() => (watcher.room.state as any).players.get(b.id)?.title === "Seasoned");
    expect(b.you.title).toBe("ten_down");
    b.send("title", { medalId: null });
    await waitFor(() => (watcher.room.state as any).players.get(b.id)?.title === "");
  });

  it("checks event-driven medals: Grand Tour, Own Goal, Woolback, Back For My Stuff, boss feats", async () => {
    // Grand Tour: set foot on all three planets in one life.
    let b = await bot("tourist", "arcadia");
    await safeLeave(b.room);
    b = await bot("tourist", "hollowmere");
    await safeLeave(b.room);
    b = await bot("tourist", "meridian");
    await waitFor(() => b.you.medals.includes("grand_tour"));

    // Boss kill: Tide Turner for every eligible player, Untouchable for one never hit, Hall of Firsts.
    const a1 = await bot("tidecaller", "arcadia");
    const a2 = await bot("tidebreaker", "arcadia");
    const room = serverRoom(a1);
    const lake = ground("arcadia", placeDir("gull_point"));
    const dmg = (targetId: string, targetKind: "player" | "npc", attackerId: string, attackerKind: "player" | "npc") =>
      emitGameEvent(room, { type: "damage", targetId, targetKind, attackerId, attackerKind, npcKind: "tidewrath", boss: true, amount: 10, hpAfter: 100, maxHp: 1000, at: Date.now() });
    dmg("boss-1", "npc", a1.id, "player");
    dmg("boss-1", "npc", a2.id, "player");
    dmg(a2.id, "player", "boss-1", "npc");
    emitGameEvent(room, { type: "kill", npcKind: "tidewrath", npcId: "boss-1", bossId: "tidewrath", killerId: a1.id, creditIds: [a1.id, a2.id], pos: lake });
    await waitFor(() => a1.you.medals.includes("tide_turner") && a2.you.medals.includes("tide_turner"));
    expect(a1.you.medals).toContain("untouchable");
    expect(a2.you.medals).not.toContain("untouchable");
    expect(progressStore.current.hall().find((h) => h.secretId === "boss:tidewrath")?.displayName).toBe("tidecaller, tidebreaker");

    // Woolback buck, then a fall within 5 s; and an own goal.
    emitGameEvent(room, { type: "damage", targetId: a1.id, targetKind: "player", attackerId: "wool-1", attackerKind: "npc", npcKind: "woolback", amount: 2, hpAfter: 98, maxHp: 100, at: Date.now() });
    emitGameEvent(room, { type: "death", victimId: a1.id, killerId: null, killerKind: "world", pos: lake });
    await waitFor(() => a1.you.medals.includes("killed_by_a_woolback"));
    emitGameEvent(room, { type: "death", victimId: a2.id, killerId: a2.id, killerKind: "player", pos: lake });
    await waitFor(() => a2.you.medals.includes("own_goal"));

    // Back For My Stuff: loot your previous life's pile after rebirth.
    const c = await bot("returner", "arcadia");
    const { bot: back, pileId } = await dieAndRejoin(c, "returner", "arcadia");
    const pile = pileStore.current.get(pileId)!;
    await tpAndWait(back, [pile.x, pile.y, pile.z]);
    back.send("pickup", { pileId });
    await waitFor(() => back.you.medals.includes("back_for_my_stuff"));
  });
});

describe("Easter eggs and the Hall of Firsts", () => {
  it("engraves only the first finder; both get the item and the hidden medal", async () => {
    const watcher = await bot("hallwatch", "portus");
    watcher.send("questSync");
    await waitFor(() => watcher.count("hall") > 0);
    const first = await bot("firstfinder", "arcadia");
    const second = await bot("secondfinder", "arcadia");
    for (const b of [first, second]) {
      b.send("admin", { cmd: "coins", args: { amount: 3 } });
      await waitFor(() => b.you.coins === 3);
      await tpAndWait(b, objAt("e1_bowl"));
    }
    first.send("interact", { target: "e1_bowl" });
    await waitFor(() => invIds(first).includes("lantern_of_lacefall"));
    second.send("interact", { target: "e1_bowl" });
    await waitFor(() => invIds(second).includes("lantern_of_lacefall"));
    expect(first.you.coins).toBe(2);
    expect(first.you.medals).toContain("behind_the_curtain");
    expect(second.you.medals).toContain("behind_the_curtain");
    expect(first.toasts.some((t) => t.includes("engraved"))).toBe(true);
    expect(second.toasts.some((t) => t.includes("engraved"))).toBe(false);
    // The Portus wall updated live, with the first finder only.
    await waitFor(() => watcher.last("hall").lines.some((l: any) => l.id === "E1"));
    expect(watcher.last("hall").lines.find((l: any) => l.id === "E1").name).toBe("firstfinder");
    // Once per life: a second offering gives nothing new.
    first.send("interact", { target: "e1_bowl" });
    await waitFor(() => first.toasts.some((t) => t.includes("already took")));
  });

  it("riddle order, keypad and the well work as designed", async () => {
    const b = await bot("puzzler", "arcadia");
    const room = serverRoom(b);
    const spawns: GameEvent[] = [];
    onGameEvent(room, (e) => e.type === "spawnRequest" && spawns.push(e));
    await tpAndWait(b, objAt("e2_btn_leaf"));
    // Wrong first press: reset + 3 Hopbits requested from the NPC lane.
    b.send("interact", { target: "e2_btn_leaf" });
    await waitFor(() => spawns.length === 1);
    expect(spawns[0]).toMatchObject({ type: "spawnRequest", reason: "egg", npcKind: "hopbit", count: 3 });
    for (const btn of ["rain", "leaf", "sun", "flame"]) b.send("interact", { target: `e2_btn_${btn}` });
    await until("pixel halo", () => invIds(b).includes("pixel_halo"));
    expect(b.you.medals).toContain("new_high_score");

    const m = await bot("auditor", "meridian");
    await tpAndWait(m, objAt("e7_safe"));
    m.send("interact", { target: "e7_safe" });
    await waitFor(() => m.last("prompt")?.kind === "keypad");
    m.send("interact", { target: "e7_safe", code: "1407" });
    await waitFor(() => m.toasts.includes("ACCESS DENIED"));
    m.send("interact", { target: "e7_safe", code: "7041" });
    await waitFor(() => invIds(m).includes("executive_visor"));

    const h = await bot("diver", "hollowmere");
    h.send("interact", { target: "e6_altar" }); // too far, and not via the well
    await tpAndWait(h, objAt("e6_well"));
    await waitFor(() => near(h, ground("hollowmere", placeDir("upside_down_chapel")), 4));
    h.send("interact", { target: "e6_altar" });
    await waitFor(() => invIds(h).includes("bone_bell"));
  });
});

describe("cosmetics", () => {
  it("wearing shows on PlayerState; worn cosmetics drop on death with everything else", async () => {
    const b = await bot("dresser", "portus");
    const other = await bot("tailor", "portus");
    await tpAndWait(b, objAt("juno_vale"));
    b.send("admin", { cmd: "coins", args: { amount: 120 } });
    await waitFor(() => b.you.coins === 120);
    b.send("buy", { itemId: "woolly_beanie" });
    await waitFor(() => invIds(b).includes("woolly_beanie"));
    const slot = [...b.you.hotbar, ...b.you.backpack].findIndex((i: any) => i?.id === "woolly_beanie");
    expect(slot).toBeGreaterThanOrEqual(4); // cosmetics go to the backpack
    b.send("wear", { slot });
    await waitFor(() => (other.room.state as any).players.get(b.id)?.cosmetics === "woolly_beanie");
    expect(b.you.worn).toEqual({ hat: "woolly_beanie" });

    // Still worn after travelling; gone (into the pile) after death.
    await safeLeave(b.room);
    const there = await bot("dresser", "arcadia");
    expect(me(there).cosmetics).toBe("woolly_beanie");
    await tpAndWait(there, offPad("arcadia", 0, 40));
    there.send("admin", { cmd: "unprotect" });
    await sleep(120);
    there.send("admin", { cmd: "damage", args: { amount: 5000 } });
    await waitFor(() => there.count("death") > 0);
    await waitFor(() => me(there).cosmetics === "");
    const pile = pileStore.current.get(there.last("death").pileId)!;
    expect(pile.items.map((i) => i.id)).toContain("woolly_beanie");
  });
});

describe("admin staged scenes", () => {
  it("stage teleports the admin and nearby crew, requests the boss, and sends travel for other bodies", async () => {
    const director = await bot("director", "arcadia");
    const actor = await bot("actor1", "arcadia");
    const bystander = await bot("bystander", "arcadia", "");
    const room = serverRoom(director);
    const spawns: GameEvent[] = [];
    onGameEvent(room, (e) => e.type === "spawnRequest" && spawns.push(e));
    director.send("admin", { cmd: "stage", args: { n: 2 } });
    const overlook = ground("arcadia", placeDir("gull_point_overlook"));
    await waitFor(() => near(director, overlook, 10) && near(actor, overlook, 10));
    expect(near(bystander, overlook, 30)).toBe(false); // players who aren't crew stay put
    expect(spawns[0]).toMatchObject({ reason: "stage", bossId: "tidewrath" });

    director.send("admin", { cmd: "stage", args: { n: 5 } });
    await waitFor(() => director.toasts.some((t) => t.startsWith("Stage 5")));
    await waitFor(() => (director.room.state as any).piles.size > 0 || pileStore.current.list("arcadia").length > 0);
    expect(me(director).flags & 2).toBe(0); // spawn protection dropped for the PvP scene

    director.send("admin", { cmd: "stage", args: { n: 1 } });
    await waitFor(() => director.count("stage") > 0);
    expect(director.last("stage")).toEqual({ n: 1, body: "portus" });

    bystander.send("admin", { cmd: "stage", args: { n: 2 } }); // not an admin: ignored
    await sleep(200);
    expect(bystander.count("stage")).toBe(0);
  });
});
