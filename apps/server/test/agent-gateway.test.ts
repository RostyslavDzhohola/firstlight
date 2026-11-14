// The hosted agent gateway (D-agents-gw-1) driven through its real paths: the plain HTTP API a model
// with only curl uses, and the remote MCP endpoint in both protocol eras, against the in-process
// server. The seats are kit agents joined over loopback through /api/play, so they are flagged.

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { FirstlightAgent } from "@firstlight/agent-kit";
import { Session, TOOL_BY_NAME, type ToolDef } from "@firstlight/agent-tools/tools";
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

// Review 2026-11-13 (agent gateway, GPT-6.1 Sol): #1 unbounded queued work, #3 concurrent legacy
// joins orphaning seats, #4 legacy notifications/cancelled acknowledged but ignored. Driven over the
// real HTTP paths; only the action itself is held (firstlight_say waits until released or stopped)
// so the queue can be seen filling up.
describe("review 2026-11-13: queues, cancellation and joins hold against a hostile caller", () => {
  /** Hold firstlight_say until released or stopped; record what started and how many stops came. */
  function holdSay() {
    const say = TOOL_BY_NAME.get("firstlight_say") as ToolDef;
    const run = say.run;
    const started: string[] = [];
    let running: ((r: Record<string, unknown>) => void) | null = null;
    let stops = 0;
    say.run = (_s, a) => new Promise((ok) => (started.push(a.phrase), (running = ok)));
    const stop = vi.spyOn(FirstlightAgent.prototype, "stop").mockImplementation(async () => {
      stops++;
      running?.({ ok: false, reason: "cancelled", hint: "stopped" });
      return { ok: true };
    });
    const calls = vi.spyOn(Session.prototype, "call");
    return {
      started,
      stops: () => stops,
      release: () => running?.({ ok: true }),
      /** The session behind the latest firstlight_say call. */
      session: () => calls.mock.contexts.findLast((_c, i) => calls.mock.calls[i]![0] === "firstlight_say") as Session | undefined,
      restore() {
        say.run = run;
        stop.mockRestore();
        calls.mockRestore();
      },
    };
  }
  const within = <T>(p: Promise<T>, ms: number, what: string) => Promise.race([p, new Promise<never>((_ok, fail) => setTimeout(() => fail(new Error(`no answer in ${ms} ms: ${what}`)), ms))]);

  it("HTTP API: a full seat queue answers 429 at once; a hung-up waiting call never runs and stops nothing", async () => {
    GATEWAY_RULES.queuePerSeat = 3;
    const ip = "198.51.100.40";
    const joined = await json(await fetch(`${base}/api/agent/join`, { method: "POST", headers: { "content-type": "application/json", ...from(ip) }, body: '{"name":"QueueSeat"}' }));
    expect(joined.body.ok, JSON.stringify(joined.body)).toBe(true);
    const auth = { authorization: `Bearer ${joined.body.seat}`, "content-type": "application/json", ...from(ip) };
    const act = (phrase: string, signal?: AbortSignal) => fetch(`${base}/api/agent/act`, { method: "POST", headers: auth, body: JSON.stringify({ tool: "say", phrase }), signal });
    const h = holdSay();
    try {
      const gg = act("GG");
      await waitFor(() => h.started.length === 1);
      const s = h.session()!;
      const hangUp = new AbortController();
      const thanks = act("Thanks", hangUp.signal).catch(() => null);
      const helpGone = new AbortController();
      const help = act("Help!", helpGone.signal).catch(() => null);
      await waitFor(() => s.pending === 3);
      // Past the bound: refused at once, not parked for later.
      const full = await within(act("Truce?"), 5000, "a call past the queue bound");
      expect(full.status).toBe(429);
      expect(full.headers.get("retry-after")).toBeTruthy();
      expect(await full.json()).toMatchObject({ ok: false, reason: "queue full" });
      // A waiting caller hangs up: its call leaves the queue; the running action goes on.
      hangUp.abort();
      await thanks;
      await waitFor(() => s.pending === 2);
      expect(h.stops()).toBe(0);
      h.release();
      expect((await gg).status).toBe(200);
      await waitFor(() => h.started.length === 2);
      expect(h.started).toEqual(["GG", "Help!"]);
      // The running caller hangs up: its action is stopped.
      helpGone.abort();
      await help;
      await waitFor(() => h.stops() === 1 && s.pending === 0);
    } finally {
      h.restore();
      await fetch(`${base}/api/agent/leave`, { method: "POST", headers: auth });
    }
    await waitFor(() => !actor("QueueSeat"));
  }, 60_000);

  /** A 2025-era MCP client calling from `ip`. */
  const legacy = (ip: string) => {
    let id = 100;
    const post = (body: Record<string, unknown>, sid?: string, signal?: AbortSignal) =>
      fetch(`${base}/mcp`, { method: "POST", signal, headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...from(ip), ...(sid ? { "mcp-session-id": sid, "mcp-protocol-version": "2025-11-25" } : {}) }, body: JSON.stringify({ jsonrpc: "2.0", ...body }) });
    return {
      post,
      async open(): Promise<string> {
        const init = await post({ id: ++id, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1" } } });
        return init.headers.get("mcp-session-id")!;
      },
      call: (sid: string, rid: number, name: string, args: Record<string, unknown>) => post({ id: rid, method: "tools/call", params: { name, arguments: args } }, sid).then((r) => r.json() as Promise<any>),
      del: (sid: string) => fetch(`${base}/mcp`, { method: "DELETE", headers: { "mcp-session-id": sid } }),
    };
  };

  it("legacy MCP: notifications/cancelled stops the running call, and a waiting one never runs", async () => {
    const m = legacy("198.51.100.42");
    const sid = await m.open();
    const cj = await m.call(sid, 1, "firstlight_join", { name: "CancelSeat" });
    expect(cj.result.isError, JSON.stringify(cj)).toBe(false);
    const h = holdSay();
    try {
      const running = m.call(sid, 41, "firstlight_say", { phrase: "GG" });
      await waitFor(() => h.started.length === 1);
      const s = h.session()!;
      const waiting = m.call(sid, 42, "firstlight_say", { phrase: "Thanks" });
      await waitFor(() => s.pending === 2);
      // Cancel the waiting one: it leaves the queue (its POST still gets an answer; the client ignores it).
      expect((await m.post({ method: "notifications/cancelled", params: { requestId: 42, reason: "changed my mind" } }, sid)).status).toBe(202);
      expect((await within(waiting, 5000, "the cancelled waiting call")).result.content[0].text).toContain("cancelled");
      expect(s.pending).toBe(1);
      expect(h.stops()).toBe(0);
      // Cancel the running one: the character stops.
      expect((await m.post({ method: "notifications/cancelled", params: { requestId: 41 } }, sid)).status).toBe(202);
      await within(running, 5000, "the cancelled running call");
      expect(h.stops()).toBe(1);
      expect(h.started).toEqual(["GG"]);
      // Another session can't cancel this one's requests, and unknown ids are ignored.
      const other = await m.open();
      const third = m.call(sid, 43, "firstlight_say", { phrase: "Help!" });
      await waitFor(() => h.started.length === 2);
      expect((await m.post({ method: "notifications/cancelled", params: { requestId: 43 } }, other)).status).toBe(202);
      expect((await m.post({ method: "notifications/cancelled", params: { requestId: 999 } }, sid)).status).toBe(202);
      expect(h.stops()).toBe(1);
      h.release();
      expect((await third).result.isError).toBe(false);
      await m.del(other);
    } finally {
      h.restore();
      await m.del(sid);
    }
    await waitFor(() => !actor("CancelSeat"));
  }, 60_000);

  /** Hold every seat's sign-in until `open()`; counts how many joins reached it. */
  function holdJoins() {
    const connect = FirstlightAgent.prototype.connect;
    let open!: () => void;
    const gate = new Promise<void>((ok) => (open = ok));
    let entered = 0;
    const spy = vi.spyOn(FirstlightAgent.prototype, "connect").mockImplementation(async function (this: FirstlightAgent, o) {
      entered++;
      await gate;
      return connect.call(this, o);
    });
    return { open: () => open(), entered: () => entered, restore: () => spy.mockRestore() };
  }

  it("legacy MCP: two joins at once seat one character, and DELETE leaves nothing behind", async () => {
    const m = legacy("198.51.100.43");
    const sid = await m.open();
    const j = holdJoins();
    try {
      const a = m.call(sid, 1, "firstlight_join", { name: "TwinA" });
      const b = m.call(sid, 2, "firstlight_join", { name: "TwinB" });
      await waitFor(() => j.entered() >= 1);
      // Let the second request reach the server before the first join finishes.
      expect((await m.post({ id: 3, method: "ping" }, sid)).status).toBe(200);
      j.open();
      const answers = (await Promise.all([a, b])).map((r) => r.result.content[0].text as string);
      expect(answers.filter((t) => t.includes('"already playing"'))).toHaveLength(1);
      expect(j.entered()).toBe(1);
    } finally {
      j.restore();
    }
    await waitFor(() => !!actor("TwinA") || !!actor("TwinB"));
    expect((await m.del(sid)).status).toBe(204);
    await waitFor(() => !actor("TwinA") && !actor("TwinB"), 15_000);
  }, 60_000);

  it("legacy MCP: a session deleted while its join is awaited closes the seat the join made", async () => {
    const m = legacy("198.51.100.44");
    const sid = await m.open();
    const j = holdJoins();
    let joined: Promise<any>;
    try {
      joined = m.call(sid, 1, "firstlight_join", { name: "LateSeat" });
      await waitFor(() => j.entered() === 1);
      expect((await m.del(sid)).status).toBe(204);
      j.open();
      expect((await joined).result.content[0].text).toContain("session ended");
    } finally {
      j.restore();
    }
    await waitFor(() => !actor("LateSeat"), 15_000);
    // Stays gone (the seat is closed, not idle).
    await new Promise((ok) => setTimeout(ok, 500));
    expect(actor("LateSeat")).toBeUndefined();
  }, 60_000);

  it("a caller that hangs up while it joins leaves no seat behind", async () => {
    const j = holdJoins();
    const gone = new AbortController();
    try {
      const r = fetch(`${base}/api/agent/join`, { method: "POST", signal: gone.signal, headers: { "content-type": "application/json", ...from("198.51.100.41") }, body: '{"name":"GoneSeat"}' }).catch(() => null);
      await waitFor(() => j.entered() === 1);
      gone.abort();
      await r;
      j.open();
    } finally {
      j.restore();
    }
    await waitFor(() => !!actor("GoneSeat"), 15_000).catch(() => {});
    await waitFor(() => !actor("GoneSeat"), 15_000);
    expect((await json(await fetch(`${base}/api/agent`))).body.seats.used).toBe(0);
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
