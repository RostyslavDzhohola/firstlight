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
import { openGameDb, setGameDb, type Db } from "../db/game-db.ts";
import { linkAccounts } from "../db/link.ts";
import { setDisplayName } from "../db/accounts.ts";
import { reserveOtpSend, releaseOtpSend } from "../db/otp-budget.ts";
import { closeDanglingSessions, pruneSessionLog } from "../db/sessions.ts";
import { stmt } from "../db/game-db.ts";
import { authOptions, authRequestState, buildAuth, OTP_MIN_LEVEL, OTP_PER_ACCOUNT_PER_DAY, OTP_PUBLIC_PER_IP_PER_DAY, OTP_PUBLIC_SHARE, type FirstlightAuth } from "./better-auth.ts";
import { hmacHex, safeEqual } from "./crypto.ts";
import type { Identity, TokenVerifier, VerifyContext } from "./identity.ts";
import { banKey, CLIENT_IP_HEADER, firstForwardedFor, normalizeIp } from "./ip.ts";
import { accountLinks, type LinkEvents } from "./links.ts";
import { classifyMailFailure, DevOutbox, disabledMailer, MailHealth, resendMailer, type Mailer } from "./mailer.ts";
import { identifyRequest, mountAccountRoutes, requireAdminFor } from "./routes.ts";
import { pruneGuests } from "./prune.ts";
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
  otpPerEmailPerHour: number;
  otpDailyBudget: number;
  /** Better Auth rate limiting (default: on in production only). */
  rateLimit?: boolean;
  /** Print dev OTP codes to the console (only when the dev outbox is in use). */
  devMailLog?: boolean;
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
  revalidate(userId: string): string | null;
  /** Resolve the caller from the Better Auth session cookie, else a Bearer JWT. */
  identify(req: Request): Promise<Identity | null>;
  /** Express middleware for /admin and /stats routes: 401 unless signed in, 403 unless admin. Sets res.locals.identity. */
  requireAdmin: (req: Request, res: Response, next: NextFunction) => Promise<void>;
  mountBeforeJson(app: Express): void;
  mountAfterJson(app: Express): void;
  close(): void;
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
  // Was this saved account created by the sign-in that's linking a guest into it (D-home-6)? Better
  // Auth creates the user moments before onLinkAccount; an older one is an existing account.
  let createdStmt: Database.Statement | null = null;
  const createdJustNow = (userId: string) => {
    createdStmt ??= authDb.prepare(`SELECT "createdAt" AS at FROM "user" WHERE id = ?`);
    const at = (createdStmt.get(userId) as { at: string | number | null } | undefined)?.at;
    const t = typeof at === "number" ? at : Date.parse(String(at ?? ""));
    return Number.isFinite(t) && Date.now() - t < 60_000;
  };

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
      const r = linkAccounts(db, guest.id, account.id, Date.now(), { targetIsNew: createdJustNow(account.id) });
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
  const housekeeping = () => {
    pruneSessionLog(db);
    try {
      const n = pruneGuests(authDb, db, { isLive: (userId) => !!sessions.get(userId) });
      if (n) console.log(`pruned ${n} abandoned guest account(s)`);
    } catch (e) {
      console.warn(`guest pruning failed: ${(e as Error).message}`);
    }
  };
  housekeeping();
  const pruneTimer = setInterval(housekeeping, 24 * 3_600_000);
  pruneTimer.unref();

  const userStmt = authDb.prepare(`SELECT id, name, "isAnonymous" AS anon FROM "user" WHERE id = ?`);

  const betterAuthVerifier: TokenVerifier = async (token, vctx?: VerifyContext) => {
    let payload: Record<string, unknown> | null = null;
    try {
      payload = (await auth.api.verifyJWT({ body: { token } })).payload as Record<string, unknown> | null;
    } catch {
      return null;
    }
    const sub = payload?.sub;
    if (!payload || typeof sub !== "string" || !sub) return null;
    const tokenName = typeof payload.name === "string" ? payload.name : "";
    if (payload.loadtest === true) {
      // Bot identities are minted only by /api/test/bot-token and only honoured during load tests.
      if (!cfg.loadtestSecret) return null;
      return { userId: sub, name: tokenName || "Bot", guest: true, admin: false, loadtest: true };
    }
    const user = userStmt.get(sub) as { id: string; name: string; anon: number | null } | undefined;
    if (!user) return null; // merged/deleted guest or deleted account
    const now = Date.now();
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
    return { userId: sub, name: display ?? generated, guest: user.anon === 1, admin: acc.isAdmin, loadtest: false, account: true, test: isTestAccount(db, sub) };
  };

  const sessionStmt = authDb.prepare(`SELECT 1 FROM "session" WHERE "userId" = ? LIMIT 1`);
  const revalidate = (userId: string): string | null => {
    if (!userStmt.get(userId)) return "account gone";
    if (isBanned(db, userId, Date.now())) return "banned";
    if (!sessionStmt.get(userId)) return "signed out";
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
        const ip = firstForwardedFor(req) ?? normalizeIp(req.socket.remoteAddress);
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
    },
    close() {
      closed = true;
      clearInterval(pruneTimer);
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
  otpDailyBudget: number;
  otpPerEmailPerHour: number;
  devMailLog: boolean;
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
    otpDailyBudget: env.otpDailyBudget,
    otpPerEmailPerHour: env.otpPerEmailPerHour,
    devMailLog: env.devMailLog,
  };
}
