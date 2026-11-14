// Residents: a handful of scripted AI characters that make a world feel lived in. No model: each
// one runs a small behaviour (resident-roles.ts) on the agent kit, joins flagged as an AI agent
// (so it wears the AI chip and stays off the people's boards) and plays by every server rule.
//
//   node tools/agent/residents.ts --url http://localhost:2567 --count 8 --bodies portus,arcadia
//
// The cast, in order (--count takes the first N): a hunter who farms creatures near a pad, a
// wanderer who walks between pads and landmarks and greets people, a trader who idles at the shop
// and the plaza scoreboard, a hunt-chaser who attempts the trials of the Three Gleams; then again.
//
// Flags: --url (default $FL_URL or http://localhost:2567), --auth-url, --count (default 4),
// --bodies (comma list, default portus,arcadia: where residents may live and go), --roles (comma
// list to cycle instead of the cast's own), --seconds (stop after this long; default: until
// Ctrl-C), --cpu (the process's CPU budget as a share of one core, default 0.5), --max-humans N
// (the budget switch: play only while at most N people are online; over it, or while the count can't
// be had, they leave safely and come back when a count is at most N; nobody joins before the first),
// --dev (dev guest tokens: local servers with ALLOW_DEV_GUESTS=1), --quiet.
//
// They talk (resident-talk.ts): a person who walks up is greeted and told who they are and what
// they do; the phrase wheel gets answers in character. Authored lines only (no free text); the
// brain is scripted unless FL_RESIDENT_BRAIN=model names an endpoint (FL_RESIDENT_API openai or
// anthropic, FL_RESIDENT_URL, FL_RESIDENT_MODEL, FL_RESIDENT_KEY, FL_RESIDENT_CALLS_PER_HOUR,
// FL_RESIDENT_TOKENS_PER_HOUR).
//
// The server decides who gets in: agents must be on (AGENTS_ENABLED) and each address may run
// AGENTS_PER_IP of them at once (default 4), each room copy AGENTS_PER_ROOM (default 8). Residents
// the caps refuse are skipped with a line saying so. Ctrl-C stops them cleanly: each walks to the
// nearest safe zone and leaves there, so no body is left in the wild to be killed (a second Ctrl-C: now).

import { homedir } from "node:os";
import { join as join_ } from "node:path";
import { AgentError, FirstlightAgent } from "@firstlight/agent-kit";
import { BODY_IDS, type BodyId } from "@firstlight/shared";
import { ROLE_VOICE, type Voice } from "@firstlight/shared/content/residentLines";
import { BEHAVIOURS, ROLES, type Resident, type ResidentStats, type Role } from "./resident-roles.ts";
import { brainFromEnv, Floor, startTalk, type Brain, type ModelStats } from "./resident-talk.ts";

export interface CastMember {
  name: string;
  role: Role;
  starter: string;
  /** Whose lines it speaks (content/residentLines.ts): its own, or its role's. */
  voice?: Voice;
}

/** The residents, in joining order. Original names (checked against docs/content.md §10 and the game's own NPCs). */
export const CAST: readonly CastMember[] = [
  { name: "Brindle_Oake", role: "hunter", starter: "ash" , voice: "brindle" },
  { name: "Tamsin_Hollis", role: "wanderer", starter: "kappa" , voice: "tamsin" },
  { name: "Marlo_Thistle", role: "trader", starter: "unit7" , voice: "marlo" },
  { name: "Juniper_Fenn", role: "chaser", starter: "ninja" , voice: "juniper" },
  { name: "Garnet_Moss", role: "hunter", starter: "unit7" },
  { name: "Hesper_Dunn", role: "wanderer", starter: "hexwick" },
  { name: "Sable_Finch", role: "trader", starter: "kappa" },
  { name: "Corbin_Reed", role: "chaser", starter: "kappa" },
  { name: "Wendell_Crane", role: "hunter", starter: "ninja" },
  { name: "Odessa_Larch", role: "wanderer", starter: "ninja" },
  { name: "Ptolemy_Birch", role: "trader", starter: "hexwick" },
  { name: "Isla_Thornby", role: "chaser", starter: "unit7" },
];

export interface ResidentsOptions {
  url: string;
  authUrl?: string;
  authOrigin?: string;
  count: number;
  /** Bodies residents may live on and travel to. */
  bodies: readonly BodyId[];
  /** Cycle these roles instead of the cast's own. */
  roles?: readonly Role[];
  /** Who plays (default CAST, in order). */
  cast?: readonly CastMember[];
  /** Stop after this long (ms); undefined: run until stop(). */
  budgetMs?: number;
  /** CPU budget for the whole process as a share of one core (0.05-4). */
  cpu: number;
  /** Dev guest tokens (`dev:<id>:<name>`) instead of the guest sign-in. */
  dev?: boolean;
  /** Where guest sessions are kept, one file per resident (the file is the character). */
  home?: string;
  log: (line: string) => void;
  /** Called about once a second; return true to stop (tests). */
  until?: (r: ResidentsReport) => boolean;
  /**
   * The budget switch: residents play only while at most this many people are online (the server's
   * /api/online count, which leaves agents out). Over it they walk to safety and leave, and come back
   * when the count falls. Nobody joins before the first valid count, and while the count is unknown
   * (the request fails) they stay out: unknown is not permission. Undefined: always play.
   */
  maxHumans?: number;
  /** How many people are online (default: GET <url>/api/online every `humansEveryMs`). */
  humans?: () => Promise<number>;
  humansEveryMs?: number;
  /** What residents say when people talk to them (default: brainFromEnv(), scripted unless FL_RESIDENT_BRAIN=model). */
  brain?: Brain;
}

export interface ResidentReport extends ResidentStats {
  name: string;
  role: Role;
  home: BodyId;
  body: BodyId;
  level: number;
  /** "playing", "away" (lost the world, coming back), "stopped", or why it isn't in ("refused: agents off", "refused: agent limit", …). */
  status: string;
  /** Movement the server refused (should be 0). */
  corrections: number;
}

export interface ResidentsReport {
  residents: ResidentReport[];
  joined: number;
  seconds: number;
  /** CPU the process used while the residents played: seconds, and as a share of one core. */
  cpu: { seconds: number; cores: number; budget: number; throttled: number };
  ended: "time" | "stopped" | "nobody";
  /** People online at the last look (null: not asked, or unknown) and whether the residents are parked for them. */
  humans: number | null;
  parked: boolean;
  /** The talk brain, and for a model brain what it spent. */
  brain: { kind: "scripted" | "model"; model?: ModelStats };
}

export interface ResidentsRun {
  /** Resolves with the report when the run is over. */
  done: Promise<ResidentsReport>;
  /** Stop cleanly: residents end their step, walk to the nearest safe zone and leave the world there. */
  stop(): void;
  report(): ResidentsReport;
}

/** The dev identity a resident plays under with `dev` (tests grant it travel). */
export const residentId = (name: string) => `res_${name.toLowerCase()}`;

const sleep = (ms: number) => new Promise<void>((ok) => setTimeout(ok, ms));

function seeded(name: string): () => number {
  let s = 2166136261;
  for (const c of name) s = Math.imul(s ^ c.charCodeAt(0), 16777619);
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Who plays, where: the first `count` of the cast (names repeat with a number past the cast's end). */
export function plan(o: Pick<ResidentsOptions, "count" | "bodies" | "roles" | "cast">): { name: string; role: Role; starter: string; home: BodyId; voice: Voice }[] {
  const planets = o.bodies.filter((b) => b !== "portus");
  const byRole: Record<Role, number> = { hunter: 0, wanderer: 0, trader: 0, chaser: 0 };
  const cast = o.cast?.length ? o.cast : CAST;
  return Array.from({ length: o.count }, (_, i) => {
    const c = cast[i % cast.length]!;
    const round = Math.floor(i / cast.length);
    const role = o.roles?.length ? o.roles[i % o.roles.length]! : c.role;
    const n = byRole[role]++;
    // Hunters live on planets (nothing to hunt in the hub), traders and chasers start in Portus when
    // it is allowed, wanderers spread over every body.
    const home: BodyId =
      role === "hunter" ? (planets[n % Math.max(1, planets.length)] ?? o.bodies[0] ?? "arcadia")
      : role === "wanderer" ? (o.bodies[n % o.bodies.length] ?? "portus")
      : o.bodies.includes("portus") ? "portus" : (o.bodies[n % o.bodies.length] ?? "portus");
    // Its own voice while it plays its own role; otherwise the role's.
    const voice = c.voice && role === c.role ? c.voice : (ROLE_VOICE[role] ?? "tamsin");
    return { name: round ? `${c.name.slice(0, 13)}_${round + 1}` : c.name, role, starter: c.starter, home, voice };
  });
}

/** Start the residents. They join one after another; the returned run stops them and reports. */
export function runResidents(o: ResidentsOptions): ResidentsRun {
  const t0 = Date.now();
  const cpu0 = process.cpuUsage();
  let stopping = false;
  /**
   * Over the people budget (maxHumans), or the count is unknown: everyone stays out until a valid
   * count is at most the budget. With a budget set, they start parked: no join before the first count.
   */
  let parked = o.maxHumans !== undefined;
  let humans: number | null = null;
  const brain = o.brain ?? brainFromEnv();
  const floor = new Floor();
  let ended: ResidentsReport["ended"] = "time";
  /** Extra waiting while over the CPU budget: every pause is stretched by this factor. */
  let rest = 0;
  let throttled = 0;
  const members = plan(o).map((m) => {
    const agent = new FirstlightAgent();
    const stats: ResidentStats = { kills: 0, deaths: 0, yields: 0, greetings: 0, casts: 0, trades: 0, attempts: 0, trials: 0, walked: 0, lines: 0 };
    const state = { status: "joining" };
    const r: Resident = {
      name: m.name,
      role: m.role,
      home: m.home,
      bodies: o.bodies,
      agent,
      stats,
      log: (line) => o.log(`${m.name.padEnd(14)} ${line}`),
      alive: () => !stopping && !parked && (agent.status === "playing" || agent.status === "reconnecting" || agent.status === "joining"),
      async pause(ms) {
        const until = Date.now() + ms * (1 + rest);
        while (!stopping && !parked && Date.now() < until) await sleep(Math.min(250, until - Date.now()));
      },
      rng: seeded(m.name),
      talks: true,
    };
    const talk = startTalk({ agent, voice: m.voice, name: m.name, brain, floor, onLine: () => stats.lines++, log: (line) => o.log(`${m.name.padEnd(14)} says ${line}`) });
    return { ...m, r, state, talk };
  });

  const report = (): ResidentsReport => {
    const used = process.cpuUsage(cpu0);
    const seconds = (Date.now() - t0) / 1000;
    const cpuS = (used.user + used.system) / 1e6;
    return {
      residents: members.map((m) => {
        const playing = m.r.agent.status === "playing" || m.r.agent.status === "reconnecting";
        const self = playing ? m.r.agent.observe({ peek: true }).self : null;
        return { name: m.r.agent.name || m.name, role: m.role, home: m.home, body: m.r.agent.bodyId, level: self?.level ?? 0, status: m.state.status, corrections: m.r.agent.corrections, ...m.r.stats, walked: Math.round(m.r.stats.walked) };
      }),
      joined: members.filter((m) => m.state.status === "playing" || m.state.status === "away" || m.state.status === "stopped").length,
      seconds: Math.round(seconds),
      cpu: { seconds: Math.round(cpuS * 10) / 10, cores: Math.round((cpuS / Math.max(0.001, seconds)) * 1000) / 1000, budget: o.cpu, throttled },
      ended,
      humans,
      parked,
      brain: { kind: brain.kind, ...("stats" in brain ? { model: { ...(brain as { stats: ModelStats }).stats } } : {}) },
    };
  };

  /** Walk to the nearest safe zone (a body leaves there at once) and leave; one cut off logs out where it stands. */
  async function leaveSafely(m: (typeof members)[number]): Promise<void> {
    const a = m.r.agent;
    if (a.status !== "playing") return void (await a.close().catch(() => {}));
    let self = a.observe({ peek: true }).self;
    if (!self.dead && self.zone !== "safe") {
      m.r.log("walks to safety before leaving");
      await Promise.race([a.moveTo("safe", { sprint: true, seconds: 45 }), sleep(46_000)]);
      self = a.observe({ peek: true }).self;
    }
    await Promise.race([a.close({ logout: !self.dead && self.zone !== "safe" }), sleep(16_000)]);
  }

  /** Refusals that waiting won't change: the caps and the switch are the server owner's, a new protocol needs a new checkout. */
  const FINAL: ReadonlySet<string> = new Set(["agents off", "agent limit", "version", "banned", "unauthorized"]);

  async function join(m: (typeof members)[number]): Promise<string | null> {
    const { r } = m;
    try {
      const joined = await r.agent.connect({
        url: o.url,
        authUrl: o.authUrl,
        authOrigin: o.authOrigin,
        name: m.name,
        starter: m.starter,
        ...(o.dev ? { token: `dev:${residentId(m.name)}:${m.name}` } : { sessionFile: join_(o.home ?? join_(process.env.FL_AGENT_HOME ?? join_(homedir(), ".firstlight", "agents"), "residents"), `${o.url.replace(/^https?:\/\//, "").replace(/[^A-Za-z0-9.-]+/g, "_")}-${m.name}.json`) }),
      });
      m.state.status = "playing";
      r.log(`joined ${r.agent.bodyId} as a ${m.role} (${joined.starter}), home ${m.home}${joined.newGuest ? " — a new guest character: the saved session had ended" : ""}`);
      for (let i = 0; i < 60 && r.agent.observe({ peek: true }).self.maxHp === 0; i++) await sleep(50);
      return null;
    } catch (e) {
      r.log(`not let in: ${(e as Error).message}`);
      return e instanceof AgentError ? e.code : "join failed";
    }
  }

  async function play(m: (typeof members)[number]): Promise<void> {
    const { r } = m;
    // Parked from the start (no valid count under the budget yet): wait in the loop, join from there.
    if (parked) m.state.status = "parked";
    const first = parked ? null : await join(m);
    if (first) {
      m.state.status = `refused: ${first}`;
      if (FINAL.has(first)) return;
    }
    let wait = 15_000;
    while (!stopping) {
      if (parked) {
        // Over the people budget: out of the world (safely) until the count falls, then back in.
        if (m.state.status === "playing") {
          await leaveSafely(m);
          m.state.status = "parked";
          r.log("leaves: enough people online");
        }
        await sleep(1000);
        continue;
      }
      if (m.state.status === "parked") {
        const why = await join(m);
        if (why && FINAL.has(why)) {
          m.state.status = `refused: ${why}`;
          return;
        }
        if (why) await r.pause(15_000);
        continue;
      }
      if (m.state.status === "playing") {
        // A behaviour that throws is a bug, not a reason to take the others down: say so, rest, go on.
        try {
          await BEHAVIOURS[m.role](r);
        } catch (e) {
          r.log(`stumbled: ${(e as Error).message}`);
          await r.pause(5000);
        }
        if (stopping || parked || r.alive()) continue;
        // Gone for good from the kit's side (the server restarted, the session ended): come back later.
        m.state.status = "away";
        r.log("lost the world: will come back");
        wait = 15_000;
      }
      await r.pause(wait);
      if (stopping) break;
      const why = await join(m);
      if (why && FINAL.has(why)) {
        m.state.status = `refused: ${why}`;
        return;
      }
      wait = Math.min(300_000, wait * 2);
    }
    m.state.status = "stopped";
  }

  const done = (async (): Promise<ResidentsReport> => {
    let humansAt = 0;
    const askHumans = o.humans ?? (async () => {
      const r = await fetch(`${o.url.replace(/\/+$/, "")}/api/online`, { signal: AbortSignal.timeout(5000) });
      const body = (await r.json()) as { online?: unknown };
      if (typeof body.online !== "number" || !Number.isFinite(body.online)) throw new Error("no count");
      return body.online;
    });
    /** Why they are parked, last said ("over" or "unknown"): each change of reason is logged once. */
    let said: string | null = null;
    const park = (why: "over" | "unknown", line: string) => {
      if (said !== why) o.log(line);
      said = why;
      if (parked) return;
      parked = true;
      for (const m of members) if (m.r.agent.status === "playing") void m.r.agent.stop();
    };
    const checkHumans = async () => {
      if (o.maxHumans === undefined) return;
      humansAt = Date.now();
      let n: number;
      try {
        n = await askHumans();
        if (typeof n !== "number" || !Number.isFinite(n)) throw new Error("no count");
      } catch {
        // Unknown is not permission: out (or stay out) until a count comes back.
        humans = null;
        return park("unknown", "the people count is unavailable: the residents stay out until it comes back");
      }
      humans = n;
      // Fails closed: a budget that isn't a number never lets anyone in.
      if (!(n <= o.maxHumans)) park("over", `${n} people online (over ${o.maxHumans}): the residents stay out`);
      else if (parked) {
        o.log(`${n} people online (at most ${o.maxHumans}): the residents come in`);
        parked = false;
        said = null;
      }
    };
    // With a budget, a valid count comes before anyone joins.
    await checkHumans();
    const plays: Promise<void>[] = [];
    for (const m of members) {
      if (stopping) break;
      plays.push(play(m));
      // One after another: joins share the address's request budget, and a crowd at the pad looks wrong.
      for (let i = 0; i < 40 && m.state.status === "joining" && !stopping; i++) await sleep(100);
      if (m.state.status === "refused: agents off") {
        o.log("AI agents are off on this server (AGENTS_ENABLED): nobody can join. Stopping.");
        stopping = true;
        ended = "nobody";
      }
    }
    // The watch: the time budget, the caller's `until`, and the CPU budget (over it: everyone rests longer).
    let last = process.cpuUsage();
    let lastAt = Date.now();
    while (!stopping) {
      await sleep(1000);
      const now = Date.now();
      // While the count is unknown, ask again sooner (at most every 5 s).
      const every = humans === null ? Math.min(5000, o.humansEveryMs ?? 30_000) : (o.humansEveryMs ?? 30_000);
      if (o.maxHumans !== undefined && now - humansAt >= every) await checkHumans();
      const used = process.cpuUsage(last);
      const share = (used.user + used.system) / 1000 / Math.max(1, now - lastAt);
      last = process.cpuUsage();
      lastAt = now;
      if (share > o.cpu) {
        rest = Math.min(8, rest * 1.5 + 0.5);
        throttled++;
      } else rest = Math.max(0, rest * 0.8 - 0.05);
      if (o.budgetMs !== undefined && now - t0 >= o.budgetMs) stopping = true;
      else if (o.until?.(report())) (stopping = true), (ended = "stopped");
      else if (members.every((m) => m.state.status.startsWith("refused"))) (stopping = true), (ended = "nobody");
    }
    for (const m of members) m.talk();
    // Stop cleanly. A body left in the wild lingers and can be killed, which costs the character
    // its levels: so each resident ends what it is doing, lets its behaviour return, walks to the
    // nearest safe zone (where a body leaves at once), and only then leaves. One too far from any
    // safe zone (or cut off) uses the logout countdown where it stands, about 10 s.
    for (const m of members) if (m.r.agent.status === "playing") await m.r.agent.stop();
    await Promise.race([Promise.all(plays), sleep(4000)]);
    const final = report();
    await Promise.all(members.map((m) => leaveSafely(m)));
    const used = process.cpuUsage(cpu0);
    for (const r of final.residents) if (r.status === "playing" || r.status === "away" || r.status === "parked") r.status = "stopped";
    final.seconds = Math.round((Date.now() - t0) / 1000);
    final.cpu.seconds = Math.round((used.user + used.system) / 1e5) / 10;
    final.cpu.cores = Math.round((final.cpu.seconds / Math.max(1, final.seconds)) * 1000) / 1000;
    final.ended = ended;
    return final;
  })();

  return {
    done,
    stop() {
      if (!stopping) ended = "stopped";
      stopping = true;
    },
    report,
  };
}

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const v = process.argv[i + 1];
  return v && !v.startsWith("--") ? v : "1";
}

async function main() {
  if (flag("help")) {
    console.log("usage: node tools/agent/residents.ts [--url U] [--auth-url U] [--count 4] [--bodies portus,arcadia] [--roles hunter,wanderer,trader,chaser] [--seconds S] [--cpu 0.5] [--max-humans N] [--dev] [--quiet]");
    return;
  }
  const quiet = !!flag("quiet");
  const t0 = Date.now();
  const log = (line: string) => quiet || console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(7)}s] ${line}`);
  const bodies = (flag("bodies") ?? "portus,arcadia").split(",").map((b) => b.trim()).filter((b): b is BodyId => (BODY_IDS as readonly string[]).includes(b));
  const roles = flag("roles")?.split(",").map((x) => x.trim()).filter((x): x is Role => (ROLES as readonly string[]).includes(x));
  const count = Math.max(1, Math.min(40, Math.round(Number(flag("count") ?? 4)) || 4));
  const seconds = Number(flag("seconds"));
  if (!bodies.length) {
    console.error(`--bodies: none of ${BODY_IDS.join(", ")}`);
    process.exit(2);
  }
  // A budget that isn't a number would compare false with every count, and so never apply.
  const maxHumans = flag("max-humans") !== undefined ? Math.round(Number(flag("max-humans"))) : undefined;
  if (maxHumans !== undefined && !(maxHumans >= 0)) {
    console.error("--max-humans: a whole number of people, 0 or more");
    process.exit(2);
  }
  const run = runResidents({
    url: flag("url") ?? process.env.FL_URL ?? "http://localhost:2567",
    authUrl: flag("auth-url") ?? process.env.FL_AUTH_URL,
    authOrigin: process.env.FL_AUTH_ORIGIN,
    count,
    bodies,
    roles,
    budgetMs: Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined,
    cpu: Math.max(0.05, Math.min(4, Number(flag("cpu") ?? 0.5) || 0.5)),
    dev: !!flag("dev") || process.env.FL_DEV === "1",
    maxHumans,
    log,
  });
  let asked = 0;
  const onSignal = () => {
    if (asked++) process.exit(130); // a second Ctrl-C: now
    log("stopping: the residents walk to safety and leave, up to a minute (Ctrl-C again to quit at once)");
    run.stop();
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  const report = await run.done;
  console.log(`RESULT ${JSON.stringify(report)}`);
  process.exit(report.joined > 0 && report.residents.every((r) => r.corrections === 0) ? 0 : 1);
}

if (import.meta.main) void main();
