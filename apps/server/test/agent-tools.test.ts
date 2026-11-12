// The agent front ends (tools/agent) playing for real against the in-process server: a model's
// session over MCP, a shell's session over the HTTP bridge, and the scripted hunter (the demo).

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { FirstlightAgent } from "@firstlight/agent-kit";
import { runHunter } from "@firstlight/agent-tools/examples/hunter";
import { handleRpc } from "@firstlight/agent-tools/mcp";
import { bridge } from "@firstlight/agent-tools/serve";
import { Session } from "@firstlight/agent-tools/tools";
import type { Game } from "../src/app.ts";
import { NPC_TUNING } from "../src/world/npc/index.ts";
import { liveRooms } from "../src/social/index.ts";
import { resetAgentSlots } from "../src/world/agents.ts";
import { grantTravel, startServer, waitFor } from "./helpers.ts";

let game: Game;
let url: string;
const sessions: Session[] = [];

beforeAll(async () => {
  game = await startServer();
  NPC_TUNING.ambient = true; // the hunter needs the world's own creatures
  url = `http://127.0.0.1:${game.port}`;
});

afterEach(async () => {
  for (const s of sessions.splice(0)) await s.agent?.close();
  resetAgentSlots();
});

afterAll(async () => {
  await game.close();
});

const flagged = (name: string) => [...liveRooms].flatMap((r) => [...r.actors.values()]).find((a) => a.identity.name === name);

describe("a model plays over MCP", () => {
  it("joins, looks, walks, uses its inventory and leaves, all through tools/call", async () => {
    const s = new Session();
    sessions.push(s);
    let id = 0;
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const r = (await handleRpc(s, { jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: args } })) as any;
      expect(r.id).toBe(id);
      return { text: r.result.content[0].text as string, isError: r.result.isError as boolean };
    };
    const join = await call("firstlight_join", { url, name: "McpScout", dev: true, starter: "ninja" });
    expect(join.isError).toBe(false);
    expect(join.text).toContain("McpScout [AI] L1 on portus");
    expect(join.text).toContain("SAFE zone (town)");
    expect(join.text).toContain('"starter":"ninja"');
    // The server has it as an agent: flagged for everyone.
    await waitFor(() => !!flagged("McpScout"));
    expect(flagged("McpScout")!.identity.agent).toBe(true);
    expect(flagged("McpScout")!.state.agent).toBe(true);

    const look = await call("firstlight_observe");
    expect(look.text).toContain("Weapon Ember Kunai");
    expect(look.text).toContain("portal:arcadia");
    const full = await call("firstlight_observe", { detail: "full" });
    const obs = JSON.parse(full.text.slice(full.text.indexOf("\n{") + 1)) as { observation: { self: { pos: number[]; hotbar: unknown[] }; portals: unknown[] } };
    expect(obs.observation.portals).toHaveLength(3);
    expect(obs.observation.self.hotbar.length).toBeGreaterThan(0);

    const walk = await call("firstlight_move", { bearing: 200, distance: 12 });
    expect(walk.isError).toBe(false);
    expect(JSON.parse(walk.text)).toMatchObject({ ok: true, corrections: 0, now: expect.stringContaining("McpScout [AI]") });
    expect((await call("firstlight_move", { target: "portal:arcadia" })).isError).toBe(false);
    // Refusals come back as tool errors with the reason and what to do.
    const fight = await call("firstlight_attack", { target: "n999" });
    expect(fight.isError).toBe(true);
    expect(JSON.parse(fight.text)).toMatchObject({ ok: false, reason: "unknown target" });
    const guide = JSON.parse((await call("firstlight_move", { target: "guide" })).text);
    expect(guide).toMatchObject({ ok: false, reason: "no guide here" });
    expect(JSON.parse((await call("firstlight_item", { action: "select", slot: 1 })).text)).toMatchObject({ ok: true, slot: 1 });
    expect(JSON.parse((await call("firstlight_say", { phrase: "Thanks" })).text)).toMatchObject({ ok: true, said: "Thanks" });
    expect(JSON.parse((await call("firstlight_travel", {})).text)).toMatchObject({ ok: false, reason: "bad target" });
    // Spells: a tight schema, the kit's own checks, and the server's refusal (no spells in the town).
    expect(JSON.parse((await call("firstlight_cast", { spell: "spark", bearing: 90 })).text)).toMatchObject({ ok: false, reason: "bad arguments", hint: '"spell" must be one of skipstep, frostbloom, wishfall, glasswing' });
    expect(JSON.parse((await call("firstlight_cast", { spell: "wishfall", target: "n1", bearing: 90 })).text)).toMatchObject({ ok: false, reason: "bad arguments", hint: "aim with one of target, bearing or pos" });
    expect(JSON.parse((await call("firstlight_cast", { spell: "skipstep", pos: [1, 2, 3] })).text)).toMatchObject({ ok: false, reason: "bad arguments" });
    expect(JSON.parse((await call("firstlight_cast", { spell: "frostbloom" })).text)).toMatchObject({ ok: false, reason: "locked" });
    expect(JSON.parse((await call("firstlight_cast", { spell: "skipstep", bearing: 90 })).text)).toMatchObject({ ok: false, reason: "safe zone", hint: expect.stringContaining("walk out") });
    // The trials: taken from Sela Marchbank here in Portus, played on the planets.
    expect(JSON.parse((await call("firstlight_trial", { mission: "A1" })).text)).toMatchObject({ ok: false, reason: "bad arguments" });
    expect(JSON.parse((await call("firstlight_trial", { mission: "T1" })).text)).toMatchObject({ ok: false, reason: "not accepted", hint: expect.stringContaining("Sela Marchbank") });
    expect(JSON.parse((await call("firstlight_move", { target: "curator" })).text)).toMatchObject({ ok: true, corrections: 0 });
    const offers = JSON.parse((await call("firstlight_missions", { action: "list" })).text);
    expect(offers.offers.map((m: { id: string }) => m.id)).toEqual(["T1", "T2", "T3"]);
    expect(offers.hunt).toMatchObject({ name: "The Three Gleams", gleams: 0, of: 3 });
    expect(JSON.parse((await call("firstlight_missions", { action: "take", ids: ["T1"] })).text)).toMatchObject({ ok: true, from: "Sela Marchbank", taken: [{ id: "T1", type: "race", on: "arcadia" }] });
    expect(JSON.parse((await call("firstlight_trial", { mission: "T1" })).text)).toMatchObject({ ok: false, reason: "wrong body" });
    expect((await call("firstlight_observe")).text).toContain("T1 The Swift Gleam 0/8 [race idle]");

    expect(JSON.parse((await call("firstlight_leave")).text)).toMatchObject({ ok: true, left: true });
    await waitFor(() => !flagged("McpScout"));
    expect((await call("firstlight_observe")).isError).toBe(true);
  }, 60_000);
});

describe("a shell plays over the HTTP bridge", () => {
  let server: Server | null = null;
  afterEach(async () => {
    await new Promise<void>((ok) => (server ? server.close(() => ok()) : ok()));
    server = null;
  });

  it("joins, travels through the portal, takes a mission and quits", async () => {
    const s = new Session();
    sessions.push(s);
    let quit = false;
    const handler = bridge(s, () => (quit = true));
    server = createServer((req, res) => void handler(req, res));
    await new Promise<void>((ok) => server!.listen(0, "127.0.0.1", ok));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const post = async (tool: string, args: Record<string, unknown> = {}) => (await (await fetch(`${base}/${tool}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(args) })).json()) as Record<string, any>;

    expect(await post("join", { url, name: "ShellScout", dev: true })).toMatchObject({ ok: true, name: "ShellScout", body: "portus", starter: "unit7" });
    expect(((await (await fetch(`${base}/`)).json()) as { playing: boolean }).playing).toBe(true);
    expect(await post("move", { target: "portal:arcadia", sprint: true })).toMatchObject({ ok: true, corrections: 0 });
    const through = await post("travel", { portal: "arcadia" });
    expect(through).toMatchObject({ ok: true, body: "arcadia" });
    expect(through.now).toContain("ShellScout [AI] L1 on arcadia");
    expect(await post("move", { target: "guide" })).toMatchObject({ ok: true });
    const taken = await post("missions", { action: "take", ids: ["A1"] });
    expect(taken.taken).toEqual([expect.objectContaining({ id: "A1", name: "Pest Control" })]);
    const seen = (await (await fetch(`${base}/observe?detail=full`)).json()) as Record<string, any>;
    expect(seen.summary).toContain("A1 Pest Control 0/8");
    expect(seen.observation.missions).toHaveLength(1);
    expect(await post("shop", { action: "list" })).toMatchObject({ ok: false, reason: "too far" });
    expect(await post("move", { target: "shop" })).toMatchObject({ ok: true });
    const goods = await post("shop", { action: "list" });
    expect(goods).toMatchObject({ ok: true, shop: "Dawnpad Trading Post", keeper: "Pell Hayward" });
    expect(goods.sells.find((x: { id: string }) => x.id === "tonic_small")).toMatchObject({ price: 10, tier: 1 });
    expect(await post("shop", { action: "buy", item: "tonic_small" })).toMatchObject({ ok: false, reason: "coins" });
    expect(await (await fetch(`${base}/quit`, { method: "POST" })).json()).toMatchObject({ ok: true, left: true });
    expect(quit).toBe(true);
    await waitFor(() => !flagged("ShellScout"));
  }, 90_000);
});

describe("the example hunter", () => {
  it("takes the hunt mission, leaves the outpost, kills creatures and is never corrected", async () => {
    grantTravel("hunterT", "arcadia", { starter: 3 });
    const agent = new FirstlightAgent();
    const lines: string[] = [];
    try {
      await agent.connect({ url, token: "dev:hunterT:Hunter_T", body: "arcadia", starter: "unit7" });
      const report = await runHunter(agent, { budgetMs: 240_000, mission: "A1", log: (l) => lines.push(l), until: (r) => r.kills >= 2 && !!r.collect?.done });
      expect(report.mission.taken, lines.join("\n")).toBe(true);
      // Kite Season (a collect near the pad): taken with the hunt and finished on the way out.
      expect(report.collect, lines.join("\n")).toMatchObject({ id: "A4", taken: true, progress: 5, goal: 5, done: true });
      expect(lines.some((l) => l.startsWith("A4 Kite Season: done"))).toBe(true);
      expect(report.kills, lines.join("\n")).toBeGreaterThanOrEqual(2);
      expect(report.corrections).toBe(0);
      expect(report.deaths).toBe(0);
      expect(agent.observe().self.zone).toBe("danger");
      expect(lines.some((l) => l.startsWith("take mission A1: ok"))).toBe(true);
      expect(lines.some((l) => l.startsWith("take mission A4: ok"))).toBe(true);
    } finally {
      await agent.close();
    }
  }, 300_000);
});

describe("the real processes (Node runs the .ts sources directly)", () => {
  const TOOLS_DIR = join(import.meta.dirname, "../../../tools/agent");
  const children: ChildProcess[] = [];
  afterEach(() => {
    for (const c of children.splice(0)) c.kill();
  });

  it("node tools/agent/mcp.ts speaks clean JSON-RPC on stdout and plays", async () => {
    const child = spawn(process.execPath, [join(TOOLS_DIR, "mcp.ts")], { env: { ...process.env, FL_URL: url, FL_DEV: "1", FL_AGENT_NAME: "StdioScout", FL_AGENT_SESSION: "none" }, stdio: ["pipe", "pipe", "pipe"] });
    children.push(child);
    const lines: string[] = [];
    const waiting = new Map<number, (m: any) => void>();
    createInterface({ input: child.stdout! }).on("line", (line) => {
      lines.push(line);
      try {
        const m = JSON.parse(line);
        waiting.get(m.id)?.(m);
      } catch {
        /* the assertion below reports it */
      }
    });
    let id = 0;
    const rpc = (method: string, params?: unknown) =>
      new Promise<any>((ok, fail) => {
        const n = ++id;
        const timer = setTimeout(() => fail(new Error(`no answer to ${method}`)), 60_000);
        waiting.set(n, (m) => (clearTimeout(timer), ok(m)));
        child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id: n, method, ...(params ? { params } : {}) })}\n`);
      });
    const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } });
    expect(init.result.serverInfo.name).toBe("firstlight-agent");
    child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    expect((await rpc("tools/list")).result.tools.length).toBeGreaterThanOrEqual(15);
    const joined = await rpc("tools/call", { name: "firstlight_join", arguments: {} });
    expect(joined.result.isError).toBe(false);
    expect(joined.result.content[0].text).toContain("StdioScout [AI] L1 on portus");
    const walked = await rpc("tools/call", { name: "firstlight_move", arguments: { bearing: 180, distance: 6 } });
    expect(JSON.parse(walked.result.content[0].text)).toMatchObject({ ok: true, corrections: 0 });
    expect((await rpc("tools/call", { name: "firstlight_leave", arguments: {} })).result.isError).toBe(false);
    // Nothing but protocol on stdout (library chatter goes to stderr).
    for (const line of lines) expect(() => JSON.parse(line), line).not.toThrow();
    expect(lines.length).toBe(id);
  }, 120_000);

  it("node tools/agent/serve.ts and fl-agent.mjs: a shell session", async () => {
    const probe = createServer();
    await new Promise<void>((ok) => probe.listen(0, "127.0.0.1", ok));
    const port = String((probe.address() as AddressInfo).port);
    await new Promise<void>((ok) => probe.close(() => ok()));
    const env = { ...process.env, FL_URL: url, FL_DEV: "1", FL_AGENT_PORT: port, FL_AGENT_SESSION: "none" };
    const bridgeProc = spawn(process.execPath, [join(TOOLS_DIR, "serve.ts")], { env, stdio: ["ignore", "ignore", "pipe"] });
    children.push(bridgeProc);
    await new Promise<void>((ok, fail) => {
      const timer = setTimeout(() => fail(new Error("the bridge didn't start")), 60_000);
      createInterface({ input: bridgeProc.stderr! }).on("line", (l) => l.includes("agent bridge on") && (clearTimeout(timer), ok()));
    });
    const cli = (...args: string[]) =>
      new Promise<{ code: number; out: string }>((ok) => execFile(process.execPath, [join(TOOLS_DIR, "fl-agent.mjs"), ...args], { env, timeout: 60_000 }, (err, stdout, stderr) => ok({ code: err ? ((err as { code?: number }).code ?? 1) : 0, out: `${stdout}${stderr}` })));
    const before = await cli("observe");
    expect(before.code).toBe(1);
    expect(before.out).toContain("call firstlight_join first");
    const joined = await cli("join", "--name", "CliScout", "--starter", "ash");
    expect(joined.code, joined.out).toBe(0);
    expect(joined.out).toContain("CliScout [AI] L1 on portus");
    expect(joined.out).toContain("Weapon Sunbrand");
    const moved = await cli("move", "--bearing", "20", "--distance", "5");
    expect(moved.code, moved.out).toBe(0);
    expect(JSON.parse(moved.out)).toMatchObject({ ok: true, corrections: 0 });
    expect((await cli("move", "portal:arcadia", "--sprint")).code).toBe(0);
    const look = await cli("observe");
    expect(look.out).toContain("portal:arcadia");
    const bad = await cli("attack", "n1", "--seconds", "500");
    expect(bad.code).toBe(1);
    expect(bad.out).toContain("must be at most 120");
    // Spells and trials from the shell: the main argument is the spell or the mission.
    const cast = await cli("cast", "skipstep", "--bearing", "180");
    expect(cast.code).toBe(1);
    expect(JSON.parse(cast.out)).toMatchObject({ ok: false, reason: "safe zone" });
    const star = await cli("cast", "wishfall", "--pos", "1,2");
    expect(JSON.parse(star.out)).toMatchObject({ ok: false, reason: "bad arguments", hint: '"pos" needs at least 3 item(s)' });
    const trial = await cli("trial", "T1");
    expect(trial.code).toBe(1);
    expect(JSON.parse(trial.out)).toMatchObject({ ok: false, reason: "not accepted" });
    const tools = (await cli("tools")).out;
    expect(tools).toContain("move  --target --bearing --distance");
    expect(tools).toContain("cast  --spell <skipstep|frostbloom|wishfall|glasswing> --target --bearing --distance --pos");
    expect(tools).toContain("trial  --mission <A4|H4|T1|T2|T3>");
    expect(JSON.parse((await cli("quit")).out)).toEqual({ ok: true, left: true });
    await new Promise<void>((ok) => (bridgeProc.exitCode !== null ? ok() : bridgeProc.once("exit", () => ok())));
    expect((await cli("observe")).code).toBe(2); // no bridge any more
  }, 180_000);
});
