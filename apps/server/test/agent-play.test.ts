// The agent kit on the systems the 2026-11-12 run added, against the real server in-process:
// the spellbook (`cast`, Skipstep's server move), per-starter pace and roll, and the timed
// objectives (a ring race taken from Sela Marchbank in Portus, a beacon held against its waves).
// The agents here hold an admin dev identity only so a test can put them somewhere and set a level;
// everything they then do goes through the kit's public actions.

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Room } from "@colyseus/sdk";
import { FirstlightAgent, groundDistance } from "@firstlight/agent-kit";
import { BODIES, type BodyId } from "@firstlight/shared";
import type { Game } from "../src/app.ts";
import { resetAgentSlots } from "../src/world/agents.ts";
import { TRIAL_RULES } from "../src/world/quests/trials.ts";
import { SPELL_BOOKS } from "../src/world/spells/SpellSystem.ts";
import { liveRooms } from "../src/social/index.ts";
import { grantTravel, joinAs, safeLeave, startServer, waitFor as poll } from "./helpers.ts";
import { adminBot, ask, me, offset, openSpotOutside } from "./npc-bots.ts";
import { objAt } from "./quest-helpers.ts";

let game: Game;
let url: string;
const agents: FirstlightAgent[] = [];
const rooms: Room[] = [];
const SCALE = TRIAL_RULES.timeScale;
const STARTERS = ["hexwick", "ash", "kappa", "unit7", "ninja"];
const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
let step = "";
/** waitFor that says which wait ran out. */
const waitFor = (cond: () => boolean, ms?: number, label = step) => poll(cond, ms).catch(() => {
  throw new Error(`timed out waiting: ${label || cond.toString().slice(0, 160)}`);
});
const d3 = (a: readonly number[], b: readonly number[]) => Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!);

beforeAll(async () => {
  game = await startServer();
  url = `http://127.0.0.1:${game.port}`;
});

afterEach(async () => {
  for (const a of agents.splice(0)) await a.close();
  for (const r of rooms.splice(0)) await safeLeave(r);
  TRIAL_RULES.timeScale = SCALE;
  SPELL_BOOKS.byUser.clear();
  resetAgentSlots();
});

afterAll(async () => {
  await game.close();
});

async function agent(id: string, body: BodyId = "arcadia", starter = "unit7"): Promise<FirstlightAgent> {
  grantTravel(id, body, { starter: STARTERS.indexOf(starter) });
  const a = new FirstlightAgent();
  agents.push(a);
  expect((await a.connect({ url, token: `dev:${id}:${id}:admin`, body, starter })).ok).toBe(true);
  await waitFor(() => a.observe({ peek: true }).self.maxHp > 0);
  return a;
}

/** The server's side of an agent: its actor (authoritative position, violations). */
function actor(a: FirstlightAgent) {
  return [...liveRooms].find((x) => x.actors.has(a.sessionId))!.actors.get(a.sessionId)!;
}

/** Test set-up, not play: put the agent's body at `p`, unprotected, at `level`; the kit adopts the place. */
async function put(a: FirstlightAgent, p: readonly number[], level?: number) {
  const room = a.room!;
  if (level) room.send("admin", { cmd: "level", args: { level } });
  room.send("admin", { cmd: "teleport", args: { x: p[0], y: p[1], z: p[2] } });
  room.send("admin", { cmd: "unprotect" });
  await waitFor(() => {
    const s = a.observe({ peek: true }).self;
    // Along the ground: `p` may be given at the body's radius, and the server stands the body on the terrain.
    return groundDistance(a.position, p) < 4 && s.protectedFor === 0 && (!level || s.level === level);
  });
  await sleep(150);
  a.corrections = 0; // the teleport was ours
}

async function adminRoom(id: string, body: BodyId): Promise<Room> {
  const r = await joinAs(game, id, body, { starter: 3 }, "admin");
  rooms.push(r);
  await waitFor(() => !!(r.state as any).players?.get(r.sessionId));
  return r;
}

const spawn = (admin: Room, kind: string, at: readonly number[], level = 1) => ask<{ id: string }>(admin, "npcInfo", { cmd: "spawn", kind, x: at[0], y: at[1], z: at[2], level, instant: true }).then((m) => m.id);
const creature = (a: FirstlightAgent, id: string) => a.observe({ peek: true }).creatures.find((c) => c.id === id);
const mission = (a: FirstlightAgent, id: string) => a.observe({ peek: true }).missions.find((m) => m.id === id);

describe("agents: spells", () => {
  it("Skipstep moves the body on the server and the agent goes on from there; refusals carry their reason", async () => {
    const a = await agent("spellA");
    // At the pad: no spells in a safe zone. A locked spell and an unknown one never reach the server.
    expect(await a.cast("skipstep", { bearing: 90 })).toMatchObject({ ok: false, reason: "safe zone" });
    expect(await a.cast("frostbloom")).toMatchObject({ ok: false, reason: "locked", hint: expect.stringContaining("level 3") });
    expect(await a.cast("fireball")).toMatchObject({ ok: false, reason: "no such spell" });

    const spot = openSpotOutside("arcadia");
    await put(a, spot);
    const before = a.observe();
    expect(before.self.spells).toMatchObject({ aether: 100, max: 100 });
    expect(before.self.spells.list.map((s) => [s.id, s.level, s.cost, s.cooldown, s.unlocked, s.ready])).toEqual([
      ["skipstep", 1, 20, 6, true, true],
      ["frostbloom", 3, 30, 10, false, false],
      ["wishfall", 6, 45, 14, false, false],
      ["glasswing", 9, 35, 18, false, false],
    ]);
    expect(before.summary).toContain("Aether 100/100. Spells: skipstep ready, frostbloom L3, wishfall L6, glasswing L9.");

    const ahead = offset(spot, 10, 0, BODIES.arcadia.radius); // the open line the spot was picked for
    const from = a.position;
    const violations = actor(a).violations;
    const blink = await a.cast("skipstep", { pos: ahead });
    expect(blink).toMatchObject({ ok: true, spell: "skipstep", cooldown: 6 });
    expect(blink.moved as number).toBeGreaterThan(5);
    expect(blink.moved as number).toBeLessThan(10.6);
    expect(blink.aether as number).toBeLessThanOrEqual(90);
    expect(d3(from, a.position)).toBeGreaterThan(5);
    // The server and the agent agree on the new place, and it wasn't a rejected move.
    const act = actor(a);
    await waitFor(() => d3([act.state.x, act.state.y, act.state.z], a.position) < 0.6);
    expect(a.corrections).toBe(0);
    // Walking on from there is accepted input by input (the old place's inputs were dropped, not punished).
    const back = await a.moveTo({ pos: spot }, { seconds: 20 });
    expect(back).toMatchObject({ ok: true, corrections: 0 });
    expect(act.violations).toBe(violations);
    await waitFor(() => d3([act.state.x, act.state.y, act.state.z], a.position) < 0.6);

    expect(await a.cast("skipstep", { pos: ahead })).toMatchObject({ ok: false, reason: "cooldown" });
    const after = a.observe();
    const skip = after.self.spells.list[0]!;
    expect(skip.ready).toBe(false);
    expect(skip.readyIn).toBeGreaterThan(0);
    expect(skip.readyIn).toBeLessThanOrEqual(6000);
    expect(after.self.spells.aether).toBeGreaterThanOrEqual(80);
    expect(after.self.spells.aether).toBeLessThan(100);
    expect(after.events.some((e) => e.type === "spell" && e.text.startsWith("cast Skipstep: blinked"))).toBe(true);
    expect(after.summary).toMatch(/Spells: skipstep \ds, frostbloom L3/);
  }, 90_000);

  it("Frostbloom, Wishfall and the Glasswing Ward land through the server at the level that unlocks them", async () => {
    const a = await agent("spellB");
    const admin = await adminRoom("spellAdmin", "arcadia");
    const spot = openSpotOutside("arcadia");
    await put(a, spot, 9);
    const R = BODIES.arcadia.radius;
    expect(a.observe().self.spells.list.every((s) => s.unlocked && s.ready)).toBe(true);

    // Frost: two creatures inside the 5 m ring are hurt and slowed.
    const near = [await spawn(admin, "hopbit", offset(spot, 3, 0, R), 7), await spawn(admin, "hopbit", offset(spot, 2, 2.5, R), 7)];
    await waitFor(() => near.every((id) => !!creature(a, id)));
    const hp0 = near.map((id) => creature(a, id)!.hp);
    const frost = await a.cast("frostbloom");
    expect(frost).toMatchObject({ ok: true, spell: "frostbloom", radius: 5 });
    expect(frost.slowed as number).toBeGreaterThanOrEqual(1);
    await waitFor(() => near.every((id, i) => (creature(a, id)?.hp ?? 0) < hp0[i]!));

    // A star on a creature 12 m away: it lands a moment later and hurts it.
    const far = await spawn(admin, "hopbit", offset(spot, 12, -3, R), 7);
    await waitFor(() => !!creature(a, far));
    const farHp = creature(a, far)!.hp;
    const star = await a.cast("wishfall", { targetId: far });
    expect(star).toMatchObject({ ok: true, spell: "wishfall", landsIn: 1.2, radius: 4 });
    await waitFor(() => (creature(a, far)?.hp ?? 0) < farHp, 8000);

    // 25 aether left of 100 (30 + 45 spent): the ward costs 35, and the kit says so without asking the server.
    expect(await a.cast("glasswing")).toMatchObject({ ok: false, reason: "aether" });
    await waitFor(() => a.observe({ peek: true }).self.spells.aether >= 36, 8000); // 6 a second, after 1.5 s
    // The ward: a shell the observation shows while it is up.
    const ward = await a.cast("glasswing");
    expect(ward).toMatchObject({ ok: true, spell: "glasswing", seconds: 4 });
    expect(ward.shell as number).toBeGreaterThan(0);
    await waitFor(() => !!a.observe({ peek: true }).self.spells.ward);
    const o = a.observe();
    expect(o.self.spells.ward!.hp).toBeGreaterThan(0);
    expect(o.summary).toMatch(/Aether \d+\/100, ward \d+hp \ds\./);
    expect(o.self.spells.aether).toBeLessThan(20);
    expect(o.self.spells.list.filter((s) => s.id !== "skipstep").every((s) => !s.ready && s.readyIn > 0)).toBe(true);
    const casts = a.events.filter((e) => e.type === "spell").map((e) => e.text);
    expect(casts.some((t) => t.startsWith("cast Frostbloom"))).toBe(true);
    expect(casts.some((t) => t.startsWith("cast Wishfall"))).toBe(true);
    expect(casts.some((t) => t.startsWith("cast Glasswing Ward"))).toBe(true);
    expect(await a.cast("frostbloom")).toMatchObject({ ok: false, reason: "cooldown" });
    expect(a.corrections).toBe(0);
  }, 90_000);
});

describe("agents: per-starter pace", () => {
  it("Hinoko outruns Brother Ash over the same ground, both roll on their own cooldown, and the server corrects neither", async () => {
    const [fast, slow] = await Promise.all([agent("paceNinja", "arcadia", "ninja"), agent("paceAsh", "arcadia", "ash")]);
    expect(fast.observe().self).toMatchObject({ starter: "ninja", speed: { run: 6.6, sprint: 9.9, dodgeCooldown: 1.1 } });
    expect(slow.observe().self).toMatchObject({ starter: "ash", speed: { run: 5.5, sprint: 8.3, dodgeCooldown: 1.35 } });
    const spot = openSpotOutside("arcadia");
    await put(fast, spot);
    await put(slow, spot);
    const R = BODIES.arcadia.radius;
    const there = offset(spot, 10, 0, R);
    // The same legs for both, at a sprint, at the same time (so a busy machine slows them alike).
    const legs = async (a: FirstlightAgent) => {
      let walked = 0, seconds = 0;
      for (let i = 0; i < 4; i++) {
        const r = await a.moveTo({ pos: i % 2 === 0 ? there : spot }, { sprint: true, within: 0.8, seconds: 20 });
        expect(r).toMatchObject({ ok: true, corrections: 0 });
        walked += r.walked as number;
        seconds += r.seconds as number;
      }
      return walked / seconds;
    };
    const [vFast, vSlow] = await Promise.all([legs(fast), legs(slow)]);
    expect(vFast / vSlow).toBeGreaterThan(1.08); // 9.9 against 8.28 m/s on paper
    expect(vSlow).toBeLessThanOrEqual(8.3 + 0.2);
    expect(vFast).toBeLessThanOrEqual(9.9 + 0.2);
    // Two rolls each, the second as soon as the kit says the first's cooldown is over.
    for (const a of [fast, slow]) {
      const first = await a.dodge(0);
      expect(first.ok).toBe(true);
      expect(first.moved as number).toBeGreaterThan(3.5);
      expect(await a.dodge(0)).toMatchObject({ ok: false, reason: "cooldown" });
      await sleep(a.observe({ peek: true }).self.cooldowns.dodge + 20);
      expect((await a.dodge(180)).ok).toBe(true);
    }
    await sleep(400);
    for (const a of [fast, slow]) {
      expect(a.corrections).toBe(0);
      expect(actor(a).violations).toBe(0);
    }
  }, 120_000);
});

describe("agents: trials", () => {
  it("takes a trial from Sela Marchbank in Portus, travels, and runs the ring route in order", async () => {
    TRIAL_RULES.timeScale = 2; // a 150 s clock: the run itself is what is checked, on a shared machine
    const a = await agent("racer", "portus", "ninja");
    await a.skipTutorial();
    const first = a.observe();
    expect(first.hunt).toMatchObject({ name: "The Three Gleams", gleams: 0, of: 3, vaultOpened: false, curator: { id: "curator", name: "Sela Marchbank" }, vault: { id: "vault" } });
    expect(first.offers.map((m) => [m.id, m.type, m.from])).toEqual([["T1", "race", "Sela Marchbank"], ["T2", "defend", "Sela Marchbank"], ["T3", "collect", "Sela Marchbank"]]);
    expect(first.summary).toContain("curator Sela Marchbank");
    expect(await a.takeMissions()).toMatchObject({ ok: false, reason: "too far", hint: "moveTo('curator') first" });
    expect(await a.moveTo("curator")).toMatchObject({ ok: true, corrections: 0 });
    expect(await a.interact("curator")).toMatchObject({ ok: true, talkedTo: "Sela Marchbank", gleams: 0, of: 3 });
    const took = await a.takeMissions(["T1"]);
    expect(took).toMatchObject({ ok: true, from: "Sela Marchbank" });
    expect((took.taken as { id: string; type: string; on: string }[])[0]).toMatchObject({ id: "T1", type: "race", on: "arcadia" });
    // The vault stays shut without the gleams, and says how many it has.
    expect(await a.moveTo("vault")).toMatchObject({ ok: true });
    expect(await a.interact("vault")).toMatchObject({ ok: false, reason: "vault locked", gleams: 0, of: 3 });
    // In Portus the trial names the body it is played on.
    expect(mission(a, "T1")).toMatchObject({ type: "race", on: "arcadia", progress: 0, goal: 8, trial: { state: "idle", limit: 75, remaining: 8, next: "played on arcadia" } });
    expect(a.observe({ peek: true }).summary).toContain("T1 The Swift Gleam 0/8 [race idle]: played on arcadia -> on arcadia (portal:arcadia)");
    expect(await a.playTrial("T1")).toMatchObject({ ok: false, reason: "wrong body" });
    expect(await a.playTrial("A1")).toMatchObject({ ok: false, reason: "not a trial" });

    expect(await a.moveTo("portal:arcadia", { sprint: true })).toMatchObject({ ok: true, corrections: 0 });
    expect(await a.enterPortal("arcadia")).toMatchObject({ ok: true, body: "arcadia" });
    await waitFor(() => a.observe({ peek: true }).self.maxHp > 0 && !!mission(a, "T1"));
    // The ring road is a long walk from the pad: the test puts the runner 30 m from ring 1 (and tough enough for the hill).
    await put(a, offset(objAt("t1_ring_1"), 30, 0, BODIES.arcadia.radius), 12);
    const idle = mission(a, "T1")!;
    expect(idle).toMatchObject({ trial: { state: "idle", limit: 75, remaining: 8 }, where: { id: "t1_ring_1" } });
    expect(idle.on).toBeUndefined();
    expect(idle.where!.dist).toBeGreaterThan(20);

    const run = a.playTrial("T1");
    await waitFor(() => mission(a, "T1")?.trial?.state === "running", 30_000);
    const mid = mission(a, "T1")!;
    expect(mid.trial).toMatchObject({ state: "running", limit: 150 });
    expect(mid.trial!.left).toBeGreaterThan(100);
    expect(mid.where!.id).toMatch(/^t1_ring_[2-8]$/);
    expect(a.observe({ peek: true }).summary).toMatch(/Missions: T1 The Swift Gleam \d\/8 \[race running \d+s left\]: run through the rings in order, \d to go -> t1_ring_\d/);
    const r = await run;
    expect(r, JSON.stringify(r)).toMatchObject({ ok: true, done: true, mission: "T1", type: "race", progress: 8, goal: 8, corrections: 0 });
    expect(r.seconds as number).toBeLessThan(150);
    const end = a.observe();
    expect(end.hunt.gleams).toBe(1);
    expect(end.missions.find((m) => m.id === "T1")).toMatchObject({ done: true, progress: 8 });
    expect(a.events.some((e) => e.type === "trial" && e.text === "T1 The Swift Gleam: done")).toBe(true);
    expect(a.events.some((e) => e.type === "mission" && e.text.startsWith("mission T1 complete"))).toBe(true);
    expect(actor(a).violations).toBe(0);
  }, 300_000);

  it("lights a beacon and holds its ring against the waves", async () => {
    TRIAL_RULES.timeScale = 0.25; // a 15 s hold; waves at 0.5, 6.25 and 11.25 s
    const a = await agent("vigil", "hollowmere", "unit7");
    await put(a, objAt("guide_hollowmere"), 14);
    const took = await a.takeMissions(["H4"]);
    expect((took.taken as { id: string; type: string }[]).map((m) => [m.id, m.type])).toEqual([["H4", "defend"]]);
    const lamp = objAt("h4_lamp");
    await put(a, offset(lamp, 18, 0, BODIES.hollowmere.radius));
    expect(mission(a, "H4")).toMatchObject({ type: "defend", goal: 60, where: { id: "h4_lamp" }, trial: { state: "idle", limit: 60, next: "walk to the beacon and interact with it to start" } });

    const run = a.playTrial("H4");
    await waitFor(() => mission(a, "H4")?.trial?.state === "running", 30_000);
    const mid = mission(a, "H4")!;
    expect(mid.trial!.left).toBeLessThanOrEqual(15);
    expect(mid.where!.dist).toBeLessThan(14); // inside the ring
    expect(a.observe({ peek: true }).summary).toMatch(/H4 The Long Vigil \d+\/60 \[defend running \d+s left\]/);
    const r = await run;
    expect(r, JSON.stringify(r)).toMatchObject({ ok: true, done: true, mission: "H4", type: "defend" });
    expect(r.hp as number).toBeGreaterThan(0);
    expect(a.events.some((e) => e.type === "trial" && e.text.startsWith("H4 The Long Vigil: the beacon is lit"))).toBe(true);
    expect(a.events.some((e) => e.type === "trial" && e.text.includes("attempt failed"))).toBe(false);
    expect(a.events.some((e) => e.type === "mission" && e.text.startsWith("mission H4 complete"))).toBe(true);
    // It never left the ring: the lamp is within reach of where it stands.
    expect(groundDistance(a.position, lamp)).toBeLessThan(14);
    expect(a.corrections).toBe(0);
  }, 180_000);
});

describe("agents: etiquette", () => {
  /** A person's shot at a point (from the head, like the client's). */
  function fireAt(r: Room, at: readonly number[]) {
    const p = me(r);
    const l = Math.hypot(p.x, p.y, p.z);
    const up = [p.x / l, p.y / l, p.z / l];
    const o = [p.x + up[0]! * 1.6, p.y + up[1]! * 1.6, p.z + up[2]! * 1.6];
    const t = [at[0]! + up[0]! * 0.4, at[1]! + up[1]! * 0.4, at[2]! + up[2]! * 0.4];
    const d = d3(o, t);
    r.send("fire", { slot: 0, ox: o[0], oy: o[1], oz: o[2], dx: (t[0]! - o[0]!) / d, dy: (t[1]! - o[1]!) / d, dz: (t[2]! - o[2]!) / d, t: Date.now() });
  }

  it("a blast that would catch a player isn't cast unless asked for", async () => {
    const a = await agent("frosty");
    const spot = openSpotOutside("arcadia");
    const R = BODIES.arcadia.radius;
    await put(a, spot, 6);
    const person = await adminBot(game, rooms, "personF", "arcadia", offset(spot, 3, 0, R), 6);
    await waitFor(() => a.observe({ peek: true }).players.some((p) => p.name === "personF" && p.dist < 5));
    const hp = () => (person.state as any).players.get(person.sessionId).hp as number;
    const full = hp();
    expect(await a.cast("frostbloom")).toMatchObject({ ok: false, reason: "players in range", who: "personF" });
    expect(await a.cast("wishfall", { targetId: person.sessionId })).toMatchObject({ ok: false, reason: "players in range", who: "personF" });
    // A star on open ground 20 m the other way catches nobody: that one is cast.
    expect(await a.cast("wishfall", { pos: offset(spot, -20, 0, R) })).toMatchObject({ ok: true, spell: "wishfall" });
    await sleep(1600); // it has landed
    expect(hp()).toBe(full);
    expect(a.observe().self.spells.list[1]).toMatchObject({ id: "frostbloom", ready: true }); // the refused frost cost nothing
  }, 60_000);

  it("no kill stealing: a fight is left to the person who joins it, and the creature is marked as theirs", async () => {
    const a = await agent("yielder");
    const spot = openSpotOutside("arcadia");
    const R = BODIES.arcadia.radius;
    await put(a, spot);
    const person = await adminBot(game, rooms, "personY", "arcadia", offset(spot, 5, 7, R), 4);
    const at = offset(spot, 7, 0, R);
    const npc = await spawn(person, "hopbit", at, 7); // far too tough for a level 1 to finish quickly
    await waitFor(() => !!creature(a, npc));
    expect(creature(a, npc)!.claimedBy).toBeUndefined();
    const fight = a.attack(npc, { seconds: 45, yieldTo: "people" });
    await waitFor(() => a.events.some((e) => e.type === "hit"), 15_000, "the agent's first hit");
    // The person starts shooting the same creature.
    const iv = setInterval(() => {
      const n = (person.state as any).npcs?.get(npc);
      if (n) fireAt(person, [n.x, n.y, n.z]);
    }, 350);
    try {
      const r = await fight;
      expect(r, JSON.stringify(r)).toMatchObject({ ok: false, killed: false, reason: "yielded", to: "personY" });
      expect(r.targetHp as number).toBeGreaterThan(0);
      const seen = a.observe();
      expect(seen.creatures.find((c) => c.id === npc)?.claimedBy).toEqual({ name: "personY", agent: false });
      expect(seen.summary).toContain("(personY's fight)");
      // And it stays off: asking again while they fight yields at once, without another hit.
      const hits = a.events.filter((e) => e.type === "hit").reduce((n, e) => n + (e.n ?? 1), 0);
      expect(await a.attack(npc, { seconds: 10, yieldTo: "people" })).toMatchObject({ ok: false, reason: "yielded" });
      expect(a.events.filter((e) => e.type === "hit").reduce((n, e) => n + (e.n ?? 1), 0)).toBe(hits);
    } finally {
      clearInterval(iv);
    }
  }, 90_000);
});
