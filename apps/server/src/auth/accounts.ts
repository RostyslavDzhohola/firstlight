// The accounts-and-persistence module: opens auth.db and game.db, runs migrations, builds Better
// Auth, and provides the token verifier and the Express mounts for createGame().
//
//   const accounts = await createAccounts(accountsConfigFromEnv(env));
//   createGame({ verify: accounts.verify, mountBeforeJson: accounts.mountBeforeJson,
//                mountAfterJson: accounts.mountAfterJson, onShutdown: accounts.close, ... });

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { getMigrations } from "better-auth/db/migration";
import { toNodeHandler } from "better-auth/node";
import type { Express, NextFunction, Request, Response } from "express";
import { ensureAccount, isBanned, isIpBanned } from "../db/accounts.ts";
import { backfillTestAccounts, isTestAccount, markTestAccount } from "../db/testAccounts.ts";
import { isAgentAccount, markAgentAccount } from "../db/agentAccounts.ts";
import { openGameDb, setGameDb, type Db } from "../db/game-db.ts";
import { linkAccounts } from "../db/link.ts";
import { setDisplayName } from "../db/accounts.ts";
import { reserveOtpSend, releaseOtpSend } from "../db/otp-budget.ts";
import { closeDanglingSessions, pruneSessionLog } from "../db/sessions.ts";
import { closeFunnel, funnelConfig } from "../db/funnel.ts";
import { startFunnelService, type FunnelService } from "../db/funnelService.ts";
import { stmt } from "../db/game-db.ts";
import { authOptions, authRequestState, buildAuth, OTP_MIN_LEVEL, OTP_PER_ACCOUNT_PER_DAY, OTP_PUBLIC_PER_IP_PER_DAY, OTP_PUBLIC_SHARE, type FirstlightAuth } from "./better-auth.ts";
import { hmacHex, safeEqual, strongSecret } from "./crypto.ts";
import type { Identity, TokenVerifier, VerifyContext } from "./identity.ts";
import { banKey, CLIENT_IP_HEADER, localDevRequest, normalizeIp, proxiedRequestIp } from "./ip.ts";
import { accountLinks, type LinkEvents } from "./links.ts";
import { classifyMailFailure, DevOutbox, disabledMailer, MailHealth, resendMailer, type Mailer } from "./mailer.ts";
import { identifyRequest, mountAccountRoutes, requireAdminFor } from "./routes.ts";
import { pruneGuests } from "./prune.ts";
import { botSecret, botSecretWarning } from "./loadtest.ts";
import { liveSessions, type SessionRegistry } from "./sessions.ts";

export const DEV_AUTH_SECRET = "dev-only-secret-change-me-dev-only-secret";

export interface AccountsConfig {
  production: boolean;
  /** Public origin of the client (Better Auth baseURL, JWT iss/aud). */
  baseURL: string;
  secret: string;
  authDbPath: string;
  gameDbPath: string;
  trustedOrigins: string[];
  /** When set, /api/auth/* requires a matching x-origin-secret header (set by the Vercel proxy). */
  originSecret: string;
  emailFrom: string;
  resendKey: string;
  adminClaimToken: string;
  loadtestSecret: string;
  /** LOADTEST_ENABLED=1: in production the load-test features need it as well as the secret (D-security-1). */
  loadtestEnabled?: boolean;
  otpPerEmailPerHour: number;
  otpDailyBudget: number;
  /** Better Auth rate limiting (default: on in production only). */
  rateLimit?: boolean;
  /** Print dev OTP codes to the console (only when the dev outbox is in use). */
  devMailLog?: boolean;
  /** #84: mount GET /api/account/dev-code (DEV_SIGNIN_CODES=1). Needs the dev outbox and devCodeKey, never in production. */
  devCodeRoute?: boolean;
  /** The root `pnpm dev`'s per-run key (DEV_SIGNIN_KEY, tools/dev.ts); a reader of the route must send it. */
  devCodeKey?: string;
  /** The funnel (#85; FUNNEL_ENABLED, default on): off, nothing is recorded and no funnel timer or worker starts. */
  funnelEnabled?: boolean;
  /** Accepted after the Better Auth verifier (dev guest tokens when ALLOW_DEV_GUESTS=1). */
  fallbackVerifier?: TokenVerifier;
  mailer?: Mailer;
  sessions?: SessionRegistry;
  links?: LinkEvents;
}

export interface Accounts {
  auth: FirstlightAuth;
  authDb: Database.Database;
  db: Db;
  /** Better Auth JWT verifier, then the fallback verifier. Pass to createGame({ verify }). */
  verify: TokenVerifier;
  sessions: SessionRegistry;
  links: LinkEvents;
  mailer: Mailer;
  /** Can sign-in codes go out right now (GET /api/account/save-status)? */
  mailHealth: MailHealth;
  /** May this account get a code for a new address (OTP_MIN_LEVEL)? Guests only use it to save. */
  maySave(userId: string): boolean;
  /** Only when the dev outbox is in use (no RESEND_API_KEY, not production). Test-only. */
  devOutbox: DevOutbox | null;
  hashIp(ip: string): string;
  /**
   * Is this account still allowed into a seat it reserved earlier? Refusal reason or null: the
   * user row is gone (merged or deleted guest), it is banned, or it has no session left (signed out).
   */
  revalidate(userId: string, sessionId?: string): string | null;
  /** Resolve the caller from the Better Auth session cookie, else a Bearer JWT. */
  identify(req: Request): Promise<Identity | null>;
  /** Express middleware for /admin and /stats routes: 401 unless signed in, 403 unless admin. Sets res.locals.identity. */
  requireAdmin: (req: Request, res: Response, next: NextFunction) => Promise<void>;
  mountBeforeJson(app: Express): void;
  mountAfterJson(app: Express): void;
  /** The funnel's worker (reports and housekeeping off the game's thread, D-sec3-1); null when the funnel is off or game.db is in memory. */
  funnel: FunnelService | null;
  /** The daily housekeeping (also run once at boot): old analytics rows, abandoned guests, and the funnel's in its worker. */
  housekeep(): Promise<void>;
  /** Flush what is queued (one overall deadline) and close the databases. */
  close(): Promise<void>;
}

export async function createAccounts(cfg: AccountsConfig): Promise<Accounts> {
  if (cfg.production && (cfg.secret.length < 32 || cfg.secret === DEV_AUTH_SECRET)) {
    throw new Error("BETTER_AUTH_SECRET must be set (32+ chars) in production");
  }
  const sessions = cfg.sessions ?? liveSessions;
  const links = cfg.links ?? accountLinks;

  if (cfg.authDbPath !== ":memory:") mkdirSync(dirname(cfg.authDbPath), { recursive: true });
  const authDb = new Database(cfg.authDbPath);
  authDb.pragma("journal_mode = WAL");
  authDb.pragma("busy_timeout = 5000");
  const db = openGameDb(cfg.gameDbPath);
  setGameDb(db);
  // The funnel (#85): on unless switched off. Its reports and housekeeping run in a worker thread on
  // their own connection (db/funnelService.ts, D-sec3-1), which needs game.db to be a file.
  funnelConfig.enabled = cfg.funnelEnabled ?? true;
  const funnel = funnelConfig.enabled && cfg.gameDbPath !== ":memory:" ? startFunnelService(db, cfg.gameDbPath) : null;
  if (funnel) {
    // Today's caps start from what today already holds (a restart doesn't reset them); counted in the worker.
    await funnel.prime().catch((e: Error) => console.warn(`funnel: today's counts not read (${e.message}); today's caps start from zero`));
  }

  let devOutbox: DevOutbox | null = null;
  let mailer: Mailer;
  if (cfg.mailer) mailer = cfg.mailer;
  else if (cfg.resendKey) mailer = resendMailer(cfg.resendKey, cfg.emailFrom);
  else if (cfg.production) mailer = disabledMailer();
  else mailer = devOutbox = new DevOutbox(!!cfg.devMailLog);
  if (cfg.mailer instanceof DevOutbox) devOutbox = cfg.mailer;
  const mailHealth = new MailHealth(mailer);

  const hashIp = (ip: string) => hmacHex(`${cfg.secret}:ip`, banKey(ip)).slice(0, 32);
  let authRef: FirstlightAuth | null = null;
  let closed = false;
  let otpQueue: Promise<void> = Promise.resolve();
  // Prepared on first use: Better Auth's tables exist only after the migrations below.
  let savedEmailStmt: Database.Statement | null = null;
  const savedEmail = (email: string) => {
    savedEmailStmt ??= authDb.prepare(`SELECT 1 FROM "user" WHERE email = ? AND ("isAnonymous" IS NULL OR "isAnonymous" = 0) LIMIT 1`);
    return !!savedEmailStmt.get(email);
  };
  const hashEmail = (email: string) => hmacHex(`${cfg.secret}:email`, email.toLowerCase());


  const options = authOptions({
    authDb,
    baseURL: cfg.baseURL,
    secret: cfg.secret,
    trustedOrigins: cfg.trustedOrigins,
    rateLimit: cfg.rateLimit ?? cfg.production,
    strictOrigin: cfg.production,
    ipBanned: (ip) => isIpBanned(db, hashIp(ip)),
    savedEmail: (email) => savedEmail(email),
    accountBanned: (userId) => isBanned(db, userId, Date.now()),
    maySave: (userId) => bestLevel(db, userId) >= OTP_MIN_LEVEL,
    queueOtp: (email, ip) => {
      // One at a time, after this response is on its way; failures are logged by sendOtp/reserveOtp.
      otpQueue = otpQueue
        .then(() => new Promise<void>((ok) => setImmediate(ok)))
        .then(() => {
          if (!authRef || closed) return;
          const api = authRef.api;
          return authRequestState.run({ otpQueued: true, otpIp: ip }, () => api.sendVerificationOTP({ body: { email, type: "sign-in" } }));
        })
        .then(
          () => {},
          () => {},
        );
    },
    reserveOtp: (email, userId, ip) => {
      // Public (queued) sends count under their own per-address key (F12 final review S6), a share of
      // the day and their client IP's ban key (F12 confirmation Opus SF2).
      const key = hashEmail(userId ? email : `public:${email}`);
      const limits = {
        perEmailPerHour: cfg.otpPerEmailPerHour,
        perDay: cfg.otpDailyBudget,
        perAccountPerDay: OTP_PER_ACCOUNT_PER_DAY,
        publicPerDay: Math.floor(cfg.otpDailyBudget * OTP_PUBLIC_SHARE),
        publicPerIpPerDay: OTP_PUBLIC_PER_IP_PER_DAY,
      };
      const r = reserveOtpSend(db, key, limits, Date.now(), userId, userId || !ip ? null : hashIp(ip));
      if (!r.ok) console.warn(`otp send refused: ${r.reason} budget`);
      return r;
    },
    releaseOtp: (id, userId) => releaseOtpSend(db, id, userId),
    sendOtp: async (email, otp) => {
      const r = await mailer.sendOtp(email, otp);
      // A player's own save reports health; background sends to saved addresses don't (no enumeration).
      if (!authRequestState.getStore()?.otpQueued) mailHealth.record(r);
      if (r.ok) return null;
      console.warn(`otp send failed: ${r.error}${r.status ? ` (${r.status})` : ""}`);
      return classifyMailFailure(r);
    },
    mailState: () => mailHealth.state(),
    onLink: (guest, account) => {
      links.emitBefore(guest.id, account.id); // rooms flush live characters first
      // Did this very sign-in create the saved account (better-auth.ts databaseHooks)? Only then does a
      // test guest's flag carry over (D-home-6).
      const targetIsNew = authRequestState.getStore()?.createdUsers?.has(account.id) === true;
      const r = linkAccounts(db, guest.id, account.id, Date.now(), { targetIsNew });
      const { moved, displaced } = sessions.rekey(guest.id, account.id);
      const name = r.displayName ?? (account.name || guest.name);
      links.emit({ fromUserId: guest.id, toUserId: account.id, name, character: r.character, merged: r.merged, moved, displaced });
      return r.displayName ?? guest.name;
    },
  });

  // Migrate before the instance exists, so its startup schema check sees the final schema.
  const { runMigrations } = await getMigrations(options);
  await runMigrations();
  const auth = buildAuth(options);
  authRef = auth;
  // Settle Better Auth's startup schema check now (it would otherwise run in the background).
  const authCtx = await auth.$context;
  await authCtx.checkSchema?.();
  closeDanglingSessions(db);
  // One-off (D-home-6): flag the automation guests that predate the tools' marker. Logs what it changed.
  const anonStmt = authDb.prepare(`SELECT "isAnonymous" AS anon FROM "user" WHERE id = ?`);
  const backfilled = backfillTestAccounts(db, (id) => (anonStmt.get(id) as { anon: number | null } | undefined)?.anon === 1);
  if (backfilled !== null) console.log(`test accounts backfill: flagged ${backfilled} automation guest account(s)`);
  // Daily housekeeping (and once at boot): old analytics rows, abandoned guests (F12, see prune.ts).
  // The funnel's (old error reports, old cohort days folded into funnel_day) runs in its worker; the
  // returned promise settles when that is done (tests and the benchmark wait for it).
  const housekeeping = (): Promise<void> => {
    pruneSessionLog(db);
    const funnelDone = funnel
      ? funnel.housekeep().then(
          () => {},
          (e: Error) => console.warn(`funnel housekeeping: ${e.message}`),
        )
      : Promise.resolve();
    try {
      const n = pruneGuests(authDb, db, { isLive: (userId) => !!sessions.get(userId) });
      if (n) console.log(`pruned ${n} abandoned guest account(s)`);
    } catch (e) {
      console.warn(`guest pruning failed: ${(e as Error).message}`);
    }
    return funnelDone;
  };
  void housekeeping();
  const pruneTimer = setInterval(() => void housekeeping(), 24 * 3_600_000);
  pruneTimer.unref();

  const startedAt = Date.now();
  const sessionByIdStmt = authDb.prepare(`SELECT "expiresAt" AS exp FROM "session" WHERE id = ? AND "userId" = ?`);
  /** Does this session of this user still exist and not expire before `now`? */
  const sessionLive = (sessionId: string, userId: string, now: number): boolean => {
    const row = sessionByIdStmt.get(sessionId, userId) as { exp: unknown } | undefined;
    return !!row && dbTime(row.exp) > now;
  };
  const botKey = botSecret(cfg);
  const botWarning = botSecretWarning(cfg);
  if (botWarning) console.warn(botWarning);
  const userStmt = authDb.prepare(`SELECT id, name, "isAnonymous" AS anon FROM "user" WHERE id = ?`);

  const betterAuthVerifier: TokenVerifier = async (token, vctx?: VerifyContext) => {
    let payload: Record<string, unknown> | null = null;
    try {
      payload = (await auth.api.verifyJWT({ body: { token } })).payload as Record<string, unknown> | null;
    } catch {
      payload = null;
    }
    if (vctx) vctx.jwt = { token, payload };
    const sub = payload?.sub;
    if (!payload || typeof sub !== "string" || !sub) return null;
    const tokenName = typeof payload.name === "string" ? payload.name : "";
    if (payload.loadtest === true) {
      // Bot identities are minted only by /api/test/bot-token and only honoured during load tests.
      if (!botKey) return null;
      return { userId: sub, name: tokenName || "Bot", guest: true, admin: false, loadtest: true };
    }
    const user = userStmt.get(sub) as { id: string; name: string; anon: number | null } | undefined;
    if (!user) return null; // merged/deleted guest or deleted account
    const now = Date.now();
    // Bound to the issuing session (D-security-5): signed out or expired, its tokens are dead. Tokens
    // without one come from before this change: only those issued before this process started.
    const sid = typeof payload.sid === "string" && payload.sid ? payload.sid : null;
    if (sid ? !sessionLive(sid, sub, now) : !(typeof payload.iat === "number" && payload.iat * 1000 < startedAt)) return null;
    if (isBanned(db, sub, now)) return null;
    const ip = normalizeIp(vctx?.ip);
    const ipHash = ip ? hashIp(ip) : null;
    if (ipHash && isIpBanned(db, ipHash, now)) return null;
    const acc = ensureAccount(db, sub, now, ipHash);
    // Our test tools send LOADTEST_SECRET with their guests' requests: flag those guests (D-home-6).
    // Only guests, and only with the right secret: a player can't set it, a saved account never gets it.
    if (user.anon === 1 && vctx?.toolSecret && cfg.loadtestSecret && safeEqual(vctx.toolSecret, cfg.loadtestSecret)) markTestAccount(db, sub, "tool", now);
    // Only validated display names are shown; otherwise a generated guest-style name (review:
    // Better Auth's free-form user.name must never become the in-game name).
    const generated = /^Wanderer-\d{4}$/.test(user.name) ? user.name : `Wanderer-${(parseInt(sub.replace(/[^0-9a-f]/gi, "").slice(-6) || "0", 16) % 9000) + 1000}`;
    let display = acc.displayName;
    // A name supplied at sign-in is only adopted if it passes the display-name rules and is free.
    if (!display && user.name && user.name !== generated) {
      const r = setDisplayName(db, sub, user.name, now);
      if (r.ok) display = r.name;
    }
    // An AI agent says so when it asks for a seat (D-agents-1): its guest account is flagged from then on.
    if (user.anon === 1 && vctx?.agent) markAgentAccount(db, sub, "play", now);
    return { userId: sub, name: display ?? generated, guest: user.anon === 1, admin: acc.isAdmin, loadtest: false, account: true, test: isTestAccount(db, sub), agent: isAgentAccount(db, sub), ...(sid ? { authSession: sid } : {}) };
  };

  const sessionStmt = authDb.prepare(`SELECT 1 FROM "session" WHERE "userId" = ? LIMIT 1`);
  const revalidate = (userId: string, sessionId?: string): string | null => {
    if (!userStmt.get(userId)) return "account gone";
    if (isBanned(db, userId, Date.now())) return "banned";
    if (sessionId ? !sessionLive(sessionId, userId, Date.now()) : !sessionStmt.get(userId)) return "signed out";
    return null;
  };

  const fallback = cfg.fallbackVerifier;
  const verify: TokenVerifier = async (token, vctx) => (await betterAuthVerifier(token, vctx)) ?? (fallback ? fallback(token, vctx) : null);

  const handler = toNodeHandler(auth);

  const accounts: Accounts = {
    auth,
    authDb,
    db,
    verify,
    sessions,
    links,
    mailer,
    mailHealth,
    maySave: (userId) => bestLevel(db, userId) >= OTP_MIN_LEVEL,
    devOutbox,
    hashIp,
    revalidate,
    identify: async () => null,
    requireAdmin: async () => {},
    mountBeforeJson(app) {
      app.use("/api/auth", (req, res, next) => {
        res.setHeader("Cache-Control", "no-store");
        // Only this middleware may set the client-IP header Better Auth trusts.
        delete req.headers[CLIENT_IP_HEADER];
        if (cfg.originSecret) {
          const got = req.headers["x-origin-secret"];
          if (typeof got !== "string" || !safeEqual(got, cfg.originSecret)) {
            res.status(403).json({ error: "forbidden" });
            return;
          }
        }
        delete req.headers["x-origin-secret"];
        // Past the origin-secret check: the Vercel hop's first forwarded address (D-security-4, ip.ts).
        const ip = proxiedRequestIp(req);
        if (ip) req.headers[CLIENT_IP_HEADER] = ip;
        next();
      });
      app.all("/api/auth/*splat", (req, res) => {
        authRequestState.run({}, () => {
          handler(req, res).catch((err: unknown) => {
            console.error("auth handler failed", err);
            if (!res.headersSent) res.status(500).json({ error: "auth failed" });
          });
        });
      });
    },
    mountAfterJson(app) {
      mountAccountRoutes(app, accounts, cfg);
      // #84: a development server with no mail key sends no email: the save and sign-in cards ask
      // here for the code the dev outbox kept and show it. It hands out anyone's code, so "not
      // production" is not enough, and neither is "looks local": a header's absence proves nothing (a
      // reverse proxy on this machine that adds no forwarding header looks exactly like the developer;
      // review round two, blocker 1). The code is readable only with the key the root `pnpm dev`
      // generated for this run (tools/dev.ts), which only the developer's own server and Vite hold,
      // and Vite shows only in the developer's terminal, as a link (no request returns it; D-sec3-6);
      // without that key configured the route does not exist. Defence in depth around it: the
      // DEV_SIGNIN_CODES=1 opt-in, never in production, a loopback socket with a loopback Host and no
      // forwarding header (localDevRequest), and an Origin that is absent or one of our client
      // origins (another site's page can't read a code by CORS or a rebound name). Every refusal is
      // the same 404.
      const outbox = devOutbox;
      const key = cfg.devCodeKey ?? "";
      if (outbox && cfg.devCodeRoute && !cfg.production && strongSecret(key)) {
        const origins = new Set(cfg.trustedOrigins);
        app.get("/api/account/dev-code", (req, res) => {
          res.setHeader("Cache-Control", "no-store");
          const given = req.headers["x-firstlight-dev-key"];
          const origin = req.headers.origin;
          if (typeof given !== "string" || !safeEqual(given, key) || (origin !== undefined && !origins.has(origin)) || !localDevRequest(req)) {
            res.status(404).json({ error: "not found" });
            return;
          }
          const email = typeof req.query.email === "string" ? req.query.email.trim() : "";
          res.json({ code: email ? outbox.recentCode(email) : null });
        });
      } else if (outbox && cfg.devCodeRoute && !cfg.production) {
        console.warn("dev-code: DEV_SIGNIN_CODES=1 but no DEV_SIGNIN_KEY, so the cards can't fetch codes; start with the root `pnpm dev` (or DEV_MAIL_LOG=1 prints them)");
      }
    },
    funnel,
    housekeep: housekeeping,
    async close() {
      if (closed) return;
      closed = true;
      clearInterval(pruneTimer);
      // Queued funnel rows and error reports: written in slices without waiting for a lock, until one
      // overall deadline; the rest is counted lost and logged once (db/funnel.ts closeFunnel). Then the
      // funnel's worker stops.
      if (funnel) await funnel.close();
      else await closeFunnel(db);
      setGameDb(null);
      try {
        db.close();
      } catch {}
      try {
        authDb.close();
      } catch {}
    },
  };
  accounts.identify = (req) => identifyRequest(accounts, req);
  accounts.requireAdmin = requireAdminFor(accounts);
  return accounts;
}

/** The highest level the account's character has reached (live row, or any recorded session). */
function bestLevel(db: Db, userId: string): number {
  const live = (stmt(db, "SELECT level FROM character WHERE user_id = ?").get(userId) as { level: number } | undefined)?.level ?? 0;
  const seen = (stmt(db, "SELECT MAX(max_level) AS m FROM session_log WHERE user_id = ?").get(userId) as { m: number | null }).m ?? 0;
  return Math.max(live, seen);
}

/** Map server env to the accounts config. */
export function accountsConfigFromEnv(env: {
  production: boolean;
  authUrl: string;
  authSecret: string;
  authDbPath: string;
  gameDbPath: string;
  clientOrigins: string[];
  originSecret: string;
  emailFrom: string;
  resendKey: string;
  adminClaimToken: string;
  loadtestSecret: string;
  loadtestEnabled?: boolean;
  otpDailyBudget: number;
  otpPerEmailPerHour: number;
  devMailLog: boolean;
  devCodeRoute?: boolean;
  devSigninKey?: string;
  funnelEnabled?: boolean;
}): AccountsConfig {
  return {
    production: env.production,
    baseURL: env.authUrl,
    secret: env.authSecret,
    authDbPath: env.authDbPath,
    gameDbPath: env.gameDbPath,
    trustedOrigins: env.clientOrigins,
    originSecret: env.originSecret,
    emailFrom: env.emailFrom,
    resendKey: env.resendKey,
    adminClaimToken: env.adminClaimToken,
    loadtestSecret: env.loadtestSecret,
    loadtestEnabled: env.loadtestEnabled,
    otpDailyBudget: env.otpDailyBudget,
    otpPerEmailPerHour: env.otpPerEmailPerHour,
    devMailLog: env.devMailLog,
    devCodeRoute: !!env.devCodeRoute && !env.production,
    devCodeKey: env.production ? "" : (env.devSigninKey ?? ""),
    funnelEnabled: env.funnelEnabled ?? true,
  };
}

/** A Better Auth date column (ms or s since the epoch, or an ISO string) in ms; NaN if unreadable. */
function dbTime(v: unknown): number {
  if (typeof v === "number") return v < 1e12 ? v * 1000 : v;
  if (typeof v === "string") return /^\d+$/.test(v) ? dbTime(Number(v)) : Date.parse(v);
  if (v instanceof Date) return v.getTime();
  return Number.NaN;
}
