// Quests and economy (seam 1): SDK bots against the real in-process server. Pads, fast travel,
// the Portus Exchange, missions, medals and titles, Easter eggs and the Hall of Firsts, cosmetics
// and admin staged scenes — all checked through messages and room state the client sees.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { placeDir } from "@firstlight/shared/content/places";
import { emitGameEvent, onGameEvent, type GameEvent } from "../src/world/events.ts";
import { pileStore } from "../src/world/piles.ts";
import { EGG_LIMITS } from "../src/world/quests/eggs.ts";
import type { QuestSystem } from "../src/world/quests/QuestSystem.ts";
import { progressStore } from "../src/world/quests/store.ts";
import { safeLeave, startServer, waitFor } from "./helpers.ts";
import { bot, dieAndRejoin, ground, harness, invIds, me, near, objAt, offPad, padAt, serverRoom, sleep, tpAndWait, until, tp } from "./quest-helpers.ts";

const quests = (room: ReturnType<typeof serverRoom>) => room.systems.find((s) => "eggs" in s) as QuestSystem;

beforeEach(async () => {
  harness.game = await startServer();
});
afterEach(async () => {
  for (const r of harness.rooms.splice(0)) await safeLeave(r);
  await harness.game!.close();
});

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
  it("limits quest actions to 5 per second", async () => {
    const b = await bot("spammer", "portus");
    await tpAndWait(b, objAt("juno_vale"));
    for (let i = 0; i < 8; i++) b.send("buy", { itemId: "carbine", tier: 1 });
    await sleep(400);
    expect(b.count("shop")).toBe(5);
  });

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

    await sleep(1000); // quest actions are limited to 5 per second

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

    // Easter-egg items are once-per-life trophies: Juno won't buy them (no coin faucet).
    await tpAndWait(b, objAt("juno_vale"));
    b.send("admin", { cmd: "egg", args: { id: "E2" } });
    await until("pixel halo", () => invIds(b).includes("pixel_halo"));
    b.send("sell", { slot: [...b.you.hotbar, ...b.you.backpack].findIndex((i: any) => i?.id === "pixel_halo") });
    await waitFor(() => b.last("shop")?.reason === "worthless");
    expect(b.toasts.at(-1)).toContain("One of a kind");
    expect(b.you.coins).toBe(25);
    expect(invIds(b)).toContain("pixel_halo");
  });
});

describe("missions", () => {
  it("hunt (via the event bus), find and reach missions complete with rewards; once per life", async () => {
    const b = await bot("errand", "arcadia");
    await tpAndWait(b, objAt("guide_arcadia"));
    for (const id of ["A1", "A2", "A3"]) b.send("mission", { action: "accept", id });
    await waitFor(() => b.you.missions.length === 3);
    await sleep(300); // one quest tick at the guide arms the reach mission
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

  it("fast travel can't complete a reach mission: the target has to be walked into", async () => {
    const b = await bot("climber", "hollowmere");
    await tpAndWait(b, padAt("hollowmere", 10)); // discover the pad at the Tolling Tower's foot
    await waitFor(() => b.you.pads.includes(10));
    await tpAndWait(b, objAt("guide_hollowmere"));
    b.send("mission", { action: "accept", id: "H3" });
    await waitFor(() => b.you.missions.length === 1);
    await tpAndWait(b, padAt("hollowmere", 0));
    b.send("fastTravel", { pad: 10 });
    await waitFor(() => near(b, padAt("hollowmere", 10), 6));
    await sleep(500);
    expect(b.you.missions[0].done).toBe(false); // the pad is 125 m from the top (D28)
    // Climb to the top platform (admin moves stand in for walking here).
    await tpAndWait(b, ground("hollowmere", placeDir("tolling_tower")));
    await waitFor(() => b.you.missions[0].done);
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
    await waitFor(() => b.you.title === "ten_down"); // the `you` message can land after the state patch
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
    const lockMs = EGG_LIMITS.lockMs;
    EGG_LIMITS.lockMs = 600; // the puzzle locks after a wrong answer (15 s in play)
    try {
      b.send("interact", { target: "e2_btn_leaf" });
      await waitFor(() => spawns.length === 1);
      expect(spawns[0]).toMatchObject({ type: "spawnRequest", reason: "egg", npcKind: "hopbit", count: 3, egg: "E2" });
      await until("puzzle unlocked", () => quests(room).eggs.lockedFor("puzzler", "E2") === 0);
    } finally {
      EGG_LIMITS.lockMs = lockMs;
    }
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
    // An enter trigger moves the player on at once: don't wait to be seen at the trigger itself.
    tp(h, objAt("e6_well"));
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

    // Party members of the admin are crew too (how guest windows join a scene in production).
    room.actors.get(director.id)!.state.party = "film";
    room.actors.get(bystander.id)!.state.party = "film";
    director.send("admin", { cmd: "stage", args: { n: 2, all: true } });
    await waitFor(() => near(bystander, overlook, 10));
  });
});
