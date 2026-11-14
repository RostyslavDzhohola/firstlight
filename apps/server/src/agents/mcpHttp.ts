// The gateway's remote MCP endpoint: `POST /mcp`, MCP's Streamable HTTP transport, written by hand
// (no SDK dependency; D-agents-gw-2). `claude mcp add --transport http firstlight <origin>/mcp` is the
// whole setup. Dual-era, as the 2026-07-28 revision describes:
//
// - Modern (2026-07-28): stateless. Every request carries its protocol version in
//   `params._meta["io.modelcontextprotocol/protocolVersion"]` and the `MCP-Protocol-Version`,
//   `Mcp-Method` and `Mcp-Name` headers, which must match the body (400, -32020 HeaderMismatch).
//   `server/discover` answers what we speak. Cross-call state is a server-minted handle passed as a
//   tool argument: `firstlight_join` returns `seat`, and every other tool takes it as `seat`.
// - Legacy (2025-03-26 .. 2025-11-25): `initialize` opens a protocol session; its `Mcp-Session-Id`
//   header carries the seat from call to call, so those clients never pass `seat`. DELETE ends it.
//
// Answers are single JSON objects (never SSE): every call is one request and one result. A client
// that hangs up on a call in progress cancels it (the seat stops walking or fighting): with no stream
// to resume, its answer could never arrive anyway. A legacy client may also cancel explicitly with
// `notifications/cancelled` (2025-11-25 basic/utilities/cancellation): the named request leaves the
// seat's queue or is stopped, and its POST is answered with the cancelled result, which the spec has
// the client ignore (HTTP needs some answer to every request). GET is 405.

import { createHash, randomBytes } from "node:crypto";
import type { Express, Request, Response } from "express";
import { InFlight, LEGACY_VERSIONS, SERVER_INFO, toolContent, toolList } from "@firstlight/agent-tools/mcp";
import { PLAYBOOK, type ToolDef } from "@firstlight/agent-tools/tools";
import { directRequestIp, banKey } from "../auth/ip.ts";
import { WindowLimiter } from "../auth/limiter.ts";
import { GATEWAY_RULES, hangUpSignal, originAllowed, readJson, type Gateway } from "./gateway.ts";

export const MODERN_VERSIONS: readonly string[] = ["2026-07-28"];
const META_VERSION = "io.modelcontextprotocol/protocolVersion";
const META_CAPS = "io.modelcontextprotocol/clientCapabilities";
const META_SERVER = "io.modelcontextprotocol/serverInfo";

/** Legacy protocol sessions (no character yet, or the seat they hold). */
export const MCP_RULES = { sessions: 512, sessionsPerIp: 24, idleMs: 30 * 60_000 };

interface LegacySession {
  key: string;
  seat: string | null;
  lastUsed: number;
  /** The join in progress: a second join waits for it instead of seating a second character. */
  joining: Promise<unknown> | null;
  /** Ended (DELETE, or swept): a join that finishes afterwards closes its seat. */
  closed: boolean;
  /** Tool calls still being answered, for `notifications/cancelled`. */
  inFlight: InFlight;
}

interface Rpc {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: { name?: unknown; arguments?: unknown; _meta?: Record<string, unknown> } & Record<string, unknown>;
}

const SEAT_ARG = {
  type: "string" as const,
  description: "Your seat: the handle firstlight_join returned. Pass it with every call (clients that keep an MCP session may leave it out).",
  minLength: 8,
  maxLength: 64,
};

/** The tools as this endpoint lists them: every one after the join takes the seat handle. */
export function mcpTools(tools: Iterable<ToolDef>): ToolDef[] {
  return [...tools].map((t) => (t.needsAgent ? { ...t, inputSchema: { ...t.inputSchema, properties: { ...t.inputSchema.properties, seat: SEAT_ARG } } } : t));
}

/** A header value with MCP's base64 sentinel decoded (`=?base64?…?=`). */
function headerValue(req: Request, name: string): string | undefined {
  const v = req.headers[name];
  const s = Array.isArray(v) ? v[0] : v;
  if (s === undefined) return undefined;
  const m = s.match(/^=\?base64\?([A-Za-z0-9+/=]*)\?=$/);
  return m ? Buffer.from(m[1]!, "base64").toString("utf8") : s;
}

const hash = (t: string) => createHash("sha256").update(t).digest("base64url");
const CANCELLED_JOIN = { ok: false, reason: "cancelled", hint: "the caller hung up while the character joined; it has left" } as const;

export function mountMcp(app: Express, gateway: Gateway, allowedOrigins: readonly string[]): void {
  const allowed = new Set(allowedOrigins);
  const sessions = new Map<string, LegacySession>();
  const ipCalls = new WindowLimiter(GATEWAY_RULES.callsPerIp, 10_000);
  const listed = mcpTools(gateway.tools.values());
  const toolNames = new Set(listed.map((t) => t.name));

  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [id, s] of sessions) {
      if (now - s.lastUsed <= MCP_RULES.idleMs || (s.seat && gateway.has(s.seat)) || s.joining || s.inFlight.size) continue;
      s.closed = true;
      sessions.delete(id);
    }
  }, 60_000);
  sweep.unref();

  const rpcError = (res: Response, status: number, id: unknown, code: number, message: string, data?: unknown) => {
    res.status(status).json({ jsonrpc: "2.0", ...(id === undefined ? {} : { id }), error: { code, message, ...(data === undefined ? {} : { data }) } });
  };

  /** One tools/call, either era: `seat` is the session's (legacy) or the argument (modern). */
  async function toolsCall(req: Request, res: Response, msg: Rpc, legacy: LegacySession | null, signal: AbortSignal): Promise<Record<string, unknown>> {
    const name = typeof msg.params?.name === "string" ? msg.params.name : "";
    const raw = msg.params?.arguments ?? {};
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return toolContent({ ok: false, reason: "bad arguments", hint: "arguments must be an object" });
    const { seat: given, ...args } = raw as Record<string, unknown>;
    const ip = directRequestIp(req);
    if (!toolNames.has(name)) return toolContent({ ok: false, reason: "unknown tool", hint: `tools: ${[...toolNames].join(", ")}` });
    if (name === "firstlight_join") {
      if (!legacy) {
        const r = await gateway.join(ip, args);
        if (!r.ok) return toolContent(r);
        // Hung up while it joined: nobody holds the handle, so the seat goes now.
        if (signal.aborted) {
          await gateway.drop(String(r.seat));
          return toolContent({ ...CANCELLED_JOIN });
        }
        return toolContent({ ...r, note: `your seat is ${String(r.seat)}: pass it as "seat" in every other firstlight_* call` });
      }
      // One join at a time per session: a second one waits for the first, then finds the seat taken.
      while (legacy.joining) await legacy.joining.catch(() => {});
      if (legacy.closed) return toolContent({ ok: false, reason: "session ended", hint: "this MCP session was closed; initialize again" });
      const playing = legacy.seat && gateway.has(legacy.seat) ? legacy.seat : null;
      if (playing) return toolContent(await gateway.call(playing, ip, name, args));
      const joining = gateway.join(ip, args);
      legacy.joining = joining;
      let r: Awaited<typeof joining>;
      try {
        r = await joining;
      } finally {
        legacy.joining = null;
      }
      if (!r.ok) return toolContent(r);
      // The session ended (DELETE) while it joined: nobody can reach this seat any more.
      if (legacy.closed) {
        await gateway.drop(String(r.seat));
        return toolContent({ ok: false, reason: "session ended", hint: "the MCP session was closed while the character joined; it has left" });
      }
      legacy.seat = r.seat as string;
      const { seat: _seat, ...rest } = r;
      return toolContent(rest);
    }
    const seat = typeof given === "string" ? given : (legacy?.seat ?? "");
    return toolContent(await gateway.call(seat, ip, name, args, signal));
  }

  app.post("/mcp", async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    if (!originAllowed(req, allowed)) return rpcError(res, 403, undefined, -32600, "forbidden origin");
    const ip = directRequestIp(req);
    if (!ip) return rpcError(res, 403, undefined, -32600, "no client address");
    if (!ipCalls.take(banKey(ip))) {
      res.setHeader("Retry-After", "5");
      return rpcError(res, 429, undefined, -32000, "slow down");
    }
    let body: unknown;
    try {
      body = await readJson(req);
    } catch (e) {
      return (e as Error).message === "too large" ? rpcError(res, 413, null, -32600, "request too large") : rpcError(res, 400, null, -32700, "parse error");
    }
    if (body === null || typeof body !== "object" || Array.isArray(body)) return rpcError(res, 400, null, -32600, "one JSON-RPC request per POST");
    const msg = body as Rpc;
    if (msg.jsonrpc !== "2.0" || typeof msg.method !== "string") return rpcError(res, 400, null, -32600, "not a JSON-RPC 2.0 request");
    const method = msg.method;
    const id = msg.id;
    if (id === undefined) {
      // A notification: nothing to answer. A legacy client's cancellation stops the request it names
      // in its own session (unknown or finished ids are ignored, as the spec asks).
      if (method === "notifications/cancelled") {
        const sid = headerValue(req, "mcp-session-id");
        const session = sid ? sessions.get(hash(sid)) : undefined;
        session?.inFlight.cancel(msg.params);
      }
      res.status(202).end();
      return;
    }
    if (typeof id !== "string" && typeof id !== "number") return rpcError(res, 400, null, -32600, "bad id");
    const reply = (result: Record<string, unknown>, headers: Record<string, string> = {}) => {
      for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
      res.status(200).json({ jsonrpc: "2.0", id, result });
    };
    const meta = msg.params?._meta;
    const version = meta && typeof meta === "object" ? meta[META_VERSION] : undefined;

    // --- legacy: the initialize handshake opens a protocol session
    if (method === "initialize") {
      const now = Date.now();
      const key = banKey(ip);
      if (sessions.size >= MCP_RULES.sessions || [...sessions.values()].filter((s) => s.key === key).length >= MCP_RULES.sessionsPerIp) return rpcError(res, 503, id, -32000, "too many MCP sessions; try again later");
      const sid = randomBytes(24).toString("base64url");
      sessions.set(hash(sid), { key, seat: null, lastUsed: now, joining: null, closed: false, inFlight: new InFlight() });
      const asked = String(msg.params?.protocolVersion ?? "");
      return reply(
        { protocolVersion: LEGACY_VERSIONS.includes(asked) ? asked : LEGACY_VERSIONS[LEGACY_VERSIONS.length - 1], capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO, instructions: PLAYBOOK },
        { "Mcp-Session-Id": sid },
      );
    }

    // --- modern: per-request metadata, mirrored in headers
    if (version !== undefined) {
      const hv = headerValue(req, "mcp-protocol-version");
      if (hv !== version) return rpcError(res, 400, id, -32020, `Header mismatch: MCP-Protocol-Version ${hv ?? "(missing)"} does not match the request's protocol version`);
      if (typeof version !== "string" || !MODERN_VERSIONS.includes(version)) return rpcError(res, 400, id, -32022, "Unsupported protocol version", { supported: [...MODERN_VERSIONS, ...LEGACY_VERSIONS], requested: version });
      if (headerValue(req, "mcp-method") !== method) return rpcError(res, 400, id, -32020, "Header mismatch: Mcp-Method does not match the request's method");
      if (method === "tools/call" && headerValue(req, "mcp-name") !== msg.params?.name) return rpcError(res, 400, id, -32020, "Header mismatch: Mcp-Name does not match the tool name");
      const caps = meta![META_CAPS];
      if (caps === null || typeof caps !== "object" || Array.isArray(caps)) return rpcError(res, 400, id, -32602, "Invalid params: _meta needs io.modelcontextprotocol/clientCapabilities");
      const done = (r: Record<string, unknown>) => reply({ resultType: "complete", ...r, _meta: { [META_SERVER]: SERVER_INFO } });
      switch (method) {
        case "server/discover":
          return done({ supportedVersions: [...MODERN_VERSIONS, ...LEGACY_VERSIONS], capabilities: { tools: {} }, instructions: PLAYBOOK });
        case "ping":
          return done({});
        case "tools/list":
          return done({ tools: toolList(listed) });
        case "resources/list":
          return done({ resources: [] });
        case "prompts/list":
          return done({ prompts: [] });
        case "tools/call":
          return done(await toolsCall(req, res, msg, null, hangUpSignal(res)));
        default:
          return rpcError(res, 404, id, -32601, `Method not found: ${method}`);
      }
    }

    // --- legacy: everything after initialize names its session
    const sid = headerValue(req, "mcp-session-id");
    if (!sid) return rpcError(res, 400, id, -32600, "Mcp-Session-Id required: send initialize first (or use protocol 2026-07-28 with _meta)");
    const session = sessions.get(hash(sid));
    if (!session) return rpcError(res, 404, id, -32001, "session not found: initialize again");
    session.lastUsed = Date.now();
    switch (method) {
      case "ping":
        return reply({});
      case "tools/list":
        return reply({ tools: toolList(listed) });
      case "resources/list":
        return reply({ resources: [] });
      case "prompts/list":
        return reply({ prompts: [] });
      case "tools/call": {
        // Cancelled by `notifications/cancelled` or by hanging up: either aborts the call.
        const t = session.inFlight.open(id);
        const gone = hangUpSignal(res);
        const abort = () => t.abort();
        gone.addEventListener("abort", abort, { once: true });
        try {
          const r = await toolsCall(req, res, msg, session, t.signal);
          if (gone.aborted) return;
          return reply(r);
        } finally {
          gone.removeEventListener("abort", abort);
          t.done();
        }
      }
      default:
        return rpcError(res, 404, id, -32601, `Method not found: ${method}`);
    }
  });

  // No server-to-client stream (legacy GET) in either era.
  app.get("/mcp", (_req, res) => {
    res.setHeader("Allow", "POST, DELETE");
    res.status(405).json({ jsonrpc: "2.0", error: { code: -32600, message: "POST JSON-RPC requests to this endpoint" } });
  });

  // Legacy: the client ends its session; its character leaves with it.
  app.delete("/mcp", async (req, res) => {
    if (!originAllowed(req, allowed)) return rpcError(res, 403, undefined, -32600, "forbidden origin");
    const sid = headerValue(req, "mcp-session-id");
    const session = sid ? sessions.get(hash(sid)) : undefined;
    if (!sid || !session) {
      res.setHeader("Allow", "POST");
      res.status(sid ? 404 : 405).end();
      return;
    }
    sessions.delete(hash(sid));
    session.closed = true;
    if (session.seat) await gateway.drop(session.seat);
    res.status(204).end();
  });
}
