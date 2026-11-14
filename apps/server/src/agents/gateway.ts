// The hosted agent gateway (D-agents-gw-1): an agent with nothing installed plays through the game
// server itself, one URL away. Two faces over this one module:
//   - the remote MCP endpoint (`/mcp`, mcpHttp.ts), with the stdio server's tools;
//   - a plain HTTP+JSON API (`/api/agent/*`, below) for models that only have curl or a fetch tool.
//
// Each seat is a character the server plays for a caller: the agent kit's `FirstlightAgent`, the
// same world model and actions as `tools/agent` (no second copy), joined over loopback through the
// ordinary `/api/play` path, so the AI flag, the agent caps and every server rule apply. The seat's
// requests carry the caller's address (X-Real-IP for /api/play, X-Forwarded-For behind the origin
// secret for /api/auth), so the per-address caps and sign-in limits count the caller, not loopback.
//
// Everything a caller sends is hostile: the request bodies are zod-checked and size-capped, tool
// arguments go through the tools' own schemas, a seat is reached only by its opaque handle (stored as
// a hash), and nothing here reaches admin commands or another seat.

import { createHash, randomBytes } from "node:crypto";
import type { Express, Request, Response } from "express";
import { z } from "zod";
import { joinWith, PLAYBOOK, Session, TOOLS, withJoin, type ToolDef } from "@firstlight/agent-tools/tools";
import { BODY_IDS, type BodyId } from "@firstlight/shared";
import { STARTERS } from "@firstlight/shared/content/weapons";
import { AGENT_REFUSAL } from "@firstlight/shared/net/agents";
import { banKey, directRequestIp } from "../auth/ip.ts";
import { WindowLimiter } from "../auth/limiter.ts";
import { env } from "../env.ts";
import { AGENT_RULES } from "../world/agents.ts";

/** The gateway's limits (read per request; tests change them and put them back). */
export const GATEWAY_RULES = {
  /** Seats played at once, all callers together (0 turns the gateway off). */
  seats: env.agentGatewaySeats,
  /** A seat with no call for this long is closed (its character logs out). */
  idleMs: env.agentGatewayIdleS * 1000,
  /** Calls per seat, and per address, in 10 s. */
  callsPerSeat: 40,
  callsPerIp: 120,
  /**
   * Calls a seat holds at once, the running one included: one action runs, the rest wait their turn.
   * Past it a call is refused (429 "queue full"), so a caller can't park work faster than it drains.
   */
  queuePerSeat: 4,
  /** Joins per address per minute, and for everyone together. */
  joinsPerIp: 6,
  joinsTotal: 60,
  /** Request bodies past this are refused (tool arguments are a few hundred bytes). */
  maxBody: 16 * 1024,
};

export interface GatewayOptions {
  /** The game server's own origin over loopback (known once it listens). */
  loopback: () => string;
  /**
   * How a seat signs in: `guest` is the browser's Better Auth guest flow over loopback (production,
   * `pnpm dev`); `dev` mints dev tokens (the in-process test server, which has no Better Auth).
   */
  signIn?: "guest" | "dev";
  /** The site origin Better Auth trusts (the kit's Origin header on sign-in). */
  authOrigin?: string;
  /** ORIGIN_SECRET: /api/auth wants it, and only then trusts the forwarded caller address. */
  originSecret?: string;
}

/** A gateway seat's session: the character, and who plays it. */
export class SeatSession extends Session {
  readonly ip: string;
  constructor(ip: string) {
    super();
    this.ip = ip;
  }
}

interface Seat {
  session: SeatSession;
  /** banKey of the caller's address (IPv6 per /64). */
  key: string;
  lastUsed: number;
}

export type GatewayResult = Record<string, unknown> & { ok: boolean; reason?: string };

const NAME = /^[A-Za-z0-9_]{3,16}$/;
const STARTER_IDS = STARTERS.map((s) => s.id) as [string, ...string[]];
const JoinArgs = z.strictObject({
  name: z.string().regex(NAME, "3-16 letters, digits or _").optional(),
  starter: z.enum(STARTER_IDS).optional(),
  body: z.enum(BODY_IDS as unknown as [BodyId, ...BodyId[]]).optional(),
});

const hash = (token: string) => createHash("sha256").update(token).digest("base64url");

export interface Gateway {
  readonly tools: ReadonlyMap<string, ToolDef>;
  /** Is the gateway taking joins right now (AGENTS_ENABLED and seats > 0)? */
  open(): boolean;
  seatsUsed(): number;
  /** Seat a new character for the caller at `ip`; `seat` (the handle) comes with a successful result. */
  join(ip: string | null, args: unknown): Promise<GatewayResult>;
  /**
   * Run a tool for the seat behind `token`. When `signal` aborts (the caller hung up, or cancelled
   * the request), the call leaves the seat's queue if it waits, or is stopped if it runs.
   */
  call(token: string, ip: string | null, name: string, args: unknown, signal?: AbortSignal): Promise<GatewayResult>;
  /** Close a seat (its character leaves). */
  drop(token: string, logout?: boolean): Promise<void>;
  /** Is there a seat behind this handle? */
  has(token: string): boolean;
  /** Close every seat (shutdown). */
  close(): Promise<void>;
}

export function createGateway(opts: GatewayOptions): Gateway {
  const seats = new Map<string, Seat>();
  const seatCalls = new WindowLimiter(GATEWAY_RULES.callsPerSeat, 10_000);
  const ipCalls = new WindowLimiter(GATEWAY_RULES.callsPerIp, 10_000);
  const ipJoins = new WindowLimiter(GATEWAY_RULES.joinsPerIp, 60_000);
  const allJoins = new WindowLimiter(GATEWAY_RULES.joinsTotal, 60_000);
  const signIn = opts.signIn ?? "guest";

  // The join the gateway serves: no url, no auth origin, no dev switch (a caller must not point the
  // server at another host or pick an identity); just a name, a starter and a world.
  const local = TOOLS.find((t) => t.name === "firstlight_join")!;
  const join: ToolDef = {
    name: local.name,
    description: local.description.replace("Call this first, once.", "Call this first, once: it gives you a seat (your character on this server)."),
    needsAgent: false,
    inputSchema: { type: "object", additionalProperties: false, properties: { name: local.inputSchema.properties.name!, starter: local.inputSchema.properties.starter!, body: local.inputSchema.properties.body! } },
    async run(s, a) {
      const parsed = JoinArgs.safeParse(a);
      if (!parsed.success) return { ok: false, reason: "bad arguments", hint: parsed.error.issues.map((i) => `${i.path.join(".") || "arguments"}: ${i.message}`).join("; ") };
      const { name, starter, body } = parsed.data;
      const ip = (s as SeatSession).ip;
      const url = opts.loopback();
      // The caller's address on every request the kit makes for this seat (see the header comment).
      const headers: Record<string, string> = { "x-real-ip": ip, "x-forwarded-for": ip, ...(opts.originSecret ? { "x-origin-secret": opts.originSecret } : {}) };
      return joinWith(s, {
        url,
        name,
        starter: starter ?? "unit7",
        body,
        headers,
        // Dev tokens: a fresh identity per seat; the name passed the pattern above, so it can't add a role.
        ...(signIn === "dev" ? { token: `dev:gw${randomBytes(6).toString("hex")}:${name ?? ""}` } : { authUrl: url, authOrigin: opts.authOrigin }),
      });
    },
  };
  const tools = withJoin(join);

  const seatsFrom = (key: string) => [...seats.values()].filter((s) => s.key === key).length;
  const open = () => AGENT_RULES.enabled && GATEWAY_RULES.seats > 0;

  async function drop(token: string, logout = true): Promise<void> {
    const id = hash(token);
    const seat = seats.get(id);
    if (!seat) return;
    seats.delete(id);
    const agent = seat.session.agent;
    seat.session.agent = null;
    await agent?.close({ logout }).catch(() => {});
  }

  // Idle seats close: a character no one has asked anything for a while logs out.
  const reaper = setInterval(() => {
    const now = Date.now();
    for (const [id, seat] of seats) {
      if (seat.session.busy > 0 || now - seat.lastUsed < GATEWAY_RULES.idleMs) continue;
      seats.delete(id);
      const agent = seat.session.agent;
      seat.session.agent = null;
      void agent?.close({ logout: true }).catch(() => {});
    }
  }, 1_000);
  reaper.unref();

  return {
    tools,
    open,
    seatsUsed: () => seats.size,
    async join(ip, args) {
      if (!open()) return { ok: false, reason: AGENT_REFUSAL.OFF, hint: "AI agents can't play on this server right now (AGENTS_ENABLED is off)." };
      if (!ip) return { ok: false, reason: "forbidden", hint: "no client address" };
      const key = banKey(ip);
      const now = Date.now();
      ipJoins.max = GATEWAY_RULES.joinsPerIp;
      allJoins.max = GATEWAY_RULES.joinsTotal;
      if (!allJoins.allows("all", now) || !ipJoins.take(key, now)) return { ok: false, reason: "slow down", hint: `at most ${GATEWAY_RULES.joinsPerIp} joins a minute from one address` };
      allJoins.add("all", now);
      if (seats.size >= GATEWAY_RULES.seats) return { ok: false, reason: "gateway full", hint: `every gateway seat is taken (${GATEWAY_RULES.seats}); try again in a few minutes` };
      const have = seatsFrom(key);
      if (have >= AGENT_RULES.perIp) return { ok: false, reason: AGENT_REFUSAL.LIMIT, hint: `Too many AI agents are playing from this address (${have} of ${AGENT_RULES.perIp}). Leave one (firstlight_leave) and try again.` };
      // The seat is held before the first await, so concurrent joins can't all pass the caps.
      const token = randomBytes(24).toString("base64url");
      const session = new SeatSession(ip);
      session.tools = tools;
      session.maxPending = GATEWAY_RULES.queuePerSeat;
      const id = hash(token);
      seats.set(id, { session, key, lastUsed: now });
      const r = await session.call("firstlight_join", args ?? {});
      if (!r.ok || !session.agent) {
        seats.delete(id);
        await session.agent?.close().catch(() => {});
        return r as GatewayResult;
      }
      const seat = seats.get(id);
      if (!seat) {
        // Closed while it joined (shutdown).
        await session.agent?.close().catch(() => {});
        return { ok: false, reason: "closed" };
      }
      seat.lastUsed = Date.now();
      return { ...r, ok: true, seat: token, idleMinutes: Math.round(GATEWAY_RULES.idleMs / 60_000) };
    },
    async call(token, ip, name, args, signal) {
      const seat = typeof token === "string" && token.length <= 64 ? seats.get(hash(token)) : undefined;
      if (!seat) return { ok: false, reason: "no seat", hint: `no seat with that handle: it closed (left, or idle ${Math.round(GATEWAY_RULES.idleMs / 60_000)} min) or never was. Call firstlight_join (POST /api/agent/join) for a new one.` };
      const now = Date.now();
      const key = ip ? banKey(ip) : seat.key;
      seatCalls.max = GATEWAY_RULES.callsPerSeat;
      ipCalls.max = GATEWAY_RULES.callsPerIp;
      if (!seatCalls.take(hash(token), now) || !ipCalls.take(key, now)) return { ok: false, reason: "slow down", hint: `at most ${GATEWAY_RULES.callsPerSeat} calls per 10 s per seat` };
      seat.lastUsed = now;
      if (name === "firstlight_join") return { ok: false, reason: "already playing", hint: "this seat has a character: firstlight_leave first, then join again", ...seat.session.status() };
      seat.session.maxPending = GATEWAY_RULES.queuePerSeat;
      const r = (await seat.session.call(name, args, { signal })) as GatewayResult;
      seat.lastUsed = Date.now();
      if (name === "firstlight_leave" && r.ok) seats.delete(hash(token));
      return r;
    },
    drop,
    has: (token) => typeof token === "string" && seats.has(hash(token)),
    async close() {
      clearInterval(reaper);
      const all = [...seats.values()];
      seats.clear();
      await Promise.all(all.map((s) => s.session.agent?.close().catch(() => {})));
    },
  };
}

// ------------------------------------------------------------------------------------- HTTP API

/** Who may call from a browser: no Origin (curl, a model's fetch tool, an MCP client) or our own site. */
export function originAllowed(req: Request, allowed: ReadonlySet<string>): boolean {
  const o = req.headers.origin;
  return o === undefined || allowed.has(o);
}

/**
 * The request's JSON body: express.json's when it parsed one, else read here (curl -d sends a form
 * content type), capped at GATEWAY_RULES.maxBody. `undefined` for no body; throws "too large"/"bad json".
 */
export async function readJson(req: Request): Promise<unknown> {
  if (Number(req.headers["content-length"] ?? 0) > GATEWAY_RULES.maxBody) throw new Error("too large");
  if (req.body !== undefined && (req as Request & { _body?: boolean })._body) return req.body;
  if (req.readableEnded) return req.body;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req as AsyncIterable<Buffer>) {
    size += c.length;
    if (size > GATEWAY_RULES.maxBody) throw new Error("too large");
    chunks.push(c);
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("bad json");
  }
}

const bearer = (req: Request): string | null => {
  const h = req.headers.authorization ?? "";
  return h.startsWith("Bearer ") ? h.slice(7).trim() : null;
};

const STATUS: Record<string, number> = { "agents off": 403, "agent limit": 403, forbidden: 403, "slow down": 429, "queue full": 429, "gateway full": 503, "no seat": 401, "unknown tool": 404 };

/** An AbortSignal that fires when the caller hangs up before its answer was sent. */
export function hangUpSignal(res: Response): AbortSignal {
  const ac = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) ac.abort();
  });
  return ac.signal;
}

/** What a caller is told about the HTTP face (GET /api/agent, and with every join). */
export const HTTP_HOWTO = [
  "Over plain HTTP: POST /api/agent/join with a JSON body {name?, starter?, body?} returns `seat`, your handle.",
  "Then send `Authorization: Bearer <seat>` with every call: GET /api/agent/observe[?detail=full], POST /api/agent/act with {\"tool\": \"move\", \"target\": \"guide\"} (the tool's short name plus its arguments), POST /api/agent/leave.",
  "One action runs at a time; tool \"stop\" interrupts it. A seat closes after a few idle minutes.",
].join("\n");

export function mountAgentApi(app: Express, gateway: Gateway, allowedOrigins: readonly string[]): void {
  const allowed = new Set(allowedOrigins);
  const send = (res: Response, r: GatewayResult) => {
    res.setHeader("Cache-Control", "no-store");
    if (r.reason === "slow down" || r.reason === "queue full") res.setHeader("Retry-After", r.reason === "slow down" ? "5" : "2");
    res.status(r.ok ? 200 : (STATUS[r.reason ?? ""] ?? 200)).json(r);
  };
  const guard = (req: Request, res: Response): boolean => {
    if (originAllowed(req, allowed)) return true;
    res.status(403).json({ ok: false, reason: "forbidden", hint: "web pages on other sites can't drive agents" });
    return false;
  };
  const body = async (req: Request, res: Response): Promise<{ v: unknown } | null> => {
    try {
      return { v: await readJson(req) };
    } catch (e) {
      const big = (e as Error).message === "too large";
      res.status(big ? 413 : 400).json({ ok: false, reason: "bad arguments", hint: big ? `the body is over ${GATEWAY_RULES.maxBody} bytes` : "the body must be JSON" });
      return null;
    }
  };

  app.get("/api/agent", (req, res) => {
    if (!guard(req, res)) return;
    res.setHeader("Cache-Control", "no-store");
    res.json({
      ok: true,
      name: "FIRSTLIGHT agent gateway",
      enabled: gateway.open(),
      ...(gateway.open() ? {} : { why: "AI agents are off on this server (AGENTS_ENABLED)." }),
      seats: { used: gateway.seatsUsed(), max: GATEWAY_RULES.seats },
      mcp: "/mcp",
      howto: HTTP_HOWTO,
      playbook: PLAYBOOK,
      tools: [...gateway.tools.values()].map((t) => ({ name: t.name.replace(/^firstlight_/, ""), description: t.description, inputSchema: t.inputSchema })),
    });
  });

  app.post("/api/agent/join", async (req, res) => {
    if (!guard(req, res)) return;
    const b = await body(req, res);
    if (!b) return;
    const gone = hangUpSignal(res);
    const r = await gateway.join(directRequestIp(req), b.v ?? {});
    // The caller hung up while it joined: nobody will ever hold this handle, so the seat goes now.
    if (r.ok && gone.aborted) return void (await gateway.drop(String(r.seat)));
    send(res, r.ok ? { ...r, howto: HTTP_HOWTO, playbook: PLAYBOOK } : r);
  });

  const Act = z.looseObject({ tool: z.string().min(1).max(40) });
  app.post("/api/agent/act", async (req, res) => {
    if (!guard(req, res)) return;
    const b = await body(req, res);
    if (!b) return;
    const parsed = Act.safeParse(b.v);
    if (!parsed.success) return send(res, { ok: false, reason: "bad arguments", hint: 'send {"tool": "<name>", ...arguments}' });
    const { tool, ...args } = parsed.data;
    const name = tool.startsWith("firstlight_") ? tool : `firstlight_${tool}`;
    // The caller hangs up: its call leaves the queue, or the walk or fight it waited on stops.
    const gone = hangUpSignal(res);
    const r = await gateway.call(bearer(req) ?? "", directRequestIp(req), name, args, gone);
    if (!gone.aborted) send(res, r);
  });

  app.get("/api/agent/observe", async (req, res) => {
    if (!guard(req, res)) return;
    const gone = hangUpSignal(res);
    const r = await gateway.call(bearer(req) ?? "", directRequestIp(req), "firstlight_observe", req.query.detail === "full" ? { detail: "full" } : {}, gone);
    if (!gone.aborted) send(res, r);
  });

  app.post("/api/agent/leave", async (req, res) => {
    if (!guard(req, res)) return;
    const b = await body(req, res);
    if (!b) return;
    const logout = (b.v as { logout?: unknown } | undefined)?.logout === true;
    send(res, await gateway.call(bearer(req) ?? "", directRequestIp(req), "firstlight_leave", logout ? { logout } : {}));
  });
}
