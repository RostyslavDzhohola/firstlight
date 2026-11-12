// The new objective types (race, defend, collect; quests/trials.ts) and the Three Gleams hunt
// (content/gleams.ts): SDK bots against the real in-process server, through the messages and state a
// client sees. Trial clocks run at TRIAL_RULES.timeScale (shrunk here, restored after each test).

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@colyseus/sdk";
import { PF } from "@firstlight/shared/net/schema";
import { GLEAMS } from "@firstlight/shared/content/gleams";
import { MISSION_BY_ID } from "@firstlight/shared/content/missions";
import type { BodyId } from "@firstlight/shared";
import { PLAY_LIMITS } from "../src/app.ts";
import { TRIAL_RULES } from "../src/world/quests/trials.ts";
import { npcSystemOf } from "../src/world/npc/index.ts";
import { progressStore } from "../src/world/quests/store.ts";
import { QuestSystem } from "../src/world/quests/QuestSystem.ts";
import { onGameEvent } from "../src/world/events.ts";
import { NF } from "@firstlight/shared/content/npcs";
import { spawnNpc } from "./npc-bots.ts";
import { characterRepo } from "../src/world/characters.ts";
import { safeLeave, startServer, waitFor } from "./helpers.ts";
import { bot, dieAndRejoin, ground, harness, invIds, me, objAt, offPad, serverRoom, sleep, tpAndWait, until, wrapRoom, type Bot } from "./quest-helpers.ts";

const SCALE = TRIAL_RULES.timeScale;
const CALLS = PLAY_LIMITS.userCalls;
beforeEach(async () => {
  harness.game = await startServer();
  PLAY_LIMITS.userCalls = 40; // these bots hop between planets more often than a player could
});
afterEach(async () => {
  TRIAL_RULES.timeScale = SCALE;
  PLAY_LIMITS.userCalls = CALLS;
  for (const r of harness.rooms.splice(0)) await safeLeave(r);
  await harness.game!.close();
});

const mission = (b: Bot, id: string) => b.you.missions.find((m: any) => m.id === id);
const trials = (b: Bot) => (b.msgs.get("trial") ?? []) as any[];
const lastTrial = (b: Bot, id: string) => trials(b).filter((t) => t.id === id).at(-1);

/** Take missions from their giver (Sela in Portus, or a planet guide), then stand on `body`. */
async function take(userId: string, ids: string[], body: BodyId, role = "admin"): Promise<Bot> {
  const giverBody = (id: string) => (MISSION_BY_ID.get(id)!.giver ? "portus" : MISSION_BY_ID.get(id)!.body);
  let b: Bot | null = null;
  for (const at of [...new Set(ids.map(giverBody))]) {
    if (b) await safeLeave(b.room);
    b = await bot(userId, at, role);
    const giver = at === "portus" ? "curator_sela" : `guide_${at}`;
    await tpAndWait(b, objAt(giver));
    const mine = ids.filter((id) => giverBody(id) === at);
    for (const id of mine) b.send("mission", { action: "accept", id });
    await until(`accepted ${mine}`, () => mine.every((id) => !!mission(b!, id)));
  }
  if (giverBody(ids[0]!) === body && ids.every((id) => giverBody(id) === body)) return b!;
  await safeLeave(b!.room);
  return bot(userId, body, role);
}

/** Run the race's rings in order by moving through them (admin moves stand in for running). */
async function runRings(b: Bot, id: string, from = 0, to?: number) {
  const rings = MISSION_BY_ID.get(id)!.race!.rings;
  for (let i = from; i < (to ?? rings.length); i++) {
    await tpAndWait(b, objAt(rings[i]!));
    await until(`ring ${i + 1}`, () => (mission(b, id)?.progress ?? 0) >= i + 1 || !!mission(b, id)?.done);
  }
}

async function gather(b: Bot, id: string, from = 0, to?: number) {
  const pieces = MISSION_BY_ID.get(id)!.collect!.pieces;
  for (let i = from; i < (to ?? pieces.length); i++) {
    await tpAndWait(b, objAt(pieces[i]!));
    await until(`piece ${i + 1}`, () => (mission(b, id)?.counts?.[i] ?? 0) === 1 || !!mission(b, id)?.done);
  }
}

const trialNpcs = (b: Bot) => npcSystemOf(serverRoom(b))!.spawnedCount("trial");
const actor = (b: Bot) => serverRoom(b).actors.get(b.id)!;
const questsOf = (room: ReturnType<typeof serverRoom>) => room.systems.find((s): s is QuestSystem => s instanceof QuestSystem)!;

/**
 * Drop the bot's socket the way a lost network does (not a consented leave: the server keeps the body
 * for the reconnection window and runs onDrop), wait until the server has noticed, and return a
 * function that reconnects with the room's token as a fresh client.
 */
async function dropSocket(b: Bot): Promise<() => Promise<Bot>> {
  const token = b.room.reconnectionToken;
  const room = serverRoom(b);
  const a = actor(b);
  b.room.reconnection.enabled = false; // we reconnect by hand, with the token
  b.room.connection.close(3000, "network lost (test)");
  await until("server saw the drop", () => (a.state.flags & PF.LINGER) !== 0);
  return async () => {
    const r = await new Client(`http://127.0.0.1:${harness.game!.port}`).reconnect(token);
    const nb = await wrapRoom(r);
    await until("same body back", () => room.actors.get(nb.id) === a && (a.state.flags & PF.LINGER) === 0);
    return nb;
  };
}

describe("race (T1, The Swift Gleam)", () => {
  it("starts at the first ring, takes them in order, pays on the last; two runners at once", async () => {
    TRIAL_RULES.timeScale = 0.2; // 15 s clock
    const a = await take("racer_a", ["T1"], "arcadia");
    const c = await take("racer_b", ["T1"], "arcadia");
    // Out of order: ring 3 first does nothing.
    await tpAndWait(a, objAt("t1_ring_3"));
    await sleep(400);
    expect(mission(a, "T1").progress).toBe(0);
    // Both run, interleaved: each has their own clock and next ring.
    await runRings(a, "T1", 0, 3);
    await runRings(c, "T1", 0, 2);
    expect(lastTrial(a, "T1")).toMatchObject({ kind: "race", state: "running", progress: 3, goal: 8, next: "t1_ring_4" });
    expect(lastTrial(a, "T1").leftMs).toBeGreaterThan(0);
    expect(lastTrial(a, "T1").limitMs).toBe(15000);
    // The deadline on the server clock, so a client counts to it whatever the delivery delay.
    expect(lastTrial(a, "T1").endsAt).toBeGreaterThan(Date.now());
    expect(lastTrial(a, "T1").endsAt).toBeLessThanOrEqual(Date.now() + 15000);
    await runRings(a, "T1", 3);
    await runRings(c, "T1", 2);
    await until("both done", () => mission(a, "T1").done && mission(c, "T1").done);
    expect(lastTrial(a, "T1").state).toBe("done");
    expect(a.last("missionDone")).toEqual({ id: "T1", xp: 300, coins: 80 });
    expect(a.toasts.some((t) => t.includes("Gleam won: 1 of 3"))).toBe(true);
  });

  it("running out of time fails the attempt; passing the first ring again restarts it", async () => {
    TRIAL_RULES.timeScale = 0.02; // 1.5 s clock
    const a = await take("racer_slow", ["T1"], "arcadia");
    await runRings(a, "T1", 0, 2);
    await until("failed on time", () => lastTrial(a, "T1")?.state === "failed", 5000);
    expect(lastTrial(a, "T1").reason).toBe("time");
    expect(mission(a, "T1").progress).toBe(0);
    expect(a.toasts.some((t) => t.includes("out of time"))).toBe(true);
    TRIAL_RULES.timeScale = 0.3;
    await tpAndWait(a, offPad("arcadia", 0, 40)); // away, then through ring 1 again
    await runRings(a, "T1");
    await until("done after restart", () => mission(a, "T1").done);
  });

  it("dying mid-race ends the attempt", async () => {
    TRIAL_RULES.timeScale = 0.3;
    const a = await take("racer_dies", ["T1"], "arcadia");
    await runRings(a, "T1", 0, 2);
    a.send("admin", { cmd: "unprotect" });
    await sleep(120);
    a.send("admin", { cmd: "damage", args: { amount: 5000 } });
    await until("death", () => a.count("death") > 0);
    await until("failed: died", () => lastTrial(a, "T1")?.state === "failed");
    expect(lastTrial(a, "T1").reason).toBe("died");
  });
});

describe("defend (T2, The Steadfast Gleam; H4, The Long Vigil)", () => {
  it("the beacon starts the clock, waves rise near the defender, and dissolve at the end", async () => {
    TRIAL_RULES.timeScale = 0.06; // 5.4 s hold, waves at 0.1 / 1.3 / 2.7 / 3.9 s
    const a = await take("holder", ["T2"], "hollowmere");
    const c = await take("holder_b", ["T2"], "hollowmere");
    for (const b of [a, c]) await tpAndWait(b, objAt("t2_beacon"));
    a.send("interact", { target: "t2_beacon" });
    c.send("interact", { target: "t2_beacon" });
    await until("both running", () => lastTrial(a, "T2")?.state === "running" && lastTrial(c, "T2")?.state === "running");
    expect(lastTrial(a, "T2")).toMatchObject({ kind: "defend", goal: 90, next: "t2_beacon", limitMs: 5400 });
    await until("a wave", () => trialNpcs(a) > 0);
    const spawned = [...npcSystemOf(serverRoom(a))!.npcs.values()].filter((n) => n.spawned?.reason === "trial");
    expect(spawned.every((n) => n.def.id === "bonewalker" || n.def.id === "gnawer")).toBe(true);
    expect(spawned.every((n) => n.level === 9)).toBe(true);
    await until("both held", () => mission(a, "T2").done && mission(c, "T2").done, 15000);
    expect(a.last("missionDone")).toEqual({ id: "T2", xp: 1000, coins: 160 });
    await until("waves dissolved", () => trialNpcs(a) === 0, 3000);
  });

  it("a wave creature its runner kills pays nothing: no XP, coins, drops or hunt credit (an ordinary one does)", async () => {
    TRIAL_RULES.timeScale = 0.3; // 27 s hold: the kill comes long before the end
    const a = await take("wave_farmer", ["T2", "H1"], "hollowmere"); // H1: a hunt, to see no kill credit
    a.send("npc", { cmd: "ambient", on: false });
    await tpAndWait(a, objAt("t2_beacon"));
    a.send("admin", { cmd: "unprotect" });
    const room = serverRoom(a);
    const npcs = npcSystemOf(room)!;
    const kills: unknown[] = [];
    const off = onGameEvent(room, (e) => {
      if (e.type === "kill") kills.push(e);
    });
    try {
      a.send("interact", { target: "t2_beacon" });
      await until("a wave", () => trialNpcs(a) > 0);
      const w = [...npcs.npcs.values()].find((n) => n.spawned?.reason === "trial")!;
      await until("risen", () => (w.state.flags & NF.INVULN) === 0);
      const me0 = actor(a).char;
      const xp = me0.xp;
      const coins = me0.coins;
      const piles = room.state.piles.size;
      const h1 = JSON.stringify(actor(a).char.missions.find((m) => m.id === "H1"));
      a.send("npc", { cmd: "hurt", id: w.id, as: a.id, amount: 5000 });
      await until("the wave creature falls", () => w.dead || !npcs.npcs.has(w.id));
      await sleep(600); // a payout would have landed by now (it retries on later ticks)
      expect(actor(a).char.xp).toBe(xp);
      expect(actor(a).char.coins).toBe(coins);
      expect(room.state.piles.size).toBe(piles);
      expect(kills).toEqual([]); // no kill event: no hunt credit, medals or news
      expect(JSON.stringify(actor(a).char.missions.find((m) => m.id === "H1"))).toBe(h1);
      expect(a.msgs.get("npcKill")?.some((k: any) => k.id === w.id && (k.xp > 0 || k.coins > 0)) ?? false).toBe(false);
      // The same kill on an ordinary Bonewalker pays: the path above is the one that pays.
      const plain = await spawnNpc(a.room, "bonewalker", objAt("t2_beacon"), { level: 9, instant: true });
      a.send("npc", { cmd: "hurt", id: plain, as: a.id, amount: 5000 });
      await until("an ordinary kill pays XP", () => actor(a).char.xp > xp);
      expect(kills.length).toBe(1);
    } finally {
      off();
    }
  });

  it("leaving the ring pauses the clock, and staying out past the grace fails it", async () => {
    TRIAL_RULES.timeScale = 0.1; // 6 s hold, 1 s grace
    const a = await take("wanderer_h4", ["H4"], "hollowmere");
    await tpAndWait(a, objAt("h4_lamp"));
    a.send("interact", { target: "h4_lamp" });
    await until("running", () => lastTrial(a, "H4")?.state === "running");
    const away = objAt("h4_lamp").map((v, i) => v + [30, 0, 0][i]!);
    await tpAndWait(a, offPad("hollowmere", 0, 40)); // far outside the ring
    await until("paused", () => lastTrial(a, "H4")?.state === "paused");
    await until("failed: left", () => lastTrial(a, "H4")?.state === "failed", 4000);
    expect(lastTrial(a, "H4").reason).toBe("left");
    expect(mission(a, "H4").done).toBe(false);
    await until("waves gone", () => trialNpcs(a) === 0, 3000);
    void away;
    // A second try, staying put, holds.
    await tpAndWait(a, objAt("h4_lamp"));
    a.send("interact", { target: "h4_lamp" });
    await until("held", () => mission(a, "H4").done, 12000);
    expect(a.last("missionDone")).toEqual({ id: "H4", xp: 900, coins: 150 });
  });

  it("a dropped socket ends the attempt at once: no hold time while away, the waves go, idle on reconnect", async () => {
    TRIAL_RULES.timeScale = 0.05; // 4.5 s hold
    const a = await take("dropped_holder", ["T2"], "hollowmere");
    await tpAndWait(a, objAt("t2_beacon"));
    a.send("interact", { target: "t2_beacon" });
    await until("running", () => lastTrial(a, "T2")?.state === "running");
    await until("a wave", () => trialNpcs(a) > 0);
    const server = serverRoom(a);
    const body = actor(a);
    const reconnect = await dropSocket(a);
    // The attempt is cancelled and its waves dissolve while the body waits for its owner.
    await until("attempt cancelled", () => !questsOf(server).trials.run(body), 2000);
    await until("waves gone", () => trialNpcs(a) === 0, 3000);
    // Longer than the whole hold: a lingering body standing in the ring earns nothing.
    await sleep(5500);
    const m = body.char.missions.find((x) => x.id === "T2")!;
    expect(m.done).toBe(false);
    expect(m.progress).toBe(0);
    expect(questsOf(server).trials.run(body)).toBeUndefined();
    const back = await reconnect();
    await until("idle on reconnect", () => lastTrial(back, "T2")?.state === "idle");
    expect(lastTrial(back, "T2").reason).toBe("dropped");
    expect(mission(back, "T2")).toMatchObject({ progress: 0, done: false });
    // And the beacon lights again for a fresh attempt.
    back.send("interact", { target: "t2_beacon" });
    await until("running again", () => lastTrial(back, "T2")?.state === "running");
  });

  it("waves belong to their runner: they come for the defender, never see, chase or hurt a bystander, and only the runner hurts them", async () => {
    TRIAL_RULES.timeScale = 0.2; // 18 s hold, waves at 0.4 / 4.4 s
    const a = await take("owner_holder", ["T2"], "hollowmere");
    const c = await bot("bystander", "hollowmere");
    a.send("npc", { cmd: "ambient", on: false }); // only the trial's creatures out here
    const beacon = objAt("t2_beacon");
    await tpAndWait(a, beacon);
    // The bystander stands right beside the defender, nearer some of the waves than the defender is.
    const side = offPad("hollowmere", 0, 40).map((v, i) => v - offPad("hollowmere", 0, 37)[i]!);
    await tpAndWait(c, beacon.map((v, i) => v + side[i]!));
    for (const b of [a, c]) b.send("admin", { cmd: "unprotect" });
    await sleep(120);
    a.send("interact", { target: "t2_beacon" });
    await until("a wave", () => trialNpcs(a) > 0);
    const npcs = npcSystemOf(serverRoom(a))!;
    const owner = actor(a);
    const other = actor(c);
    const waves = () => [...npcs.npcs.values()].filter((n) => n.spawned?.reason === "trial" && !n.dead);
    const hp0 = other.state.hp;
    let sawBystander = false;
    let allOnOwner = false;
    const until4s = Date.now() + 4000;
    while (Date.now() < until4s) {
      a.send("admin", { cmd: "heal" }); // the defender soaks the hits; the test is about who takes them
      if (waves().some((n) => n.target === other)) sawBystander = true;
      if (waves().length > 0 && waves().every((n) => n.target === owner)) allOnOwner = true;
      await sleep(100);
    }
    expect(sawBystander).toBe(false);
    expect(allOnOwner).toBe(true); // nothing has to find them: they come for the runner
    expect(other.state.hp).toBe(hp0);
    // A bystander's hits do nothing to someone else's trial; the runner's land.
    const w = waves()[0]!;
    const hp = w.state.hp;
    c.send("npc", { cmd: "hurt", id: w.id, as: c.id, amount: 30 });
    await until("refused as immune", () => c.count("immune") > 0);
    expect(w.state.hp).toBe(hp);
    a.send("npc", { cmd: "hurt", id: w.id, as: a.id, amount: 30 });
    await until("the runner's hit lands", () => w.state.hp < hp);
  });

  it("dying on the beacon fails the attempt and its waves dissolve", async () => {
    TRIAL_RULES.timeScale = 0.2;
    const a = await take("fallen_holder", ["T2"], "hollowmere");
    await tpAndWait(a, objAt("t2_beacon"));
    a.send("interact", { target: "t2_beacon" });
    await until("wave", () => trialNpcs(a) > 0);
    a.send("admin", { cmd: "unprotect" });
    await sleep(120);
    a.send("admin", { cmd: "damage", args: { amount: 5000 } });
    await until("failed: died", () => lastTrial(a, "T2")?.state === "failed");
    expect(lastTrial(a, "T2").reason).toBe("died");
    await until("waves gone", () => trialNpcs(a) === 0, 3000);
  });
});

describe("collect (T3, The Patient Gleam; A4, Kite Season)", () => {
  it("timed: the clock starts at the first shard; running out drops them; gathering all pays", async () => {
    TRIAL_RULES.timeScale = 0.01; // 2.4 s clock
    const a = await take("gatherer", ["T3"], "meridian");
    await gather(a, "T3", 0, 2);
    expect(lastTrial(a, "T3")).toMatchObject({ kind: "collect", state: "running", progress: 2, goal: 8, next: null, limitMs: 2400 });
    await tpAndWait(a, offPad("meridian", 0, 40)); // wandered off: the clock runs out
    await until("failed on time", () => lastTrial(a, "T3")?.state === "failed", 5000);
    expect(mission(a, "T3").progress).toBe(0);
    expect(mission(a, "T3").counts).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    TRIAL_RULES.timeScale = 0.2;
    await gather(a, "T3");
    await until("done", () => mission(a, "T3").done);
    expect(a.last("missionDone")).toEqual({ id: "T3", xp: 2400, coins: 350 });
  });

  it("the last shard pays before it says done; a failed save keeps the completion pending (past the clock) and pays once", async () => {
    TRIAL_RULES.timeScale = 0.03; // 7.2 s clock
    const a = await take("unlucky_gatherer", ["T3"], "meridian");
    const repo = characterRepo.current;
    const save = repo.save;
    let failing = false;
    repo.save = (userId, data) => {
      if (failing && userId === "unlucky_gatherer") throw new Error("disk I/O error (test)");
      save.call(repo, userId, data);
    };
    try {
      await gather(a, "T3", 0, 7);
      const clockEnds = Date.now() + 7200;
      failing = true;
      await tpAndWait(a, objAt(MISSION_BY_ID.get("T3")!.collect!.pieces[7]!));
      await sleep(Math.max(600, clockEnds - Date.now() + 800)); // past the clock, the payout still failing
      expect(trials(a).some((t) => t.id === "T3" && (t.state === "done" || t.state === "failed"))).toBe(false);
      expect(a.count("missionDone")).toBe(0);
      const m = actor(a).char.missions.find((x) => x.id === "T3")!;
      expect(m.done).toBe(false);
      expect(m.counts).toEqual([1, 1, 1, 1, 1, 1, 1, 1]);
      const coins = actor(a).char.coins;
      failing = false;
      await until("paid on the retry", () => mission(a, "T3")?.done === true);
      await until("done after the commit", () => lastTrial(a, "T3")?.state === "done");
      await sleep(400);
      expect(a.count("missionDone")).toBe(1);
      expect(actor(a).char.coins).toBe(coins + 350);
      expect(characterRepo.current.load("unlucky_gatherer")!.missions.find((x) => x.id === "T3")!.done).toBe(true);
    } finally {
      repo.save = save;
    }
  });

  it("untimed pieces (A4) are kept across a reconnect; a race's attempt is not", async () => {
    TRIAL_RULES.timeScale = 1;
    let a = await take("kiter", ["A4"], "arcadia");
    await tpAndWait(a, objAt("guide_arcadia"));
    await gather(a, "A4", 0, 3);
    expect(mission(a, "A4").progress).toBe(3);
    await safeLeave(a.room);
    a = await bot("kiter", "arcadia");
    expect(mission(a, "A4").progress).toBe(3);
    expect(mission(a, "A4").counts).toEqual([1, 1, 1, 0, 0]);
    await gather(a, "A4", 3);
    await until("kites done", () => mission(a, "A4").done);
    expect(a.last("missionDone")).toEqual({ id: "A4", xp: 60, coins: 25 });

    // A race cut by a reconnect starts over.
    await safeLeave(a.room);
    let r = await take("kiter", ["T1"], "arcadia");
    await runRings(r, "T1", 0, 3);
    await safeLeave(r.room);
    r = await bot("kiter", "arcadia");
    expect(mission(r, "T1").progress).toBe(0);
  });
});

describe("the Three Gleams", () => {
  it("Sela gives the trials in Portus only; all three open the vault once per life, with medal, title and the Hall line for the first", async () => {
    TRIAL_RULES.timeScale = 0.05;
    // Guides don't hand out trials, and Sela's are refused away from her.
    const g = await bot("seeker", "arcadia");
    await tpAndWait(g, objAt("guide_arcadia"));
    g.send("mission", { action: "accept", id: "T1" });
    await until("denied elsewhere", () => g.last("denied")?.reason === "giver elsewhere");
    await safeLeave(g.room);
    const p0 = await bot("seeker", "portus");
    await tpAndWait(p0, objAt("gleam_vault"));
    p0.send("interact", { target: "gleam_vault" });
    await until("locked", () => p0.last("denied")?.reason === "vault locked");
    await safeLeave(p0.room);

    // Win all three, each on its planet.
    let b = await take("seeker", ["T1", "T2", "T3"], "arcadia");
    await runRings(b, "T1");
    await until("T1", () => mission(b, "T1").done);
    await safeLeave(b.room);
    b = await bot("seeker", "hollowmere");
    await tpAndWait(b, objAt("t2_beacon"));
    b.send("interact", { target: "t2_beacon" });
    await until("T2", () => mission(b, "T2").done, 12000);
    await safeLeave(b.room);
    b = await bot("seeker", "meridian");
    await gather(b, "T3");
    await until("T3", () => mission(b, "T3").done);
    expect(b.toasts.some((t) => t.includes("All three gleams won"))).toBe(true);
    await safeLeave(b.room);

    const watcher = await bot("hall_watch", "portus");
    watcher.send("questSync");
    await until("hall", () => watcher.count("hall") > 0);
    b = await bot("seeker", "portus");
    const coins = b.you.coins;
    await tpAndWait(b, objAt("gleam_vault"));
    b.send("interact", { target: "gleam_vault" });
    await until("cape", () => invIds(b).includes("gleamweave_cape"));
    expect(b.you.coins).toBe(coins + GLEAMS.reward.coins);
    await until("medal", () => b.you.medals.includes("three_gleams"));
    expect(b.toasts.some((t) => t.includes("engraved"))).toBe(true);
    await until("hall line", () => watcher.last("hall").lines.some((l: any) => l.id === GLEAMS.firsts));
    expect(watcher.last("hall").lines.find((l: any) => l.id === GLEAMS.firsts).name).toBe("seeker");
    b.send("title", { medalId: "three_gleams" });
    await until("title", () => me(b).title === "Gleamkeeper");
    // Once per life.
    b.send("interact", { target: "gleam_vault" });
    await until("opened", () => b.last("denied")?.reason === "vault opened");
    expect(invIds(b).filter((id: string) => id === "gleamweave_cape")).toHaveLength(1);
    // The cape can't be sold (a once-per-life reward, like egg items).
    expect(progressStore.current.hall().filter((e) => e.secretId === GLEAMS.firsts)).toHaveLength(1);
  });

  it("hunt progress belongs to the life: a rebirth clears the gleams and the vault opens again; the medal stays", async () => {
    TRIAL_RULES.timeScale = 0.05;
    const capes = (b: Bot) => invIds(b).filter((id: string) => id === "gleamweave_cape").length;
    /** Win T1, T2 and T3 in this life, then stand in Portus at the vault. */
    async function winAll(uid: string, checkReconnect = false): Promise<Bot> {
      let b = await take(uid, ["T1", "T2", "T3"], "arcadia");
      await runRings(b, "T1");
      await until("T1", () => mission(b, "T1").done);
      await safeLeave(b.room);
      if (checkReconnect) {
        b = await bot(uid, "arcadia"); // a reconnect keeps a won gleam
        expect(mission(b, "T1").done).toBe(true);
        await safeLeave(b.room);
      }
      b = await bot(uid, "hollowmere");
      await tpAndWait(b, objAt("t2_beacon"));
      b.send("interact", { target: "t2_beacon" });
      await until("T2", () => mission(b, "T2").done, 12000);
      await safeLeave(b.room);
      b = await bot(uid, "meridian");
      await gather(b, "T3");
      await until("T3", () => mission(b, "T3").done);
      await safeLeave(b.room);
      b = await bot(uid, "portus");
      await tpAndWait(b, objAt("gleam_vault"));
      return b;
    }
    async function openVault(b: Bot) {
      const coins = b.you.coins;
      b.send("interact", { target: "gleam_vault" });
      await until("cape", () => capes(b) === 1);
      await until("coins", () => b.you.coins === coins + GLEAMS.reward.coins);
    }

    // Life 1: the vault pays, the medal is earned, the Hall line engraved.
    let b = await winAll("lifer", true);
    await openVault(b);
    await until("medal", () => b.you.medals.includes("three_gleams"));
    expect(b.count("medal")).toBe(1);
    expect(b.you.gleamVault).toBe(true);
    await safeLeave(b.room);

    // Death and rebirth: missions, gleams and the vault's once-per-life flag go with the life.
    b = await bot("lifer", "arcadia");
    b = (await dieAndRejoin(b, "lifer", "arcadia")).bot;
    expect(b.you.missions).toEqual([]);
    expect(b.you.gleamVault).toBe(false);
    expect(b.you.medals).toContain("three_gleams"); // the medal stays with the account
    await safeLeave(b.room);
    b = await bot("lifer", "portus");
    await tpAndWait(b, objAt("gleam_vault"));
    b.send("interact", { target: "gleam_vault" });
    await until("locked again", () => b.last("denied")?.reason === "vault locked");
    await safeLeave(b.room);

    // Life 2: win them again; the vault pays exactly once more, with no second medal or Hall line.
    b = await winAll("lifer");
    expect(capes(b)).toBe(0); // the first cape went into the death pile
    const before = b.you.coins;
    await openVault(b);
    b.send("interact", { target: "gleam_vault" });
    await until("once per life", () => b.last("denied")?.reason === "vault opened");
    await sleep(300);
    expect(capes(b)).toBe(1);
    expect(b.you.coins).toBe(before + GLEAMS.reward.coins);
    expect(b.count("medal")).toBe(0);
    expect(b.you.medals).toContain("three_gleams");
    expect(progressStore.current.hall().filter((e) => e.secretId === GLEAMS.firsts)).toHaveLength(1);
  }, 120_000);
});

describe("spells on trials (the spellbook lane)", () => {
  type V = [number, number, number];
  const sub = (a: readonly number[], b: readonly number[]): V => [a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!];
  const len = (v: readonly number[]) => Math.hypot(v[0]!, v[1]!, v[2]!);
  const unit = (v: readonly number[]): V => [v[0]! / len(v), v[1]! / len(v), v[2]! / len(v)];
  const cross = (a: V, b: V): V => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const feet = (b: Bot): V => [me(b).x, me(b).y, me(b).z];

  it("Skipstep in a race: a blink past a ring doesn't count, a blink through one does (rings are checked along the blink)", async () => {
    TRIAL_RULES.timeScale = 0.4; // 30 s clock
    const a = await take("blinker", ["T1"], "arcadia");
    a.send("admin", { cmd: "unprotect" });
    await runRings(a, "T1", 0, 2); // the clock runs; ring 3 is next
    const R3 = objAt("t1_ring_3");
    const up = unit(R3);
    const back = sub(objAt("t1_ring_2"), R3);
    const along = unit(sub(back, up.map((u) => u * (back[0] * up[0] + back[1] * up[1] + back[2] * up[2])) as V)).map((v) => -v) as V; // ring 2 → ring 3, on the ground plane
    const side = cross(up, along);
    const at = (f: number, s: number) => ground("arcadia", unit(R3.map((v, i) => v + along[i]! * f + side[i]! * s)));
    const blink = async () => {
      const from = feet(a);
      a.send("cast", { spell: "skipstep", dx: along[0], dy: along[1], dz: along[2] });
      await until("blinked", () => len(sub(feet(a), from)) > 8);
      await sleep(450); // two quest ticks
    };
    // Past: 7.5 m to the side of the ring (radius 4.5), blinking parallel to the route.
    await tpAndWait(a, at(-25, 10));
    await sleep(300);
    await tpAndWait(a, at(-5, 7.5));
    await sleep(300);
    await blink();
    expect(mission(a, "T1").progress).toBe(2);
    // Through: from 7 m short of it, straight along the route.
    a.send("admin", { cmd: "spells", args: { refill: true } }); // the cooldown, for the test
    await tpAndWait(a, at(-25, 10)); // back round the side: no admin move of ours crosses the ring
    await sleep(300);
    await tpAndWait(a, at(-7, 0));
    await sleep(300);
    expect(mission(a, "T1").progress).toBe(2);
    await blink();
    await until("ring 3 by the blink", () => mission(a, "T1").progress === 3);
    expect(lastTrial(a, "T1")).toMatchObject({ state: "running", next: "t1_ring_4" });
  });

  it("Frostbloom hurts the runner's own waves and not someone else's; the defender's ward soaks wave hits and the hold goes on", async () => {
    TRIAL_RULES.timeScale = 0.25; // 22.5 s hold
    const a = await take("caster_holder", ["T2"], "hollowmere");
    const c = await bot("caster_bystander", "hollowmere");
    a.send("npc", { cmd: "ambient", on: false });
    for (const b of [a, c]) {
      b.send("admin", { cmd: "level", args: { level: 9 } }); // Frostbloom (3) and the ward (9)
      b.send("admin", { cmd: "unprotect" });
    }
    await tpAndWait(a, objAt("t2_beacon"));
    await sleep(150);
    a.send("interact", { target: "t2_beacon" });
    await until("a wave", () => trialNpcs(a) > 0);
    const npcs = npcSystemOf(serverRoom(a))!;
    const owner = actor(a);
    const close = () => [...npcs.npcs.values()].find((n) => n.spawned?.reason === "trial" && !n.dead && !(n.state.flags & NF.INVULN) && len(sub(n.pos, feet(a))) < 4);
    await until("a wave creature up close (they come for the runner)", () => {
      a.send("admin", { cmd: "heal" });
      return !!close();
    }, 8000);
    // The runner's nova lands through combat's damage pipeline.
    const w = close()!;
    const hp = w.state.hp;
    a.send("cast", { spell: "frostbloom", dx: 1, dy: 0, dz: 0 });
    await until("frostbloom hurt the wave", () => w.state.hp < hp);
    // A bystander's nova on top of it does nothing to someone else's trial.
    const hp2 = w.state.hp;
    await tpAndWait(c, w.pos);
    c.send("cast", { spell: "frostbloom", dx: 1, dy: 0, dz: 0 });
    await until("refused as immune", () => c.count("immune") > 0);
    expect(w.state.hp).toBe(hp2);
    // The ward on the beacon: wave hits go into the shell; the hold keeps counting.
    await tpAndWait(a, objAt("t2_beacon"));
    const held = mission(a, "T2").progress;
    a.send("cast", { spell: "glasswing", dx: 1, dy: 0, dz: 0 });
    await until("a wave hit soaked by the ward", () => (a.msgs.get("spell") ?? []).some((e: any) => e.spell === "glasswing" && e.phase === "absorb" && e.by === a.id), 8000);
    expect(lastTrial(a, "T2").state).not.toBe("failed");
    await until("the hold goes on", () => mission(a, "T2").progress > held);
    expect(owner.dead).toBe(false);
  });
});
