// Better Auth 1.7.7 configuration (docs/tech-facts.md §5): anonymous guests, email-OTP save/sign-in,
// 15-minute JWTs for /api/play. The OTP budget and send result are enforced here through hooks,
// because Better Auth reports success even when the send function fails.

import { AsyncLocalStorage } from "node:async_hooks";
import { randomInt } from "node:crypto";
import type Database from "better-sqlite3";
import { betterAuth, type BetterAuthOptions } from "better-auth";
import { APIError, createAuthMiddleware, getSessionFromCtx, isAPIError } from "better-auth/api";
import { anonymous, emailOTP, jwt } from "better-auth/plugins";
import { z } from "zod";
import { CLIENT_IP_HEADER } from "./ip.ts";

export const SAVING_BUSY = "Saving is busy, try again later";

/** A new address only gets a code from a player who reached this level (the save card's first level-up). */
export const OTP_MIN_LEVEL = 2;

/** Codes one account may ask for per UTC day (saving a guest), so one session can't drain the global budget. */
export const OTP_PER_ACCOUNT_PER_DAY = 10;

/**
 * Public requests (no session that may save: returning players signing in) may use this share of
 * the global daily budget, so they can never use up what saving needs (F12 confirmation Opus SF2).
 */
export const OTP_PUBLIC_SHARE = 0.6;

/** Public codes per client IP (IPv6: per /64, the ban key) per UTC day. */
export const OTP_PUBLIC_PER_IP_PER_DAY = 5;

/**
 * Better Auth endpoints the game never calls (F12 final review S6, S8). It uses only anonymous
 * sign-in, get-session, token, sign-in codes (send-verification-otp, type "sign-in") and
 * sign-in/email-otp. The other email-OTP endpoints answered differently for saved and unknown
 * addresses; email/password flows aren't configured; profile edits go through /api/account; and a
 * guest that deleted itself kept its game.db rows and display name for good. Server-side
 * `auth.api.*` calls skip this list, so the anonymous plugin still deletes the guest after a save.
 */
export const DISABLED_AUTH_PATHS = [
  "/update-user",
  "/change-email",
  "/delete-user",
  "/delete-anonymous-user",
  "/email-otp/check-verification-otp",
  "/email-otp/verify-email",
  "/email-otp/request-password-reset",
  "/forget-password/email-otp",
  "/email-otp/reset-password",
  "/email-otp/request-email-change",
  "/email-otp/change-email",
  "/sign-in/email",
  "/sign-up/email",
  "/request-password-reset",
  "/reset-password",
  "/send-verification-email",
  "/verify-email",
  "/change-password",
  "/verify-password",
];

/**
 * Every failed code check (wrong, used up, expired, none sent) gets this one answer: otherwise
 * "too many attempts" or "expired" would show that a code exists, which for a session-less request
 * means the address is saved (F12 final review S6).
 */
export const WRONG_CODE = { code: "INVALID_OTP", message: "Wrong or expired code" } as const;
const CODE_FAILURES: ReadonlySet<string> = new Set(["INVALID_OTP", "OTP_EXPIRED", "TOO_MANY_ATTEMPTS"]);

/** Per-request state shared by the before hook, the send function and the after hook. */
interface AuthRequestState {
  /** The budget reservation of this send, and the account it counts against (null: a public send). */
  otpReservation?: { id: number; userId: string | null };
  otpSendFailed?: boolean;
  /** A queued background send (the public request was already answered). */
  otpQueued?: boolean;
  /** The client IP the queued send was asked from (its per-IP cap). */
  otpIp?: string | null;
}

export const authRequestState = new AsyncLocalStorage<AuthRequestState>();

export interface LinkedUser {
  id: string;
  name: string;
}

export interface AuthDeps {
  authDb: Database.Database;
  baseURL: string;
  secret: string;
  trustedOrigins: string[];
  rateLimit: boolean;
  /** True if this client IP is banned. */
  ipBanned(ip: string): boolean;
  /** Does this (lower-cased) address belong to a saved account? (A returning player.) */
  savedEmail(email: string): boolean;
  /** Is this account banned? (Its session gets no codes at all.) */
  accountBanned(userId: string): boolean;
  /** May this signed-in player get a code for any address? (Saving a guest after OTP_MIN_LEVEL.) */
  maySave(userId: string): boolean;
  /**
   * Send a code to this saved address in the background: reserve the budget and deliver later, so
   * the public answer never depends on the budget, the delivery result or its timing. `ip`: the
   * client that asked.
   */
  queueOtp(email: string, ip: string | null): void;
  /**
   * Reserve one OTP send for this (lower-cased) email; false = over budget. Returns a reservation id.
   * `userId` is the signed-in player asking (OTP_PER_ACCOUNT_PER_DAY applies), or null for a queued
   * public send from `ip` (OTP_PUBLIC_SHARE of the day and OTP_PUBLIC_PER_IP_PER_DAY apply).
   * The two kinds have separate per-address hourly caps, so public requests (which only reach saved
   * addresses) never change what a player who may save is told about an address.
   */
  reserveOtp(email: string, userId: string | null, ip: string | null): { ok: true; id: number } | { ok: false; reason: string };
  releaseOtp(id: number, userId: string | null): void;
  sendOtp(email: string, otp: string): Promise<boolean>;
  /** Guest → account. Synchronous game.db move + live re-key; returns the name to keep on the account. */
  onLink(guest: LinkedUser, account: LinkedUser): string | null;
}

const IP_CHECKED_PATHS = new Set(["/sign-in/anonymous", "/sign-in/email-otp", "/email-otp/send-verification-otp"]);
const emailSchema = z.email();

/** Better Auth options (exported separately so migrations can run before the instance exists). */
export function authOptions(d: AuthDeps) {
  return {
    appName: "FIRSTLIGHT",
    database: d.authDb,
    secret: d.secret,
    baseURL: d.baseURL,
    basePath: "/api/auth",
    disabledPaths: DISABLED_AUTH_PATHS,
    trustedOrigins: d.trustedOrigins,
    telemetry: { enabled: false },
    session: { expiresIn: 60 * 60 * 24 * 180, updateAge: 60 * 60 * 24 },
    rateLimit: {
      enabled: d.rateLimit,
      storage: "memory",
      customRules: {
        "/sign-in/anonymous": { window: 60, max: 20 },
        "/sign-in/email-otp": { window: 60, max: 5 },
        // Per-IP cap on code emails (review: OTP abuse); per-address and daily caps live in otp-budget.
        "/email-otp/send-verification-otp": { window: 3600, max: 8 },
      },
    },
    advanced: { ipAddress: { ipAddressHeaders: [CLIENT_IP_HEADER] } },
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        if (!IP_CHECKED_PATHS.has(ctx.path ?? "")) return;
        const ip = ctx.headers?.get(CLIENT_IP_HEADER);
        if (ip && d.ipBanned(ip)) throw APIError.from("FORBIDDEN", { code: "BANNED", message: "This device is banned." });
        if (ctx.path !== "/email-otp/send-verification-otp") return;
        const body = (ctx.body ?? {}) as { email?: unknown; type?: unknown };
        if (body.type !== "sign-in") throw APIError.from("BAD_REQUEST", { code: "UNSUPPORTED_OTP_TYPE", message: "Only sign-in codes are supported." });
        const email = typeof body.email === "string" ? body.email.toLowerCase() : "";
        if (!emailSchema.safeParse(email).success) return; // Better Auth rejects it
        // F12: a code goes only to a returning player's saved address, or from a signed-in player
        // who reached OTP_MIN_LEVEL (saving a guest), so fresh guests and session-less requests can't
        // drain the global budget. Public requests (no session, or below that level) always get the
        // same immediate answer, whatever the address, budget or delivery result (no enumeration);
        // saved addresses are served by a queued background send. A player who may save gets the
        // synchronous path with clear errors: its outcome doesn't depend on whose address it is.
        // Public sends are capped per client IP and to a share of the day in the background, so the
        // answer stays the same (F12 confirmation Opus SF2).
        let userId: string | null = null;
        const queued = authRequestState.getStore();
        if (!queued?.otpQueued) {
          const session = await getSessionFromCtx(ctx, { disableRefresh: true }).catch(() => null);
          userId = session?.user.id ?? null;
          // A banned account's session gets nothing (F12 final review S7).
          if (userId && d.accountBanned(userId)) throw APIError.from("FORBIDDEN", { code: "BANNED", message: "This account is banned." });
          if (!userId || !d.maySave(userId)) {
            if (d.savedEmail(email)) d.queueOtp(email, ip ?? null);
            return ctx.json({ success: true });
          }
        }
        // Budget key ignores "+tag" aliases so one inbox can't multiply its hourly allowance.
        const r = d.reserveOtp(email.replace(/\+[^@]*@/, "@"), userId, userId ? null : (queued?.otpIp ?? null));
        if (!r.ok) throw APIError.from("TOO_MANY_REQUESTS", { code: "SAVING_BUSY", message: SAVING_BUSY });
        const st = authRequestState.getStore();
        if (st) st.otpReservation = { id: r.id, userId };
      }),
      after: createAuthMiddleware(async (ctx) => {
        if (ctx.path === "/sign-in/email-otp") {
          const r = ctx.context.returned;
          // A Response, not a thrown APIError: an error thrown here would keep the endpoint's status (403).
          if (isAPIError(r) && CODE_FAILURES.has(String((r.body as { code?: unknown } | undefined)?.code))) return Response.json(WRONG_CODE, { status: 400 });
          return;
        }
        if (ctx.path !== "/email-otp/send-verification-otp") return;
        const st = authRequestState.getStore();
        const res = st?.otpReservation;
        if (!st || !res) return;
        const failed = st.otpSendFailed || isAPIError(ctx.context.returned);
        if (!failed) return;
        d.releaseOtp(res.id, res.userId);
        st.otpReservation = undefined;
        if (st.otpSendFailed) throw APIError.from("SERVICE_UNAVAILABLE", { code: "SAVING_BUSY", message: SAVING_BUSY });
      }),
    },
    plugins: [
      anonymous({
        generateName: () => `Wanderer-${randomInt(1000, 10000)}`,
        onLinkAccount: async ({ anonymousUser, newUser, ctx }) => {
          const keep = d.onLink(
            { id: anonymousUser.user.id, name: anonymousUser.user.name },
            { id: newUser.user.id, name: newUser.user.name },
          );
          // The client should pass `name` on sign-in; if it didn't, keep the guest's name anyway.
          if (!newUser.user.name && keep) await ctx.context.internalAdapter.updateUser(newUser.user.id, { name: keep });
        },
      }),
      emailOTP({
        storeOTP: "hashed",
        otpLength: 6,
        expiresIn: 300,
        allowedAttempts: 3,
        async sendVerificationOTP({ email, otp, type }) {
          if (type !== "sign-in") return;
          const ok = await d.sendOtp(email, otp);
          if (!ok) {
            const st = authRequestState.getStore();
            if (st) st.otpSendFailed = true;
          }
        },
      }),
      jwt({
        disableSettingJwtHeader: true,
        jwt: {
          expirationTime: "15m",
          // Never the default (whole user incl. email): name and guest flag only.
          definePayload: ({ user }) => ({ name: user.name, guest: !!(user as { isAnonymous?: boolean | null }).isAnonymous }),
        },
      }),
    ],
  } satisfies BetterAuthOptions;
}

export function buildAuth(options: ReturnType<typeof authOptions>) {
  return betterAuth(options);
}

export type FirstlightAuth = ReturnType<typeof buildAuth>;
