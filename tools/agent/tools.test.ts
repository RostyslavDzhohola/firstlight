// The agent's tools as a model sees them: tight schemas with real descriptions, arguments checked
// before anything runs, and the two front ends (MCP over stdio, the local HTTP bridge) answering
// sensibly without a game. Playing through them against a server: apps/server/test/agent-tools.test.ts.

import { readdirSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { stripTypeScriptTypes } from "node:module";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { handleRpc, MCP_PROTOCOL } from "./mcp.ts";
import { bridge } from "./serve.ts";
import { callTool, checkArgs, PLAYBOOK, Session, TOOLS, TOOL_BY_NAME } from "./tools.ts";

describe("tool schemas", () => {
  it("every tool is named, described and closed to unknown arguments", () => {
    expect(TOOLS.map((t) => t.name)).toEqual(expect.arrayContaining(["firstlight_join", "firstlight_observe", "firstlight_move", "firstlight_attack", "firstlight_interact", "firstlight_travel", "firstlight_shop", "firstlight_missions", "firstlight_respawn", "firstlight_leave"]));
    expect(new Set(TOOLS.map((t) => t.name)).size).toBe(TOOLS.length);
    for (const t of TOOLS) {
      expect(t.name, t.name).toMatch(/^firstlight_[a-z]+$/);
      expect(t.description.length, t.name).toBeGreaterThanOrEqual(60);
      expect(t.description.length, t.name).toBeLessThanOrEqual(700);
      const s = t.inputSchema;
      expect(s.type).toBe("object");
      expect(s.additionalProperties).toBe(false);
      for (const r of s.required ?? []) expect(Object.keys(s.properties), `${t.name}.${r}`).toContain(r);
      for (const [k, p] of Object.entries(s.properties)) {
        expect(p.description.length, `${t.name}.${k}`).toBeGreaterThanOrEqual(8);
        expect(["string", "number", "integer", "boolean", "array"], `${t.name}.${k}`).toContain(p.type);
        // Numbers are bounded and free text is capped: nothing open-ended reaches the game.
        if (p.type === "number" || p.type === "integer") expect(p.minimum !== undefined && p.maximum !== undefined, `${t.name}.${k} bounds`).toBe(true);
        if (p.type === "string" && !p.enum) expect(p.maxLength, `${t.name}.${k} maxLength`).toBeLessThanOrEqual(200);
        if (p.type === "array") expect(p.items && p.maxItems, `${t.name}.${k} items`).toBeTruthy();
        if (p.enum) expect(p.enum.length, `${t.name}.${k}`).toBeGreaterThan(0);
      }
    }
    // The whole tool list is small enough to sit in a model's context (about 2k tokens).
    expect(Buffer.byteLength(JSON.stringify(TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }))))).toBeLessThan(12_000);
    expect(Buffer.byteLength(PLAYBOOK)).toBeLessThan(1600);
  });

  it("checks arguments against the schema", () => {
    const move = TOOL_BY_NAME.get("firstlight_move")!.inputSchema;
    expect(checkArgs(move, { target: "guide" })).toBeNull();
    expect(checkArgs(move, { bearing: 90, distance: 40, sprint: true })).toBeNull();
    expect(checkArgs(move, undefined)).toBeNull();
    expect(checkArgs(move, { bearing: 400, distance: 40 })).toBe('"bearing" must be at most 360');
    expect(checkArgs(move, { distance: "far" })).toBe('"distance" must be a number');
    expect(checkArgs(move, { speed: 99 })).toContain('unknown argument "speed"');
    expect(checkArgs(move, [1, 2])).toBe("arguments must be an object");
    const attack = TOOL_BY_NAME.get("firstlight_attack")!.inputSchema;
    expect(checkArgs(attack, {})).toBe('missing "target"');
    expect(checkArgs(attack, { target: "n1", seconds: 1e9 })).toBe('"seconds" must be at most 120');
    expect(checkArgs(attack, { target: "n1", seconds: Number.NaN })).toBe('"seconds" must be a number');
    const shop = TOOL_BY_NAME.get("firstlight_shop")!.inputSchema;
    expect(checkArgs(shop, { action: "steal" })).toBe('"action" must be one of list, buy, sell');
    expect(checkArgs(shop, { action: "buy", item: "tonic_small", qty: 2.5 })).toBe('"qty" must be a whole number');
    const missions = TOOL_BY_NAME.get("firstlight_missions")!.inputSchema;
    expect(checkArgs(missions, { action: "take", ids: ["A1", "A2"] })).toBeNull();
    expect(checkArgs(missions, { action: "take", ids: [1] })).toBe('"ids" items must be strings');
    expect(checkArgs(TOOL_BY_NAME.get("firstlight_join")!.inputSchema, { name: "ab" })).toBe('"name" is too short');
  });

  it("refuses to act before joining, and never throws", async () => {
    const s = new Session();
    expect(await callTool(s, "firstlight_observe", {})).toMatchObject({ ok: false, reason: "not in the game", hint: "call firstlight_join first" });
    expect(await callTool(s, "firstlight_move", { target: 7 })).toMatchObject({ ok: false, reason: "bad arguments" });
    expect(await callTool(s, "firstlight_fly", {})).toMatchObject({ ok: false, reason: "unknown tool" });
    // A server that isn't there: a refusal, not an exception.
    const r = await callTool(s, "firstlight_join", { url: "http://127.0.0.1:9", dev: true, name: "Nobody" });
    expect(r).toMatchObject({ ok: false });
    expect(s.agent).toBeNull();
  });
});

describe("MCP (JSON-RPC over stdio)", () => {
  const s = new Session();
  const rpc = (method: string, params?: Record<string, unknown>, id: number | undefined = 1) => handleRpc(s, { jsonrpc: "2.0", ...(id === undefined ? {} : { id }), method, ...(params ? { params } : {}) });

  it("initializes, lists the tools and answers calls", async () => {
    const init = (await rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "0" } })) as any;
    expect(init).toMatchObject({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "firstlight-agent" } } });
    expect(init.result.instructions).toContain("firstlight_join");
    expect(((await rpc("initialize", { protocolVersion: "1999-01-01" })) as any).result.protocolVersion).toBe(MCP_PROTOCOL);
    expect(await rpc("notifications/initialized", undefined, undefined)).toBeNull();
    expect(await rpc("ping")).toEqual({ jsonrpc: "2.0", id: 1, result: {} });
    const list = (await rpc("tools/list")) as any;
    expect(list.result.tools).toHaveLength(TOOLS.length);
    expect(list.result.tools[0]).toEqual({ name: "firstlight_join", description: TOOLS[0]!.description, inputSchema: TOOLS[0]!.inputSchema });
    const call = (await rpc("tools/call", { name: "firstlight_observe", arguments: {} })) as any;
    expect(call.result.isError).toBe(true);
    expect(call.result.content).toEqual([{ type: "text", text: expect.stringContaining("call firstlight_join first") }]);
    const bad = (await rpc("tools/call", { name: "firstlight_attack", arguments: { target: "" } })) as any;
    expect(bad.result.isError).toBe(true);
    expect(bad.result.content[0].text).toContain("bad arguments");
  });

  it("answers unknown methods and malformed requests with JSON-RPC errors", async () => {
    expect(await rpc("resources/read")).toMatchObject({ id: 1, error: { code: -32601 } });
    expect(await handleRpc(s, { id: 5, method: "ping" })).toMatchObject({ id: 5, error: { code: -32600 } });
    expect(await rpc("notifications/cancelled", { requestId: 3 }, undefined)).toBeNull();
  });
});

describe("HTTP bridge", () => {
  let server: Server | null = null;
  afterEach(async () => {
    await new Promise<void>((ok) => (server ? server.close(() => ok()) : ok()));
    server = null;
  });

  async function start(): Promise<string> {
    const handler = bridge(new Session());
    server = createServer((req, res) => void handler(req, res));
    await new Promise<void>((ok) => server!.listen(0, "127.0.0.1", ok));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  it("lists the tools, takes calls by short name, and refuses browsers", async () => {
    const base = await start();
    const root = (await (await fetch(`${base}/`)).json()) as any;
    expect(root).toMatchObject({ name: "firstlight-agent bridge", playing: false });
    expect(root.tools).toHaveLength(TOOLS.length);
    expect(await (await fetch(`${base}/observe`)).json()).toMatchObject({ ok: false, reason: "not in the game" });
    expect(await (await fetch(`${base}/move`, { method: "POST", body: JSON.stringify({ target: "guide" }) })).json()).toMatchObject({ ok: false, reason: "not in the game" });
    expect(await (await fetch(`${base}/firstlight_move`, { method: "POST", body: "{not json" })).json()).toMatchObject({ ok: false, reason: "bad arguments" });
    const unknown = await fetch(`${base}/fly`, { method: "POST" });
    expect(unknown.status).toBe(404);
    expect((await fetch(`${base}/move`)).status).toBe(405);
    // A web page on another origin can reach localhost: anything that carries an Origin is refused.
    const fromPage = await fetch(`${base}/move`, { method: "POST", headers: { Origin: "https://example.org" }, body: "{}" });
    expect(fromPage.status).toBe(403);
    expect(await fromPage.json()).toMatchObject({ ok: false, reason: "forbidden" });
    // ...and so is a foreign hostname pointed at this address (DNS rebinding).
    expect((await fetch(`${base}/observe`, { headers: { Host: "evil.example:7361" } })).status).toBe(403);
  });
});

describe("the kit and the tools run as they are", () => {
  // `node tools/agent/mcp.ts` runs the sources with Node's type stripping (no build): only erasable
  // syntax, like the server (apps/server/test/strip-types.test.ts).
  const dirs = [import.meta.dirname, join(import.meta.dirname, "examples"), join(import.meta.dirname, "../../packages/agent-kit/src")];
  const files = dirs.flatMap((d) => readdirSync(d).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts")).map((f) => join(d, f)));
  it("finds the sources", () => {
    expect(files.map((f) => f.split("/").pop())).toEqual(expect.arrayContaining(["mcp.ts", "serve.ts", "tools.ts", "hunter.ts", "agent.ts", "walker.ts", "nav.ts", "observe.ts", "auth.ts"]));
  });
  for (const file of files) {
    it(`${file.split("/").slice(-2).join("/")} is erasable TypeScript`, () => {
      expect(() => stripTypeScriptTypes(readFileSync(file, "utf8"), { mode: "strip" })).not.toThrow();
    });
  }
});
