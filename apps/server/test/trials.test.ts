// The new objective types (race, defend, collect; quests/trials.ts) and the Three Gleams hunt
// (content/gleams.ts): SDK bots against the real in-process server, through the messages and state a
// client sees. Trial clocks run at TRIAL_RULES.timeScale (shrunk here, restored after each test).

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GLEAMS } from "@firstlight/shared/content/gleams";
import { MISSION_BY_ID } from "@firstlight/shared/content/missions";
import type { BodyId } from "@firstlight/shared";
import { PLAY_LIMITS } from "../src/app.ts";
import { TRIAL_RULES } from "../src/world/quests/trials.ts";
import { npcSystemOf } from "../src/world/npc/index.ts";
import { progressStore } from "../src/world/quests/store.ts";
import { safeLeave, startServer, waitFor } from "./helpers.ts";
import { bot, harness, invIds, me, objAt, offPad, serverRoom, sleep, tpAndWait, until, type Bot } from "./quest-helpers.ts";

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
    await runRings(a, "T1", 3);
    await runRings(c, "T1", 2);
    await until("both done", () => mission(a, "T1").done && mission(c, "T1").done);
    expect(lastTrial(a, "T1").state).toBe("done");
    expect(a.last("missionDone")).toEqual({ id: "T1", xp: 300, coins: 80 });
    expect(a.toasts.some((t) => t.includes("Gleam won: 1 of 3"))).toBe(true);
    // The hunt is public: each hears of the other's gleam (the event feed), never of their own.
    await until("the news reached both", () => a.count("news") === 1 && c.count("news") === 1);
    expect(a.last("news")).toEqual({ kind: "gleam", name: me(c).name, mission: "T1" });
    expect(c.last("news")).toEqual({ kind: "gleam", name: me(a).name, mission: "T1" });
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
  it("the beacon starts the clock, waves rise near the defender and pay nothing, and dissolve at the end", async () => {
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
    let b = await take("lifer", ["T1"], "arcadia");
    await runRings(b, "T1");
    await until("T1", () => mission(b, "T1").done);
    // A reconnect keeps a won gleam.
    await safeLeave(b.room);
    b = await bot("lifer", "arcadia");
    expect(mission(b, "T1").done).toBe(true);
    // Death and rebirth: missions (and gleams) are lost with the life.
    await tpAndWait(b, offPad("arcadia", 0, 40));
    b.send("admin", { cmd: "unprotect" });
    await sleep(120);
    b.send("admin", { cmd: "damage", args: { amount: 5000 } });
    await waitFor(() => b.count("death") > 0);
    b.send("respawn", { starter: 1, palette: 0 });
    await waitFor(() => b.count("reborn") > 0);
    await safeLeave(b.room);
    b = await bot("lifer", "portus");
    expect(b.you.missions).toEqual([]);
    await tpAndWait(b, objAt("curator_sela"));
    b.send("mission", { action: "accept", id: "T1" });
    await until("re-accepted", () => !!mission(b, "T1"));
  });
});
