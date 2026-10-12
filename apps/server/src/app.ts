// Builds the game server: one HTTP server shared by Express routes and the Colyseus WebSocket
// transport. Exported as a factory so integration tests can run it in-process on a random port.

import http from "node:http";
import { matchMaker, Server } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import type { TokenVerifier } from "./auth/identity.ts";
import { directRequestIp } from "./auth/ip.ts";
import { BodyRoom } from "./world/BodyRoom.ts";
import { isBodyId, onlineCount, play, type MatchmakingLimits } from "./world/matchmaking.ts";

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
}

export interface Game {
  app: Express;
  httpServer: http.Server;
  gameServer: Server;
  port: number;
  close(): Promise<void>;
}

export async function createGame(opts: GameOptions): Promise<Game> {
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
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    Vary: "Origin",
  });
  // No client-side joinOrCreate/joinById/create; reconnect only.
  matchMaker.controller.exposedMethods = ["reconnect"];

  app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.path.startsWith("/api/") && !req.path.startsWith("/api/auth/")) {
      res.setHeader("Access-Control-Allow-Origin", corsFor(req.headers.origin));
      res.setHeader("Access-Control-Allow-Credentials", "true");
      res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
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
    if (Date.now() - onlineCache.at > 1000) onlineCache = { at: Date.now(), value: await onlineCount(false) };
    res.setHeader("Cache-Control", "public, max-age=2");
    res.json({ online: onlineCache.value });
  });

  app.post("/api/play", async (req, res) => {
    const auth = req.headers.authorization ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    const identity = token ? await opts.verify(token, { ip: directRequestIp(req) }) : null;
    if (!identity) {
      res.status(401).json({ ok: false, error: "unauthorized" });
      return;
    }
    const body = req.body?.body;
    if (!isBodyId(body)) {
      res.status(400).json({ ok: false, error: "bad body" });
      return;
    }
    try {
      const result = await play(
        identity,
        {
          body,
          partyLeaderRoomId: typeof req.body.partyLeaderRoomId === "string" ? req.body.partyLeaderRoomId : undefined,
          partySize: typeof req.body.partySize === "number" ? req.body.partySize : undefined,
          loadtest: req.body.loadtest === true,
        },
        opts.limits,
      );
      res.json(result);
    } catch (err) {
      console.error("play failed", err);
      res.status(500).json({ ok: false, error: "play failed" });
    }
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
