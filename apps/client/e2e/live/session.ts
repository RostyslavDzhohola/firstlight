// A live play session: one headless, muted browser in the game that stays open while a model (or a
// person) plays it one command at a time with `e2e/live/fl.mjs` (live/README.md). The same stack,
// fixtures and Player as the journeys; every answer is short text a small model can read, and each
// command lands in $E2E_OUT/live/transcript.log with its time.

import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import path from "node:path";
import { measureBlinks, playAWhile } from "../blink.ts";
import { test } from "../fixtures.ts";
import { hitTrainingDummies, newEmail, saveWithEmail } from "../flows.ts";
import { STARTERS, type FlEvent, type Npc, type Player, type Snap, type StarterName, type Target } from "../player.ts";
import { OUT, TARGET } from "../stack.ts";

const PORT = Number(process.env.FL_LIVE_PORT ?? 7357);
const IDLE_MS = Number(process.env.FL_LIVE_IDLE_MIN ?? 20) * 60_000;
const DIR = path.join(OUT, "live");
const SHOTS = path.join(DIR, "shots");
const SESSION_FILE = path.join(DIR, "session.json");
const TRANSCRIPT = path.join(DIR, "transcript.log");

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

test("live session", async ({ player, page, consoleErrors }) => {
  mkdirSync(SHOTS, { recursive: true });
  writeFileSync(TRANSCRIPT, "");
  const commands = makeCommands(player, consoleErrors);
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

  let quit: () => void = () => {};
  const done = new Promise<void>((resolve) => (quit = resolve));
  commands.quit = { usage: "quit", help: "end the session (closes the browser and the stack)", run: async () => (setTimeout(quit, 100), "bye") };
  commands.help = {
    usage: "help",
    help: "this list",
    run: async () => Object.values(commands).map((c) => `${c.usage.padEnd(28)} ${c.help}`).join("\n"),
  };

  let idle = setTimeout(quit, IDLE_MS);
  let queue = Promise.resolve();
  const server = createServer((req, res) => {
    if (req.method !== "POST") {
      res.end(JSON.stringify({ ok: true, target: TARGET, gfx: player.gfx }));
      return;
    }
    void readBody(req).then((raw) => {
      queue = queue.then(async () => {
        clearTimeout(idle);
        idle = setTimeout(quit, IDLE_MS);
        let cmd = "?";
        let args: string[] = [];
        try {
          ({ cmd, args } = JSON.parse(raw) as { cmd: string; args: string[] });
        } catch {}
        const t0 = Date.now();
        let ok = true;
        let out: string;
        const c = commands[cmd];
        try {
          out = c ? await c.run(args) : `unknown command "${cmd}": try \`fl help\``;
          if (!c) ok = false;
        } catch (e) {
          ok = false;
          out = `error: ${String((e as Error)?.message ?? e).split("\n").filter(Boolean).slice(0, 3).join(" | ")}`;
        }
        const ms = Date.now() - t0;
        appendFileSync(TRANSCRIPT, `${new Date(t0).toISOString()} ${String(ms).padStart(6)} ms ${ok ? "ok " : "ERR"} ${[cmd, ...args].join(" ")} → ${out.split("\n")[0]!.slice(0, 160)}\n`);
        res.writeHead(ok ? 200 : 400, { "content-type": "text/plain; charset=utf-8" });
        res.end(out);
      });
    });
  });
  await new Promise<void>((resolve, reject) => server.once("error", reject).listen(PORT, "127.0.0.1", resolve));
  writeFileSync(SESSION_FILE, JSON.stringify({ port: PORT, target: TARGET, gfx: player.gfx, baseURL: test.info().project.use.baseURL, out: DIR }, null, 2));
  console.log(`[live] session ready on 127.0.0.1:${PORT} (${TARGET}, ${player.gfx}); commands: e2e/live/fl.mjs help`);
  await done;
  clearTimeout(idle);
  server.close();
  rmSync(SESSION_FILE, { force: true });
});

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let s = "";
    req.on("data", (c: Buffer) => (s += c.toString("utf8")));
    req.on("end", () => resolve(s));
  });
}

function makeCommands(player: Player, consoleErrors: string[]): Record<string, Command> {
  const page = player.page;
  let identity: string | null = null;

  const once = (who: string) => {
    if (identity) throw new Error(`this session already plays as ${identity}: a session is one player (\`fl quit\`, then start a new session)`);
    identity = who;
  };
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

  const goal = (spec: string | undefined, s: Snap): Goal => {
    const [kind = "", arg = ""] = (spec ?? "").split(":");
    const reach = (x: Snap) => (x.weapon?.delivery === "melee" ? 1.8 : Math.min((x.weapon?.range ?? 20) * 0.7, 18));
    const near = (surface: number) => (x: Target | null) => !!x && x.surface < surface;
    const byNpc = (id: string): Goal => ({
      label: `npc ${id}`,
      pick: (x) => x.npcs?.find((n) => n.id === id && !n.dead) ?? null,
      arrived: (x) => {
        const n = x.npcs?.find((m) => m.id === id);
        return !n || n.dead || n.dist <= reach(x);
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
          label: `the mission marker (${s.mission?.title ?? "none"})`,
          pick: (x) => (x.mission && typeof x.mission.surface === "number" ? (x.mission as Target) : null),
          arrived: (x) => !x.mission || (x.mission.surface ?? 99) < 3,
        };
      case "gate": {
        const g = nearest(s.gates);
        if (!g) throw new Error("no gate here (gates exist in Portus and the walled outposts)");
        return { label: `gate ${g.i}`, pick: (x) => x.gates?.[g.i] ?? null, arrived: (x) => near(3)(x.gates?.[g.i] ?? null) };
      }
      case "dummy": {
        const d = nearest(s.dummies, (x) => !x.down);
        if (!d) throw new Error("no standing training dummy in view");
        return { label: `dummy ${d.i}`, pick: (x) => x.dummies?.[d.i] ?? null, arrived: (x) => (x.dummies?.[d.i]?.dist ?? 0) <= reach(x) };
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
        await player.lock();
        return brief(await player.snap());
      },
    },
    esc: {
      usage: "esc",
      help: "Esc the way desktop Chrome does it (releases the lock / opens or closes the menu)",
      async run() {
        await player.escape();
        await page.waitForTimeout(300);
        return brief(await player.snap());
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
        return `${pre}${ok ? "arrived at" : "did not reach"} ${g.label}\n${await state()}`;
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
      help: "left-click n times (default 1) and report what the server said",
      async run([n = "1"]) {
        const pre = await ensureLock();
        const since = await player.now();
        for (let i = 0; i < Number(n); i++) {
          await player.attack();
          await page.waitForTimeout(450);
        }
        const r = await player.attackResult(since, 1200);
        return `${pre}sent ${r.sent.join(",") || "nothing"} · server ${r.accepted ? "accepted" : "did not echo"} the attack · denied ${r.denied.join(",") || "none"}${r.toasts.length ? ` · toasts ${r.toasts.map((t) => `"${t}"`).join(" ")}` : ""}\n${brief(await player.snap())}`;
      },
    },
    fight: {
      usage: "fight [sec]",
      help: "find the nearest hostile, close in, aim and attack until it pays XP, you die, or sec pass (default 60)",
      async run([sec = "60"]) {
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
          const g = goal(`npc:${foe.id}`, s);
          // Walls stop shots (D43): from behind one, go round it toward the foe one step at a time.
          const line = (await player.clearance([foe.bearing], foe.surface))?.[0]?.clear ?? foe.surface;
          if (line < foe.surface - 1.5) {
            const go = await player.steer(foe.bearing, Math.min(4, foe.surface), s);
            if (Math.abs(go.bearing) > 8) await player.turn(go.bearing);
            await player.hold(["KeyW"], 600);
            continue;
          }
          if (!g.arrived(s)) {
            await player.walkTo(g.pick, g.arrived, { timeoutMs: 5000 });
            continue;
          }
          await player.aim(g.pick);
          await player.attack();
          shots++;
          await page.waitForTimeout(450);
        }
        const s = await player.snap();
        const gained = (s.you?.xp ?? 0) - xp0;
        const verdict = s.player?.dead ? "you died" : (s.you?.level ?? 1) > level0 ? `level up to ${s.you?.level}` : gained > 0 ? `killed it: +${gained} XP` : "no kill in time";
        return `${pre}${verdict} · ${shots} attacks · fought ${[...foes].join(", ") || "nothing (no hostile found)"}\n${await state()}`;
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
        return `${bad.length ? `FAIL: ${bad.join(", ")}` : "pass: no blinking"} · ${f.frames} frames p50 ${f.p50.toFixed(1)} ms p95 ${f.p95.toFixed(1)} ms max ${f.max.toFixed(0)} ms · luma samples ${r.probe.samples}`;
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
        return brief(await player.snap());
      },
    },
  };
  return commands;
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
    s.stage + (s.loading ? ` (${s.loading})` : ""),
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
function describe(s: Snap, events: FlEvent[]): string {
  const lines = [brief(s)];
  const p = s.player;
  if (s.zone) lines.push(`zone label "${s.zone.labelText ?? s.zone.label ?? "-"}" · server ${s.zone.server ?? "?"} · local ${s.zone.local ?? "?"} · ${s.zone.toSafe !== null && s.zone.toSafe !== undefined ? `${n0(Math.abs(s.zone.toSafe))} m ${s.zone.local === "safe" ? "to the edge" : "back to safety"}` : ""}`);
  if (p) {
    const starter = p.starter !== null && p.starter !== undefined ? STARTERS[p.starter] ?? `starter ${p.starter}` : "?";
    lines.push(`me ${p.name ?? "?"} (${starter}) Lv ${s.you?.level ?? p.level ?? "?"} · HP ${n0(p.hp)} · XP ${s.you?.xp ?? "?"}/${s.you?.xpToNext ?? "?"} · coins ${s.you?.coins ?? "?"} · ${p.protected ? "spawn-protected" : "unprotected"}${p.inCombat ? " · in combat" : ""}${p.swimming ? " · swimming" : ""} · anim ${p.clip ?? p.anim}`);
  }
  if (s.weapon) lines.push(`weapon ${s.weapon.name} (${s.weapon.delivery}, range ${s.weapon.range} m) · hotbar ${(s.hotbar ?? []).map((h) => (h ? h.id : "-")).join(" ")}`);
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
      return `${e.tagName.toLowerCase()}${e.dataset.e2e ? `[${e.dataset.e2e}]` : ""} "${label}"`;
    });
    return { text, controls };
  });
  return `${r.text.slice(0, 2500)}\n--- controls (${r.controls.length}) ---\n${r.controls.slice(0, 40).join("\n")}`;
}
