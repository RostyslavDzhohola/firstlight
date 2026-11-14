// FIRSTLIGHT as an MCP server over stdio, so a model with tools can play:
//
//   node tools/agent/mcp.ts
//
// Hand-rolled JSON-RPC 2.0 (one JSON message per line, as the MCP stdio transport defines), no
// dependency. Tools come from tools.ts. Everything that isn't protocol goes to stderr.
//
// Environment: FL_URL (game server, default http://localhost:2567), FL_AUTH_URL (sign-in origin when
// it differs), FL_AGENT_NAME, FL_DEV=1 (dev guest tokens on a local dev server), FL_AGENT_HOME
// (where guest sessions are kept; default ~/.firstlight/agents), FL_AGENT_SESSION=none (don't keep one).

import { createInterface } from "node:readline";
import { PLAYBOOK, Session, type ToolDef } from "./tools.ts";

export const MCP_PROTOCOL = "2025-06-18";
/** Versions with the `initialize` handshake ("legacy" since 2026-07-28) this server speaks. */
export const LEGACY_VERSIONS: readonly string[] = ["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"];
const SUPPORTED = new Set(LEGACY_VERSIONS);
export const SERVER_INFO = { name: "firstlight-agent", title: "FIRSTLIGHT (play the game)", version: "1.1.0" };

interface Rpc {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

/** Tools as MCP lists them. */
export function toolList(tools: readonly ToolDef[]): Record<string, unknown>[] {
  return tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
}

/** A tool's result as an MCP CallToolResult: the summary reads better as text than inside JSON. */
export function toolContent(r: Record<string, unknown>): { content: { type: "text"; text: string }[]; isError: boolean } {
  const { summary, look, ...rest } = r as { summary?: string; look?: string } & Record<string, unknown>;
  const text = [summary ?? look, Object.keys(rest).length > 1 || rest.ok !== true ? JSON.stringify(rest) : null].filter(Boolean).join("\n");
  return { content: [{ type: "text", text: text || JSON.stringify(rest) }], isError: r.ok === false };
}

/** Answer one JSON-RPC message (null for notifications). `signal` cancels a tool call. Exported for the tests. */
export async function handleRpc(session: Session, msg: Rpc, signal?: AbortSignal): Promise<Record<string, unknown> | null> {
  const id = msg.id;
  const reply = (result: unknown) => (id === undefined ? null : { jsonrpc: "2.0", id, result });
  const fail = (code: number, message: string) => (id === undefined ? null : { jsonrpc: "2.0", id, error: { code, message } });
  if (msg.jsonrpc !== "2.0" || typeof msg.method !== "string") return fail(-32600, "not a JSON-RPC 2.0 request");
  switch (msg.method) {
    case "initialize": {
      const asked = String(msg.params?.protocolVersion ?? "");
      return reply({
        protocolVersion: SUPPORTED.has(asked) ? asked : MCP_PROTOCOL,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: PLAYBOOK,
      });
    }
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: toolList([...session.tools.values()]) });
    case "tools/call": {
      const name = String(msg.params?.name ?? "");
      return reply(toolContent(await session.call(name, msg.params?.arguments, { signal })));
    }
    case "resources/list":
      return reply({ resources: [] });
    case "prompts/list":
      return reply({ prompts: [] });
    default:
      if (msg.method.startsWith("notifications/")) return null;
      return fail(-32601, `unknown method ${msg.method}`);
  }
}

/** A JSON-RPC id as a map key (1 and "1" are different requests). */
export const rpcKey = (id: unknown): string | null => (typeof id === "string" || typeof id === "number" ? `${typeof id}:${id}` : null);

/**
 * Requests still being answered, by id, so `notifications/cancelled` can stop one (MCP 2025-11-25,
 * basic/utilities/cancellation: the receiver SHOULD stop processing the request, free its resources
 * and not send a response; unknown or finished ids are ignored). The HTTP endpoint keeps one per session.
 */
export class InFlight {
  private readonly byId = new Map<string, Set<AbortController>>();

  /** Track a request; `done` untracks it. Returns its signal, whether it was cancelled, and its own abort. */
  open(id: unknown): { signal: AbortSignal; cancelled: () => boolean; abort: () => void; done: () => void } {
    const ac = new AbortController();
    const key = rpcKey(id);
    if (key) {
      const set = this.byId.get(key) ?? new Set();
      set.add(ac);
      this.byId.set(key, set);
    }
    return {
      signal: ac.signal,
      cancelled: () => ac.signal.aborted,
      abort: () => ac.abort(),
      done: () => {
        if (!key) return;
        const set = this.byId.get(key);
        set?.delete(ac);
        if (set && !set.size) this.byId.delete(key);
      },
    };
  }

  /** A `notifications/cancelled`: abort the request it names, if it is still running. */
  cancel(params: unknown): boolean {
    const key = rpcKey((params as { requestId?: unknown } | null | undefined)?.requestId);
    const set = key ? this.byId.get(key) : undefined;
    if (!set) return false;
    for (const ac of set) ac.abort();
    return true;
  }

  get size(): number {
    return this.byId.size;
  }
}

/**
 * The stdio server's dispatcher: answers a message, honours `notifications/cancelled` for tool calls
 * in progress, and drops the reply of a request that was cancelled. Exported for the tests.
 */
export function rpcServer(session: Session): { handle(msg: Rpc): Promise<Record<string, unknown> | null>; inFlight: InFlight } {
  const inFlight = new InFlight();
  return {
    inFlight,
    async handle(msg) {
      if (msg.method === "notifications/cancelled") {
        inFlight.cancel(msg.params);
        return null;
      }
      if (msg.method !== "tools/call" || msg.id === undefined) return handleRpc(session, msg);
      const t = inFlight.open(msg.id);
      try {
        const r = await handleRpc(session, msg, t.signal);
        return t.cancelled() ? null : r;
      } finally {
        t.done();
      }
    },
  };
}

/**
 * One line of stdin as a request, or the JSON-RPC error to answer it with: -32700 when it isn't
 * JSON, -32600 when it is JSON but not a request object (`null`, a number, a string, an array:
 * batches aren't part of this transport). Exported for the tests.
 */
export function parseRpc(line: string): { msg: Rpc } | { error: Record<string, unknown> } {
  let msg: unknown;
  try {
    msg = JSON.parse(line);
  } catch {
    return { error: { jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } } };
  }
  if (msg === null || typeof msg !== "object" || Array.isArray(msg)) return { error: { jsonrpc: "2.0", id: null, error: { code: -32600, message: "not a JSON-RPC 2.0 request" } } };
  return { msg: msg as Rpc };
}

async function main() {
  // stdout carries the protocol and nothing else: whatever a library prints (the Colyseus SDK
  // reports its reconnects with console.log) goes to stderr.
  console.log = console.info = console.debug = (...args: unknown[]) => console.error(...args);
  const session = new Session((line) => process.stderr.write(`[firstlight] ${line}\n`));
  const server = rpcServer(session);
  const out = (m: unknown) => process.stdout.write(`${JSON.stringify(m)}\n`);
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  // Tool calls run one at a time, in order (Session.call); the rest answer at once.
  rl.on("line", (line) => {
    if (!line.trim()) return;
    const parsed = parseRpc(line);
    if ("error" in parsed) {
      out(parsed.error);
      return;
    }
    const msg = parsed.msg;
    void server.handle(msg)
      .catch((e: unknown) => ({ jsonrpc: "2.0", id: msg.id ?? null, error: { code: -32603, message: (e as Error).message } }))
      .then((r) => r && out(r));
  });
  const bye = async () => {
    await session.agent?.close().catch(() => {});
    process.exit(0);
  };
  rl.on("close", () => void bye());
  process.on("SIGINT", () => void bye());
  process.on("SIGTERM", () => void bye());
}

if (import.meta.main) void main();
