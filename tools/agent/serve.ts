// A local HTTP bridge to one FIRSTLIGHT character, for models that only have a shell:
//
//   node tools/agent/serve.ts [--port 7361] [--join] [--name Scout_7] [--url http://localhost:2567] [--dev]
//
// Bound to 127.0.0.1 only (it plays a character for whoever can reach it; never expose it).
//   GET  /            what this is, and the tool list with schemas
//   GET  /observe     firstlight_observe (add ?detail=full for the JSON)
//   POST /<tool>      a tool by its short name (join, move, attack, …) or full name; JSON body = arguments
//   POST /quit        leave the game and stop the bridge
// The CLI wrapper is fl-agent.mjs. Tools and their schemas are in tools.ts (the MCP server serves the same).

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { callTool, PLAYBOOK, Session, TOOLS } from "./tools.ts";

export const DEFAULT_PORT = 7361;
const MAX_BODY = 16 * 1024;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((ok, fail) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        fail(new Error("body too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => ok(Buffer.concat(chunks).toString("utf8")));
    req.on("error", fail);
  });
}

/** The bridge's request handler (exported for the tests). */
export function bridge(session: Session, onQuit: () => void = () => {}) {
  let chain: Promise<unknown> = Promise.resolve();
  return async (req: IncomingMessage, res: ServerResponse) => {
    const send = (status: number, body: unknown) => {
      const text = JSON.stringify(body);
      res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(text), "Cache-Control": "no-store" });
      res.end(text);
    };
    // Browsers must not drive this: a page on another origin can POST to localhost. Requests that
    // carry an Origin (any browser fetch does) are refused; curl and the CLI send none.
    if (req.headers.origin) return send(403, { ok: false, reason: "forbidden", hint: "this bridge takes local tools, not web pages" });
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const path = url.pathname.replace(/^\/+|\/+$/g, "");
    try {
      if (req.method === "GET" && path === "") return send(200, { name: "firstlight-agent bridge", playing: !!session.agent, playbook: PLAYBOOK, tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) });
      if (req.method === "GET" && path === "observe") return send(200, await callTool(session, "firstlight_observe", url.searchParams.get("detail") === "full" ? { detail: "full" } : {}));
      if (req.method !== "POST") return send(405, { ok: false, reason: "use POST", hint: "POST /<tool> with a JSON body; GET / lists the tools" });
      if (path === "quit") {
        await session.agent?.close().catch(() => {});
        session.agent = null;
        send(200, { ok: true, left: true });
        onQuit();
        return;
      }
      const name = path.startsWith("firstlight_") ? path : `firstlight_${path}`;
      const raw = await readBody(req);
      let args: unknown = {};
      if (raw.trim()) {
        try {
          args = JSON.parse(raw);
        } catch {
          return send(400, { ok: false, reason: "bad arguments", hint: "the body must be JSON" });
        }
      }
      // One action at a time, in order; stop jumps the queue to interrupt a walk or a fight.
      const call = () => callTool(session, name, args);
      const result = name === "firstlight_stop" ? call() : (chain = chain.then(call, call));
      const r = (await result) as Record<string, unknown>;
      return send(r.reason === "unknown tool" ? 404 : 200, r);
    } catch (e) {
      return send(500, { ok: false, reason: "error", hint: (e as Error).message });
    }
  };
}

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const v = process.argv[i + 1];
  return v && !v.startsWith("--") ? v : "1";
}

async function main() {
  const port = Number(flag("port") ?? process.env.FL_AGENT_PORT ?? DEFAULT_PORT);
  const session = new Session((line) => console.error(`[firstlight] ${line}`));
  const server = createServer((req, res) => void handler(req, res));
  const stop = () => {
    server.close();
    setTimeout(() => process.exit(0), 200).unref();
  };
  const handler = bridge(session, stop);
  await new Promise<void>((ok, fail) => {
    server.once("error", fail);
    server.listen(port, "127.0.0.1", ok);
  });
  console.error(`[firstlight] agent bridge on http://127.0.0.1:${port} (GET / for the tools)`);
  if (flag("join")) {
    const r = await callTool(session, "firstlight_join", { ...(flag("url") ? { url: flag("url") } : {}), ...(flag("name") ? { name: flag("name") } : {}), ...(flag("starter") ? { starter: flag("starter") } : {}), ...(flag("dev") ? { dev: true } : {}) });
    console.error(`[firstlight] ${r.ok ? `joined as ${r.name} on ${r.body}` : `join failed: ${r.reason} ${r.hint ?? ""}`}`);
  }
  const bye = async () => {
    await session.agent?.close().catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", () => void bye());
  process.on("SIGTERM", () => void bye());
}

if (import.meta.main) void main();
