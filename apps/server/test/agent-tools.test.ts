// The agent front ends (tools/agent) playing for real against the in-process server: a model's
// session over MCP, a shell's session over the HTTP bridge, and the scripted hunter (the demo).

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
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
    expect(look.text).toContain("portal to arcadia");
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
    expect(JSON.parse((await call("firstlight_cast", { spell: "spark", bearing: 90 })).text)).toMatchObject({ ok: true, sent: true });

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
      const report = await runHunter(agent, { budgetMs: 150_000, mission: "A1", log: (l) => lines.push(l), until: (r) => r.kills >= 2 });
      expect(report.mission.taken, lines.join("\n")).toBe(true);
      expect(report.kills, lines.join("\n")).toBeGreaterThanOrEqual(2);
      expect(report.corrections).toBe(0);
      expect(report.deaths).toBe(0);
      expect(agent.observe().self.zone).toBe("danger");
      expect(lines.some((l) => l.startsWith("take mission A1: ok"))).toBe(true);
    } finally {
      await agent.close();
    }
  }, 180_000);
});
