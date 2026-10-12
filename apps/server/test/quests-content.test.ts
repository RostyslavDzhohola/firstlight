// Every mission, egg and medal has a server test (SPEC M6). Seam 1: SDK bots against the real
// in-process server; other lanes' events (NPC kills, props, onboarding) are emitted on the bus the
// way those lanes will emit them.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BODIES, padDirs, type BodyId } from "@firstlight/shared";
import { MEDAL_RULES } from "@firstlight/shared/content/medals";
import { missionsOn } from "@firstlight/shared/content/missions";
import { offsetDir, placeDir } from "@firstlight/shared/content/places";
import { rayTerrain } from "../src/world/geometry.ts";
import { WEAPON_INDEX } from "@firstlight/shared/content/weapons";
import { emitGameEvent, onGameEvent, type GameEvent } from "../src/world/events.ts";
import { npcSystemOf } from "../src/world/npc/index.ts";
import { MODE } from "../src/world/npc/npc.ts";
import { PF } from "@firstlight/shared/net/schema";
import { NPC_INDEX } from "@firstlight/shared/content/npcs";
import { emitNpcEvent } from "../src/world/npc/tuning.ts";
import { EGG_LIMITS } from "../src/world/quests/eggs.ts";
import type { QuestSystem } from "../src/world/quests/QuestSystem.ts";
import { progressStore } from "../src/world/quests/store.ts";
import { safeLeave, startServer } from "./helpers.ts";
import { bot, ground, harness, invIds, me, near, objAt, offPad, padAt, serverRoom, sleep, tpAndWait, until, type Bot, tp } from "./quest-helpers.ts";

beforeEach(async () => {
  harness.game = await startServer();
});
afterEach(async () => {
  for (const r of harness.rooms.splice(0)) await safeLeave(r);
  await harness.game!.close();
});

const mission = (b: Bot, id: string) => b.you.missions.find((m: any) => m.id === id);
const actorOf = (b: Bot) => serverRoom(b).actors.get(b.id)!;
const slotOf = (b: Bot, id: string) => [...b.you.hotbar, ...b.you.backpack].findIndex((i: any) => i?.id === id);

/** A ground spot near the E8 hatch with a clear line (terrain and props) from head height to every point. */
function vantage(b: Bot, targets: [number, number, number][], awayFrom?: [number, number, number]): [number, number, number] {
  const room = serverRoom(b);
  const hatch = objAt("e8_hatch");
  const hl = Math.hypot(...hatch);
  const dir: [number, number, number] = [hatch[0] / hl, hatch[1] / hl, hatch[2] / hl];
  for (const r of [25, 40, 55, 70, 90]) {
    for (let k = 0; k < 16; k++) {
      const a = (k / 16) * Math.PI * 2;
      const spot = ground("meridian", offsetDir(dir, Math.cos(a) * r, Math.sin(a) * r, BODIES.meridian.radius));
      const l = Math.hypot(...spot);
      const head: [number, number, number] = [spot[0] + (spot[0] / l) * 1.6, spot[1] + (spot[1] / l) * 1.6, spot[2] + (spot[2] / l) * 1.6];
      const clear = targets.every((t) => {
        const v: [number, number, number] = [t[0] - head[0], t[1] - head[1], t[2] - head[2]];
        const len = Math.hypot(...v);
        const d: [number, number, number] = [v[0] / len, v[1] / len, v[2] / len];
        return len < 140 && rayTerrain(room.terrain, head, d, len, 1) >= len && !room.host.props?.raycast(head, d, len);
      });
      const apart = !awayFrom || Math.hypot(spot[0] - awayFrom[0], spot[1] - awayFrom[1], spot[2] - awayFrom[2]) > 8;
      if (clear && apart && Math.hypot(spot[0] - hatch[0], spot[1] - hatch[1], spot[2] - hatch[2]) > 12) return spot;
    }
  }
  throw new Error("no vantage point on the E8 lamps");
}

/** A real Stillshot shot from the bot's head at a point (combat's hitscan → "shot" → quests). */
function snipe(b: Bot, at: readonly number[]) {
  const a = actorOf(b);
  a.lastAttackAt = 0; // the test doesn't wait out the 1.4 s rate or the reload
  a.reloadEndsAt = 0;
  const p = me(b);
  const l = Math.hypot(p.x, p.y, p.z);
  const head = [p.x + (p.x / l) * 1.6, p.y + (p.y / l) * 1.6, p.z + (p.z / l) * 1.6];
  const d = [at[0]! - head[0]!, at[1]! - head[1]!, at[2]! - head[2]!];
  const dl = Math.hypot(d[0]!, d[1]!, d[2]!);
  b.send("fire", { slot: slotOf(b, "stillshot"), ox: head[0], oy: head[1], oz: head[2], dx: d[0]! / dl, dy: d[1]! / dl, dz: d[2]! / dl, t: Date.now() });
}
const quests = (b: Bot) => serverRoom(b).systems.find((s) => "eggs" in s) as QuestSystem;

async function runPlanetMissions(b: Bot, body: Exclude<BodyId, "portus">) {
  await tpAndWait(b, objAt(`guide_${body}`));
  const defs = missionsOn(body);
  for (const d of defs) b.send("mission", { action: "accept", id: d.id });
  await until(`${body} accepted`, () => defs.every((d) => mission(b, d.id)), 8000);
  await sleep(300); // one quest tick at the guide arms the reach mission (players walk from here)
  for (const d of defs) {
    if (d.hunt) {
      // Kills arrive the way the NPC lane reports them: by def and spawn area, with the credited players.
      for (const t of d.hunt.targets) for (let i = 0; i < t.count; i++) emitNpcEvent({ kind: "kill", body, def: t.npcKind, npcLevel: 10, players: [b.id], userIds: ["courier"], area: d.hunt.place ?? null });
    } else if (d.find) {
      await tpAndWait(b, objAt(d.find.object));
      b.send("interact", { target: d.find.object });
    } else if (d.reach) {
      await tpAndWait(b, ground(body, placeDir(d.reach.place)));
    }
    await until(`${d.id} done`, () => mission(b, d.id)?.done === true, 8000);
    expect(b.msgs.get("missionDone")!.some((m) => m.id === d.id && m.xp === d.reward.xp && m.coins === d.reward.coins)).toBe(true);
  }
  // Leave from the main pad (safe) so the character saves at once.
  await tpAndWait(b, padAt(body, 0));
}

describe("all nine missions", () => {
  it("complete through their real objectives on all three planets, then Errand Runner", async () => {
    let coins = 0;
    for (const body of ["arcadia", "hollowmere", "meridian"] as const) {
      const b = await bot("courier", body);
      await runPlanetMissions(b, body);
      coins += missionsOn(body).reduce((s, d) => s + d.reward.coins, 0);
      expect(b.you.coins).toBe(coins);
      if (body === "meridian") await until("errand runner", () => b.you.medals.includes("errand_runner"), 8000);
      else await safeLeave(b.room);
    }
  }, 60_000);
});

describe("medals", () => {
  it("progress medals: Spark, Firstlight, Cartographer", async () => {
    const b = await bot("progressor", "arcadia");
    emitGameEvent(serverRoom(b), { type: "onboardingDone", playerId: b.id });
    await until("spark", () => b.you.medals.includes("spark"));
    b.send("admin", { cmd: "level", args: { level: 20 } });
    await until("firstlight", () => b.you.medals.includes("firstlight"), 3000);
    for (let i = 0; i < padDirs(BODIES.arcadia).length; i++) {
      await tpAndWait(b, padAt("arcadia", i));
      await sleep(260);
    }
    await until("cartographer", () => b.you.medals.includes("cartographer"));
    expect(b.you.pads).toHaveLength(12);
  }, 15_000);

  it("feat medals: all three bosses and Triple Crown, Demolition Crew, Arc Welder, Long Shot", async () => {
    const b = await bot("featster", "arcadia");
    const room = serverRoom(b);
    const at = ground("arcadia", placeDir("gull_point"));
    for (const bossId of ["tidewrath", "hollow_king", "receiver"] as const) emitGameEvent(room, { type: "kill", npcKind: bossId, bossId, killerId: b.id, creditIds: [b.id], pos: at });
    await until("boss medals", () => ["tide_turner", "regicide", "decommissioned", "triple_crown"].every((m) => b.you.medals.includes(m)));

    for (let i = 0; i < MEDAL_RULES.DEMOLITION_PROPS - 1; i++) emitGameEvent(room, { type: "propBroken", playerId: b.id });
    await sleep(100);
    expect(b.you.medals).not.toContain("demolition_crew");
    emitGameEvent(room, { type: "propBroken", playerId: b.id });
    await until("demolition crew", () => b.you.medals.includes("demolition_crew"));
    expect(progressStore.current.stat("featster", "props_broken")).toBe(200);

    // Arc Welder: a Stormcoil cast whose chain damaged 4 entities (combat's "shot" broadcast; only T2+ chains reach 4).
    const chainShot = (weapon: string, n: number) =>
      room.host.broadcast("shot", { by: b.id, weapon: WEAPON_INDEX.get(weapon), ox: 0, oy: 0, oz: 0, dx: 1, dy: 0, dz: 0, chain: Array.from({ length: n }, () => [0, 0, 0]) });
    chainShot("stormcoil", 3);
    chainShot("carbine", 5);
    await sleep(100);
    expect(b.you.medals).not.toContain("arc_welder");
    chainShot("stormcoil", 4);
    await until("arc welder", () => b.you.medals.includes("arc_welder"));

    // Long Shot: a kill at 120 m or more by a Stillshot that just fired (not an older projectile).
    b.send("admin", { cmd: "give", args: { id: "stillshot", tier: 1 } });
    await until("stillshot", () => b.you.hotbar[1]?.id === "stillshot");
    b.send("equip", { slot: 1 });
    await until("equip", () => b.you.selected === 1);
    const shooter = actorOf(b);
    shooter.lastAttackAt = Date.now();
    emitGameEvent(room, { type: "kill", npcKind: "hopbit", killerId: b.id, pos: offPad("arcadia", 0, 60) });
    shooter.lastAttackAt = Date.now() - 5000;
    emitGameEvent(room, { type: "kill", npcKind: "hopbit", killerId: b.id, pos: offPad("arcadia", 0, 135) });
    await sleep(100);
    expect(b.you.medals).not.toContain("long_shot");
    shooter.lastAttackAt = Date.now();
    emitGameEvent(room, { type: "kill", npcKind: "hopbit", killerId: b.id, pos: offPad("arcadia", 0, 135) });
    await until("long shot", () => b.you.medals.includes("long_shot"));
  }, 15_000);

  it("survival and joke medals: Old Timer, By a Thread, With Friends Like These", async () => {
    const a = await bot("survivor", "arcadia");
    const friend = await bot("frenemy", "arcadia");
    actorOf(a).char.life!.playMs = MEDAL_RULES.OLD_TIMER_MS;
    await until("old timer", () => a.you.medals.includes("old_timer"), 3000);

    const room = serverRoom(a);
    emitGameEvent(room, { type: "damage", targetId: a.id, targetKind: "player", attackerId: null, attackerKind: "world", amount: 95, hpAfter: 4, maxHp: 100, at: Date.now() - MEDAL_RULES.BY_A_THREAD_MS - 1000 });
    await until("by a thread", () => a.you.medals.includes("by_a_thread"));

    actorOf(a).state.party = "party-7";
    actorOf(friend).state.party = "party-7";
    emitGameEvent(room, { type: "death", victimId: a.id, killerId: friend.id, killerKind: "player", pos: offPad("arcadia", 0, 30) });
    await until("with friends", () => a.you.medals.includes("with_friends_like_these"));
    expect(friend.you.medals).not.toContain("with_friends_like_these");
  });
});

describe("Easter eggs", () => {
  it("E3 Follow the Gold: the burrow opens when the NPC lane reports the Golden Hopbit's run", async () => {
    const b = await bot("follower", "arcadia");
    await tpAndWait(b, objAt("e3_burrow"));
    b.send("interact", { target: "e3_burrow" });
    await until("too small", () => b.toasts.some((t) => t.includes("too small")));
    emitGameEvent(serverRoom(b), { type: "secretStep", playerId: b.id, secretId: "E3", step: "burrow" });
    b.send("interact", { target: "e3_burrow" });
    await until("golden hopbit", () => invIds(b).includes("golden_hopbit"));
    expect(b.you.medals).toContain("follow_the_gold");
  });

  it("E4 The Ferryman's Lanterns: seven lanterns, the ghost ferry, the oar", async () => {
    const b = await bot("ferryman", "hollowmere");
    for (let i = 1; i <= 7; i++) {
      await tpAndWait(b, objAt(`e4_lantern_${i}`));
      b.send("interact", { target: `e4_lantern_${i}` });
      await until(`lantern ${i}`, () => b.toasts.some((t) => t.includes(`(${i}/7)`) || t.includes("All seven")));
      await sleep(210); // quest actions are limited to 5 per second
    }
    // An enter trigger moves the player on at once: don't wait to be seen at the trigger itself.
    tp(b, objAt("e4_ferry"));
    await until("ferried", () => near(b, ground("hollowmere", placeDir("ferrymans_isle")), 4));
    b.send("interact", { target: "e4_chest" });
    await until("oar", () => [...b.you.hotbar, ...b.you.backpack].some((i: any) => i?.id === "riverstaff" && i.tier === 2 && i.skin === "ferrymans_oar"));
    expect(b.you.medals).toContain("paid_the_ferryman");
  }, 15_000);

  it("E5 Bellringer: wrong order raises bones, the right order gives the Candle Crown", async () => {
    const b = await bot("ringer", "hollowmere");
    const spawns: GameEvent[] = [];
    onGameEvent(serverRoom(b), (e) => e.type === "spawnRequest" && spawns.push(e));
    await tpAndWait(b, objAt("e5_rope_lantern"));
    const lockMs = EGG_LIMITS.lockMs;
    EGG_LIMITS.lockMs = 600; // the ropes lock after a wrong order (15 s in play)
    try {
      b.send("interact", { target: "e5_rope_candle" });
      await until("penalty", () => spawns.length === 1);
      expect(spawns[0]).toMatchObject({ npcKind: "bonewalker", count: 2, egg: "E5" });
      await until("bonewalkers raised", () => [...npcSystemOf(serverRoom(b))!.npcs.values()].filter((n) => n.spawned?.key === "E5").length === 2);
      await until("ropes unlocked", () => quests(b).eggs.lockedFor("ringer", "E5") === 0);
    } finally {
      EGG_LIMITS.lockMs = lockMs;
    }
    for (const r of ["skull", "lantern", "candle"]) b.send("interact", { target: `e5_rope_${r}` });
    await until("candle crown", () => invIds(b).includes("candle_crown"));
    expect(b.you.medals).toContain("bellringer");
  });

  it("E8 Lights Out: five lamps shot within 20 s open the hatch; each player has their own lamps", async () => {
    const b = await bot("sniper", "meridian");
    const other = await bot("lampwatch", "meridian");
    b.send("interact", { target: "e8_hatch" }); // from far away: nothing
    const lamps = [1, 2, 3, 4, 5].map((i) => objAt(`e8_lamp_${i}`));
    const spot = vantage(b, lamps);
    const spot2 = vantage(b, lamps, spot); // apart, so neither stands in the other's line of fire
    for (const [x, at] of [[b, spot], [other, spot2]] as const) {
      await tpAndWait(x, at);
      x.send("admin", { cmd: "unprotect" });
      x.send("admin", { cmd: "give", args: { id: "stillshot", tier: 1 } });
      await until("stillshot", () => slotOf(x, "stillshot") >= 0);
      x.send("equip", { slot: slotOf(x, "stillshot") });
      await until("equipped", () => x.you.selected === slotOf(x, "stillshot"));
      x.send("scope", { on: true }); // scoped: no spread (the lamps are 0.6 m across)
    }
    // Someone else shoots lamp 1 first: it goes dark for them only and doesn't block this run.
    snipe(other, objAt("e8_lamp_1"));
    await until("other's lamp", () => (other.msgs.get("lamp") ?? []).some((m) => !m.on && m.id === "e8_lamp_1"));
    for (let i = 1; i <= 5; i++) {
      snipe(b, objAt(`e8_lamp_${i}`));
      await until(`lamp ${i}`, () => (b.msgs.get("lamp") ?? []).filter((m) => !m.on).length === i);
    }
    await until("dark", () => b.toasts.some((t) => t.includes("goes dark")));
    expect((other.msgs.get("lamp") ?? []).filter((m) => !m.on)).toHaveLength(1);
    expect(other.toasts.some((t) => t.includes("goes dark"))).toBe(false);
    await tpAndWait(b, objAt("e8_hatch"));
    b.send("interact", { target: "e8_hatch" });
    await until("static cloak", () => invIds(b).includes("static_cloak"));
    expect(b.you.medals).toContain("lights_out");
  }, 20_000);

  it("E9 Ticket #000: when the trooper reaches the lift with you beside it, the Vat Room opens; not from afar or in a fight", async () => {
    const b = await bot("diplomat", "meridian");
    const far = await bot("escapee", "meridian");
    expect(invIds(b)).not.toContain("ticket_000_helmet");
    const npcs = npcSystemOf(serverRoom(b))!;
    // The real brain path: Ticket #000 walking for `walker` and already 120 m from where it started.
    const walkTo = (who: Bot, nearBy: boolean) => {
      const p = me(nearBy ? who : b);
      const at = serverRoom(b).snapToGround([p.x, p.y, p.z]);
      const n = npcs.createNpc(NPC_INDEX.get("ticket_000")!, 1, at, Date.now(), { instant: true });
      n.egg = { follower: null, since: 0, walker: who.id, walkFrom: [at[0] + 500, at[1], at[2]], walkDir: n.facing };
      npcs.setMode(n, MODE.SCRIPT, Date.now());
      return n;
    };
    // From afar (the far bot is 300 m away): refused.
    await tpAndWait(far, offPad("meridian", 0, 300));
    walkTo(far, false);
    await until("refused", () => far.toasts.some((t) => t.includes("doors close")));
    expect(near(far, ground("meridian", placeDir("vat_room")), 30)).toBe(false);
    // Beside it but combat-tagged: refused too.
    await tpAndWait(b, offPad("meridian", 0, 200));
    b.send("admin", { cmd: "unprotect" });
    await until("off the safe ring", () => (actorOf(b).state.flags & PF.SAFE) === 0 && actorOf(b).protectedUntil === 0);
    b.send("admin", { cmd: "damage", args: { amount: 1 } });
    await until("tagged", () => actorOf(b).combatUntil > Date.now());
    walkTo(b, true);
    await until("refused in combat", () => b.toasts.some((t) => t.includes("doors close")));
    // Out of combat, beside it: down to the Vat Room.
    actorOf(b).combatUntil = 0;
    walkTo(b, true);
    await until("vat room", () => near(b, ground("meridian", placeDir("vat_room")), 4));
    b.send("interact", { target: "e9_pod" });
    await until("helmet", () => invIds(b).includes("ticket_000_helmet"));
    expect(b.you.medals).toContain("not_a_clone");
    expect(progressStore.current.hall().map((h) => h.secretId)).toContain("E9");
  });
});

describe("NPC lane bridge", () => {
  it("NPC kills by spawn area feed hunts, boss kills feed medals, egg penalties spawn real NPCs", async () => {
    const b = await bot("bridger", "arcadia");
    await tpAndWait(b, objAt("guide_arcadia"));
    b.send("mission", { action: "accept", id: "A1" });
    await until("accepted", () => !!mission(b, "A1"));
    // Kills outside Clover Fields (other area, or none) don't count; inside do.
    emitNpcEvent({ kind: "kill", body: "arcadia", def: "hopbit", npcLevel: 2, players: [b.id], userIds: ["bridger"], area: "lacefall" });
    emitNpcEvent({ kind: "kill", body: "arcadia", def: "hopbit", npcLevel: 2, players: [b.id], userIds: ["bridger"], area: null });
    emitNpcEvent({ kind: "kill", body: "hollowmere", def: "hopbit", npcLevel: 2, players: [b.id], userIds: ["bridger"], area: "clover_fields" });
    for (let i = 0; i < 3; i++) emitNpcEvent({ kind: "kill", body: "arcadia", def: "hopbit", npcLevel: 2, players: [b.id], userIds: ["bridger"], area: "clover_fields" });
    await until("hunt progress", () => mission(b, "A1")?.progress === 3);

    emitNpcEvent({ kind: "bossKill", body: "arcadia", boss: "tidewrath", sessionIds: [b.id], userIds: ["bridger"], names: ["bridger"] });
    await until("tide turner", () => b.you.medals.includes("tide_turner"));

    const npcs = npcSystemOf(serverRoom(b))!;
    const before = npcs.npcs.size;
    await tpAndWait(b, objAt("e2_btn_flame"));
    b.send("interact", { target: "e2_btn_flame" }); // wrong first button
    await until("hopbits spawned", () => [...npcs.npcs.values()].filter((n) => n.def.id === "hopbit").length >= 3 && npcs.npcs.size >= before + 3);
  });
});
