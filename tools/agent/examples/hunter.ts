// A scripted player with no model behind it: the kit's demo and its end-to-end check.
//
//   node tools/agent/examples/hunter.ts --url http://localhost:2567 --dev --seconds 300
//
// It arrives (through the Portus portal if the character is new), takes the first hunt mission and
// Kite Season (a collect) from Arcadia's guide, buys tonics if it can pay, leaves the safe zone,
// gathers the five kite panels in the meadow, then fights creatures of its level, drinks a tonic
// when hurt, runs back to safety when badly hurt, picks up its loot, and stops when the missions
// are done or the time is up. It uses its spells where they pay: Frostbloom when two or more
// creatures are on top of it, the Glasswing Ward when hurt in a fight, Skipstep to break away
// before a retreat. Everything it does goes through the same calls a model makes over MCP or HTTP;
// nothing here reads the server's memory.
//
// Flags: --url, --auth-url, --name, --starter, --dev (dev guest token), --seconds (default 300),
// --mission (default A1), --collect (default A4; "none" to skip it), --quiet.

import { FirstlightAgent, type ActionResult, type Observation, type ObservedCreature } from "@firstlight/agent-kit";

export interface HunterOptions {
  /** Stop after this long (ms). */
  budgetMs: number;
  /** The hunt mission to take and finish (Arcadia's first: A1 "Pest Control"). */
  mission: string;
  /** A collect mission to play first (default A4 "Kite Season", near the Arcadia pad); null: none. */
  collect?: string | null;
  log: (line: string) => void;
  /** Stop early (tests). */
  until?: (r: HunterReport) => boolean;
}

export interface HunterReport {
  kills: number;
  deaths: number;
  tonics: number;
  retreats: number;
  piles: number;
  /** XP earned from kills and missions during the run. */
  xp: number;
  coins: number;
  level: number;
  mission: { id: string; taken: boolean; progress: number; goal: number; done: boolean };
  /** The collect mission, when one was asked for. */
  collect: { id: string; taken: boolean; progress: number; goal: number; done: boolean } | null;
  /** Spells cast, by id. */
  casts: Record<string, number>;
  /** Movement the server refused (should be 0). */
  corrections: number;
  seconds: number;
  ended: "mission done" | "time" | "stopped" | "offline";
}

const sleep = (ms: number) => new Promise<void>((ok) => setTimeout(ok, ms));

/** How long a creature we left to a person stays theirs. */
const YIELD_MS = 40_000;

/**
 * What to fight next: whatever is on us, else a mission creature, else a hostile one of our size.
 * Never a creature a person is fighting (`claimedBy` someone who isn't an agent) nor one we yielded
 * lately (`theirs`: id → until when): no kill stealing (D-agents-10). Undefined: nothing to fight.
 */
export function pickTarget(creatures: readonly ObservedCreature[], level: number, theirs: ReadonlyMap<string, number>, now: number): ObservedCreature | undefined {
  const fair = creatures.filter((c) => !c.boss && c.level <= level + 2 && c.dist < 60 && !(c.claimedBy && !c.claimedBy.agent) && !((theirs.get(c.id) ?? 0) > now));
  return fair.find((c) => c.onMe) ?? fair.find((c) => c.mission) ?? fair.find((c) => c.hostile && c.kind === "hopbit") ?? fair.find((c) => c.hostile);
}

/** Play the hunter with a connected agent until the mission is done or the budget runs out. */
export async function runHunter(agent: FirstlightAgent, o: HunterOptions): Promise<HunterReport> {
  const t0 = Date.now();
  const left = () => o.budgetMs - (Date.now() - t0);
  const collect = o.collect === undefined ? "A4" : o.collect;
  const r: HunterReport = { kills: 0, deaths: 0, tonics: 0, retreats: 0, piles: 0, xp: 0, coins: 0, level: 1, mission: { id: o.mission, taken: false, progress: 0, goal: 0, done: false }, collect: collect ? { id: collect, taken: false, progress: 0, goal: 0, done: false } : null, casts: {}, corrections: 0, seconds: 0, ended: "time" };
  const say = (what: string, res?: ActionResult) => o.log(res ? `${what}: ${res.ok ? "ok" : `no (${res.reason})`}${res.hint && !res.ok ? ` — ${res.hint}` : ""}` : what);
  let look: Observation = agent.observe();
  const see = (): Observation => {
    look = agent.observe();
    for (const e of look.events) {
      if (e.type === "kill") r.kills++;
      const xp = /\+(\d+) XP/.exec(e.text);
      if (xp && (e.type === "kill" || e.type === "mission")) r.xp += Number(xp[1]);
      if (e.type === "death") r.deaths++;
      if (e.type !== "hit" && e.type !== "hurt") o.log(`  · ${e.text}`);
    }
    const m = look.missions.find((x) => x.id === o.mission);
    if (m) r.mission = { id: m.id, taken: true, progress: m.progress, goal: m.goal, done: m.done };
    const c = collect ? look.missions.find((x) => x.id === collect) : undefined;
    if (c) r.collect = { id: c.id, taken: true, progress: c.progress, goal: c.goal, done: c.done };
    r.level = look.self.level;
    r.coins = look.self.coins;
    r.corrections = agent.corrections;
    return look;
  };
  const finish = (ended: HunterReport["ended"]): HunterReport => {
    see();
    r.ended = ended;
    r.seconds = Math.round((Date.now() - t0) / 1000);
    return r;
  };

  // The first private state arrives a moment after the join.
  for (let i = 0; i < 60 && agent.observe({ peek: true }).self.maxHp === 0; i++) await sleep(50);
  o.log(see().summary.split("\n").slice(0, 2).join("\n"));

  // 1. Get to Arcadia (a new character starts in the Portus town).
  if (look.self.body === "portus") {
    await agent.skipTutorial();
    say("walk to the Arcadia portal", await agent.moveTo("portal:arcadia", { sprint: true }));
    const through = await agent.enterPortal("arcadia");
    say("through the portal", through);
    if (!through.ok) return finish("stopped");
    for (let i = 0; i < 60 && agent.observe({ peek: true }).self.maxHp === 0; i++) await sleep(50);
    see();
  }
  if (look.self.body !== "arcadia") {
    o.log(`the hunter's mission is on arcadia, and this character is on ${look.self.body}: stopping`);
    return finish("stopped");
  }

  // 2. The mission, and tonics if we can pay for them.
  const prepare = async () => {
    see();
    const want = [o.mission, ...(collect ? [collect] : [])].filter((id) => !look.missions.some((m) => m.id === id));
    if (want.length) {
      say("walk to the guide", await agent.moveTo("guide", { sprint: true }));
      for (const id of want) say(`take mission ${id}`, await agent.takeMissions([id]));
    }
    see();
    const tonics = look.self.hotbar.concat(look.self.backpack).filter((i) => i.id.startsWith("tonic")).reduce((n, i) => n + i.qty, 0);
    const buy = Math.min(3 - tonics, Math.floor(look.self.coins / 10));
    if (buy > 0) {
      say("walk to the shop", await agent.moveTo("shop", { sprint: true }));
      say(`buy ${buy} small tonic(s)`, await agent.buy("tonic_small", { qty: buy }));
    }
  };
  await prepare();
  /** Cast a spell if the book says it is ready (unlocked, off cooldown, enough aether). */
  const cast = async (spell: string, why: string, aim: { bearing?: number; targetId?: string } = {}): Promise<boolean> => {
    if (!agent.observe({ peek: true }).self.spells.list.find((x) => x.id === spell)?.ready) return false;
    const res = await agent.cast(spell, aim);
    if (res.ok) r.casts[spell] = (r.casts[spell] ?? 0) + 1;
    say(`${why}: cast ${spell}`, res);
    return res.ok;
  };

  // 3. Hunt.
  let idle = 0;
  const theirs = new Map<string, number>(); // creatures left to a person, until when
  while (left() > 0) {
    if (o.until?.(r)) return finish("stopped");
    if (agent.status === "offline" || agent.status === "closed") return finish("offline");
    if (agent.status !== "playing") {
      await sleep(500);
      continue;
    }
    see();
    if (r.mission.done && (!r.collect || r.collect.done || !r.collect.taken)) {
      say("missions done: back to safety", await agent.moveTo("safe", { sprint: true, seconds: 40 }));
      return finish("mission done");
    }
    const me = look.self;
    if (me.dead) {
      say("died: a new life", await agent.respawn());
      for (let i = 0; i < 60 && agent.observe({ peek: true }).self.maxHp === 0; i++) await sleep(50);
      if (see().self.body === "portus") {
        await agent.moveTo("portal:arcadia", { sprint: true });
        say("back through the portal", await agent.enterPortal("arcadia"));
        await sleep(500);
      }
      await prepare();
      continue;
    }
    // Hurt: a tonic first, then the safe zone until the HP is back.
    const hp = me.hp / Math.max(1, me.maxHp);
    const tonic = me.hotbar.concat(me.backpack).find((i) => i.id.startsWith("tonic"));
    if (hp < 0.55 && tonic && me.cooldowns.tonic === 0) {
      const used = await agent.useItem(tonic.slot);
      if (used.ok) r.tonics++;
      say(`HP ${me.hp}/${me.maxHp}: drink ${tonic.name}`, used);
    }
    if (hp < 0.35 && me.zone !== "safe") {
      r.retreats++;
      // Break away first: a blink toward safety puts 10 m between us and what is biting.
      if (look.safety && look.creatures.some((c) => c.onMe && c.dist < 8)) await cast("skipstep", "disengage", { bearing: look.safety.bearing });
      say(`HP ${me.hp}/${me.maxHp}: retreat`, await agent.moveTo("safe", { sprint: true, seconds: 40 }));
      for (let i = 0; i < 40 && left() > 0; i++) {
        const s = agent.observe({ peek: true }).self;
        if (s.dead || s.hp >= s.maxHp * 0.8) break;
        await sleep(1000);
      }
      continue;
    }
    // The collect mission first: a walk over the pieces, close to the pad (stops when something bites).
    const kites = collect ? look.missions.find((m) => m.id === collect && !m.done) : undefined;
    if (kites && kites.on === undefined && !look.creatures.some((c) => c.onMe)) {
      const res = await agent.playTrial(kites.id, { seconds: Math.min(150, Math.max(5, left() / 1000)), stopWhenHit: true });
      o.log(`${kites.id} ${kites.name}: ${res.done ? "done" : (res.reason ?? "ended")} · ${res.progress}/${res.goal} in ${res.seconds} s`);
      if (res.done || res.reason === "timeout") continue;
      if (res.reason === "hurt") see(); // fight what bit us below, then come back to the kites
      if (res.reason === "blocked" || res.reason === "no mission spot") r.collect = r.collect && { ...r.collect, taken: false }; // can't be had from here: hunt on
    }
    // Loot that is ours and close.
    const pile = look.piles.find((p) => p.dist < 30 && (p.yours || look.players.every((pl) => pl.dist > 40)));
    if (pile && !look.creatures.some((c) => c.onMe)) {
      const went = await agent.moveTo(pile.id, { sprint: true, seconds: 15, stopWhenHit: true });
      if (went.ok) {
        const got = await agent.interact(pile.id);
        if (got.ok) r.piles++;
        say("pick up loot", got);
      }
      continue;
    }
    // A fight: whatever is on us, else a mission creature, else a hostile one of our size; never a person's.
    const target = pickTarget(look.creatures, me.level, theirs, Date.now());
    if (target) {
      idle = 0;
      // Spells where they pay: frost when two or more are within its ring, the ward when hurt and bitten.
      const close = look.creatures.filter((c) => c.dist <= 4.5 && (c.onMe || c.hostile) && !c.boss).length;
      if (me.zone !== "safe" && close >= 2) await cast("frostbloom", `${close} creatures within 5 m`);
      if (me.zone !== "safe" && hp < 0.5 && look.creatures.some((c) => c.onMe)) await cast("glasswing", `HP ${me.hp}/${me.maxHp} under attack`);
      // Short rounds, so the next look can answer a second creature joining in.
      const fight = await agent.attack(target.id, { seconds: me.level >= 3 ? 10 : 25, retreatBelow: 0.35, yieldTo: "people" });
      o.log(`fight ${target.name} L${target.level} (${Math.round(target.dist)} m): ${fight.killed ? `killed, +${fight.xp} XP` : (fight.reason ?? "ended")} · HP ${fight.hp}`);
      if (fight.reason === "safe zone") await agent.moveTo("mission", { sprint: true, seconds: 20 });
      // A person is fighting it (or stands in our line): the kill is theirs. Leave it for a while and
      // step back; the next look picks another creature, or there is nothing to do but wait.
      if (fight.reason === "yielded" || fight.reason === "player in the way") {
        theirs.set(target.id, Date.now() + YIELD_MS);
        await agent.moveTo({ bearing: (target.bearing + 180) % 360, distance: 10 }, { seconds: 5 });
      }
      continue;
    }
    // Nothing to fight here: to the hunting ground, then wander round it.
    const where = look.missions.find((m) => m.id === o.mission)?.where;
    if (where && where.dist > 18) say(`to the hunting ground (${Math.round(where.dist)} m)`, await agent.moveTo(`mission:${o.mission}`, { sprint: true, seconds: Math.min(45, Math.max(5, left() / 1000)), stopWhenHit: true }));
    else {
      idle++;
      await agent.moveTo({ bearing: (idle * 97) % 360, distance: 22 }, { seconds: 8, stopWhenHit: true });
    }
  }
  return finish("time");
}

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const v = process.argv[i + 1];
  return v && !v.startsWith("--") ? v : "1";
}

async function main() {
  const url = flag("url") ?? process.env.FL_URL ?? "http://localhost:2567";
  const name = flag("name") ?? `Hunter_${Math.floor(Math.random() * 900 + 100)}`;
  const quiet = !!flag("quiet");
  const t0 = Date.now();
  const log = (line: string) => quiet || console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s] ${line}`);
  const agent = new FirstlightAgent();
  const joined = await agent.connect({
    url,
    authUrl: flag("auth-url") ?? process.env.FL_AUTH_URL,
    authOrigin: process.env.FL_AUTH_ORIGIN,
    name,
    starter: flag("starter") ?? "unit7",
    ...(flag("dev") ? { token: `dev:${name.toLowerCase()}:${name}` } : { sessionFile: process.env.FL_AGENT_SESSION }),
    log,
  });
  log(`joined: ${JSON.stringify(joined)}`);
  process.on("SIGINT", () => void agent.close().then(() => process.exit(130)));
  const collect = flag("collect") ?? "A4";
  const report = await runHunter(agent, { budgetMs: Number(flag("seconds") ?? 300) * 1000, mission: flag("mission") ?? "A1", collect: collect === "none" ? null : collect, log });
  await agent.close();
  console.log(`RESULT ${JSON.stringify(report)}`);
  process.exit(report.corrections === 0 && agent.status === "closed" ? 0 : 1);
}

if (import.meta.main) void main();
