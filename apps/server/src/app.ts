// Builds the game server: one HTTP server shared by Express routes and the Colyseus WebSocket
// transport. Exported as a factory so integration tests can run it in-process on a random port.

import http from "node:http";
import { matchMaker, Server } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import type { TokenVerifier } from "./auth/identity.ts";
import { directRequestIp } from "./auth/ip.ts";
import { BodyRoom } from "./world/BodyRoom.ts";
import { enterSandbox, isBodyId, onlineCount, play, type MatchmakingLimits } from "./world/matchmaking.ts";
import { identityCheck, storageRecovery, travelRedirect } from "./world/admission.ts";
import { pendingSeats } from "./world/reservations.ts";
import { STARTERS } from "@firstlight/shared/content/weapons";
import { PROTOCOL_VERSION } from "@firstlight/shared/net/protocol";
import { timingSafeEqual } from "node:crypto";
import { partyOf, partyRoomFor, playRefusal } from "./social/index.ts";
import { publicOnlineCount } from "./ops/home.ts";

export interface GameOptions {
  port: number;
  verify: TokenVerifier;
  limits: MatchmakingLimits;
  allowedOrigins: string[];
  /** Mount extra routes (auth, admin) before JSON parsing. */
  mountBeforeJson?: (app: Express) => void;
  mountAfterJson?: (app: Express) => void;
  gracefulShutdown?: boolean;
  onShutdown?: () => Promise<void> | void;
  /** When verification fails: is this a validly signed token of a banned account/network? (403 "banned" instead of 401.) */
  explainRefusal?: (token: string, ip: string | null) => Promise<string | null>;
  /** Accounts: recheck a real account when its seat is used (merged/deleted, banned, signed out). */
  revalidate?: (userId: string) => string | null;
}

const LOOPBACK: ReadonlySet<string> = new Set(["127.0.0.1", "::1"]);

/** /api/play limits (F12 S2): calls per 10 s and unused seats, per account and per address. */
export const PLAY_LIMITS = {
  windowMs: 10_000,
  userCalls: 6,
  ipCalls: 60,
  userSeats: 2,
  ipSeats: 10,
};

export interface Game {
  app: Express;
  httpServer: http.Server;
  gameServer: Server;
  port: number;
  close(): Promise<void>;
}

/** Our test tools mark their guests with this header (LOADTEST_SECRET; D-home-6). */
export function toolHeader(req: Request): string | null {
  const v = req.headers["x-loadtest-secret"];
  return typeof v === "string" && v ? v : null;
}

function secretMatches(given: unknown, expected: string): boolean {
  if (typeof given !== "string" || !expected) return false;
  const a = Buffer.from(given), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function createGame(opts: GameOptions): Promise<Game> {
  identityCheck.current = opts.revalidate ?? (() => null);
  const playCalls = new Map<string, number[]>();
  const ipCalls = new Map<string, number[]>();
  const pruneCalls = setInterval(() => {
    const now = Date.now();
    for (const m of [playCalls, ipCalls]) for (const [k, v] of m) if (v.every((t) => now - t > PLAY_LIMITS.windowMs)) m.delete(k);
  }, 60_000);
  pruneCalls.unref();
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", true);
  const httpServer = http.createServer(app);

  const allowed = new Set(opts.allowedOrigins);
  const corsFor = (origin: string | null | undefined) => (origin && allowed.has(origin) ? origin : opts.allowedOrigins[0] ?? "");
  // Colyseus answers its own HTTP routes with permissive CORS by default; pin it to our origins.
  matchMaker.controller.getCorsHeaders = (headers: Headers) => ({
    "Access-Control-Allow-Origin": corsFor(headers.get("origin")),
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Loadtest-Secret",
    Vary: "Origin",
  });
  // No client-side joinOrCreate/joinById/create; reconnect only.
  matchMaker.controller.exposedMethods = ["reconnect"];

  app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.path.startsWith("/api/") && !req.path.startsWith("/api/auth/")) {
      res.setHeader("Access-Control-Allow-Origin", corsFor(req.headers.origin));
      res.setHeader("Access-Control-Allow-Credentials", "true");
      res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Loadtest-Secret");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Vary", "Origin");
      if (req.method === "OPTIONS") {
        res.status(204).end();
        return;
      }
    }
    next();
  });

  opts.mountBeforeJson?.(app);
  app.use(express.json({ limit: "32kb" }));

  app.get("/healthz", async (_req, res) => {
    res.json({ ok: true, uptime: process.uptime(), online: await onlineCount(true) });
  });

  let onlineCache = { at: 0, value: 0 };
  app.get("/api/online", async (_req, res) => {
    // Real players only: load-test bots and our test accounts don't count (D-home-6).
    if (Date.now() - onlineCache.at > 1000) onlineCache = { at: Date.now(), value: publicOnlineCount() };
    res.setHeader("Cache-Control", "public, max-age=2");
    res.json({ online: onlineCache.value });
  });

  app.post("/api/play", async (req, res) => {
    const auth = req.headers.authorization ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    const identity = token ? await opts.verify(token, { ip: directRequestIp(req), toolSecret: toolHeader(req) }) : null;
    if (!identity) {
      const why = token && opts.explainRefusal ? await opts.explainRefusal(token, directRequestIp(req)).catch(() => null) : null;
      if (why) res.status(403).json({ ok: false, error: why });
      else res.status(401).json({ ok: false, error: "unauthorized" });
      return;
    }
    const body = req.body?.body;
    if (!isBodyId(body)) {
      res.status(400).json({ ok: false, error: "bad body" });
      return;
    }
    // Stale tabs after a deploy: refuse other protocol versions so the client reloads.
    if (req.body?.v !== PROTOCOL_VERSION) {
      res.status(409).json({ ok: false, error: "version", version: PROTOCOL_VERSION });
      return;
    }
    // Rate limits: each request reserves a seat for a while (F12 S2: per account and per address).
    const now = Date.now();
    const recent = (playCalls.get(identity.userId) ?? []).filter((t) => now - t < PLAY_LIMITS.windowMs);
    if (recent.length >= PLAY_LIMITS.userCalls) {
      res.status(429).json({ ok: false, error: "slow down" });
      return;
    }
    recent.push(now);
    playCalls.set(identity.userId, recent);
    const ip = directRequestIp(req);
    // Per-address limits skip load-test bots and loopback (local development and in-process tests;
    // production requests always carry the edge's client address).
    const perAddress = !identity.loadtest && !(ip !== null && LOOPBACK.has(ip));
    if (!identity.loadtest) {
      const key = ip ?? "unknown";
      const fromIp = (ipCalls.get(key) ?? []).filter((t) => now - t < PLAY_LIMITS.windowMs);
      if (perAddress && fromIp.length >= PLAY_LIMITS.ipCalls) {
        res.status(429).json({ ok: false, error: "slow down" });
        return;
      }
      fromIp.push(now);
      ipCalls.set(key, fromIp);
    }
    // A change of this account couldn't be saved: not back in until storage works (F12 re-review S5).
    if (!storageRecovery.ok(identity.userId)) {
      res.status(503).json({ ok: false, error: "storage" });
      return;
    }
    // Banned (also covers dev identities) or recently kicked by an admin.
    const refusal = identity.loadtest ? null : playRefusal(identity.userId);
    if (refusal) {
      res.status(403).json({ ok: false, error: refusal });
      return;
    }
    // Bots only in load-test rooms, players only in public rooms ("no fake players, ever").
    if ((req.body.loadtest === true) !== !!identity.loadtest) {
      res.json({ ok: false, error: "forbidden" });
      return;
    }
    // An admin's sandbox (D-admin-3): admins only, the real character alive and out of a fight; it
    // is saved now and leaves the real world, and the sandbox opens (or goes on, after travel).
    const sandbox = req.body.sandbox === true;
    if (sandbox) {
      const why = enterSandbox(identity, now);
      if (why) {
        res.status(403).json({ ok: false, error: why });
        return;
      }
    }
    // Travel tickets: a character may only rejoin its current body or the one an unexpired ticket
    // names (portal, out of combat); brand-new characters start home. Admins and bots are exempt.
    const redirect = travelRedirect(identity, body, Date.now());
    if (redirect) {
      res.json({ ok: false, error: "travel", body: redirect });
      return;
    }
    // Party headroom (D12) only for real party members: the copy another member is in on this body
    // (a client hint is honoured only if it names such a room).
    const partyRoom = sandbox ? undefined : partyRoomFor(identity.userId, body, typeof req.body.partyLeaderRoomId === "string" ? req.body.partyLeaderRoomId : undefined);
    // Unused-seat caps: checked and claimed together, before any await (F12 re-review S4); the claim
    // becomes the reservation or is released.
    const seatIp = perAddress ? (ip ?? "unknown") : null;
    if (!identity.loadtest && (pendingSeats.forUser(identity.userId, now) >= PLAY_LIMITS.userSeats || (seatIp !== null && pendingSeats.forIp(seatIp, now) >= PLAY_LIMITS.ipSeats))) {
      res.status(429).json({ ok: false, error: "slow down" });
      return;
    }
    const claim = pendingSeats.claim(identity.userId, seatIp, body, now);
    try {
      const result = await play(
        identity,
        {
          body,
          partyLeaderRoomId: partyRoom,
          partySize: partyRoom ? partyOf(identity.userId).length : undefined,
          starter: Number.isInteger(req.body.starter) ? Math.max(0, Math.min(STARTERS.length - 1, req.body.starter)) : undefined,
          palette: Number.isInteger(req.body.palette) ? Math.max(0, Math.min(5, req.body.palette)) : undefined,
          look: Number.isInteger(req.body.look) ? Math.max(0, Math.min(15, req.body.look)) : undefined,
          loadtest: req.body.loadtest === true,
          sandbox,
        },
        opts.limits,
      );
      if (result.ok) pendingSeats.bind(claim, result.reservation.sessionId, result.reservation.roomId);
      else pendingSeats.release(claim);
      res.json(result);
    } catch (err) {
      pendingSeats.release(claim);
      console.error("play failed", err);
      res.status(500).json({ ok: false, error: "play failed" });
    }
  });

  // Load-test and admin metrics: per-room tick time and process usage. Guarded by the load-test secret.
  app.get("/api/metrics", async (req, res) => {
    const secret = process.env.LOADTEST_SECRET;
    if (!secret || !secretMatches(req.headers["x-loadtest-secret"], secret)) {
      res.status(403).json({ error: "forbidden" });
      return;
    }
    const rooms = await matchMaker.query({ name: "body" });
    const stats = rooms.map((r) => {
      const room = matchMaker.getLocalRoomById(r.roomId) as BodyRoom | undefined;
      const t = [...(room?.tickTimes ?? [])].sort((a, b) => a - b);
      const q = (p: number) => (t.length ? +t[Math.min(t.length - 1, Math.floor(t.length * p))]!.toFixed(2) : 0);
      return { roomId: r.roomId, metadata: r.metadata, clients: r.clients, tickP50: q(0.5), tickP95: q(0.95), tickMax: q(1) };
    });
    const mem = process.memoryUsage();
    const cpu = process.cpuUsage();
    res.json({ rooms: stats, rssMB: Math.round(mem.rss / 1048576), heapMB: Math.round(mem.heapUsed / 1048576), cpuUserS: cpu.user / 1e6, cpuSystemS: cpu.system / 1e6, uptimeS: process.uptime() });
  });

  opts.mountAfterJson?.(app);

  const transport = new WebSocketTransport({ server: httpServer, maxPayload: 16 * 1024 });
  const gameServer = new Server({ transport, gracefullyShutdown: opts.gracefulShutdown ?? false });
  gameServer.define("body", BodyRoom).filterBy(["body"]);
  if (opts.onShutdown) gameServer.onShutdown(opts.onShutdown);

  await gameServer.listen(opts.port);
  const address = httpServer.address();
  const port = typeof address === "object" && address ? address.port : opts.port;

  return {
    app,
    httpServer,
    gameServer,
    port,
    async close() {
      await gameServer.gracefullyShutdown(false).catch(() => {});
      await new Promise<void>((r) => httpServer.close(() => r()));
    },
  };
}
