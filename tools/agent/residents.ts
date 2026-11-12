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
// Ctrl-C), --cpu (the process's CPU budget as a share of one core, default 0.5), --dev (dev guest
// tokens: local servers with ALLOW_DEV_GUESTS=1), --quiet.
//
// The server decides who gets in: agents must be on (AGENTS_ENABLED) and each address may run
// AGENTS_PER_IP of them at once (default 4), each room copy AGENTS_PER_ROOM (default 8). Residents
// the caps refuse are skipped with a line saying so. Ctrl-C stops them cleanly (a second one: now).

import { homedir } from "node:os";
import { join } from "node:path";
import { AgentError, FirstlightAgent } from "@firstlight/agent-kit";
import { BODY_IDS, type BodyId } from "@firstlight/shared";
import { BEHAVIOURS, ROLES, type Resident, type ResidentStats, type Role } from "./resident-roles.ts";

export interface CastMember {
  name: string;
  role: Role;
  starter: string;
}

/** The residents, in joining order. Original names (checked against docs/content.md §10 and the game's own NPCs). */
export const CAST: readonly CastMember[] = [
  { name: "Brindle_Oake", role: "hunter", starter: "ash" },
  { name: "Tamsin_Hollis", role: "wanderer", starter: "kappa" },
  { name: "Marlo_Thistle", role: "trader", starter: "unit7" },
  { name: "Juniper_Fenn", role: "chaser", starter: "ninja" },
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
}

export interface ResidentReport extends ResidentStats {
  name: string;
  role: Role;
  home: BodyId;
  body: BodyId;
  level: number;
  /** "playing", "offline", or why it never got in ("agents off", "agent limit", …). */
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
}

export interface ResidentsRun {
  /** Resolves with the report when the run is over. */
  done: Promise<ResidentsReport>;
  /** Stop cleanly: residents finish their step, leave the world (a logout countdown outside safe zones). */
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
export function plan(o: Pick<ResidentsOptions, "count" | "bodies" | "roles">): { name: string; role: Role; starter: string; home: BodyId }[] {
  const planets = o.bodies.filter((b) => b !== "portus");
  const byRole: Record<Role, number> = { hunter: 0, wanderer: 0, trader: 0, chaser: 0 };
  return Array.from({ length: o.count }, (_, i) => {
    const c = CAST[i % CAST.length]!;
    const round = Math.floor(i / CAST.length);
    const role = o.roles?.length ? o.roles[i % o.roles.length]! : c.role;
    const n = byRole[role]++;
    // Hunters live on planets (nothing to hunt in the hub), traders and chasers start in Portus when
    // it is allowed, wanderers spread over every body.
    const home: BodyId =
      role === "hunter" ? (planets[n % Math.max(1, planets.length)] ?? o.bodies[0] ?? "arcadia")
      : role === "wanderer" ? (o.bodies[n % o.bodies.length] ?? "portus")
      : o.bodies.includes("portus") ? "portus" : (o.bodies[n % o.bodies.length] ?? "portus");
    return { name: round ? `${c.name.slice(0, 13)}_${round + 1}` : c.name, role, starter: c.starter, home };
  });
}

/** Start the residents. They join one after another; the returned run stops them and reports. */
export function runResidents(o: ResidentsOptions): ResidentsRun {
  const t0 = Date.now();
  const cpu0 = process.cpuUsage();
  let stopping = false;
  let ended: ResidentsReport["ended"] = "time";
  /** Extra waiting while over the CPU budget: every pause is stretched by this factor. */
  let rest = 0;
  let throttled = 0;
  const members = plan(o).map((m) => {
    const agent = new FirstlightAgent();
    const stats: ResidentStats = { kills: 0, deaths: 0, yields: 0, greetings: 0, casts: 0, trades: 0, attempts: 0, trials: 0, walked: 0 };
    const state = { status: "joining" };
    const r: Resident = {
      name: m.name,
      role: m.role,
      home: m.home,
      bodies: o.bodies,
      agent,
      stats,
      log: (line) => o.log(`${m.name.padEnd(14)} ${line}`),
      alive: () => !stopping && (agent.status === "playing" || agent.status === "reconnecting" || agent.status === "joining"),
      async pause(ms) {
        const until = Date.now() + ms * (1 + rest);
        while (!stopping && Date.now() < until) await sleep(Math.min(250, until - Date.now()));
      },
      rng: seeded(m.name),
    };
    return { ...m, r, state };
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
      joined: members.filter((m) => m.state.status !== "joining" && !m.state.status.startsWith("refused")).length,
      seconds: Math.round(seconds),
      cpu: { seconds: Math.round(cpuS * 10) / 10, cores: Math.round((cpuS / Math.max(0.001, seconds)) * 1000) / 1000, budget: o.cpu, throttled },
      ended,
    };
  };

  async function play(m: (typeof members)[number]): Promise<void> {
    const { r } = m;
    try {
      const joined = await r.agent.connect({
        url: o.url,
        authUrl: o.authUrl,
        authOrigin: o.authOrigin,
        name: m.name,
        starter: m.starter,
        ...(o.dev ? { token: `dev:${residentId(m.name)}:${m.name}` } : { sessionFile: join(o.home ?? join(process.env.FL_AGENT_HOME ?? join(homedir(), ".firstlight", "agents"), "residents"), `${o.url.replace(/^https?:\/\//, "").replace(/[^A-Za-z0-9.-]+/g, "_")}-${m.name}.json`) }),
      });
      m.state.status = "playing";
      r.log(`joined ${r.agent.bodyId} as a ${m.role} (${joined.starter}), home ${m.home}`);
    } catch (e) {
      const code = e instanceof AgentError ? e.code : "join failed";
      m.state.status = `refused: ${code}`;
      r.log(`not let in: ${(e as Error).message}`);
      return;
    }
    for (let i = 0; i < 60 && r.agent.observe({ peek: true }).self.maxHp === 0; i++) await sleep(50);
    // A behaviour that throws is a bug, not a reason to take the others down: say so, rest, go on.
    while (r.alive()) {
      try {
        await BEHAVIOURS[m.role](r);
      } catch (e) {
        r.log(`stumbled: ${(e as Error).message}`);
        await r.pause(5000);
      }
      if (r.agent.status === "reconnecting") await r.pause(2000);
    }
    m.state.status = stopping ? "stopped" : r.agent.status;
  }

  const done = (async (): Promise<ResidentsReport> => {
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
      else if (members.every((m) => m.state.status !== "joining" && !m.r.alive())) (stopping = true), (ended = members.some((m) => m.state.status === "playing" || m.state.status === "offline") ? "stopped" : "nobody");
    }
    // Stop cleanly: end what each is doing, then leave the world (in a safe zone the body goes at
    // once; elsewhere the logout countdown takes about 10 s standing still).
    const final = report();
    await Promise.all(
      members.map(async (m) => {
        const a = m.r.agent;
        if (a.status !== "playing" && a.status !== "reconnecting") return void a.close().catch(() => {});
        await a.stop();
        const safe = a.status === "playing" && a.observe({ peek: true }).self.zone === "safe";
        await Promise.race([a.close({ logout: !safe }), sleep(16_000)]);
      }),
    );
    await Promise.race([Promise.all(plays), sleep(3000)]);
    const used = process.cpuUsage(cpu0);
    final.seconds = Math.round((Date.now() - t0) / 1000);
    final.cpu.seconds = Math.round((used.user + used.system) / 1e5) / 10;
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
    console.log("usage: node tools/agent/residents.ts [--url U] [--auth-url U] [--count 4] [--bodies portus,arcadia] [--roles hunter,wanderer,trader,chaser] [--seconds S] [--cpu 0.5] [--dev] [--quiet]");
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
    log,
  });
  let asked = 0;
  const onSignal = () => {
    if (asked++) process.exit(130); // a second Ctrl-C: now
    log("stopping: the residents are leaving (Ctrl-C again to quit at once)");
    run.stop();
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  const report = await run.done;
  console.log(`RESULT ${JSON.stringify(report)}`);
  process.exit(report.joined > 0 && report.residents.every((r) => r.corrections === 0) ? 0 : 1);
}

if (import.meta.main) void main();
