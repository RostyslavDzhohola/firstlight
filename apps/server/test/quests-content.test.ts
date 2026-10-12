// Every mission, egg and medal has a server test (SPEC M6). Seam 1: SDK bots against the real
// in-process server. Medals and eggs go through the real paths (weapons fired, props broken, NPCs
// spawned and killed, the NPC lane's events); only Spark still fakes its event (no onboarding yet).

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BODIES, isSafe, padDirs, type BodyId } from "@firstlight/shared";
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

/** A real shot with `weapon` from the bot's head at a point (combat → "shot"/damage → quests). */
function fireAt(b: Bot, weapon: string, at: readonly number[], slot = slotOf(b, weapon)) {
  const a = actorOf(b);
  a.lastAttackAt = 0; // the test doesn't wait out fire rates, reloads or heat
  a.reloadEndsAt = 0;
  a.overheatUntil = 0;
  const p = me(b);
  const l = Math.hypot(p.x, p.y, p.z);
  const head = [p.x + (p.x / l) * 1.6, p.y + (p.y / l) * 1.6, p.z + (p.z / l) * 1.6];
  const d = [at[0]! - head[0]!, at[1]! - head[1]!, at[2]! - head[2]!];
  const dl = Math.hypot(d[0]!, d[1]!, d[2]!);
  b.send("fire", { slot, ox: head[0], oy: head[1], oz: head[2], dx: d[0]! / dl, dy: d[1]! / dl, dz: d[2]! / dl, t: Date.now() });
}
const snipe = (b: Bot, at: readonly number[]) => fireAt(b, "stillshot", at);

const liftBy = (p: readonly number[], h: number): [number, number, number] => {
  const l = Math.hypot(p[0]!, p[1]!, p[2]!);
  return [p[0]! + (p[0]! / l) * h, p[1]! + (p[1]! / l) * h, p[2]! + (p[2]! / l) * h];
};

/** Clear line from a head at `from` to `to`: no terrain, no intact prop. */
function clear(b: Bot, from: readonly number[], to: readonly number[]): boolean {
  const room = serverRoom(b);
  const v = [to[0]! - from[0]!, to[1]! - from[1]!, to[2]! - from[2]!];
  const len = Math.hypot(v[0]!, v[1]!, v[2]!);
  const d: [number, number, number] = [v[0]! / len, v[1]! / len, v[2]! / len];
  const o: [number, number, number] = [from[0]!, from[1]!, from[2]!];
  return rayTerrain(room.terrain, o, d, len, 1) >= len && !room.host.props?.raycast(o, d, len);
}

/** A shooter spot and a target spot `range` m apart along the surface, with a clear line between. */
function lineOfSight(b: Bot, range: number): { shooter: [number, number, number]; target: [number, number, number] } {
  const R = BODIES.arcadia.radius;
  for (const pad of padDirs(BODIES.arcadia)) {
    for (let k = 0; k < 8; k++) {
      const c = Math.cos((k * Math.PI) / 4), sn = Math.sin((k * Math.PI) / 4);
      for (const start of [30, 50, 70, 100]) {
        const shooter = ground("arcadia", offsetDir(pad, c * start, sn * start, R));
        const target = ground("arcadia", offsetDir(pad, c * (start + range), sn * (start + range), R));
        if (BODIES.arcadia.waterLevel + R + 0.5 > Math.min(Math.hypot(...shooter), Math.hypot(...target))) continue;
        if (isSafe(BODIES.arcadia, ...shooter)) continue;
        if (clear(b, liftBy(shooter, 1.6), liftBy(target, 0.3))) return { shooter, target };
      }
    }
  }
  throw new Error(`no ${range} m line of sight`);
}

/** A breakable of `kind` and a firing spot 7 m from it with a clear line to its centre. */
function propInSight(b: Bot, kind: string): { shooter: [number, number, number]; prop: [number, number, number] } {
  const room = serverRoom(b);
  const sys = room.systems.find((x) => "brokenUntil" in x) as unknown as { list: { kind: string; index: number; px: number; py: number; pz: number; cx: number; cy: number; cz: number; rx: number; ry: number; rz: number; fx: number; fy: number; fz: number; foot: number }[] };
  for (const p of sys.list) {
    if (p.kind !== kind) continue;
    for (let k = 0; k < 12; k++) {
      const a = (k / 12) * Math.PI * 2;
      const c = Math.cos(a), s = Math.sin(a), r = p.foot + 7;
      const at = [p.px + (p.rx * c + p.fx * s) * r, p.py + (p.ry * c + p.fy * s) * r, p.pz + (p.rz * c + p.fz * s) * r];
      const l = Math.hypot(at[0]!, at[1]!, at[2]!);
      const shooter = ground("arcadia", [at[0]! / l, at[1]! / l, at[2]! / l]);
      if (isSafe(BODIES.arcadia, ...shooter) || Math.hypot(...shooter) < BODIES.arcadia.radius + BODIES.arcadia.waterLevel + 0.5) continue;
      const head = liftBy(shooter, 1.6);
      const centre: [number, number, number] = [p.cx, p.cy, p.cz];
      const v = [centre[0] - head[0], centre[1] - head[1], centre[2] - head[2]];
      const len = Math.hypot(v[0]!, v[1]!, v[2]!);
      const d: [number, number, number] = [v[0]! / len, v[1]! / len, v[2]! / len];
      if (rayTerrain(room.terrain, head, d, len, 0.5) < len) continue;
      if (room.host.props?.raycast(head, d, len + 1)?.index !== p.index) continue;
      return { shooter, prop: centre };
    }
  }
  throw new Error(`no ${kind} in sight`);
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
      if (body === "meridian") {
        await until("errand runner", () => b.you.medals.includes("errand_runner"), 8000);
        expect(invIds(b).filter((id: string) => id === "copper_orbit_pack")).toHaveLength(1);
      }
      else await safeLeave(b.room);
    }
  }, 60_000);
});

describe("medals", () => {
  it("progress medals: Spark, Firstlight, Cartographer", async () => {
    const b = await bot("progressor", "arcadia");
    // Spark through the bus listener for onboardingDone. The real path (training dummies on Portus,
    // OnboardingSystem paying and awarding it in one transaction) is driven in onboarding.test.ts.
    emitGameEvent(serverRoom(b), { type: "onboardingDone", playerId: b.id });
    await until("spark", () => b.you.medals.includes("spark"));
    b.send("admin", { cmd: "level", args: { level: 20 } });
    await until("firstlight", () => b.you.medals.includes("firstlight"), 3000);
    for (let i = 0; i < padDirs(BODIES.arcadia).length; i++) {
      await tpAndWait(b, padAt("arcadia", i));
      await until(`pad ${i}`, () => b.you.pads.includes(i));
    }
    await until("cartographer", () => b.you.medals.includes("cartographer"));
    expect(b.you.pads).toHaveLength(12);
  }, 15_000);

  it("boss medals and Triple Crown from the NPC lane's boss kills on each planet", async () => {
    const kills = [["arcadia", "tidewrath", "tide_turner"], ["hollowmere", "hollow_king", "regicide"], ["meridian", "the_receiver", "decommissioned"]] as const;
    for (const [body, boss, medal] of kills) {
      const b = await bot("featster", body);
      // The boss system's own event, emitted here: a test kill needs an admin tool (npc hurt), which
      // makes the fight assisted and withholds every medal. Real assisted kills (boss.ts emitting
      // bossKill before its loot) are driven in stage-admin.test.ts.
      emitNpcEvent({ kind: "bossKill", body, boss, sessionIds: [b.id], userIds: ["featster"], names: ["featster"] });
      await until(medal, () => b.you.medals.includes(medal));
      if (body === "meridian") await until("triple crown", () => b.you.medals.includes("triple_crown"));
      else {
        expect(b.you.medals).not.toContain("triple_crown");
        await tpAndWait(b, padAt(body, 0)); // leave from a pad so the life progress saves at once
        await safeLeave(b.room);
      }
    }
  }, 30_000);

  it("Demolition Crew: the 200th prop broken by a real rocket", async () => {
    const b = await bot("wrecker", "arcadia");
    progressStore.current.addStat("wrecker", "props_broken", MEDAL_RULES.DEMOLITION_PROPS - 1);
    const { shooter, prop } = propInSight(b, "crate");
    await tpAndWait(b, shooter);
    b.send("admin", { cmd: "unprotect" });
    b.send("admin", { cmd: "give", args: { id: "comet", tier: 1 } });
    await until("comet", () => slotOf(b, "comet") >= 0);
    await until("ready", () => (actorOf(b).state.flags & (PF.SAFE | PF.PROTECTED)) === 0);
    fireAt(b, "comet", prop);
    await until("demolition crew", () => b.you.medals.includes("demolition_crew"));
    expect(progressStore.current.stat("wrecker", "props_broken")).toBeGreaterThanOrEqual(MEDAL_RULES.DEMOLITION_PROPS); // the blast may take a neighbour too
  });

  it("Arc Welder: a real T2 Stormcoil cast that chains through 4 entities (a T1 cast reaches only 3)", async () => {
    const b = await bot("welder", "arcadia");
    b.send("admin", { cmd: "level", args: { level: 6 } });
    await tpAndWait(b, offPad("arcadia", 0, 55));
    b.send("admin", { cmd: "unprotect" });
    await until("ready", () => b.you.level === 6 && (actorOf(b).state.flags & (PF.SAFE | PF.PROTECTED)) === 0);
    const line = [60, 63, 66, 69, 72].map((m) => offPad("arcadia", 0, m));
    const spawnLine = async () => {
      const npcs = npcSystemOf(serverRoom(b))!;
      for (const n of [...npcs.npcs.values()]) npcs.despawnNpc(n);
      for (const p of line) b.send("npc", { cmd: "spawn", kind: "woolback", x: p[0], y: p[1], z: p[2], level: 1, roam: 0, instant: true });
      await until("woolbacks", () => [...npcs.npcs.values()].filter((n) => n.def.id === "woolback").length === line.length);
    };
    const shots = () => b.count("shot");
    for (const tier of [1, 2]) {
      await spawnLine();
      b.send("admin", { cmd: "give", args: { id: "stormcoil", tier } });
      await until(`stormcoil ${tier}`, () => [...b.you.hotbar, ...b.you.backpack].some((i: any) => i?.id === "stormcoil" && i.tier === tier));
      const slot = [...b.you.hotbar, ...b.you.backpack].findIndex((i: any) => i?.id === "stormcoil" && i.tier === tier);
      const before = shots();
      fireAt(b, "stormcoil", liftBy(line[0]!, 1.0), slot);
      await until(`cast ${tier}`, () => shots() > before);
      const chain = b.last("shot").chain as unknown[];
      if (tier === 1) {
        expect(chain).toHaveLength(3); // 2 jumps
        expect(b.you.medals).not.toContain("arc_welder");
      } else expect(chain.length).toBeGreaterThanOrEqual(4);
    }
    await until("arc welder", () => b.you.medals.includes("arc_welder"));
  }, 20_000);

  it("Long Shot: a real Stillshot kill at 120 m or more (not at 60 m)", async () => {
    const b = await bot("farshot", "arcadia");
    b.send("admin", { cmd: "give", args: { id: "stillshot", tier: 1 } });
    await until("stillshot", () => slotOf(b, "stillshot") >= 0);
    b.send("equip", { slot: slotOf(b, "stillshot") });
    b.send("scope", { on: true });
    for (const [range, counts] of [[60, false], [125, true]] as const) {
      const { shooter, target } = lineOfSight(b, range);
      await tpAndWait(b, shooter);
      b.send("admin", { cmd: "unprotect" });
      await until("ready", () => (actorOf(b).state.flags & (PF.SAFE | PF.PROTECTED)) === 0);
      const npcs = npcSystemOf(serverRoom(b))!;
      b.send("npc", { cmd: "spawn", kind: "hopbit", x: target[0], y: target[1], z: target[2], level: 1, roam: 0, instant: true });
      await until("hopbit", () => [...npcs.npcs.values()].some((n) => n.def.id === "hopbit" && !n.dead));
      const hop = [...npcs.npcs.values()].find((n) => n.def.id === "hopbit" && !n.dead)!;
      const kills = b.count("npcKill");
      fireAt(b, "stillshot", liftBy(hop.pos, 0.3));
      await until(`kill at ${range} m`, () => b.count("npcKill") > kills);
      if (counts) await until("long shot", () => b.you.medals.includes("long_shot"));
      else expect(b.you.medals).not.toContain("long_shot");
    }
  }, 20_000);

  it("survival and joke medals: Old Timer, By a Thread, With Friends Like These", async () => {
    const a = await bot("survivor", "arcadia");
    const friend = await bot("frenemy", "arcadia");
    actorOf(a).char.life!.playMs = MEDAL_RULES.OLD_TIMER_MS;
    await until("old timer", () => a.you.medals.includes("old_timer"), 3000);

    // By a Thread: real damage down to 5% or less, then still alive when the window ends.
    const rules = MEDAL_RULES as { BY_A_THREAD_MS: number };
    const window = rules.BY_A_THREAD_MS;
    rules.BY_A_THREAD_MS = 600;
    try {
      await tpAndWait(a, offPad("arcadia", 0, 40));
      a.send("admin", { cmd: "unprotect" });
      await until("ready", () => (actorOf(a).state.flags & (PF.SAFE | PF.PROTECTED)) === 0);
      a.send("admin", { cmd: "damage", args: { amount: 96 } });
      await until("4 hp", () => actorOf(a).state.hp === 4);
      await until("by a thread", () => a.you.medals.includes("by_a_thread"), 4000);
    } finally {
      rules.BY_A_THREAD_MS = window;
    }

    // With Friends Like These: a party member's real carbine shot finishes you.
    actorOf(a).state.party = "party-7";
    actorOf(friend).state.party = "party-7";
    await tpAndWait(friend, offPad("arcadia", 0, 48));
    friend.send("admin", { cmd: "unprotect" });
    friend.send("admin", { cmd: "give", args: { id: "carbine", tier: 3 } });
    await until("carbine", () => [...friend.you.hotbar, ...friend.you.backpack].some((i: any) => i?.id === "carbine" && i.tier === 3));
    await until("friend ready", () => (actorOf(friend).state.flags & (PF.SAFE | PF.PROTECTED)) === 0);
    const slot = [...friend.you.hotbar, ...friend.you.backpack].findIndex((i: any) => i?.id === "carbine" && i.tier === 3);
    friend.send("admin", { cmd: "level", args: { level: 12 } });
    await until("friend L12", () => friend.you.level === 12);
    for (let i = 0; i < 10 && !a.you.dead; i++) {
      const before = actorOf(a).state.hp;
      fireAt(friend, "carbine", liftBy([me(a).x, me(a).y, me(a).z], 1.0), slot);
      await until("hit", () => actorOf(a).state.hp < before || actorOf(a).dead, 2000).catch(() => {});
      if (actorOf(a).dead) break;
    }
    await until("with friends", () => a.you.medals.includes("with_friends_like_these"));
    expect(friend.you.medals).not.toContain("with_friends_like_these");
  }, 20_000);
});

describe("Easter eggs", () => {
  it("E3 Follow the Gold: when the Golden Hopbit you followed runs into its burrow, the burrow opens", async () => {
    const b = await bot("follower", "arcadia");
    await tpAndWait(b, objAt("e3_burrow"));
    b.send("interact", { target: "e3_burrow" });
    await until("too small", () => b.toasts.some((t) => t.includes("too small")));
    // The real brain path: a Golden Hopbit beside you that you have already followed for 60 s
    // (the follow timing itself is covered in npc-unit.test.ts).
    const npcs = npcSystemOf(serverRoom(b))!;
    const p = me(b);
    const n = npcs.createNpc(NPC_INDEX.get("golden_hopbit")!, 1, serverRoom(b).snapToGround([p.x, p.y, p.z]), Date.now(), { instant: true, roam: 0 });
    n.egg = { follower: b.id, since: Date.now() - 61_000 };
    await until("burrow open", () => b.toasts.some((t) => t.includes("dives into its burrow")));
    expect(n.dead).toBe(true);
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

    // Synthetic for the same reason as above (an admin kill would be assisted: no medal to see).
    emitNpcEvent({ kind: "bossKill", body: "arcadia", boss: "tidewrath", sessionIds: [b.id], userIds: ["bridger"], names: ["bridger"] });
    await until("tide turner", () => b.you.medals.includes("tide_turner"));

    const npcs = npcSystemOf(serverRoom(b))!;
    const before = npcs.npcs.size;
    await tpAndWait(b, objAt("e2_btn_flame"));
    b.send("interact", { target: "e2_btn_flame" }); // wrong first button
    await until("hopbits spawned", () => [...npcs.npcs.values()].filter((n) => n.def.id === "hopbit").length >= 3 && npcs.npcs.size >= before + 3);
  });
});
