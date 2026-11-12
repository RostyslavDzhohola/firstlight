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
import { callTool, PLAYBOOK, Session, TOOLS } from "./tools.ts";

export const MCP_PROTOCOL = "2025-06-18";
const SUPPORTED = new Set(["2024-11-05", "2025-03-26", "2025-06-18"]);

interface Rpc {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

/** Answer one JSON-RPC message (null for notifications). Exported for the tests. */
export async function handleRpc(session: Session, msg: Rpc): Promise<Record<string, unknown> | null> {
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
        serverInfo: { name: "firstlight-agent", title: "FIRSTLIGHT (play the game)", version: "1.0.0" },
        instructions: PLAYBOOK,
      });
    }
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) });
    case "tools/call": {
      const name = String(msg.params?.name ?? "");
      const r = await callTool(session, name, msg.params?.arguments);
      // The summary reads better as text than inside JSON.
      const { summary, look, ...rest } = r as { summary?: string; look?: string } & Record<string, unknown>;
      const text = [summary ?? look, Object.keys(rest).length > 1 || rest.ok !== true ? JSON.stringify(rest) : null].filter(Boolean).join("\n");
      return reply({ content: [{ type: "text", text: text || JSON.stringify(rest) }], isError: r.ok === false });
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

async function main() {
  // stdout carries the protocol and nothing else: whatever a library prints (the Colyseus SDK
  // reports its reconnects with console.log) goes to stderr.
  console.log = console.info = console.debug = (...args: unknown[]) => console.error(...args);
  const session = new Session((line) => process.stderr.write(`[firstlight] ${line}\n`));
  const out = (m: unknown) => process.stdout.write(`${JSON.stringify(m)}\n`);
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  // One call at a time, in order: a character does one thing at a time.
  let chain: Promise<void> = Promise.resolve();
  rl.on("line", (line) => {
    if (!line.trim()) return;
    let msg: Rpc;
    try {
      msg = JSON.parse(line) as Rpc;
    } catch {
      out({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
      return;
    }
    // firstlight_stop must be able to interrupt a walk or a fight in progress.
    const urgent = msg.method === "tools/call" && msg.params?.name === "firstlight_stop";
    const run = async () => {
      const r = await handleRpc(session, msg).catch((e: unknown) => ({ jsonrpc: "2.0", id: msg.id ?? null, error: { code: -32603, message: (e as Error).message } }));
      if (r) out(r);
    };
    if (urgent || msg.method !== "tools/call") void run();
    else chain = chain.then(run);
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
