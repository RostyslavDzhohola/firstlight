// What a resident does all day. Four behaviours on top of the agent kit, each a plain loop of the
// same high-level actions a model would call (walk, look, fight, trade, say a phrase): no model, no
// server access. They are flagged as AI agents like every kit player, so they wear the AI chip.
//
// House rules, the same for all four:
// - never attack a player (the kit refuses a player target without `pvp`, and nothing here asks for it);
// - a creature a person is fighting is that person's: don't start on it, and break off (stand back)
//   the moment they hit one you were fighting, so they land the last hits;
// - keep away from the boss arenas: nothing is picked inside one and walks go round them;
// - take only loot that is yours, don't stand on the till or the guide, say hello with the phrase wheel.

import type { ActionResult, FirstlightAgent, Observation } from "@firstlight/agent-kit";
import { bearingTo, bodyWorld, groundDistance, type BodyWorld, type V3 } from "@firstlight/agent-kit";
import type { BodyId } from "@firstlight/shared";
import { bossArena } from "@firstlight/shared/content/arenas";
import { GLEAMS } from "@firstlight/shared/content/gleams";
import { MISSION_BY_ID, missionsOn } from "@firstlight/shared/content/missions";
import { offsetDir, placeDir, placesOn } from "@firstlight/shared/content/places";

export type Role = "hunter" | "wanderer" | "trader" | "chaser";
export const ROLES: readonly Role[] = ["hunter", "wanderer", "trader", "chaser"];

export interface ResidentStats {
  kills: number;
  deaths: number;
  /** Fights left to a person who joined in. */
  yields: number;
  greetings: number;
  casts: number;
  trades: number;
  /** Trial attempts started and trials finished. */
  attempts: number;
  trials: number;
  /** Metres walked. */
  walked: number;
}

export interface Resident {
  name: string;
  role: Role;
  /** Where it lives: the body it goes back to. */
  home: BodyId;
  /** Bodies it may travel to (the runner's --bodies). */
  bodies: readonly BodyId[];
  agent: FirstlightAgent;
  stats: ResidentStats;
  log(line: string): void;
  /** False once the runner is stopping or the agent is gone for good. */
  alive(): boolean;
  /** Wait `ms` (longer when the process is over its CPU budget); returns early when stopping. */
  pause(ms: number): Promise<void>;
  /** 0..1, this resident's own sequence. */
  rng(): number;
}

/** How near a boss arena's edge a resident lets itself get (metres). */
const ARENA_MARGIN = 30;
/** The hologram scoreboard in Portus Plaza: metres east and north of the plaza centre (client world/HoloBoard.ts HOLO_AT), and where to stand to read it. */
const SCOREBOARD = { east: 7.2, north: -12.6, viewEast: 4.4, viewNorth: -7.6 } as const;
const GREET_EVERY_MS = 180_000;

const between = (r: Resident, a: number, b: number) => a + (b - a) * r.rng();

/** Look, and count what happened since the last look. */
export function look(r: Resident): Observation {
  const o = r.agent.observe();
  for (const e of o.events) {
    if (e.type === "kill" && !e.text.startsWith("killed player")) r.stats.kills++;
    else if (e.type === "death") r.stats.deaths++;
    else if (e.type === "spell" && e.text.startsWith("cast ")) r.stats.casts++;
    if (e.type === "death" || e.type === "level" || e.type === "mission" || e.type === "trial") r.log(`· ${e.text}`);
  }
  return o;
}

const world = (r: Resident): BodyWorld => bodyWorld(r.agent.bodyId);

/** Inside (or within `margin` of) the boss arena of this body? */
export function nearArena(w: BodyWorld, p: readonly number[], margin = ARENA_MARGIN): boolean {
  const a = bossArena(w.terrain);
  return !!a && groundDistance(p, a.centre) < a.radius + margin;
}

/** A point to walk to first when the straight line to `to` would cross the boss arena: round its edge. */
export function roundArena(w: BodyWorld, from: readonly number[], to: readonly number[]): V3 | null {
  const a = bossArena(w.terrain);
  if (!a) return null;
  const keep = a.radius + ARENA_MARGIN;
  const c = a.centre;
  const d = [to[0]! - from[0]!, to[1]! - from[1]!, to[2]! - from[2]!];
  const dd = d[0]! * d[0]! + d[1]! * d[1]! + d[2]! * d[2]!;
  if (dd < 1) return null;
  const t = Math.max(0, Math.min(1, ((c[0] - from[0]!) * d[0]! + (c[1] - from[1]!) * d[1]! + (c[2] - from[2]!) * d[2]!) / dd));
  const near = [from[0]! + d[0]! * t, from[1]! + d[1]! * t, from[2]! + d[2]! * t];
  const off = [near[0]! - c[0], near[1]! - c[1], near[2]! - c[2]];
  const miss = Math.hypot(off[0]!, off[1]!, off[2]!);
  if (miss >= keep || t <= 0 || t >= 1) return null;
  // Push the nearest point of the line out to well past the edge, on the side the line already leans.
  const side = miss > 0.5 ? off.map((v) => v / miss) : [a.side[0], a.side[1], a.side[2]];
  const out = keep + 25;
  return w.onGround([c[0] + side[0]! * out, c[1] + side[1]! * out, c[2] + side[2]! * out]);
}

function tonicOf(o: Observation) {
  return o.self.hotbar.concat(o.self.backpack).find((i) => i.id.startsWith("tonic"));
}

/** Greet people who have come near, each one once in a while, with the phrase wheel. */
export async function greet(r: Resident, o: Observation, greeted: Map<string, number>): Promise<boolean> {
  const now = Date.now();
  const p = o.players.find((x) => !x.agent && !x.dead && x.dist <= 12 && now - (greeted.get(x.name) ?? 0) > GREET_EVERY_MS);
  if (!p) return false;
  greeted.set(p.name, now);
  await r.agent.lookAt(p.id);
  const said = await r.agent.phrase("Truce?"); // the wheel's friendly hello
  if (said.ok) {
    r.stats.greetings++;
    r.log(`greets ${p.name}`);
  }
  await r.pause(1200);
  return true;
}

/**
 * Hurt or dead: deal with it before anything else. Returns true when it did something (look again).
 * A resident never fights back against a player: it drinks, and runs for the nearest safe zone.
 */
export async function mind(r: Resident, o: Observation): Promise<boolean> {
  const a = r.agent;
  const me = o.self;
  if (me.dead) {
    const res = await a.respawn();
    r.log(`fell: a new life${res.ok ? "" : ` (${res.reason})`}`);
    await r.pause(1500);
    return true;
  }
  const hp = me.hp / Math.max(1, me.maxHp);
  if (hp < 0.55 && me.cooldowns.tonic === 0) {
    const tonic = tonicOf(o);
    if (tonic) await a.useItem(tonic.slot);
  }
  if (hp < 0.35 && me.zone !== "safe") {
    // Break away with a blink toward safety when something is biting, then run.
    if (o.safety && o.creatures.some((c) => c.onMe && c.dist < 8) && me.spells.list[0]?.ready) await a.cast("skipstep", { bearing: o.safety.bearing });
    r.log(`HP ${me.hp}/${me.maxHp}: back to safety`);
    await walk(r, "safe", { sprint: true, seconds: 45 });
    for (let i = 0; i < 45 && r.alive(); i++) {
      const s = a.observe({ peek: true }).self;
      if (s.dead || s.hp >= s.maxHp * 0.8) break;
      await r.pause(1000);
    }
    return true;
  }
  return false;
}

/** moveTo, counting the metres. */
export async function walk(r: Resident, target: Parameters<FirstlightAgent["moveTo"]>[0], o: Parameters<FirstlightAgent["moveTo"]>[1] = {}): Promise<ActionResult> {
  const res = await r.agent.moveTo(target, o);
  r.stats.walked += (res.walked as number) ?? 0;
  return res;
}

/**
 * A long walk in short legs, round the boss arena, looking up between legs (`each` may greet, and
 * returns true to stop the walk). Resolves true on arrival.
 */
export async function travelTo(r: Resident, dest: V3, o: { sprint?: boolean; within?: number; seconds?: number; each?: (o: Observation) => Promise<boolean> } = {}): Promise<boolean> {
  const w = world(r);
  const within = o.within ?? 3;
  const until = Date.now() + (o.seconds ?? 240) * 1000;
  let stuck = 0;
  while (r.alive() && Date.now() < until) {
    const seen = look(r);
    if (seen.self.dead || seen.self.hp < seen.self.maxHp * 0.35) return false;
    if (o.each && (await o.each(seen))) return false;
    const here = r.agent.position;
    if (groundDistance(here, dest) <= within) return true;
    const via = roundArena(w, here, dest);
    const leg = await walk(r, { pos: via ?? dest }, { sprint: o.sprint, within: via ? 6 : within, seconds: 5 });
    if (leg.ok && !via) return true;
    if (leg.reason === "blocked" || (leg.reason === "timeout" && (leg.walked as number) < 1)) {
      if (++stuck >= 3) return false;
      await walk(r, { bearing: r.rng() * 360, distance: 12 }, { seconds: 6 });
    } else if (leg.reason !== "timeout" && !leg.ok) return false;
  }
  return false;
}

/** Get to another body: back to Portus through this planet's portal, then out through Portus'. */
export async function goTo(r: Resident, body: BodyId): Promise<boolean> {
  const a = r.agent;
  for (let hop = 0; hop < 2 && r.alive() && a.bodyId !== body; hop++) {
    const to: BodyId = a.bodyId === "portus" ? body : "portus";
    if (a.bodyId === "portus") await a.skipTutorial();
    // The portal can be most of a kilometre away (back from a trial): walk on while it gets nearer.
    let walked = await walk(r, `portal:${to}`, { sprint: true, seconds: 60 });
    for (let best = Infinity; !walked.ok && walked.reason === "timeout" && (walked.remaining as number) < best - 20 && r.alive(); ) {
      best = walked.remaining as number;
      const seen = look(r);
      if (seen.self.dead || seen.self.hp < seen.self.maxHp * 0.35) return false; // the caller minds that first
      walked = await walk(r, `portal:${to}`, { sprint: true, seconds: 60 });
    }
    if (!walked.ok) {
      r.log(`can't reach the portal to ${to}: ${walked.reason}`);
      return false;
    }
    const through = await a.enterPortal(to);
    r.log(`through the portal to ${to}: ${through.ok ? "ok" : through.reason}`);
    if (!through.ok) {
      await r.pause(4000); // in combat, or the other world has its share of agents: try later
      return false;
    }
    for (let i = 0; i < 60 && a.observe({ peek: true }).self.maxHp === 0; i++) await r.pause(50);
  }
  return a.bodyId === body;
}

// ------------------------------------------------------------------------------------ the hunter

/** Farms creatures of its own size near its home pad; takes the guide's hunt missions on the way. */
export async function hunter(r: Resident): Promise<void> {
  const a = r.agent;
  const theirs = new Map<string, number>(); // creatures left to someone, and until when
  let asked = false;
  let idle = 0;
  while (r.alive()) {
    await r.pause(150); // a breath every round: no branch below can spin
    const o = look(r);
    if (await mind(r, o)) continue;
    if (a.bodyId !== r.home) {
      if (!(await goTo(r, r.home))) await r.pause(3000);
      asked = false;
      continue;
    }
    const w = world(r);
    const me = o.self;
    const pad = w.pads[0]?.pos ?? a.position;
    // Once per visit: the guide's hunts of about this level, and tonics when there are coins for them.
    if (!asked && w.guide) {
      asked = true;
      const want = missionsOn(r.home).filter((m) => m.type === "hunt" && m.recLevel[0] <= me.level + 1 && !o.missions.some((x) => x.id === m.id)).map((m) => m.id as string);
      if (want.length && (await walk(r, "guide", { sprint: true, seconds: 60 })).ok) {
        const took = await a.takeMissions(want);
        if (took.ok) r.log(`takes ${want.join(", ")} from the guide`);
        await walk(r, { bearing: r.rng() * 360, distance: 4 }, { seconds: 4 }); // off the guide's toes
      }
      const tonics = me.hotbar.concat(me.backpack).filter((i) => i.id.startsWith("tonic")).reduce((n, i) => n + i.qty, 0);
      const buy = Math.min(3 - tonics, Math.floor(me.coins / 10));
      if (buy > 0 && (await walk(r, "shop", { sprint: true, seconds: 60 })).ok && (await a.buy("tonic_small", { qty: buy })).ok) r.stats.trades++;
      continue;
    }
    if (nearArena(w, a.position)) {
      await travelTo(r, pad, { sprint: true, within: 40, seconds: 60 });
      continue;
    }
    // Loot that is ours, close, with nobody standing on it.
    const pile = o.piles.find((p) => p.yours && p.dist < 25);
    if (pile && !o.creatures.some((c) => c.onMe)) {
      if ((await walk(r, pile.id, { sprint: true, seconds: 12, stopWhenHit: true })).ok) await a.interact(pile.id);
      continue;
    }
    const now = Date.now();
    const st = a.room?.state as any;
    const fair = o.creatures.filter((c) => {
      if (c.boss || c.level > me.level + 1 || c.dist > 50) return false;
      if (c.claimedBy || (theirs.get(c.id) ?? 0) > now) return false; // someone's fight
      const n = st?.npcs?.get(c.id);
      return !!n && !nearArena(w, [n.x, n.y, n.z]) && groundDistance([n.x, n.y, n.z], pad) < 190;
    });
    // What is on it, then a mission creature, then something hostile. Peaceful wildlife (the shepherd's Woolbacks) is left alone.
    const target = fair.find((c) => c.onMe) ?? fair.find((c) => c.mission) ?? fair.find((c) => c.hostile);
    if (target) {
      idle = 0;
      const close = o.creatures.filter((c) => c.dist <= 4.5 && (c.onMe || c.hostile) && !c.boss && !c.claimedBy).length;
      if (me.zone !== "safe" && close >= 2 && me.spells.list[1]?.ready) await a.cast("frostbloom");
      const fight = await a.attack(target.id, { seconds: 8, retreatBelow: 0.4, yieldTo: "people" });
      if (fight.reason === "yielded") {
        // A person is on it: stand back and leave them the kill.
        r.stats.yields++;
        theirs.set(target.id, now + 40_000);
        r.log(`leaves the ${target.name} to ${fight.to}`);
        await walk(r, { bearing: (target.bearing + 180) % 360, distance: 10 }, { seconds: 5 });
      } else if (fight.reason === "safe zone") await walk(r, target.id, { within: 6, seconds: 10 });
      else if (fight.killed) r.log(`killed ${target.name} L${target.level}: +${fight.xp} XP`);
      continue;
    }
    // Nothing fair in sight: drift round the pad, never far from it.
    idle++;
    const hunt = o.missions.find((m) => m.type === "hunt" && !m.done && m.where);
    if (groundDistance(a.position, pad) > 140) await travelTo(r, pad, { within: 60, seconds: 60 });
    else if (hunt && hunt.where!.dist > 25 && idle <= 3) await walk(r, `mission:${hunt.id}`, { sprint: me.zone === "safe", seconds: 25, stopWhenHit: true });
    else if (me.zone === "safe") {
      // Out through the gate, then on away from the pad.
      await walk(r, "gate", { seconds: 40 });
      await walk(r, { bearing: bearingTo(pad, a.position), distance: between(r, 25, 45) }, { seconds: 12, stopWhenHit: true });
    } else await walk(r, { bearing: r.rng() * 360, distance: between(r, 18, 40) }, { seconds: 10, stopWhenHit: true });
    await r.pause(between(r, 800, 2500));
  }
}

// ------------------------------------------------------------------------------------ the wanderer

interface Stop {
  name: string;
  pos: V3;
}

/** Places worth walking to on a body: pads, portals, named landmarks; no lairs, no hidden places, no water. */
export function stopsOn(w: BodyWorld): Stop[] {
  const stops: Stop[] = [];
  for (const p of w.pads) stops.push({ name: p.name, pos: p.pos });
  for (const p of w.portals) stops.push({ name: `the portal to ${p.to}`, pos: w.onGround(p.dir) });
  for (const p of placesOn(w.id)) {
    if (p.kind !== "landmark" && p.kind !== "area") continue;
    stops.push({ name: p.name, pos: w.onGround(placeDir(p)) });
  }
  if (w.id === "portus") {
    if (w.curator) stops.push({ name: w.curator.def.name, pos: w.curator.pos });
    if (w.vault) stops.push({ name: "the Gleam Vault", pos: w.vault.pos }); // its own name is the E prompt
    const hall = w.things.get("hall_wall");
    if (hall) stops.push({ name: `the ${hall.def.name}`, pos: hall.pos });
    stops.push({ name: "the scoreboard", pos: scoreboardView(w) });
  }
  return stops.filter((s) => !w.deepAt(s.pos) && !nearArena(w, s.pos, 60));
}

function scoreboardView(w: BodyWorld): V3 {
  return w.onGround(offsetDir(placeDir("portus_plaza"), SCOREBOARD.viewEast, SCOREBOARD.viewNorth, w.R));
}

function scoreboardAt(w: BodyWorld): V3 {
  return w.onGround(offsetDir(placeDir("portus_plaza"), SCOREBOARD.east, SCOREBOARD.north, w.R));
}

/** Walks between pads and landmarks, stops to look, greets people who come near. */
export async function wanderer(r: Resident): Promise<void> {
  const a = r.agent;
  const greeted = new Map<string, number>();
  /** Between the legs of a walk: say hello, and walk on. */
  const hello = async (seen: Observation) => ((await greet(r, seen, greeted)), false);
  let last = "";
  while (r.alive()) {
    await r.pause(150); // a breath every round: no branch below can spin
    const o = look(r);
    if (await mind(r, o)) continue;
    if (a.bodyId !== r.home) {
      if (!(await goTo(r, r.home))) await r.pause(3000);
      continue;
    }
    const w = world(r);
    const here = a.position;
    // One of the nearest few places it didn't just leave.
    const near = stopsOn(w)
      .filter((s) => s.name !== last && groundDistance(here, s.pos) > 12)
      .sort((p, q) => groundDistance(here, p.pos) - groundDistance(here, q.pos))
      .slice(0, 4);
    const stop = near[Math.floor(r.rng() * near.length)];
    if (!stop) {
      await r.pause(5000);
      continue;
    }
    r.log(`walks to ${stop.name} (${Math.round(groundDistance(here, stop.pos))} m)`);
    const there = await travelTo(r, stop.pos, { within: 5, seconds: 400, each: hello });
    last = stop.name;
    if (!there) continue;
    // Arrived: look about for a while, and say hello to whoever turns up.
    await a.lookAt(r.rng() * 360);
    const until = Date.now() + between(r, 6000, 20_000);
    while (r.alive() && Date.now() < until) {
      const seen = look(r);
      if (seen.self.dead || seen.creatures.some((c) => c.onMe)) break;
      await greet(r, seen, greeted);
      await r.pause(1000);
    }
  }
}

// ------------------------------------------------------------------------------------ the trader

/** Idles at the shop and the plaza scoreboard: browses, buys a tonic when it can, steps off the till. */
export async function trader(r: Resident): Promise<void> {
  const a = r.agent;
  const greeted = new Map<string, number>();
  const idleFor = async (ms: number, face?: V3) => {
    const until = Date.now() + ms;
    if (face) await a.lookAt(bearingTo(a.position, face));
    while (r.alive() && Date.now() < until) {
      const seen = look(r);
      if (seen.self.dead) return;
      if (await greet(r, seen, greeted)) {
        if (face) await a.lookAt(bearingTo(a.position, face));
      }
      await r.pause(1500);
    }
  };
  while (r.alive()) {
    await r.pause(150); // a breath every round: no branch below can spin
    const o = look(r);
    if (await mind(r, o)) continue;
    if (a.bodyId !== r.home) {
      if (!(await goTo(r, r.home))) await r.pause(3000);
      continue;
    }
    const w = world(r);
    const shop = w.shops[0];
    if (shop && (await walk(r, "shop", { seconds: 90 })).ok) {
      const goods = await a.shop();
      const tonics = o.self.hotbar.concat(o.self.backpack).filter((i) => i.id.startsWith("tonic")).reduce((n, i) => n + i.qty, 0);
      if (goods.ok && o.self.coins >= 10 && tonics < 3 && (await a.buy("tonic_small")).ok) {
        r.stats.trades++;
        r.log(`buys a tonic at ${goods.shop}`);
        await a.phrase("Thanks");
      }
      // Off the till, so a person can use it.
      await walk(r, { bearing: r.rng() * 360, distance: between(r, 3.5, 6) }, { seconds: 5 });
      await idleFor(between(r, 15_000, 40_000), shop.at);
    }
    if (!r.alive()) return;
    if (w.id === "portus") {
      if (await travelTo(r, scoreboardView(w), { within: 2.5, seconds: 90 })) await idleFor(between(r, 20_000, 60_000), scoreboardAt(w));
    } else {
      // No scoreboard out here: a turn round the pad instead.
      const pad = w.pads[0];
      if (pad && (await travelTo(r, pad.pos, { within: 6, seconds: 90 }))) await idleFor(between(r, 15_000, 40_000));
    }
  }
}

// ------------------------------------------------------------------------------------ the hunt-chaser

/** Chases the Three Gleams: takes a trial from Sela Marchbank, travels to it, attempts it, comes back. */
export async function chaser(r: Resident): Promise<void> {
  const a = r.agent;
  const greeted = new Map<string, number>();
  const hello = async (seen: Observation) => ((await greet(r, seen, greeted)), false);
  const fails = new Map<string, number>();
  while (r.alive()) {
    await r.pause(150); // a breath every round: no branch below can spin
    const o = look(r);
    if (await mind(r, o)) continue;
    const level = o.self.level;
    const done = (id: string) => o.missions.some((m) => m.id === id && m.done);
    // All three won: the vault (once a life), then a rest by it.
    if (o.hunt.gleams >= o.hunt.of && !o.hunt.vaultOpened) {
      if ((await goTo(r, "portus")) && (await walk(r, "vault", { seconds: 60 })).ok) {
        const opened = await a.interact("vault");
        r.log(`the Gleam Vault: ${opened.ok ? "opened" : opened.reason}`);
        if (opened.ok) await a.phrase("GG");
      }
      await r.pause(5000);
      continue;
    }
    // The next trial it may try: on a body it may visit, not too far over its level, not failed too often lately.
    const next = GLEAMS.trials.map((id) => MISSION_BY_ID.get(id)!).find((m) => !done(m.id) && r.bodies.includes(m.body) && level >= m.recLevel[0] - 3 && (fails.get(m.id) ?? 0) < 3);
    if (!next) {
      // Nothing it can try for now: wait by Sela with the others, and try again later.
      if ((await goTo(r, "portus")) && world(r).curator) await travelTo(r, world(r).curator!.pos, { within: between(r, 4, 7), seconds: 90, each: hello });
      for (let i = 0; i < 60 && r.alive(); i++) {
        await greet(r, look(r), greeted);
        await r.pause(1500);
      }
      fails.clear();
      continue;
    }
    if (!o.missions.some((m) => m.id === next.id)) {
      if (!(await goTo(r, "portus"))) {
        await r.pause(3000);
        continue;
      }
      if ((await walk(r, "curator", { seconds: 90 })).ok) {
        await a.interact("curator");
        const took = await a.takeMissions([next.id]);
        r.log(`asks ${GLEAMS.curator.name} for ${next.id} ${next.name}: ${took.ok ? "taken" : took.reason}`);
        await walk(r, { bearing: r.rng() * 360, distance: 4 }, { seconds: 4 });
        if (!took.ok) fails.set(next.id, (fails.get(next.id) ?? 0) + 1);
      }
      continue;
    }
    if (a.bodyId !== next.body) {
      if (!(await goTo(r, next.body))) await r.pause(3000);
      continue;
    }
    // On the trial's body. A warm-up on the way if the guide has a collect near the pad (Arcadia's Kite Season).
    const w = world(r);
    const warm = missionsOn(next.body).find((m) => m.type === "collect" && !m.collect?.limitS);
    if (warm && !o.missions.some((m) => m.id === warm.id) && (fails.get(warm.id) ?? 0) < 2 && o.self.zone === "safe" && w.guide && (await walk(r, "guide", { sprint: true, seconds: 60 })).ok) {
      if (!(await a.takeMissions([warm.id])).ok) fails.set(warm.id, 2);
      await walk(r, { bearing: r.rng() * 360, distance: 4 }, { seconds: 4 });
      continue;
    }
    const open = warm ? o.missions.find((m) => m.id === warm.id && !m.done) : undefined;
    if (open && (fails.get(open.id) ?? 0) < 2) {
      const res = await a.playTrial(open.id, { seconds: 150, stopWhenHit: true });
      r.log(`${open.id} ${open.name}: ${res.done ? "done" : res.reason} (${res.progress}/${res.goal})`);
      if (res.done) r.stats.trials++;
      else fails.set(open.id, (fails.get(open.id) ?? 0) + 1);
      continue;
    }
    // To where the trial starts (a long way from the pad), then the attempt.
    const spot = o.missions.find((m) => m.id === next.id)?.where;
    const start = w.missionSpot(next.id)?.pos;
    if (!spot || !start) {
      fails.set(next.id, 3);
      continue;
    }
    if (spot.dist > 45 && !(await travelTo(r, start, { sprint: true, within: 40, seconds: 420, each: hello }))) {
      if (!look(r).self.dead) fails.set(next.id, (fails.get(next.id) ?? 0) + 1);
      continue;
    }
    r.stats.attempts++;
    r.log(`attempts ${next.id} ${next.name}`);
    const res = await a.playTrial(next.id, {});
    r.log(`${next.id} ${next.name}: ${res.done ? `done in ${res.seconds} s` : res.reason} (${res.progress}/${res.goal})`);
    if (res.done) {
      r.stats.trials++;
      await a.phrase("GG");
    } else fails.set(next.id, (fails.get(next.id) ?? 0) + 1);
    await r.pause(between(r, 2000, 5000));
  }
}

export const BEHAVIOURS: Record<Role, (r: Resident) => Promise<void>> = { hunter, wanderer, trader, chaser };
