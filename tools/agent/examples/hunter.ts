// A scripted player with no model behind it: the kit's demo and its end-to-end check.
//
//   node tools/agent/examples/hunter.ts --url http://localhost:2567 --dev --seconds 300
//
// It arrives (through the Portus portal if the character is new), takes the first hunt mission from
// Arcadia's guide, buys tonics if it can pay, leaves the safe zone, fights creatures of its level,
// drinks a tonic when hurt, runs back to safety when badly hurt, picks up its loot, and stops when
// the mission is done or the time is up. Everything it does goes through the same calls a model
// makes over MCP or HTTP; nothing here reads the server's memory.
//
// Flags: --url, --auth-url, --name, --starter, --dev (dev guest token), --seconds (default 300),
// --mission (default A1), --quiet.

import { FirstlightAgent, type ActionResult, type Observation } from "@firstlight/agent-kit";

export interface HunterOptions {
  /** Stop after this long (ms). */
  budgetMs: number;
  /** The hunt mission to take and finish (Arcadia's first: A1 "Pest Control"). */
  mission: string;
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
  /** Movement the server refused (should be 0). */
  corrections: number;
  seconds: number;
  ended: "mission done" | "time" | "stopped" | "offline";
}

const sleep = (ms: number) => new Promise<void>((ok) => setTimeout(ok, ms));

/** Play the hunter with a connected agent until the mission is done or the budget runs out. */
export async function runHunter(agent: FirstlightAgent, o: HunterOptions): Promise<HunterReport> {
  const t0 = Date.now();
  const left = () => o.budgetMs - (Date.now() - t0);
  const r: HunterReport = { kills: 0, deaths: 0, tonics: 0, retreats: 0, piles: 0, xp: 0, coins: 0, level: 1, mission: { id: o.mission, taken: false, progress: 0, goal: 0, done: false }, corrections: 0, seconds: 0, ended: "time" };
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
    if (!look.missions.some((m) => m.id === o.mission)) {
      say("walk to the guide", await agent.moveTo("guide", { sprint: true }));
      say(`take mission ${o.mission}`, await agent.takeMissions([o.mission]));
    }
    see();
    const tonics = look.self.hotbar.concat(look.self.backpack).filter((i) => i.id.startsWith("tonic")).reduce((n, i) => n + i.qty, 0);
    const want = Math.min(3 - tonics, Math.floor(look.self.coins / 10));
    if (want > 0) {
      say("walk to the shop", await agent.moveTo("shop", { sprint: true }));
      say(`buy ${want} small tonic(s)`, await agent.buy("tonic_small", { qty: want }));
    }
  };
  await prepare();

  // 3. Hunt.
  let idle = 0;
  while (left() > 0) {
    if (o.until?.(r)) return finish("stopped");
    if (agent.status === "offline" || agent.status === "closed") return finish("offline");
    if (agent.status !== "playing") {
      await sleep(500);
      continue;
    }
    see();
    if (r.mission.done) {
      say("mission done: back to safety", await agent.moveTo("safe", { sprint: true, seconds: 40 }));
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
      say(`HP ${me.hp}/${me.maxHp}: retreat`, await agent.moveTo("safe", { sprint: true, seconds: 40 }));
      for (let i = 0; i < 40 && left() > 0; i++) {
        const s = agent.observe({ peek: true }).self;
        if (s.dead || s.hp >= s.maxHp * 0.8) break;
        await sleep(1000);
      }
      continue;
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
    // A fight: whatever is on us, else a mission creature, else a hostile one of our size.
    const fair = look.creatures.filter((c) => !c.boss && c.level <= me.level + 2 && c.dist < 60);
    const target = fair.find((c) => c.onMe) ?? fair.find((c) => c.mission) ?? fair.find((c) => c.hostile && c.kind === "hopbit") ?? fair.find((c) => c.hostile);
    if (target) {
      idle = 0;
      const fight = await agent.attack(target.id, { seconds: 25, retreatBelow: 0.35 });
      o.log(`fight ${target.name} L${target.level} (${Math.round(target.dist)} m): ${fight.killed ? `killed, +${fight.xp} XP` : (fight.reason ?? "ended")} · HP ${fight.hp}`);
      if (fight.reason === "safe zone") await agent.moveTo("mission", { sprint: true, seconds: 20 });
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
    name,
    starter: flag("starter") ?? "unit7",
    ...(flag("dev") ? { token: `dev:${name.toLowerCase()}:${name}` } : { sessionFile: process.env.FL_AGENT_SESSION }),
    log,
  });
  log(`joined: ${JSON.stringify(joined)}`);
  process.on("SIGINT", () => void agent.close().then(() => process.exit(130)));
  const report = await runHunter(agent, { budgetMs: Number(flag("seconds") ?? 300) * 1000, mission: flag("mission") ?? "A1", log });
  await agent.close();
  console.log(`RESULT ${JSON.stringify(report)}`);
  process.exit(report.corrections === 0 && agent.status === "closed" ? 0 : 1);
}

if (import.meta.main) void main();
