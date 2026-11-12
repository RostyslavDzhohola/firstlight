// A live play session: one headless, muted browser in the game that stays open while a model (or a
// person) plays it one command at a time with `e2e/live/fl.mjs` (live/README.md). The same stack,
// fixtures and Player as the journeys; every answer is short text a small model can read, and each
// command lands in $E2E_OUT/live/transcript.log with its time. The page is filmed (live/film.ts;
// FL_LIVE_VIDEO=0 turns that off) and frame times are sampled every 5 s; at the end the film becomes
// video.mp4 with a strip under the game showing each command, its answer and the driver's thinking time.

import type { Browser, Locator } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { availableParallelism, loadavg } from "node:os";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { measureBlinks, playAWhile } from "../blink.ts";
import { test } from "../fixtures.ts";
import { hitTrainingDummies, newEmail, saveWithEmail } from "../flows.ts";
import { Film } from "./film.ts";
import { STARTERS, wrap180, type FlEvent, type Npc, type Player, type Quest, type Snap, type StarterName, type Target } from "../player.ts";
import { OUT, TARGET } from "../stack.ts";

const PORT = Number(process.env.FL_LIVE_PORT ?? 7357);
const IDLE_MS = Number(process.env.FL_LIVE_IDLE_MIN ?? 20) * 60_000;
const DIR = path.join(OUT, "live");
const SHOTS = path.join(DIR, "shots");
const SESSION_FILE = path.join(DIR, "session.json");
const TRANSCRIPT = path.join(DIR, "transcript.log");
const PERF_LOG = path.join(DIR, "perf.jsonl");
const TRACE = path.join(DIR, "trace.log");
const VIDEO = process.env.FL_LIVE_VIDEO !== "0";
/** Who drives (a model's name), for the video's strip and the report. */
const DRIVER = process.env.FL_LIVE_DRIVER ?? "";

/** Commands that work before a game page is open. */
const OPENERS = new Set(["help", "home", "start", "dev", "quit", "errors", "eval", "shot", "wait", "note", "report"]);

/** One answered command (the transcript, the video strip). */
interface Entry {
  at: number;
  ms: number;
  ok: boolean;
  line: string;
  out: string;
}

/** Frame times over one 5 s window, with where the player was. */
interface PerfSample {
  at: number;
  body: string | null;
  playing: boolean;
  frames: number;
  p50: number;
  p95: number;
  max: number;
  over100: number;
  /** The machine's 1-minute load average then (other jobs slow the harness and the game). */
  load: number;
}

interface Command {
  usage: string;
  help: string;
  run(args: string[]): Promise<string>;
}

/** How a walk, aim or fight finds its target in each snapshot, and when it has arrived. */
interface Goal {
  label: string;
  pick(s: Snap): Target | null;
  arrived(s: Snap): boolean;
}

test("live session", async ({ player, page, consoleErrors, browser }) => {
  const startedAt = Date.now();
  mkdirSync(SHOTS, { recursive: true });
  writeFileSync(TRANSCRIPT, "");
  writeFileSync(PERF_LOG, "");
  writeFileSync(TRACE, "");
  const entries: Entry[] = [];
  const perf: PerfSample[] = [];
  // No ffmpeg (or no screencast) costs the film, never the session.
  let film = VIDEO ? new Film(page, path.join(DIR, "film.mp4")) : null;
  await film?.start().catch((e: unknown) => {
    console.log(`[live] no film: ${String((e as Error)?.message ?? e).slice(0, 200)}`);
    film = null;
  });
  const { commands, guardTick } = makeCommands(player, consoleErrors);
  commands.note = {
    usage: "note <text>",
    help: "write a finding into the transcript and the video strip (e.g. `note A5 fail: no waypoint on the minimap`)",
    run: async (args) => `noted: ${args.join(" ")}`,
  };
  commands.report = {
    usage: "report",
    help: "the session so far: time, commands, deaths, tutorial and missions, frame times per place, console errors",
    run: async () => sessionReport(entries, perf, (await page.evaluate(() => !!(window as { __fl?: unknown }).__fl).catch(() => false)) ? await player.snap() : null, consoleErrors.length, startedAt, deaths),
  };
  let shots = 0;
  commands.shot = {
    usage: "shot [name]",
    help: "screenshot (1280×720 PNG); prints its path for you to open",
    async run(args) {
      const file = path.join(SHOTS, `${String(++shots).padStart(2, "0")}-${(args.join("-") || "shot").replace(/[^a-z0-9-]+/gi, "-")}.png`);
      await page.screenshot({ path: file, timeout: 30_000 });
      return file;
    },
  };

  // `quit` and the idle timer only mark the session closing; it ends once the running command has
  // answered, and anything queued behind it is turned away.
  let closing = false;
  let quit: () => void = () => {};
  const done = new Promise<void>((resolve) => (quit = resolve));
  commands.quit = {
    usage: "quit",
    help: "end the session (closes the browser and the stack)",
    async run() {
      closing = true;
      return "bye";
    },
  };
  commands.help = {
    usage: "help",
    help: "this list",
    run: async () => `evidence: ${DIR} (transcript.log, shots/)\n${Object.values(commands).map((c) => `${c.usage.padEnd(28)} ${c.help}`).join("\n")}`,
  };

  // The idle clock runs only between commands: a slow `start` never times itself out.
  let idle: ReturnType<typeof setTimeout> | undefined;
  const armIdle = () => {
    clearTimeout(idle);
    idle = setTimeout(() => {
      closing = true;
      quit();
    }, IDLE_MS);
  };

  const handle = async (raw: string, res: ServerResponse) => {
    const reply = (status: number, text: string) => {
      res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
      res.end(text);
    };
    if (closing) return reply(503, "the session is closing");
    let msg: { cmd?: unknown; args?: unknown } = {};
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) msg = parsed;
    } catch {}
    const cmd = msg.cmd;
    const args = msg.args ?? [];
    if (typeof cmd !== "string" || !Array.isArray(args) || !args.every((a) => typeof a === "string")) return reply(400, 'bad request: send {"cmd": string, "args": string[]}');
    clearTimeout(idle);
    running = true;
    await guarding;
    const t0 = Date.now();
    let ok = true;
    let out: string;
    const c = commands[cmd];
    try {
      const needsGame = c && !OPENERS.has(cmd) && !(await page.evaluate(() => !!(window as { __fl?: unknown }).__fl).catch(() => false));
      if (needsGame) throw new Error("no game page is open yet: run `fl home` or `fl start <starter>` first");
      out = c ? await c.run(args) : `unknown command "${cmd}": try \`fl help\``;
      if (!c) ok = false;
    } catch (e) {
      ok = false;
      // Playwright colours its messages: strip the escapes, keep the first lines.
      out = `error: ${String((e as Error)?.message ?? e).replace(/\u001b\[[0-9;]*m/g, "").split("\n").filter(Boolean).slice(0, 3).join(" | ")}`;
    }
    // What changed since the last answer, the driver's thinking time included: the world doesn't wait.
    if (c && cmd !== "snap" && cmd !== "eval") {
      const now = await page.evaluate(() => !!(window as { __fl?: unknown }).__fl).catch(() => false) ? await player.snap().catch(() => null) : null;
      const guarded = summarize(guardNotes);
      guardNotes = [];
      if (now?.player?.dead && lastSnap && !lastSnap.player?.dead) deaths++;
      const delta = [now ? changes(lastSnap, now) : "", guarded && `the guard ${guarded} while you were thinking`].filter(Boolean).join(" · ");
      if (delta) out += `\nsince your last command: ${delta}`;
      lastSnap = now;
    }
    const ms = Date.now() - t0;
    const line = [cmd, ...args].join(" ");
    entries.push({ at: t0, ms, ok, line, out });
    appendFileSync(TRANSCRIPT, `${new Date(t0).toISOString()} ${String(ms).padStart(6)} ms ${ok ? "ok " : "ERR"} ${line} → ${out.split("\n")[0]!.slice(0, 160)}\n`);
    reply(ok ? 200 : 400, out);
    running = false;
    if (closing) quit();
    else armIdle();
  };

  let lastSnap: Snap | null = null;
  /** Deaths seen as alive → dead between answers (and at the end), not read from answer text. */
  let deaths = 0;

  // The guard: between commands the world keeps running while the driver thinks (seconds for a
  // model), so the harness keeps the character alive the way a player's hands would. Commands wait
  // for its beat to end; `guard off` stops it.
  let guardOn = TARGET !== "prod";
  let running = false;
  let guardActive = false;
  let guarding: Promise<unknown> = Promise.resolve();
  let guardNotes: string[] = [];
  const guardTimer = setInterval(() => {
    if (running || closing || !guardOn || guardActive) return;
    guardActive = true;
    guarding = guardTick()
      .then((note) => {
        if (note) guardNotes.push(note);
      })
      .catch(() => {})
      .finally(() => (guardActive = false));
  }, 200);
  commands.guard = {
    usage: "guard [on|off]",
    help: "between your commands the harness fights what comes within reach and drinks tonics (on by default; off on production)",
    async run([how]) {
      if (how === "on" || how === "off") {
        if (how === "on" && TARGET === "prod") throw new Error("the guard fights, and production play is read-only");
        guardOn = how === "on";
      }
      return `guard ${guardOn ? "on" : "off"}`;
    },
  };

  // Frame times every 5 s, whatever the driver is doing (the travel, the fights, the thinking).
  const sampler = setInterval(() => {
    void page
      .evaluate(() => {
        const fl = (window as any).__fl;
        if (!fl) return null;
        const f = fl.frames.stats(performance.now() - 5000);
        const s = fl.snapshot();
        return { body: s.body ?? null, playing: s.stage === "playing" && !s.loading, frames: f.frames, p50: f.p50, p95: f.p95, max: f.max, over100: f.over100 };
      })
      .then((r) => {
        if (!r || closing) return;
        const sample = { at: Date.now(), ...r, load: Math.round(loadavg()[0]! * 10) / 10 } as PerfSample;
        perf.push(sample);
        appendFileSync(PERF_LOG, JSON.stringify(sample) + "\n");
      })
      .catch(() => {});
  }, 5000);

  // One command at a time, in arrival order; a failed one never stalls the rest.
  let queue = Promise.resolve();
  const server = createServer((req, res) => {
    if (req.method !== "POST") {
      res.end(JSON.stringify({ ok: !closing, target: TARGET, gfx: player.gfx }));
      return;
    }
    void readBody(req).then((raw) => {
      queue = queue.then(() => handle(raw, res)).catch((e: unknown) => {
        if (!res.headersSent) res.writeHead(500).end(String(e));
      });
    });
  });
  try {
    await new Promise<void>((resolve, reject) => server.once("error", reject).listen(PORT, "127.0.0.1", resolve));
    writeFileSync(SESSION_FILE, JSON.stringify({ port: PORT, target: TARGET, gfx: player.gfx, baseURL: test.info().project.use.baseURL, out: DIR }, null, 2));
    console.log(`[live] session ready on 127.0.0.1:${PORT} (${TARGET}, ${player.gfx}); commands: e2e/live/fl.mjs help`);
    armIdle();
    await done;
  } finally {
    closing = true;
    clearTimeout(idle);
    clearInterval(sampler);
    clearInterval(guardTimer);
    await queue;
    await guarding;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeIdleConnections();
    });
    rmSync(SESSION_FILE, { force: true });
    // The last look before the page goes: a death since the last answer counts, and the report keeps
    // the final tutorial and mission state.
    const last = (await page.evaluate(() => !!(window as { __fl?: unknown }).__fl).catch(() => false)) ? await player.snap().catch(() => null) : null;
    const prev = lastSnap as Snap | null; // set by `handle`; flow analysis here only sees the null it started as
    if (last?.player?.dead && prev && !prev.player?.dead) deaths++;
    writeFileSync(path.join(DIR, "report.txt"), sessionReport(entries, perf, last, consoleErrors.length, startedAt, deaths) + "\n");
    if (film) {
      const f = film;
      const file = await f
        .stop()
        .then(() => finishVideo(f, browser, entries))
        .catch((e: unknown) => `failed: ${String((e as Error)?.message ?? e).slice(0, 300)}`);
      console.log(`[live] video: ${file}${f.cut ? ` (${f.cut})` : ""}`);
    }
  }
});

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let s = "";
    req.on("data", (c: Buffer) => (s += c.toString("utf8")));
    req.on("end", () => resolve(s));
  });
}

function makeCommands(player: Player, consoleErrors: string[]): { commands: Record<string, Command>; guardTick: () => Promise<string | null> } {
  const page = player.page;
  /** The macros' own decisions (walk, fight, quest), for working out why a run went wrong. */
  let traced = Date.now();
  const trace = (line: string) => {
    const now = Date.now();
    appendFileSync(TRACE, `${new Date(now).toISOString()} +${String(now - traced).padStart(5)} ms ${line}\n`);
    traced = now;
  };
  let identity: string | null = null;

  const once = (who: string) => {
    if (identity) throw new Error(`this session already plays as ${identity}: a session is one player (\`fl quit\`, then start a new session)`);
    identity = who;
  };
  /** Production play stays read-only, like `pnpm e2e:prod`: no attacks (other players there are real people), no saves, no dev guests. */
  const localOnly = (what: string) => {
    if (TARGET === "prod") throw new Error(`${what} works only on the local stack`);
  };
  /** Movement and looking only reach the game under pointer lock: take it first, and say so. */
  const ensureLock = async () => {
    if ((await player.snap()).input.pointerLocked) return "";
    await player.lock();
    return "(clicked into the world first: the pointer is now locked)\n";
  };

  const state = async () => describe(await player.snap(), await player.events(-Infinity));

  /** A target that is there now (an unavailable one is refused before anything moves). */
  const goal = (spec: string | undefined, s: Snap): Goal => {
    const g = anyGoal(spec, s);
    if (!g.pick(s)) throw new Error(`${g.label} isn't in view here`);
    return g;
  };
  const anyGoal = (spec: string | undefined, s: Snap): Goal => {
    const [kind = "", arg = ""] = (spec ?? "").split(":");
    const reach = (x: Snap) => (x.weapon?.delivery === "melee" ? 1.8 : Math.min((x.weapon?.range ?? 20) * 0.7, 18));
    const near = (surface: number) => (x: Target | null) => !!x && x.surface < surface;
    const byNpc = (id: string): Goal => ({
      label: `npc ${id}`,
      pick: (x) => x.npcs?.find((n) => n.id === id && !n.dead) ?? null,
      // Gone from the list (dead, or beyond the hook's nearest 40) is "lost", never "arrived".
      arrived: (x) => {
        const n = x.npcs?.find((m) => m.id === id && !m.dead);
        return !!n && n.dist <= reach(x);
      },
    });
    const nearest = <T extends Target>(list: T[] | undefined, ok: (t: T) => boolean = () => true) =>
      (list ?? []).map((t, i) => ({ t, i })).filter((x) => ok(x.t)).sort((a, b) => a.t.dist - b.t.dist)[0];
    switch (kind) {
      case "pad":
        return { label: "the pad", pick: (x) => x.pad ?? null, arrived: (x) => near(3)(x.pad ?? null) };
      case "guide":
        return { label: `the guide ${s.guide?.name ?? ""}`.trim(), pick: (x) => x.guide ?? null, arrived: (x) => near(2.5)(x.guide ?? null) };
      case "mission":
        return {
          label: s.mission?.title ? `the mission marker (${s.mission.title})` : "a mission marker",
          pick: (x) => (x.mission && typeof x.mission.surface === "number" ? (x.mission as Target) : null),
          arrived: (x) => typeof x.mission?.surface === "number" && x.mission.surface < 3,
        };
      case "gate": {
        const g = nearest(s.gates);
        if (!g) throw new Error("no gate here (gates exist in Portus and the walled outposts)");
        return { label: `gate ${g.i}`, pick: (x) => x.gates?.[g.i] ?? null, arrived: (x) => near(3)(x.gates?.[g.i] ?? null) };
      }
      case "dummy": {
        const d = nearest(s.dummies, (x) => !x.down);
        if (!d) throw new Error("no standing training dummy in view");
        const standing = (x: Snap) => (x.dummies?.[d.i] && !x.dummies[d.i]!.down ? x.dummies[d.i]! : null);
        return { label: `dummy ${d.i}`, pick: standing, arrived: (x) => (standing(x)?.dist ?? Infinity) <= reach(x) };
      }
      case "hostile": {
        const n = nearest(s.npcs, (x: Npc) => x.hostile && !x.dead);
        if (!n) throw new Error("no live hostile in view");
        return { ...byNpc(n.t.id), label: `${n.t.name ?? n.t.kind} ${n.t.id}` };
      }
      case "npc": {
        const q = arg.toLowerCase();
        const n = nearest(s.npcs, (x: Npc) => !x.dead && (x.id === arg || x.kind.toLowerCase() === q || (x.name ?? "").toLowerCase().includes(q)));
        if (!n) throw new Error(`no live npc matching "${arg}" in view`);
        return { ...byNpc(n.t.id), label: `${n.t.name ?? n.t.kind} ${n.t.id}` };
      }
      case "player": {
        const q = arg.toLowerCase();
        const p = s.players?.find((x) => x.id === arg || x.name.toLowerCase().includes(q));
        if (!p) throw new Error(`no player matching "${arg}" in this copy`);
        return { label: `player ${p.name}`, pick: (x) => x.players?.find((o) => o.id === p.id) ?? null, arrived: (x) => near(3)(x.players?.find((o) => o.id === p.id) ?? null) };
      }
      default:
        throw new Error(`unknown target "${spec ?? ""}": pad, guide, mission, gate, dummy, hostile, npc:<id|kind|name>, player:<name>`);
    }
  };

  /**
   * One beat of a fight with `foe` (`fight`, `quest`): go round a wall, close in, side-step anyone in
   * the line of fire, back off point blank, aim, and click only when it will land. True when it attacked.
   */
  let lastRoll = 0;
  const fightBeat = async (s: Snap, foe: Npc): Promise<boolean> => {
    trace(`beat: ${foe.name ?? foe.kind} ${foe.id} ${n0(foe.dist)} m ${n0(foe.bearing)}° · HP ${n0(s.player?.hp)}`);
    const g = goal(`npc:${foe.id}`, s);
    // Walls stop shots (D43): from behind one, go round it toward the foe one step at a time.
    const line = (await player.clearance([foe.bearing], foe.surface))?.[0]?.clear ?? foe.surface;
    if (line < foe.surface - 1.5) {
      const go = await player.steer(foe.bearing, Math.min(4, foe.surface), s);
      if (Math.abs(go.bearing) > 8) await player.turn(go.bearing);
      await player.hold(["KeyW"], 600);
      return false;
    }
    if (!g.arrived(s)) {
      await player.walkTo(g.pick, g.arrived, { timeoutMs: 5000 });
      return false;
    }
    // Outside safe zones a hit on a player is PvP, and on production they are real people.
    const near = playerInHarmsWay(s, foe);
    if (near) {
      await player.hold([wrap180(near.bearing - foe.bearing) > 0 ? "KeyA" : "KeyD"], 600);
      return false;
    }
    // Ranged: keep every hostile at 5 m or more. Point blank a bolt misses a creature at our feet,
    // and a pack of Hopbits keeps up with a backpedal (two dry runs died without landing a shot).
    // Turn away from the pack and sprint (9 m/s against their 4), or roll back 4.5 m when one is on
    // top of us and the roll is ready, then turn back and shoot from range.
    if (s.weapon?.delivery !== "melee") {
      const close = (s.npcs ?? []).filter((n) => n.hostile && !n.dead && n.dist < 5);
      if (close.length) {
        const rad = (d: number) => (d * Math.PI) / 180;
        const pack = (Math.atan2(close.reduce((a, n) => a + Math.sin(rad(n.bearing)), 0), close.reduce((a, n) => a + Math.cos(rad(n.bearing)), 0)) * 180) / Math.PI;
        if (close.some((n) => n.dist < 2.5) && Date.now() - lastRoll > 1300) {
          trace(`kite: roll back from ${close.length} at ${close.map((n) => n0(n.dist)).join("/")} m`);
          if (Math.abs(pack) > 10) await player.turn(pack);
          await page.keyboard.down("KeyS");
          await player.hold(["KeyC"], 60);
          await page.waitForTimeout(350);
          await page.keyboard.up("KeyS");
          lastRoll = Date.now();
        } else {
          trace(`kite: sprint away from ${close.length} at ${close.map((n) => n0(n.dist)).join("/")} m`);
          await player.turn(wrap180(pack + 180));
          await player.hold(["ShiftLeft", "KeyW"], 1400);
          await player.turn(180);
        }
        return false;
      }
    }
    // A bolt: one exact mouse move onto it and a frame for the camera to follow (a hopping creature
    // moves between the looks of Player.aim). A swing: turn to face it.
    const melee = s.weapon?.delivery === "melee";
    if (melee) await player.aim(g.pick);
    else if (!(await player.aimOnce(foe))) {
      await player.turn(foe.bearing);
      return false;
    } else await page.waitForTimeout(40);
    // Click only when it will land: a shot needs the crosshair on the foe; a swing sweeps an arc, so
    // facing it within 20° is enough.
    const aimed = await player.snap();
    const still = aimed.npcs?.find((n) => n.id === foe.id && !n.dead);
    // A bolt's tolerance is the target's own size at that range (a Hopbit is 0.9 m), never looser than 4.5°.
    const size = Math.min(0.08, Math.max(0.015, ((still?.height ?? 0.9) * 0.4) / Math.max(1, still?.dist ?? 1)));
    const onTarget =
      !!still && still.aimYaw !== null && still.aimPitch !== null && (melee ? Math.abs(still.aimYaw) < 0.35 : Math.abs(still.aimYaw) < size && Math.abs(still.aimPitch) < Math.max(0.02, size));
    if (!still || !onTarget || playerInHarmsWay(aimed, still)) {
      trace(`hold fire: ${!still ? "foe gone" : !onTarget ? `off target yaw ${still.aimYaw} pitch ${still.aimPitch} (tolerance ${size.toFixed(3)}) at ${n0(still.dist)} m` : "a player near the line"}`);
      return false;
    }
    trace(`fire at ${foe.name ?? foe.kind} ${foe.id} ${n0(still.dist)} m (HP ${n0(still.hp)})`);
    await player.attack();
    await page.waitForTimeout(450);
    return true;
  };

  const walkOut = async () => {
    const s = await player.snap();
    if (s.zone?.local === "danger" && (s.zone.toSafe ?? 0) > 2) return "already outside the safe zone";
    await (s.zone?.kind === "town" ? player.walkOutOfTown() : player.walkOutOfRing());
    return "walked out of the safe zone";
  };

  const commands: Record<string, Command> = {
    home: {
      usage: "home [flag[=value] …]",
      help: "open the site's first page (/?e2e plus flags such as autoplay or tier=high); prints the screen",
      async run(args) {
        await player.open(Object.fromEntries(args.map((a) => (a.includes("=") ? a.split(/=(.*)/s).slice(0, 2) : [a, true])) as [string, string | true][]));
        await page.waitForTimeout(800);
        return screen(page);
      },
    },
    start: {
      usage: "start <starter> [name]",
      help: "a new guest the real way: Play → pick hexwick|ash|kappa|unit7 → name → Play as; waits for the world",
      async run([who, name]) {
        const starter = pickStarter(who);
        once(`guest ${starter}`);
        const t = await player.playAsNewGuest({ starter, name });
        await player.waitInWorld();
        return `in the world ${((Date.now() - t.playAsAt) / 1000).toFixed(1)} s after "Play as ${starter}"\n${await state()}`;
      },
    },
    dev: {
      usage: "dev <body> [starter]",
      help: "local only: a dev admin guest placed straight on portus|arcadia|hollowmere|meridian (admin commands work)",
      async run([body = "arcadia", who = "hexwick"]) {
        localOnly("dev");
        const starter = pickStarter(who);
        once(`dev admin ${starter}`);
        await player.joinAsDevAdmin({ starter, body });
        await player.waitInWorld(90_000, body);
        return state();
      },
    },
    world: {
      usage: "world",
      help: "wait until the loading screen is gone and the player is in the world (after home autoplay, a portal, a rejoin)",
      async run() {
        await player.waitInWorld();
        return state();
      },
    },
    state: { usage: "state", help: "what the game knows right now: zone, you, weapon, creatures, guide, portals, menus, toasts", run: state },
    snap: {
      usage: "snap [field]",
      help: "the raw __fl.snapshot() JSON, or one field of it (npcs, zone, ui, onboarding…)",
      async run([field]) {
        const s = (await player.snap()) as unknown as Record<string, unknown>;
        if (field && !(field in s)) throw new Error(`no field "${field}": ${Object.keys(s).join(", ")}`);
        return JSON.stringify(field ? s[field] : s).slice(0, 6000);
      },
    },
    screen: { usage: "screen", help: "the text a player can read on the page and every visible button or field", run: () => screen(page) },
    click: {
      usage: "click <text>",
      help: "click the visible button, menu item, link or text that matches",
      async run(args) {
        const re = new RegExp(args.join(" ").replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
        for (const l of [page.getByRole("button", { name: re }), page.getByRole("menuitem", { name: re }), page.getByRole("link", { name: re }), page.getByText(re)]) {
          const hit = l.filter({ visible: true }).first();
          if (!(await hit.count())) continue;
          const label = ((await hit.innerText().catch(() => "")) || re.source).trim().replace(/\s+/g, " ").slice(0, 60);
          const cover = await coveredBy(hit);
          if (cover) throw new Error(`"${label}" is under ${cover}: deal with that first (\`fl screen\` marks covered controls)`);
          await hit.click({ timeout: 5000 });
          await page.waitForTimeout(400);
          return `clicked "${label}"\n${brief(await player.snap())}`;
        }
        throw new Error(`nothing visible matches "${args.join(" ")}" (\`fl screen\` lists the buttons)`);
      },
    },
    clickxy: {
      usage: "clickxy <x> <y> [right]",
      help: "click a page point (1280×720 viewport), e.g. a spot on the map; `right` for a right-click",
      async run([x, y, b]) {
        await player.clickAt(Number(x), Number(y), b === "right" ? "right" : "left");
        await page.waitForTimeout(400);
        return brief(await player.snap());
      },
    },
    fill: {
      usage: "fill <label> <text…>",
      help: "type into the visible field whose label, placeholder or name matches",
      async run([label = "", ...text]) {
        const re = new RegExp(label, "i");
        for (const l of [page.getByLabel(re), page.getByPlaceholder(re), page.locator(`input[name*="${label}" i], input[type="${label}" i]`)]) {
          const hit = l.filter({ visible: true }).first();
          if (!(await hit.count())) continue;
          await hit.fill(text.join(" "));
          return `filled "${label}"`;
        }
        throw new Error(`no visible field matches "${label}"`);
      },
    },
    lock: {
      usage: "lock",
      help: "click into the world until the pointer is locked (mouse look, keys and attacks need it)",
      async run() {
        try {
          await player.lock();
        } catch {
          const s = await player.snap();
          throw new Error(`couldn't lock the pointer: clicking the world didn't take it${s.player?.dead ? " (you're dead: rise first)" : ""} · ${brief(s)}`);
        }
        return brief(await player.snap());
      },
    },
    esc: {
      usage: "esc",
      help: "Esc the way desktop Chrome does it (releases the lock / opens or closes the menu)",
      async run() {
        const before = await player.snap();
        const menuWasOpen = before.ui.visibleE2e.includes("pause-menu");
        await player.escape();
        await page.waitForTimeout(300);
        const s = await player.snap();
        if (brief(s) === brief(before)) return `${brief(s)}\n(the one-line status is the same as before Esc: \`fl screen\` shows what is in front)`;
        // J5.1: a desktop browser shows "Click to look around" here; headless Chrome lets the page re-lock at once.
        const note = menuWasOpen && s.input.pointerLocked ? "\n(the game took the pointer back by itself: headless Chrome allows that without a click, so the \"Click to look around\" hint never shows here)" : "";
        return brief(s) + note;
      },
    },
    key: {
      usage: "key <keys> [ms]",
      help: "tap a key (E, M, C, Space, Tab, 1…) or hold keys for ms: `key W 2000`, `key Shift+W 1500`",
      async run([spec = "", ms]) {
        const keys = spec.split("+").map(keyCode);
        if (keys.length === 1 && keys[0] === "Escape") return commands.esc!.run([]);
        const warn = (await player.snap()).input.pointerLocked ? "" : "(the pointer isn't locked: the game ignores game keys until `fl lock`)\n";
        if (ms) await player.hold(keys, Number(ms));
        else if (keys.length > 1) await player.hold(keys, 120);
        else await player.tap(keys[0]!);
        await page.waitForTimeout(250);
        return warn + brief(await player.snap());
      },
    },
    turn: {
      usage: "turn <deg>",
      help: "turn the camera right (negative: left) with the mouse",
      async run([d]) {
        const pre = await ensureLock();
        await player.turn(Number(d));
        return pre + brief(await player.snap());
      },
    },
    pitch: {
      usage: "pitch <deg>",
      help: "look up (negative: down)",
      async run([d]) {
        const pre = await ensureLock();
        await player.lookUp((Number(d) * Math.PI) / 180);
        return pre + brief(await player.snap());
      },
    },
    walk: {
      usage: "walk <target> [sec]",
      help: "walk there steering round walls: pad, guide, mission, gate, dummy, hostile, npc:<id|kind|name>, player:<name> (default 30 s)",
      async run([spec, sec = "30"]) {
        const pre = await ensureLock();
        const g = goal(spec, await player.snap());
        const ok = await player.walkTo(g.pick, g.arrived, { timeoutMs: Number(sec) * 1000 });
        const lost = !ok && !g.pick(await player.snap());
        return `${pre}${ok ? "arrived at" : lost ? "lost sight of" : `did not reach (${sec} s)`} ${g.label}\n${await state()}`;
      },
    },
    out: { usage: "out", help: "walk out of the town or the pad's safe ring through the nearest gate, into the wild", run: async () => `${await ensureLock()}${await walkOut()}\n${await state()}` },
    portal: {
      usage: "portal <body>",
      help: "walk into the plaza portal to arcadia|hollowmere|meridian|portus and wait for the arrival",
      async run([to = ""]) {
        const pre = await ensureLock();
        const t0 = Date.now();
        await player.walkThroughPortal(to);
        return `${pre}arrived on ${to} ${((Date.now() - t0) / 1000).toFixed(1)} s after setting off\n${await state()}`;
      },
    },
    aim: {
      usage: "aim <target>",
      help: "put a target under the crosshair (same targets as walk)",
      async run([spec]) {
        const pre = await ensureLock();
        const g = goal(spec, await player.snap());
        const ok = await player.aim(g.pick);
        return `${pre}${ok ? "aimed at" : "couldn't aim at"} ${g.label}\n${brief(await player.snap())}`;
      },
    },
    attack: {
      usage: "attack [n]",
      help: "local only: left-click n times (default 1) and report what the server said",
      async run([n = "1"]) {
        localOnly("attack");
        const pre = await ensureLock();
        const since = await player.now();
        for (let i = 0; i < Number(n); i++) {
          await player.attack();
          await page.waitForTimeout(450);
        }
        const r = await player.attackResult(since, 1200);
        const training = r.sent.length > 0 && r.sent.every((m) => m === "train") ? " (a training swing: weapons are holstered here and only a training dummy answers it)" : "";
        return `${pre}sent ${r.sent.join(",") || "nothing"}${training} · server ${r.accepted ? "accepted" : "did not echo"} the attack · denied ${r.denied.join(",") || "none"}${r.toasts.length ? ` · toasts ${r.toasts.map((t) => `"${t}"`).join(" ")}` : ""}\n${brief(await player.snap())}`;
      },
    },
    cast: {
      usage: "cast <spell> [target]",
      help: "local only: cast skipstep|frostbloom|wishfall|glasswing (or its key: Q F X Z) with its real key, aimed at a target first if given (same targets as walk); reports what the server said",
      async run([spell = "", spec]) {
        localOnly("cast");
        const want = spell.toLowerCase();
        const slots = (await player.snap()).spells?.slots ?? [];
        const slot = slots.find((x) => want && (x.id === want || x.key.toLowerCase() === want || x.name.toLowerCase().startsWith(want)));
        if (!slot) throw new Error(`no spell "${spell}": ${slots.map((x) => `${x.id} (${x.key})`).join(", ") || "the spellbook isn't up yet"}`);
        const pre = await ensureLock();
        let aimed = "";
        if (spec) {
          const g = goal(spec, await player.snap());
          aimed = (await player.aim(g.pick)) ? ` at ${g.label}` : ` (couldn't aim at ${g.label})`;
        }
        const since = await player.now();
        await player.tap(`Key${slot.key}`);
        // Wishfall lands after its warning; the others answer within a round trip.
        await page.waitForTimeout(slot.id === "wishfall" ? 1900 : 600);
        const ev = await player.events(since);
        const sent = ev.some((e) => e.kind === "out" && e.type === "cast");
        const denied = ev.filter((e) => e.kind === "in" && e.type === "denied").map((e) => `${e.action}:${e.reason}`);
        const seen = ev.filter((e) => e.kind === "in" && e.type === "spell" && e.mine).map((e) => `${e.spell} ${e.phase}${typeof e.hits === "number" ? ` (slowed ${e.hits})` : ""}`);
        const hits = ev.filter((e) => e.kind === "in" && e.type === "hit" && e.mine).map((e) => String(e.amount));
        const toasts = ev.filter((e) => e.kind === "toast").map((e) => `"${String(e.text ?? "").trim()}"`);
        const s = await player.snap();
        return `${pre}${slot.name}${aimed}: ${sent ? "cast sent" : "nothing sent (the client held it back)"} · server ${seen.join(", ") || "sent no spell event"} · denied ${denied.join(",") || "none"}${hits.length ? ` · hits ${hits.join(", ")}` : ""}${toasts.length ? ` · toasts ${toasts.join(" ")}` : ""}\n${spellLine(s)}\n${brief(s)}`;
      },
    },
    fight: {
      usage: "fight [sec]",
      help: "local only: find the nearest hostile, close in, aim and attack until it pays XP, you die, or sec pass (default 60)",
      async run([sec = "60"]) {
        localOnly("fight");
        const pre = await ensureLock();
        const until = Date.now() + Number(sec) * 1000;
        const s0 = await player.snap();
        const xp0 = s0.you?.xp ?? 0;
        const level0 = s0.you?.level ?? 1;
        let shots = 0;
        const foes = new Set<string>();
        while (Date.now() < until) {
          const s = await player.snap();
          if ((s.you?.xp ?? 0) > xp0 || (s.you?.level ?? 1) > level0 || s.player?.dead) break;
          if (s.player?.swimming) {
            await player.turn(180);
            await player.hold(["KeyW"], 1000);
            continue;
          }
          if (s.zone?.server === "safe") {
            await walkOut();
            continue;
          }
          const foe = (s.npcs ?? []).filter((n) => n.hostile && !n.dead && n.dist < 60).sort((a, b) => a.dist - b.dist)[0];
          if (!foe) {
            const go = await player.steer(0, 6, s);
            if (Math.abs(go.bearing) > 8) await player.turn(go.bearing);
            await player.hold(["ShiftLeft", "KeyW"], 800);
            continue;
          }
          foes.add(foe.name ?? foe.kind);
          if (await fightBeat(s, foe)) shots++;
        }
        const s = await player.snap();
        const gained = (s.you?.xp ?? 0) - xp0;
        const verdict = s.player?.dead ? "you died" : (s.you?.level ?? 1) > level0 ? `level up to ${s.you?.level}` : gained > 0 ? `killed it: +${gained} XP` : "no kill in time";
        return `${pre}${verdict} · ${shots} attacks · fought ${[...foes].join(", ") || "nothing (no hostile found)"}\n${await state()}`;
      },
    },
    dodge: {
      usage: "dodge [run]",
      help: "press C (standing, or `run`: while sprinting) and time key → roll from the page's own event log",
      async run([how]) {
        const pre = await ensureLock();
        const running = how === "run";
        if (running) {
          await page.keyboard.down("ShiftLeft");
          await page.keyboard.down("KeyW");
          await page.waitForTimeout(700);
        }
        const since = await player.now();
        await player.hold(["KeyC"], 60);
        await page.waitForTimeout(900);
        if (running) {
          await page.keyboard.up("KeyW");
          await page.keyboard.up("ShiftLeft");
        }
        // As J5.3 measures it: the C keydown, then the controller's dodge state (anim 7) and the avatar's roll clip.
        const ev = await player.events(since);
        const key = ev.find((e) => e.kind === "key" && e.code === "KeyC");
        if (!key) return `${pre}the page never saw C`;
        const anim = ev.find((e) => e.kind === "anim" && e.to === 7 && e.t >= key.t);
        const clip = ev.find((e) => e.kind === "clip" && /dodge|roll/i.test(String(e.name)) && e.t >= key.t);
        const corrected = ev.some((e) => e.kind === "in" && e.type === "correct" && e.t - key.t < 800);
        const ms = clip ? clip.t - key.t : anim ? anim.t - key.t : null;
        const verdict =
          ms === null ? "FAIL: no roll started" : corrected ? `FAIL: the roll started ${Math.round(ms)} ms after C, then the server snapped it back` : ms < 100 ? `pass: the roll started ${Math.round(ms)} ms after C` : `FAIL: the roll started ${Math.round(ms)} ms after C (over 100 ms)`;
        return `${pre}${verdict}${running ? " (sprinting)" : " (standing)"} · wait 1.2 s before the next dodge (cooldown)\n${brief(await player.snap())}`;
      },
    },
    train: { usage: "train", help: "hit the tutorial's three training dummies until they pay level 2", run: async () => `${await ensureLock()}level ${await hitTrainingDummies(player)} after the dummies\n${await state()}` },
    save: {
      usage: "save [email]",
      help: "local only: Esc → Save progress with an email code from the dev mail log (trains to level 2 first)",
      async run([email = newEmail("live")]) {
        localOnly("save");
        await saveWithEmail(player, email);
        return `saved as ${email}\n${await state()}`;
      },
    },
    blink: {
      usage: "blink",
      help: "walk and look around ~12 s with the blink probe on: frame stalls, flashes, HUD flicker",
      async run() {
        await ensureLock();
        const r = await measureBlinks(player, () => playAWhile(player));
        const f = r.frames;
        const bad = [r.probe.flashes.length && `${r.probe.flashes.length} flash(es)`, r.probe.flaps.length && `${r.probe.flaps.length} HUD flicker(s)`, f.over250 && `${f.over250} frame(s) over 250 ms`, f.over100 > 2 && `${f.over100} frames over 100 ms`].filter(Boolean);
        const blind = r.probe.samples <= 50 || r.probe.errors > 0;
        const verdict = bad.length ? `FAIL: ${bad.join(", ")}` : blind ? `inconclusive: the probe read ${r.probe.samples} picture samples with ${r.probe.errors} errors (needs over 50, none failed)` : "pass: no blinking";
        return `${verdict} · ${f.frames} frames p50 ${f.p50.toFixed(1)} ms p95 ${f.p95.toFixed(1)} ms max ${f.max.toFixed(0)} ms · luma samples ${r.probe.samples}`;
      },
    },
    perf: {
      usage: "perf [sec]",
      help: "frame times over the next sec (default 5) as things are",
      async run([sec = "5"]) {
        const t0 = await player.now();
        await page.waitForTimeout(Number(sec) * 1000);
        const f = (await page.evaluate((t) => (window as any).__fl.frames.stats(t), t0)) as { frames: number; p50: number; p95: number; max: number; over100: number };
        return `${(f.frames / Number(sec)).toFixed(0)} fps · p50 ${f.p50.toFixed(1)} ms · p95 ${f.p95.toFixed(1)} ms · max ${f.max.toFixed(0)} ms · ${f.over100} frames over 100 ms`;
      },
    },
    events: {
      usage: "events [n]",
      help: "the last n (default 15) things that happened: toasts, server replies, refusals, travel, loading",
      async run([n = "15"]) {
        const ev = await player.events();
        const now = await player.now();
        // The server's toast message shows up again as the DOM toast: keep the DOM one.
        const keep = ev.filter((e) => ["toast", "in", "body", "loading", "room", "lock"].includes(e.kind) && !(e.kind === "in" && e.type === "toast"));
        return keep.slice(-Number(n)).map((e) => `${(((e.t - now) / 1000).toFixed(1) + " s").padStart(8)} ${eventLine(e)}`).join("\n") || "nothing yet";
      },
    },
    errors: {
      usage: "errors",
      help: "console errors and uncaught page errors so far",
      run: async () => (consoleErrors.length ? `${consoleErrors.length} error(s):\n${consoleErrors.slice(-10).join("\n")}` : "no console errors"),
    },
    eval: {
      usage: "eval <js expression>",
      help: "evaluate in the page (window.__fl, document…); prints JSON. Prefer the commands above",
      async run(args) {
        const v = await page.evaluate(args.join(" "));
        return JSON.stringify(v ?? null).slice(0, 4000);
      },
    },
    wait: {
      usage: "wait <ms>",
      help: "let the game run (up to 60 s)",
      async run([ms = "1000"]) {
        await page.waitForTimeout(Math.min(Number(ms), 60_000));
        return (await page.evaluate(() => !!(window as { __fl?: unknown }).__fl)) ? brief(await player.snap()) : "waited";
      },
    },
  };

  // ------------------------------------------------------------------------------ the first part
  // FIRSTLIGHT's opening as macros a model chains: the tutorial in Portus (`step`, `tutorial`), the
  // portal to Arcadia, Lark's three missions (`talk`, `quest`) and getting up again (`rise`). Each does
  // a whole beat with real input at the harness's pace and answers what it saw.

  /**
   * The bearing to walk toward `want` that keeps 55 m from any boss (Arcadia's Tidewrath slams 70 HP
   * along 40 m from its lake; two killed a level-3 dry run on its way to Gull Point): go along the
   * tangent of that circle when the straight line would cross it, straight out when inside it.
   */
  const SHUN = 55;
  const shunBosses = (s: Snap, want: number, toGoal: number): number => {
    const boss = (s.bosses ?? []).filter((b) => !b.dead && b.surface < SHUN + 40).sort((a, b) => a.surface - b.surface)[0];
    if (!boss || toGoal < boss.surface - SHUN) return want;
    const off = wrap180(want - boss.bearing);
    const side = off >= 0 ? 1 : -1;
    if (boss.surface <= SHUN) return wrap180(boss.bearing + side * 130);
    const tangent = (Math.asin(SHUN / boss.surface) * 180) / Math.PI;
    if (Math.abs(off) >= tangent) return want;
    return wrap180(boss.bearing + side * (tangent + 5));
  };

  /** Hold Shift+W and steer as we go (no stop to turn) until `arrived`, `stop` names a reason, or time runs out. */
  const cruise = async (pick: (s: Snap) => Target | null, arrived: (s: Snap) => boolean, opts: { timeoutMs: number; avoidPortal?: boolean; stop?: (s: Snap) => string | null }): Promise<string> => {
    const until = Date.now() + opts.timeoutMs;
    const keys = ["ShiftLeft", "KeyW"];
    let down = false;
    const press = async (on: boolean) => {
      if (on === down) return;
      down = on;
      for (const k of on ? keys : [...keys].reverse()) await (on ? page.keyboard.down(k) : page.keyboard.up(k));
    };
    const trail: { at: number; pos: number[] }[] = [];
    let side = "KeyD";
    let shunning = false;
    const t0 = Date.now();
    const end = (why: string) => {
      trace(`walk: ${why} after ${((Date.now() - t0) / 1000).toFixed(1)} s`);
      return why;
    };
    try {
      while (Date.now() < until) {
        const s = await player.snap();
        if (arrived(s)) return end("arrived");
        const why = opts.stop?.(s);
        if (why) return end(why);
        const t = pick(s);
        if (!t) return end("lost sight of it");
        if (s.player?.dead) return end("died");
        const want = shunBosses(s, t.bearing, t.surface);
        if ((want !== t.bearing) !== shunning) {
          shunning = want !== t.bearing;
          trace(shunning ? `walk: going round a boss (bearing ${n0(want)}° instead of ${n0(t.bearing)}°)` : "walk: past the boss, straight on");
        }
        const go = await player.steer(want, Math.min(4, t.surface + 0.5), s, opts.avoidPortal ?? true);
        if (Math.abs(go.bearing) > 70) await press(false); // a sharp turn: stop, turn, go on
        if (Math.abs(go.bearing) > 3) await player.turn(go.bearing);
        if (t.surface < 5) {
          // Close: walk in short steps so we don't run past it.
          await press(false);
          await player.hold(["KeyW"], Math.max(120, Math.min(600, (t.surface / 4) * 1000)));
          continue;
        }
        await press(true);
        await page.waitForTimeout(90);
        const now = Date.now();
        trail.push({ at: now, pos: s.player!.pos });
        while (trail.length > 1 && trail[0]!.at < now - 2500) trail.shift();
        const a = trail[0]!;
        const p = s.player!.pos;
        if (now - a.at > 2000 && Math.hypot(a.pos[0]! - p[0]!, a.pos[1]! - p[1]!, a.pos[2]! - p[2]!) < 1.5) {
          // Stuck (a slope, a creature, a corner the rays missed): back off, side-step, hop.
          trace(`walk: stuck at ${p.map((v) => v.toFixed(0)).join(",")}, side-stepping`);
          await press(false);
          await player.hold(["KeyS"], 400);
          await player.hold([side], 900);
          await player.hold([side, "KeyW"], 700);
          await player.tap("Space");
          side = side === "KeyD" ? "KeyA" : "KeyD";
          trail.length = 0;
        }
      }
      return end(arrived(await player.snap()) ? "arrived" : "ran out of time");
    } finally {
      await press(false);
    }
  };

  /** A tonic heals over 3 s and then cools down for 8 (weapons.ts): one per 8.5 s. */
  let drankAt = 0;
  const tonicReady = (s: Snap) => Date.now() - drankAt > 8500 && (s.hotbar ?? []).some((h) => !!h && /tonic/.test(h.id));
  const hpShare = (s: Snap) => (s.player?.hp ?? 0) / (s.player?.maxHp || 100);

  /** Below 45% HP with a tonic ready: drink it (select its slot, click, back to the weapon). */
  const drink = async (s: Snap): Promise<string | null> => {
    const hp = s.player?.hp ?? 0;
    if (hpShare(s) >= 0.45 || s.player?.dead || !tonicReady(s)) return null;
    const slot = (s.hotbar ?? []).findIndex((h) => !!h && /tonic/.test(h.id));
    if (slot < 0) return null;
    drankAt = Date.now();
    const back = s.weapon?.slot ?? 0;
    await player.tap(`Digit${slot + 1}`);
    await page.waitForTimeout(250);
    await player.attack();
    await page.waitForTimeout(500);
    await player.tap(`Digit${back + 1}`);
    await page.waitForTimeout(250);
    return `drank a ${s.hotbar![slot]!.id.replace(/_/g, " ")} at HP ${n0(hp)}`;
  };

  /**
   * The hunt's prey: the live creature the mission pointer is on (the server says which kills count).
   * The pointer's title reads "Hopbit · 36 m" and its spot is the creature's feet, so match by name and
   * by where it is.
   */
  const pointedAt = (s: Snap): Npc | undefined => {
    const m = s.mission;
    if (!m?.creep || typeof m.surface !== "number" || typeof m.bearing !== "number") return undefined;
    const name = m.title.split(" · ")[0]!.trim();
    const off = (n: Npc) => Math.abs(n.surface - m.surface!) + Math.abs(wrap180(n.bearing - m.bearing!)) / 10;
    return (s.npcs ?? []).filter((n) => !n.dead && (n.name === name || n.kind === name.toLowerCase()) && off(n) < 6).sort((a, b) => off(a) - off(b))[0];
  };

  /**
   * A hostile close enough to be a fight already (it comes before any errand: dying resets missions).
   * A ranged starter takes it on from 15 m, before it reaches point blank.
   */
  const threat = (s: Snap) => {
    const r = s.weapon?.delivery === "melee" ? 8 : 15;
    // Never a boss: that is a raid for a group, not something to pick a fight with on the way.
    return (s.npcs ?? []).filter((n) => n.hostile && !n.dead && n.tier !== "boss" && n.dist < r).sort((a, b) => a.dist - b.dist)[0];
  };

  /**
   * Out of tonics (or waiting on one) below half HP with something hostile near: run for the pad's safe
   * ring instead of fighting on (nothing heals but tonics and level-ups, and dying resets every
   * mission). What happened, or null when there was no need.
   */
  const retreat = async (s: Snap): Promise<string | null> => {
    if (hpShare(s) >= 0.5 || tonicReady(s) || s.zone?.server === "safe" || !s.pad) return null;
    if (!(s.npcs ?? []).some((n) => n.hostile && !n.dead && n.dist < 25)) return null;
    trace(`retreat: HP ${n0(s.player?.hp)}, no tonic ready, running for the pad ${where(s.pad)}`);
    const how = await cruise((x) => x.pad ?? null, (x) => x.zone?.server === "safe" || !(x.npcs ?? []).some((n) => n.hostile && !n.dead && n.dist < 30), { timeoutMs: 25_000, avoidPortal: true });
    return `ran for safety at HP ${n0(s.player?.hp)} (${how})`;
  };

  const cardText = () => page.evaluate(() => (document.querySelector<HTMLElement>(".fl-onb__step")?.innerText ?? "").replace(/\s+/g, " ").trim());

  /**
   * A heading (degrees from the camera) for a straight run of `len` metres that stays clear of walls
   * and passes no portal ring: Player.steer only sees rings within 10 m, and a 2.6 s sprint is 23 m
   * (a dry run sprinted the tutorial straight into the Hollowmere portal).
   */
  const openHeading = async (len: number): Promise<number> => {
    const s = await player.snap();
    const cands = Array.from({ length: 12 }, (_, i) => wrap180(i * 30));
    const clear = (await player.clearance(cands, len)) ?? cands.map((b) => ({ bearing: b, clear: len }));
    const rad = (d: number) => (d * Math.PI) / 180;
    const pastPortal = (b: number) =>
      (s.portals ?? []).some((p) => {
        const off = rad(wrap180(p.bearing - b));
        const along = p.surface * Math.cos(off);
        return along > -3 && along < len + 6 && Math.abs(p.surface * Math.sin(off)) < 7;
      });
    const ok = clear.filter((c) => c.clear >= len - 0.5 && !pastPortal(c.bearing)).sort((a, b) => Math.abs(a.bearing) - Math.abs(b.bearing));
    trace(`tutorial: ${ok.length} of 12 headings give a clear ${len} m run${ok[0] ? `, taking ${ok[0].bearing}°` : ""}`);
    if (!ok[0]) throw new Error(`no clear ${len} m run from here (walls or a portal ring in every direction): \`walk pad\` to the plaza's middle and \`step\` again`);
    return ok[0].bearing;
  };

  /** How each tutorial step is done with real input (onboardingSteps.ts says what counts). */
  const doStep: Record<string, () => Promise<unknown>> = {
    move: async () => {
      await player.turn(await openHeading(10));
      await player.hold(["KeyW"], 1500);
    },
    look: async () => {
      for (let i = 0; i < 4; i++) await player.turn(60);
    },
    jump: () => player.tap("Space"),
    sprint: async () => {
      await player.turn(await openHeading(25));
      await player.hold(["ShiftLeft", "KeyW"], 2600);
    },
    dodge: () => player.hold(["KeyC"], 60),
    attack: () => hitTrainingDummies(player),
    switch: async () => {
      await player.tap("Digit2");
      await page.waitForTimeout(400);
      await player.tap("Digit1");
    },
    pickup: () => player.tap("KeyE"),
    map: async () => {
      await player.tap("KeyM");
      await page.waitForTimeout(1500);
      await player.tap("KeyM");
      await page.waitForTimeout(500);
    },
    // A quick tap keeps the wheel open; a number says that phrase (5: "Thanks").
    wheel: async () => {
      await player.tap("KeyG");
      await page.waitForTimeout(500);
      await player.tap("Digit5");
    },
    voice: () => page.waitForTimeout(9000),
    portal: () => player.walkThroughPortal("arcadia"),
  };

  /** The current tutorial step, done; what its card said and how long it took. */
  const step = async (): Promise<string> => {
    localOnly("the tutorial macros (they hit training dummies)");
    const s0 = await player.snap();
    const id = s0.onboarding?.active && !s0.onboarding.allDone ? s0.onboarding.step : null;
    if (!id) return s0.onboarding?.allDone ? "the tutorial is done" : "no tutorial step right now (it runs in Portus for a new player)";
    const pre = await ensureLock();
    const card = await cardText();
    const t0 = Date.now();
    const act = doStep[id];
    if (!act) throw new Error(`no macro for the tutorial step "${id}": do it by hand (the card says: ${card})`);
    let s = s0;
    for (let i = 0; i < 3 && s.onboarding?.step === id && !s.onboarding.allDone; i++) {
      await act();
      await ensureLock();
      for (let k = 0; k < 10; k++) {
        s = await player.snap();
        if (s.onboarding?.step !== id || s.onboarding.allDone || s.body !== s0.body) break;
        await page.waitForTimeout(300);
      }
    }
    const moved = s.onboarding?.step !== id || !!s.onboarding?.allDone || s.body !== s0.body;
    const next = s.body !== s0.body ? `now on ${s.body}` : s.onboarding?.allDone ? "that was the last step" : `next: ${s.onboarding?.step}`;
    return `${pre}${moved ? "done" : "NOT done"}: ${id} in ${((Date.now() - t0) / 1000).toFixed(1)} s · the card said "${card.slice(0, 220)}" · ${next}`;
  };

  /** Walk to the guide, press E, take every mission on offer and close the panel. */
  const talk = async (): Promise<string> => {
    localOnly("talk (it takes missions)");
    const s0 = await player.snap();
    if (!s0.guide) throw new Error("no guide here: each planet's guide stands by its main pad (Lark on Arcadia)");
    const pre = await ensureLock();
    const g = goal("guide", s0);
    if (!g.arrived(s0)) {
      const how = await cruise(g.pick, g.arrived, { timeoutMs: 45_000 });
      if (how !== "arrived") throw new Error(`couldn't reach the guide: ${how}`);
    }
    await player.face((x) => x.guide?.bearing ?? null, 20);
    const panel = page.locator(".fl-overlay").filter({ visible: true }).last();
    for (let i = 0; i < 3 && !(await panel.count()); i++) {
      await player.tap("KeyE");
      await page.waitForTimeout(700);
      if (!(await panel.count())) await player.hold(["KeyW"], 250);
    }
    if (!(await panel.count())) throw new Error("pressed E by the guide but no panel opened (`fl screen` shows the prompt, if any)");
    const said = (await panel.innerText()).replace(/\s+/g, " ").trim();
    let took = 0;
    for (let i = 0; i < 4; i++) {
      const accept = panel.getByRole("button", { name: /^accept$/i }).first();
      if (!(await accept.count())) break;
      await accept.click();
      took++;
      await page.waitForTimeout(600);
    }
    const close = panel.getByRole("button", { name: /^close$/i }).first();
    if (await close.count()) await close.click();
    else await player.escape();
    await page.waitForTimeout(400);
    await ensureLock();
    const s = await player.snap();
    const list = (s.quests ?? []).map((q) => `${q.id} ${q.name} (${q.type}: ${q.objective}) ${q.done ? "done" : q.taken ? `taken ${q.progress}/${q.goal}` : "not taken"}`);
    return `${pre}took ${took} mission(s) · the panel said "${said.slice(0, 300)}"\n${list.join("\n")}`;
  };

  /** Pursue one mission until it is done, we die, or time runs out. */
  const quest = async (id: string | undefined, sec: number): Promise<string> => {
    localOnly("quest (it fights)");
    const s0 = await player.snap();
    const list = s0.quests ?? [];
    if (!list.length) throw new Error("no missions here: they're on the planets (Lark by Arcadia's main pad gives three)");
    const q0 = id ? list.find((q) => q.id.toLowerCase() === id.toLowerCase()) : list.find((q) => q.taken && !q.done);
    if (!q0) throw new Error(id ? `no mission ${id} here (${list.map((q) => q.id).join(", ")})` : "no open mission: `fl talk` to the guide first");
    if (q0.done) return `${q0.id} ${q0.name} is already done`;
    if (!q0.taken) throw new Error(`${q0.id} isn't taken yet: \`fl talk\` first`);
    const pre = await ensureLock();
    const t0 = Date.now();
    const until = t0 + sec * 1000;
    trace(`quest ${q0.id} ${q0.name} (${q0.type}) ${q0.progress}/${q0.goal}, objective ${typeof q0.surface === "number" ? where(q0 as Target) : "not placed"}`);
    const mine = (x: Snap) => x.quests?.find((q) => q.id === q0.id);
    const spot = (x: Snap) => {
      const q = mine(x);
      return q && typeof q.surface === "number" ? (q as Quest & Target) : null;
    };
    const log: string[] = [];
    let attacks = 0;
    let fights = 0;
    // Progress: a kill for a hunt; for a find or a reach (0/1 until the end), getting 10 m closer.
    let progress = q0.progress;
    let closest = q0.surface ?? Infinity;
    let gainedAt = Date.now();
    while (Date.now() < until) {
      const s = await player.snap();
      const q = mine(s);
      if (!q || q.done || s.player?.dead) break;
      if (q.progress !== progress || (q.type !== "hunt" && (q.surface ?? Infinity) < closest - 10)) {
        progress = q.progress;
        closest = Math.min(closest, q.surface ?? Infinity);
        gainedAt = Date.now();
      } else if (Date.now() - gainedAt > 150_000) {
        log.push("no progress in 150 s: stopped (look with `state` or a `shot`)");
        break;
      }
      const sip = await drink(s);
      if (sip) {
        log.push(sip);
        continue;
      }
      const ran = await retreat(s);
      if (ran) {
        log.push(ran);
        continue;
      }
      if (s.zone?.server === "safe" && q.type === "hunt" && (q.surface ?? 0) > 30) {
        // Out of the pad's ring first (attacks don't count inside).
        await walkOut();
        continue;
      }
      const prey = q.type === "hunt" ? pointedAt(s) : undefined;
      // A hunt fights what comes near. An errand (find, reach) runs past it the way a player would
      // (a sprint is 9 m/s, a Hopbit 4, a Sparkfly 5): nothing heals between fights but tonics and
      // level-ups, and every fight on the way costs HP the next place needs (a dry run reached
      // Lacefall's Sparkflies at 49 HP and died there).
      const foe = q.type === "hunt" ? (threat(s) ?? (prey && prey.surface < 45 ? prey : undefined)) : undefined;
      // Weapons are holstered inside a safe ring, but a creature at its edge still reaches in: step out.
      if (foe && s.zone?.server === "safe" && foe.dist < 8) {
        trace(`quest ${q0.id}: ${foe.name ?? foe.kind} ${n0(foe.dist)} m away while we stand in a safe ring: walking out`);
        await walkOut();
        continue;
      }
      if (foe && s.zone?.server !== "safe") {
        fights++;
        if (await fightBeat(s, foe)) attacks++;
        continue;
      }
      if (q.type === "hunt") {
        const pointer = (x: Snap) => (x.mission?.shown && typeof x.mission.surface === "number" ? (x.mission as Target) : spot(x));
        const how = await cruise(pointer, (x) => (pointedAt(x)?.surface ?? 99) < 40, { timeoutMs: Math.min(25_000, until - Date.now()), stop: (x) => (threat(x) ? "attacked" : null) });
        if (how !== "arrived" && how !== "attacked") log.push(`walk: ${how}`);
        continue;
      }
      // On an errand, stop running only to drink.
      const thirsty = (x: Snap) => (hpShare(x) < 0.45 && tonicReady(x) ? "thirsty" : null);
      if (q.type === "find") {
        const at = spot(s);
        if (!at) {
          log.push("the object isn't placed here");
          break;
        }
        if (at.surface > 1.6) {
          const how = await cruise(spot, (x) => (spot(x)?.surface ?? 99) <= 1.6 || !!mine(x)?.done, { timeoutMs: Math.min(60_000, until - Date.now()), stop: thirsty });
          if (how !== "arrived" && how !== "thirsty") log.push(`walk: ${how}`);
          continue;
        }
        await player.tap("KeyE");
        await page.waitForTimeout(900);
        continue;
      }
      const how = await cruise(spot, (x) => !!mine(x)?.done, { timeoutMs: Math.min(60_000, until - Date.now()), stop: thirsty });
      if (how !== "arrived" && how !== "thirsty") log.push(`walk: ${how}`);
    }
    // Done on an errand with creatures about (Lacefall's Sparkflies killed a dry run that stood by the
    // bell): run on toward the pad until nothing hostile is within 30 m, before handing back.
    let s = await player.snap();
    if (mine(s)?.done && q0.type !== "hunt" && s.pad && (s.npcs ?? []).some((n) => n.hostile && !n.dead && n.dist < 25)) {
      const how = await cruise((x) => x.pad ?? null, (x) => x.zone?.server === "safe" || !(x.npcs ?? []).some((n) => n.hostile && !n.dead && n.dist < 30), { timeoutMs: 20_000 });
      log.push(`got clear of the creatures there (${how})`);
      s = await player.snap();
    }
    const q = mine(s);
    const verdict = s.player?.dead ? "YOU DIED: missions reset on rebirth (`fl rise`, then `fl talk` again)" : q?.done ? `${q0.id} ${q0.name} DONE` : `${q0.id} not done in ${sec} s (${q?.progress ?? 0}/${q?.goal ?? "?"})`;
    const objective = q && typeof q.surface === "number" ? ` · objective ${where(q as Target)}` : "";
    return `${pre}${verdict} in ${((Date.now() - t0) / 1000).toFixed(0)} s · ${attacks} attacks over ${fights} fight beats${objective}${log.length ? ` · ${[...new Set(log)].slice(0, 4).join("; ")}` : ""}\n${await state()}`;
  };

  Object.assign(commands, {
    step: { usage: "step", help: "local only: do the current tutorial step with real input; says what its card asked and how long it took", run: step },
    tutorial: {
      usage: "tutorial [all]",
      help: "local only: every tutorial step in turn up to the portal (`all`: walk into the Arcadia portal too); one line per step",
      async run([all]) {
        localOnly("the tutorial macros (they hit training dummies)");
        const lines: string[] = [];
        for (let i = 0; i < 14; i++) {
          const s = await player.snap();
          if (!s.onboarding?.active || s.onboarding.allDone || s.body !== "portus") break;
          if (s.onboarding.step === "portal" && all !== "all") {
            lines.push("stopped before the portal step: `fl step` or `fl portal arcadia` walks in");
            break;
          }
          const line = await step();
          lines.push(line);
          if (line.startsWith("NOT done")) break;
        }
        return `${lines.join("\n") || "no tutorial running here"}\n${await state()}`;
      },
    },
    talk: { usage: "talk", help: "local only: walk to this planet's guide, press E, take every mission offered and close the panel", run: talk },
    quest: {
      usage: "quest [id] [sec]",
      help: "local only: do a taken mission (default: the first open one) until done, you die, or sec pass (default 240): hunts fight what the pointer marks, finds walk there and press E, reaches walk in",
      run: ([id, sec]) => (id && /^\d+$/.test(id) ? quest(undefined, Number(id)) : quest(id, Number(sec ?? 240))),
    },
    rise: {
      usage: "rise",
      help: "local only: after dying, Rise again, keep the rebirth pick as it is, rise in town and wait for the world",
      async run() {
        localOnly("rise (rebirth replaces and saves the character)");
        for (let i = 0; i < 5; i++) {
          const s = await player.snap();
          if (!s.player?.dead && s.stage === "playing" && !s.loading) break;
          const b = page.getByRole("button", { name: /^rise (again|in)/i }).filter({ visible: true }).first();
          if (await b.count()) await b.click();
          await page.waitForTimeout(1500);
        }
        await player.waitInWorld();
        return state();
      },
    },
  } satisfies Record<string, Command>);

  /**
   * One beat of the guard (between commands): drink below 45% HP, fight a hostile within reach
   * outside the safe zones. Nothing while dead, loading, in a menu or with the pointer free (the
   * driver left it so), and never on production (read-only there). What it did, or null.
   */
  const guardTick = async (): Promise<string | null> => {
    if (TARGET === "prod") return null;
    const s = await player.snap().catch(() => null);
    if (!s || s.stage !== "playing" || s.loading || !s.player || s.player.dead || !s.input.pointerLocked) return null;
    if ((s.ui.pauseMenuMode && s.ui.pauseMenuMode !== "hidden") || s.ui.overlays.length) return null;
    const sip = await drink(s);
    if (sip) return sip;
    const ran = await retreat(s);
    if (ran) return ran;
    const foe = threat(s);
    if (!foe || s.zone?.server === "safe") return null;
    await fightBeat(s, foe);
    return `fought ${foe.name ?? foe.kind}#${foe.id}`;
  };
  return { commands, guardTick };
}

/**
 * Another live player near the line of fire: in the front half toward `foe` within the weapon's reach
 * (sweeps, piercing, point-blank), or within 10 m of the foe (chains, splash). A courtesy to other
 * local sessions, not a full damage model: projectiles travel past their range and chains jump
 * further, which is why `fight` and `attack` are refused on production.
 */
function playerInHarmsWay(s: Snap, foe: Target) {
  const reach = Math.max(s.weapon?.range ?? 20, foe.dist) + 3;
  return s.players?.find((o) => {
    if (o.dead) return false;
    const off = wrap180(o.bearing - foe.bearing);
    if (o.dist <= reach && Math.abs(off) <= 90) return true;
    const apart = Math.sqrt(o.dist ** 2 + foe.dist ** 2 - 2 * o.dist * foe.dist * Math.cos((off * Math.PI) / 180));
    return apart <= 10;
  });
}

function pickStarter(who: string | undefined): StarterName {
  const q = (who ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const hit = STARTERS.find((s) => q && s.toLowerCase().replace(/[^a-z0-9]/g, "").includes(q));
  if (!hit) throw new Error(`pick a starter: hexwick, ash, kappa or unit7 (got "${who ?? ""}")`);
  return hit;
}

const KEY_NAMES: Record<string, string> = { shift: "ShiftLeft", space: "Space", esc: "Escape", escape: "Escape", tab: "Tab", enter: "Enter", ctrl: "ControlLeft", alt: "AltLeft" };

function keyCode(k: string): string {
  const low = k.toLowerCase();
  if (KEY_NAMES[low]) return KEY_NAMES[low]!;
  if (/^[a-z]$/.test(low)) return `Key${low.toUpperCase()}`;
  if (/^[0-9]$/.test(low)) return `Digit${low}`;
  return k;
}

const n0 = (v: number | null | undefined) => (v === null || v === undefined ? "?" : Math.round(v).toString());

function where(t: Target | null | undefined): string {
  if (!t) return "none";
  const b = Math.round(t.bearing);
  const side = Math.abs(b) <= 5 ? "ahead" : Math.abs(b) >= 170 ? "behind" : b > 0 ? `${b}° right` : `${-b}° left`;
  return `${n0(t.surface)} m ${side}${t.onScreen ? " (on screen)" : ""}`;
}

/** One line: the essentials after an action. */
function brief(s: Snap): string {
  const p = s.player;
  const ui = [s.ui.pauseMenuMode && s.ui.pauseMenuMode !== "hidden" && `menu ${s.ui.pauseMenuMode}`, s.ui.photo && "photo mode", ...s.ui.overlays.map((o) => o.replace(/^fl-overlay\s*/, "").split(" ")[0])].filter(Boolean);
  return [
    s.stage + (s.loading ? ` (${s.loading.replace(/\s+/g, " ").slice(0, 40)}…)` : ""),
    s.body ?? "no body",
    s.zone ? `zone ${s.zone.server ?? "?"}${s.zone.kind ? `/${s.zone.kind}` : ""}` : null,
    p ? `HP ${n0(p.hp)}${p.dead ? " DEAD" : ""}` : null,
    s.input.pointerLocked ? "pointer locked" : "pointer free",
    ui.length ? `ui: ${ui.join(", ")}` : null,
    s.lastDenied && s.t - s.lastDenied.t < 5000 ? `denied ${s.lastDenied.action}:${s.lastDenied.reason}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** `fl state`: everything a player would glance at, in a dozen short lines. */
/** The spellbook in one line: aether, then each spell with its key and whether a press would cast it. */
function spellLine(s: Snap): string {
  const b = s.spells;
  if (!b) return "spells: not up yet";
  const one = (x: NonNullable<Snap["spells"]>["slots"][number]) =>
    `${x.key} ${x.name} ${!x.unlocked ? `locked (Lv ${x.level})` : x.cooldown > 0 ? `${x.cooldown.toFixed(1)} s` : x.short ? `needs ${x.cost} aether` : "ready"}`;
  return `aether ${Math.floor(b.aether)}/${b.max}${b.ward ? ` · ward up (${b.ward.hp} HP, ${b.ward.left.toFixed(1)} s)` : ""} · ${b.slots.map(one).join(" · ")}`;
}

function describe(s: Snap, events: FlEvent[]): string {
  const lines = [brief(s)];
  const p = s.player;
  if (s.zone) lines.push(`zone label "${s.zone.labelText ?? s.zone.label ?? "-"}" · server ${s.zone.server ?? "?"} · local ${s.zone.local ?? "?"} · ${s.zone.toSafe !== null && s.zone.toSafe !== undefined ? `${n0(Math.abs(s.zone.toSafe))} m ${s.zone.local === "safe" ? "to the edge" : "back to safety"}` : ""}`);
  if (p) {
    const starter = p.starter !== null && p.starter !== undefined ? STARTERS[p.starter] ?? `starter ${p.starter}` : "?";
    lines.push(`me ${p.name ?? "?"} (${starter}) Lv ${s.you?.level ?? p.level ?? "?"} · HP ${n0(p.hp)} · XP ${s.you?.xp ?? "?"}/${s.you?.xpToNext ?? "?"} · coins ${s.you?.coins ?? "?"}${p.protected ? " · spawn protection on (just arrived: nothing can hurt you yet)" : ""}${p.inCombat ? " · in combat" : ""}${p.swimming ? " · swimming" : ""} · anim ${p.clip ?? p.anim}`);
  }
  if (s.weapon) lines.push(`weapon ${s.weapon.name} (${s.weapon.delivery}, range ${s.weapon.range} m) · hotbar ${(s.hotbar ?? []).map((h) => (h ? h.id : "-")).join(" ")}`);
  if (s.spells) lines.push(spellLine(s));
  if (s.onboarding?.active) lines.push(`tutorial step ${s.onboarding.step ?? "?"} (${s.onboarding.done} done${s.onboarding.allDone ? ", all done" : ""})`);
  const npcs = (s.npcs ?? []).filter((n) => !n.dead).sort((a, b) => a.dist - b.dist);
  const hostile = npcs.filter((n) => n.hostile);
  if (hostile.length) lines.push(`hostiles ${hostile.length}: ${hostile.slice(0, 4).map((n) => `${n.name ?? n.kind} ${n.id} L${n.level} ${n0(n.hp)}/${n0(n.maxHp)} ${where(n)}`).join(" | ")}`);
  const calm = npcs.filter((n) => !n.hostile);
  if (calm.length) lines.push(`other creatures ${calm.length}: ${calm.slice(0, 3).map((n) => `${n.name ?? n.kind} ${where(n)}`).join(" | ")}`);
  if (s.players?.length) lines.push(`players ${s.players.length}: ${s.players.slice(0, 3).map((o) => `${o.name} ${where(o)}`).join(" | ")}`);
  const marks = [
    s.pad && `pad ${where(s.pad)}`,
    s.guide && `guide ${s.guide.name ?? ""} ${where(s.guide)}`,
    s.mission?.shown && `mission "${s.mission.title}" ${typeof s.mission.surface === "number" ? where(s.mission as Target) : ""}`,
    ...(s.portals ?? []).slice(0, 4).map((x) => `portal ${x.to} ${where(x)}`),
    s.gates?.length && `${s.gates.length} gates, nearest ${where([...s.gates].sort((a, b) => a.dist - b.dist)[0])}`,
    s.dummies?.length && `dummies ${s.dummies.filter((d) => !d.down).length} standing, nearest ${where([...s.dummies].filter((d) => !d.down).sort((a, b) => a.dist - b.dist)[0])}`,
  ].filter(Boolean);
  if (marks.length) lines.push(marks.join(" · "));
  const quests = (s.quests ?? []).map((q) => `${q.id} ${q.name} ${q.done ? "done" : q.taken ? `${q.progress}/${q.goal}` : "not taken"}${!q.done && typeof q.surface === "number" ? ` (${where(q as Target)})` : ""}`);
  if (quests.length) lines.push(`missions: ${quests.join(" | ")}`);
  lines.push(`on screen: ${s.ui.visibleE2e.join(", ") || "-"}`);
  const toasts = events.filter((e) => e.kind === "toast" && s.t - e.t < 15_000).map((e) => `"${String(e.text ?? "").trim().replace(/\s+/g, " ")}"`);
  if (toasts.length) lines.push(`toasts (15 s): ${toasts.slice(-3).join(" ")}`);
  return lines.join("\n");
}

function eventLine(e: FlEvent): string {
  switch (e.kind) {
    case "toast":
      return `toast "${String(e.text ?? "").trim().replace(/\s+/g, " ")}"`;
    case "in":
      return e.type === "denied" ? `server refused ${e.action}: ${e.reason}` : `server ${e.type}${e.mine ? " (mine)" : ""}`;
    case "lock":
      return `pointer ${e.locked ? "locked" : "released"}`;
    default:
      return `${e.kind} ${JSON.stringify({ ...e, t: undefined, kind: undefined }).slice(0, 120)}`;
  }
}

/** What sits on top of a control's middle, when something does ("a div.fl-death \"You died…\""). */
async function coveredBy(l: Locator): Promise<string | null> {
  return l.evaluate((e) => {
    const b = e.getBoundingClientRect();
    const top = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
    if (!top || top === e || e.contains(top) || top.contains(e)) return null;
    const card = top.closest<HTMLElement>(".fl-overlay, [data-e2e], section, dialog") ?? (top as HTMLElement);
    return `${card.tagName.toLowerCase()}.${String(card.className).split(" ")[0]} "${(card.innerText ?? "").trim().replace(/\s+/g, " ").slice(0, 40)}"`;
  });
}

/** The text a player can read and what they can click, from the DOM. */
async function screen(page: Player["page"]): Promise<string> {
  const r = await page.evaluate(() => {
    const visible = (e: Element) => {
      const b = e.getBoundingClientRect();
      const st = getComputedStyle(e);
      return b.width > 0 && b.height > 0 && st.visibility !== "hidden" && st.opacity !== "0" && !e.closest("[hidden]");
    };
    const text = document.body.innerText.replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();
    const controls = [...document.querySelectorAll<HTMLElement>("button, a[href], [role=button], [role=menuitem], input, select, textarea")].filter(visible).map((e) => {
      const label = (e.getAttribute("aria-label") || e.innerText || (e as HTMLInputElement).placeholder || (e as HTMLInputElement).name || "").trim().replace(/\s+/g, " ").slice(0, 50);
      const b = e.getBoundingClientRect();
      const top = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
      const covered = !!top && top !== e && !e.contains(top) && !top.contains(e);
      return `${e.tagName.toLowerCase()}${e.dataset.e2e ? `[${e.dataset.e2e}]` : ""} "${label}"${covered ? " (covered)" : ""}`;
    });
    return { text, controls };
  });
  return `${r.text.slice(0, 2500)}\n--- controls (${r.controls.length}) ---\n${r.controls.slice(0, 40).join("\n")}`;
}

/** What changed between two snapshots, in a few words ("HP 100→58 · +15 XP · A1 3→4/8"); "" when nothing did. */
function changes(a: Snap | null, b: Snap): string {
  const out: string[] = [];
  if (a && a.body !== b.body && b.body) out.push(`now on ${b.body}`);
  // A new connection on the same body without travel: the connection dropped and the game rejoined.
  else if (a?.net && b.net && a.net.sessionId !== b.net.sessionId && !b.player?.dead && !a.player?.dead) out.push("the game reconnected (the connection dropped)");
  const hp0 = a?.player?.hp, hp1 = b.player?.hp;
  if (a && !a.player?.dead && b.player?.dead) out.push("YOU DIED (missions reset; `fl rise`)");
  else if (a?.player?.dead && b.player && !b.player.dead) out.push("you are alive again");
  else if (typeof hp0 === "number" && typeof hp1 === "number" && Math.round(hp0) !== Math.round(hp1) && a?.body === b.body) out.push(`HP ${n0(hp0)}→${n0(hp1)}${hp1 < hp0 && b.player?.inCombat ? " (something is hitting you)" : ""}`);
  const lv0 = a?.you?.level, lv1 = b.you?.level;
  if (lv0 && lv1 && lv1 !== lv0) out.push(`level ${lv0}→${lv1}`);
  else if (a?.you && b.you && b.you.xp > a.you.xp) out.push(`+${b.you.xp - a.you.xp} XP`);
  const st0 = a?.onboarding?.step, st1 = b.onboarding?.step;
  if (a && b.onboarding && st0 !== st1) out.push(st1 ? `tutorial step now ${st1}` : "tutorial done");
  for (const q of b.quests ?? []) {
    const was = a?.quests?.find((x) => x.id === q.id);
    if (!was || a?.body !== b.body) continue;
    if (q.done && !was.done) out.push(`${q.id} ${q.name} DONE`);
    else if (q.taken && !was.taken) out.push(`took ${q.id} ${q.name}`);
    else if (q.progress !== was.progress) out.push(`${q.id} ${was.progress}→${q.progress}/${q.goal}`);
  }
  // The pause menu and the panels don't stop the world (Haiku died reading How to play outside town).
  const menu = b.ui.pauseMenuMode && b.ui.pauseMenuMode !== "hidden" ? "the pause menu" : b.ui.overlays.length ? "a panel" : null;
  const foe = (b.npcs ?? []).filter((n) => n.hostile && !n.dead && n.dist < 25).sort((x, y) => x.dist - y.dist)[0];
  if (menu && b.zone?.server === "danger" && foe && !b.player?.dead) out.push(`WARNING ${menu} is open outside a safe zone and the world doesn't pause: ${foe.name ?? foe.kind} ${n0(foe.dist)} m away`);
  return out.join(" · ");
}

/** "fought 2 Hopbit, drank a tonic small at HP 30" from the guard's notes ("fought <name>#<id>"). */
function summarize(notes: string[]): string {
  const foes = new Map<string, Set<string>>();
  const other: string[] = [];
  for (const n of notes) {
    const m = n.match(/^fought (.+)#(.+)$/);
    if (m) foes.set(m[1]!, (foes.get(m[1]!) ?? new Set()).add(m[2]!));
    else other.push(n);
  }
  return [...[...foes].map(([name, ids]) => `fought ${ids.size} ${name}`), ...other].join(", ");
}

const mmss = (ms: number) => `${String(Math.floor(ms / 60_000)).padStart(2, "0")}:${String(Math.floor((ms % 60_000) / 1000)).padStart(2, "0")}`;

/** `fl report` and report.txt: the run in a dozen lines, frame times per place included. */
function sessionReport(entries: Entry[], perf: PerfSample[], s: Snap | null, consoleErrors: number, startedAt: number, died: number): string {
  const first = entries[0]?.at ?? startedAt;
  const last = entries.at(-1);
  const busy = entries.reduce((n, e) => n + e.ms, 0);
  const span = last ? last.at + last.ms - first : 0;
  const lines = [
    `${DRIVER ? `driver ${DRIVER} · ` : ""}${mmss(span)} from the first command to the last · ${entries.length} commands (${entries.filter((e) => !e.ok).length} errors) · game busy ${mmss(busy)}, driver thinking ${mmss(Math.max(0, span - busy))}`,
  ];
  const marks = entries.filter((e) => /DONE|tutorial done|now on /.test(e.out)).map((e) => `${mmss(e.at + e.ms - first)} ${e.out.match(/since your last command: (.*)$/m)?.[1] ?? e.line}`);
  if (marks.length) lines.push(`milestones: ${marks.slice(0, 12).join(" | ")}`);
  if (s) {
    const quests = (s.quests ?? []).map((q) => `${q.id} ${q.done ? "done" : q.taken ? `${q.progress}/${q.goal}` : "not taken"}`).join(", ");
    lines.push(`now: ${brief(s)} · Lv ${s.you?.level ?? "?"}${s.onboarding?.active ? ` · tutorial ${s.onboarding.allDone ? "all done" : `at ${s.onboarding.step}`}` : ""}${quests ? ` · missions ${quests}` : ""}`);
  }
  lines.push(`deaths ${died} · console errors ${consoleErrors}`);
  if (perf.length) {
    const loads = perf.map((p) => p.load).sort((a, b) => a - b);
    lines.push(`machine load (1-min average, ${availableParallelism()} cores): median ${loads[Math.floor(loads.length / 2)]} · max ${loads.at(-1)}${loads[Math.floor(loads.length / 2)]! > availableParallelism() * 2 ? " — busy: other jobs slowed this run" : ""}`);
  }
  // Frame times per place, only while playing (loading screens and travel are their own thing).
  const byBody = new Map<string, PerfSample[]>();
  for (const p of perf) if (p.playing && p.body && p.frames > 0) byBody.set(p.body, [...(byBody.get(p.body) ?? []), p]);
  for (const [body, list] of byBody) {
    const frames = list.reduce((n, p) => n + p.frames, 0);
    const p95s = list.map((p) => p.p95).sort((x, y) => x - y);
    lines.push(
      `frames on ${body} (${list.length * 5} s${VIDEO ? ", filming on" : ""}): ${(frames / (list.length * 5)).toFixed(0)} fps · median p95 ${p95s[Math.floor(p95s.length / 2)]!.toFixed(1)} ms · worst 5 s p95 ${p95s.at(-1)!.toFixed(1)} ms · longest frame ${Math.max(...list.map((p) => p.max)).toFixed(0)} ms · ${list.reduce((n, p) => n + p.over100, 0)} frames over 100 ms`,
    );
  }
  const loading = perf.filter((p) => !p.playing).length;
  if (loading) lines.push(`not playing (loading, travel, home page) for about ${loading * 5} s of samples`);
  lines.push(`evidence: ${DIR} (transcript.log, perf.jsonl, shots/${VIDEO ? ", video.mp4 when the session ends" : ""})`);
  return lines.join("\n");
}

/**
 * The film as an MP4: the game on top, and under it a strip with the driver, the clock, the command
 * running or its answer, and the thinking gap before the next one. Captions are drawn as PNGs in a
 * spare page (this ffmpeg has no text filters) and stacked under the game with ffmpeg.
 */
async function finishVideo(film: Film, browser: Browser, entries: Entry[]): Promise<string> {
  const raw = film.file;
  const seconds = film.seconds;
  const filmStart = film.startedAt;
  const first = entries[0]?.at ?? filmStart;
  const t = (at: number) => Math.max(0, (at - filmStart) / 1000);

  // Strip segments: [from, to) seconds of film, two lines each.
  type Seg = { from: number; head: string; body: string; tone: "run" | "ok" | "err" | "idle" };
  const segs: Seg[] = [{ from: 0, head: `${DRIVER || "driver"} · waiting for the first command`, body: "", tone: "idle" }];
  entries.forEach((e, i) => {
    const clock = mmss(e.at - first);
    const next = entries[i + 1];
    const answer = e.out.split("\n")[0]!.slice(0, 150);
    const change = e.out.match(/since your last command: (.*)$/m)?.[1]?.slice(0, 120);
    if (e.ms >= 400) segs.push({ from: t(e.at), head: `${DRIVER || "driver"} · ${clock} · #${i + 1}  ▶ ${e.line.slice(0, 80)}`, body: "running…", tone: "run" });
    const gap = next ? ` · then ${((next.at - e.at - e.ms) / 1000).toFixed(1)} s thinking` : "";
    segs.push({ from: t(e.at + e.ms), head: `${DRIVER || "driver"} · ${clock} · #${i + 1}  ${e.ok ? "✓" : "✗"} ${e.line.slice(0, 80)} (${(e.ms / 1000).toFixed(1)} s)${gap}`, body: `→ ${answer}${change ? `   [${change}]` : ""}`, tone: e.ok ? "ok" : "err" });
  });
  segs.sort((a, b) => a.from - b.from);

  const caps = path.join(DIR, "video-strip");
  rmSync(caps, { recursive: true, force: true });
  mkdirSync(caps, { recursive: true });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 84 } });
  const strip = await ctx.newPage();
  await strip.setContent(`<body style="margin:0;background:#0d1117;color:#e6edf3;font:15px -apple-system,Helvetica,sans-serif;height:84px;overflow:hidden">
    <div id="h" style="padding:10px 14px 4px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis"></div>
    <div id="b" style="padding:0 14px;color:#9da7b3;white-space:nowrap;overflow:hidden;text-overflow:ellipsis"></div></body>`);
  // A segment shorter than a frame is dropped, and its time goes to the one before it, so every later
  // caption keeps its place on the film's clock.
  const kept = segs.filter((g, i) => (segs[i + 1]?.from ?? seconds) - g.from > 0.02 || i === 0);
  const list: string[] = [];
  for (let i = 0; i < kept.length; i++) {
    const g = kept[i]!;
    const dur = (kept[i + 1]?.from ?? seconds) - g.from;
    if (dur <= 0) continue;
    await strip.evaluate(([h, b, c]) => {
      document.getElementById("h")!.textContent = h!;
      document.getElementById("b")!.textContent = b!;
      document.getElementById("h")!.style.color = c!;
    }, [g.head, g.body, { run: "#f0b429", ok: "#e6edf3", err: "#ff7b72", idle: "#9da7b3" }[g.tone]] as const);
    const png = path.join(caps, `${String(i).padStart(4, "0")}.png`);
    await strip.screenshot({ path: png });
    list.push(`file '${png}'`, `duration ${dur.toFixed(3)}`);
  }
  await ctx.close();
  if (list.length) list.push(list.at(-2)!); // the concat demuxer needs the last picture twice
  const listFile = path.join(caps, "strip.txt");
  writeFileSync(listFile, list.join("\n") + "\n");

  // From a second before the first command to two after the last answer.
  const from = Math.max(0, t(first) - 1);
  const lastEnd = entries.length ? t(entries.at(-1)!.at + entries.at(-1)!.ms) + 2 : seconds;
  const mp4 = path.join(DIR, "video.mp4");
  execFileSync(
    "ffmpeg",
    ["-y", "-v", "error", "-i", raw, "-f", "concat", "-safe", "0", "-i", listFile, "-filter_complex", "[0:v]fps=25,scale=1280:720,format=yuv420p[g];[1:v]fps=25,scale=1280:84,format=yuv420p[s];[g][s]vstack=inputs=2[o]", "-map", "[o]", "-ss", from.toFixed(2), "-t", Math.max(1, Math.min(seconds, lastEnd) - from).toFixed(2), ...(process.platform === "darwin" ? ["-c:v", "h264_videotoolbox", "-b:v", "3M"] : ["-c:v", "libx264", "-preset", "veryfast", "-crf", "26"]), "-movflags", "+faststart", mp4],
    { stdio: "inherit", timeout: 20 * 60_000 },
  );
  rmSync(raw, { force: true }); // the strip's copy is the one to keep
  return mp4;
}
