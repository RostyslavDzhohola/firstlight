// The hosted agent gateway (D-agents-gw-1) driven through its real paths: the plain HTTP API a model
// with only curl uses, and the remote MCP endpoint in both protocol eras, against the in-process
// server. The seats are kit agents joined over loopback through /api/play, so they are flagged.

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Game } from "../src/app.ts";
import { GATEWAY_RULES } from "../src/agents/gateway.ts";
import { AGENT_RULES, resetAgentSlots } from "../src/world/agents.ts";
import { liveRooms } from "../src/social/index.ts";
import { startServer, waitFor } from "./helpers.ts";
import { startAuthServer } from "./auth-helpers.ts";

let game: Game;
let base: string;
const saved = { ...GATEWAY_RULES };
const savedPerIp = AGENT_RULES.perIp;

beforeAll(async () => {
  game = await startServer();
  base = `http://127.0.0.1:${game.port}`;
});

afterEach(async () => {
  Object.assign(GATEWAY_RULES, saved);
  AGENT_RULES.perIp = savedPerIp;
  AGENT_RULES.enabled = true;
  resetAgentSlots();
});

afterAll(async () => {
  await game.close();
});

const actor = (name: string) => [...liveRooms].flatMap((r) => [...r.actors.values()]).find((a) => a.identity.name === name);
const json = async (res: Response) => ({ status: res.status, body: (await res.json()) as Record<string, any> });
/** A caller somewhere else: the gateway reads the edge's X-Real-IP like /api/play does. */
const from = (ip: string) => ({ "x-real-ip": ip });

describe("the plain HTTP API", () => {
  it("joins with a bare curl body, plays, and leaves; the character wears the AI chip", async () => {
    const info = await json(await fetch(`${base}/api/agent`));
    expect(info.body).toMatchObject({ ok: true, enabled: true, mcp: "/mcp", seats: { used: 0, max: GATEWAY_RULES.seats } });
    expect(info.body.tools.map((t: { name: string }) => t.name)).toContain("move");
    expect(info.body.tools.find((t: { name: string }) => t.name === "join").inputSchema.properties).not.toHaveProperty("url");

    // curl -d sends a form content type: the gateway reads the JSON anyway.
    const joined = await json(await fetch(`${base}/api/agent/join`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...from("203.0.113.7") }, body: '{"name":"CurlScout","starter":"ash"}' }));
    expect(joined.status).toBe(200);
    expect(joined.body).toMatchObject({ ok: true, name: "CurlScout", body: "portus", starter: "ash" });
    expect(joined.body.look).toContain("CurlScout [AI] L1 on portus");
    expect(joined.body.howto).toContain("Authorization: Bearer");
    const seat = joined.body.seat as string;
    expect(seat).toMatch(/^[A-Za-z0-9_-]{32}$/);
    await waitFor(() => !!actor("CurlScout"));
    expect(actor("CurlScout")!.identity.agent).toBe(true);
    expect(actor("CurlScout")!.state.agent).toBe(true);
    // Counted against the caller's address, not loopback.
    expect(actor("CurlScout")!.identity.agentIp).toBe("203.0.113.7");

    const auth = { authorization: `Bearer ${seat}`, ...from("203.0.113.7") };
    const look = await json(await fetch(`${base}/api/agent/observe?detail=full`, { headers: auth }));
    expect(look.body.summary).toContain("SAFE zone (town)");
    expect(look.body.observation.portals).toHaveLength(3);
    const walk = await json(await fetch(`${base}/api/agent/act`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ tool: "move", bearing: 200, distance: 10 }) }));
    expect(walk.body).toMatchObject({ ok: true, corrections: 0, now: expect.stringContaining("CurlScout [AI]") });
    expect((await json(await fetch(`${base}/api/agent/act`, { method: "POST", headers: auth, body: '{"tool":"say","phrase":"GG"}' }))).body).toMatchObject({ ok: true, said: "GG" });
    // A second join on a seat that plays is refused by the tool table, not a second character.
    expect((await json(await fetch(`${base}/api/agent/act`, { method: "POST", headers: auth, body: '{"tool":"join"}' }))).body).toMatchObject({ ok: false, reason: "already playing" });

    const left = await json(await fetch(`${base}/api/agent/leave`, { method: "POST", headers: auth }));
    expect(left.body).toMatchObject({ ok: true, left: true });
    await waitFor(() => !actor("CurlScout"));
    expect((await json(await fetch(`${base}/api/agent/observe`, { headers: auth }))).status).toBe(401);
  }, 60_000);

  it("treats what an agent sends as hostile", async () => {
    const post = (path: string, body: string, headers: Record<string, string> = {}) => fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body });
    // No pointing the server at another host, no dev identities, no roles smuggled in a name.
    expect((await json(await post("/api/agent/join", '{"url":"http://169.254.169.254"}'))).body).toMatchObject({ ok: false, reason: "bad arguments", hint: expect.stringContaining('unknown argument "url"') });
    expect((await json(await post("/api/agent/join", '{"dev":true}'))).body).toMatchObject({ ok: false, reason: "bad arguments" });
    expect((await json(await post("/api/agent/join", '{"name":"x:y:admin"}'))).body).toMatchObject({ ok: false, reason: "bad arguments" });
    expect((await json(await post("/api/agent/join", '{"starter":"dragon"}'))).body).toMatchObject({ ok: false, reason: "bad arguments" });
    // Bodies: JSON only, and small.
    expect((await post("/api/agent/join", "{nope")).status).toBe(400);
    expect((await post("/api/agent/act", JSON.stringify({ tool: "move", target: "x".repeat(20_000) }))).status).toBe(413);
    // Web pages on other sites can't drive a seat; our own site can ask what this is.
    expect((await post("/api/agent/join", "{}", { origin: "https://evil.example" })).status).toBe(403);
    expect((await fetch(`${base}/api/agent`, { headers: { origin: "http://localhost:5173" } })).status).toBe(200);
    // No seat, a wrong seat, an unknown tool.
    expect((await json(await post("/api/agent/act", '{"tool":"observe"}'))).status).toBe(401);
    expect((await json(await post("/api/agent/act", '{"tool":"observe"}', { authorization: "Bearer not-a-seat-at-all" }))).body).toMatchObject({ ok: false, reason: "no seat" });
    expect((await post("/api/agent/act", '{"nope":1}')).status).toBe(200);
  }, 30_000);

  it("keeps the switch, the caps and the idle timeout", async () => {
    const join = (ip: string, name?: string) => fetch(`${base}/api/agent/join`, { method: "POST", headers: { "content-type": "application/json", ...from(ip) }, body: JSON.stringify(name ? { name } : {}) }).then(json);
    AGENT_RULES.enabled = false;
    expect(await join("198.51.100.1")).toMatchObject({ status: 403, body: { ok: false, reason: "agents off" } });
    expect((await json(await fetch(`${base}/api/agent`))).body).toMatchObject({ enabled: false, why: expect.stringContaining("AGENTS_ENABLED") });
    AGENT_RULES.enabled = true;

    // Per address: the agent cap (AGENTS_PER_IP) holds for gateway seats too.
    AGENT_RULES.perIp = 1;
    const a = await join("198.51.100.2", "CapOne");
    expect(a.body.ok).toBe(true);
    expect(await join("198.51.100.2")).toMatchObject({ status: 403, body: { reason: "agent limit" } });
    // The global seat cap.
    GATEWAY_RULES.seats = 1;
    expect(await join("198.51.100.3")).toMatchObject({ status: 503, body: { reason: "gateway full" } });
    GATEWAY_RULES.seats = saved.seats;
    // Joins per address per minute.
    GATEWAY_RULES.joinsPerIp = 1;
    AGENT_RULES.perIp = 4;
    await join("198.51.100.4", "RateOne");
    expect(await join("198.51.100.4")).toMatchObject({ status: 429, body: { reason: "slow down" } });

    // Idle seats close and their characters leave.
    GATEWAY_RULES.idleMs = 300;
    await waitFor(() => !actor("CapOne") && !actor("RateOne"), 15_000);
    expect((await json(await fetch(`${base}/api/agent/observe`, { headers: { authorization: `Bearer ${a.body.seat}` } }))).body).toMatchObject({ ok: false, reason: "no seat" });
  }, 60_000);
});

describe("the remote MCP endpoint", () => {
  const V = "2026-07-28";
  let rid = 0;
  /** A modern (2026-07-28) request: per-request _meta mirrored in headers. */
  const modern = async (method: string, params: Record<string, unknown> = {}, headers: Record<string, string> = {}) => {
    const name = typeof params.name === "string" ? { "mcp-name": params.name } : {};
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": V, "mcp-method": method, ...name, ...headers },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++rid, method, params: { ...params, _meta: { "io.modelcontextprotocol/protocolVersion": V, "io.modelcontextprotocol/clientCapabilities": {} } } }),
    });
    return json(res);
  };
  const text = (r: { body: Record<string, any> }) => r.body.result.content[0].text as string;

  it("2026-07-28: discover, list, join for a seat handle, play by passing it, leave", async () => {
    const d = await modern("server/discover");
    expect(d.body.result).toMatchObject({ resultType: "complete", supportedVersions: expect.arrayContaining([V, "2025-06-18"]), capabilities: { tools: {} } });
    expect(d.body.result.instructions).toContain("FIRSTLIGHT");
    const list = await modern("tools/list");
    const tools = list.body.result.tools as { name: string; inputSchema: { properties: Record<string, unknown> } }[];
    expect(tools.find((t) => t.name === "firstlight_join")!.inputSchema.properties).not.toHaveProperty("url");
    expect(tools.find((t) => t.name === "firstlight_move")!.inputSchema.properties).toHaveProperty("seat");

    const joined = await modern("tools/call", { name: "firstlight_join", arguments: { name: "McpRemote" } });
    expect(joined.body.result.isError).toBe(false);
    expect(text(joined)).toContain("McpRemote [AI] L1 on portus");
    const seat = JSON.parse(text(joined).slice(text(joined).indexOf("\n{") + 1)).seat as string;
    await waitFor(() => !!actor("McpRemote"));
    expect(actor("McpRemote")!.identity.agent).toBe(true);
    const look = await modern("tools/call", { name: "firstlight_observe", arguments: { seat } });
    expect(text(look)).toContain("McpRemote [AI]");
    const noSeat = await modern("tools/call", { name: "firstlight_observe", arguments: {} });
    expect(noSeat.body.result.isError).toBe(true);
    expect(text(noSeat)).toContain("no seat");
    expect(text(await modern("tools/call", { name: "firstlight_leave", arguments: { seat } }))).toContain('"left":true');
    await waitFor(() => !actor("McpRemote"));
  }, 60_000);

  it("2026-07-28: headers must match the body, and versions are named", async () => {
    expect(await modern("tools/list", {}, { "mcp-method": "tools/call" })).toMatchObject({ status: 400, body: { error: { code: -32020 } } });
    expect(await modern("tools/call", { name: "firstlight_observe", arguments: {} }, { "mcp-name": "firstlight_leave" })).toMatchObject({ status: 400, body: { error: { code: -32020 } } });
    // The base64 sentinel decodes before the comparison.
    expect((await modern("tools/call", { name: "firstlight_observe", arguments: {} }, { "mcp-name": `=?base64?${Buffer.from("firstlight_observe").toString("base64")}?=` })).status).toBe(200);
    const old = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", "mcp-protocol-version": "1999-01-01", "mcp-method": "tools/list" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: { "io.modelcontextprotocol/protocolVersion": "1999-01-01", "io.modelcontextprotocol/clientCapabilities": {} } } }),
    }).then(json);
    expect(old).toMatchObject({ status: 400, body: { error: { code: -32022, data: { supported: expect.arrayContaining([V]) } } } });
    expect(await modern("sampling/whatever")).toMatchObject({ status: 404, body: { error: { code: -32601 } } });
    expect((await fetch(`${base}/mcp`)).status).toBe(405);
    expect((await fetch(`${base}/mcp`, { method: "POST", headers: { origin: "https://evil.example", "content-type": "application/json" }, body: "{}" })).status).toBe(403);
    expect((await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "[1,2]" })).status).toBe(400);
  }, 30_000);

  it("2025-era clients: initialize opens a session that carries the seat; DELETE ends both", async () => {
    const post = (body: Record<string, unknown>, sid?: string) =>
      fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(sid ? { "mcp-session-id": sid, "mcp-protocol-version": "2025-06-18" } : {}) }, body: JSON.stringify({ jsonrpc: "2.0", ...body }) });
    const init = await post({ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } });
    const sid = init.headers.get("mcp-session-id")!;
    expect(sid).toBeTruthy();
    expect(((await init.json()) as any).result).toMatchObject({ protocolVersion: "2025-06-18", serverInfo: { name: "firstlight-agent" } });
    expect((await post({ method: "notifications/initialized" }, sid)).status).toBe(202);
    expect((await post({ id: 2, method: "tools/list" })).status).toBe(400); // no session id
    expect((await post({ id: 2, method: "tools/list" }, "made-up")).status).toBe(404);
    const joined = (await (await post({ id: 3, method: "tools/call", params: { name: "firstlight_join", arguments: { name: "McpLegacy" } } }, sid)).json()) as any;
    expect(joined.result.isError).toBe(false);
    expect(joined.result.content[0].text).not.toContain('"seat"'); // the session carries it
    await waitFor(() => !!actor("McpLegacy"));
    const look = (await (await post({ id: 4, method: "tools/call", params: { name: "firstlight_observe", arguments: {} } }, sid)).json()) as any;
    expect(look.result.content[0].text).toContain("McpLegacy [AI]");
    expect((await fetch(`${base}/mcp`, { method: "DELETE", headers: { "mcp-session-id": sid } })).status).toBe(204);
    await waitFor(() => !actor("McpLegacy"));
    expect((await post({ id: 5, method: "tools/list" }, sid)).status).toBe(404);
  }, 60_000);
});

describe("seats sign in like a browser guest (the production path)", () => {
  it("makes a Better Auth guest over loopback, behind the origin secret, with the caller's address", async () => {
    const server = await startAuthServer({ originSecret: "gateway-test-origin-secret" });
    try {
      const r = await json(await fetch(`${server.base}/api/agent/join`, { method: "POST", headers: { "content-type": "application/json", ...from("192.0.2.44") }, body: '{"name":"GuestSeat"}' }));
      expect(r.body).toMatchObject({ ok: true, name: "GuestSeat", body: "portus" });
      await waitFor(() => !!actor("GuestSeat"));
      const id = actor("GuestSeat")!.identity;
      expect(id).toMatchObject({ agent: true, guest: true, account: true, agentIp: "192.0.2.44" });
      // A real guest account, flagged as an agent's for good.
      expect(server.accounts.authDb.prepare(`SELECT "isAnonymous" AS anon FROM "user" WHERE id = ?`).get(id.userId)).toEqual({ anon: 1 });
      await fetch(`${server.base}/api/agent/leave`, { method: "POST", headers: { authorization: `Bearer ${r.body.seat}` } });
      await waitFor(() => !actor("GuestSeat"));
    } finally {
      await server.close();
    }
  }, 60_000);
});
