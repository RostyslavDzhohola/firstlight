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

/** Per-request state shared by the before hook, the send function and the after hook. */
interface AuthRequestState {
  otpReservation?: number;
  otpSendFailed?: boolean;
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
  /**
   * May this request email a code to this (lower-cased) address? Yes for an address that already has
   * a saved account (a returning player, any browser), or for a signed-in player who reached
   * OTP_MIN_LEVEL (saving a guest). Anything else is answered like a send but nothing is sent.
   */
  mayEmailCode(email: string, sessionUserId: string | null): boolean;
  /** Reserve one OTP send for this (lower-cased) email; false = over budget. Returns a reservation id. */
  reserveOtp(email: string): { ok: true; id: number } | { ok: false; reason: string };
  releaseOtp(id: number): void;
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
    // Players never edit their Better Auth profile directly (names go through /api/account/name).
    disabledPaths: ["/update-user", "/change-email", "/delete-user"],
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
        // F12: fresh guests and session-less requests could otherwise drain the global daily budget
        // from many networks. They get the same answer as a send (no hint whether the address is
        // saved), but no code is made, sent or counted.
        const session = await getSessionFromCtx(ctx, { disableRefresh: true }).catch(() => null);
        if (!d.mayEmailCode(email, session?.user.id ?? null)) return ctx.json({ success: true });
        // Budget key ignores "+tag" aliases so one inbox can't multiply its hourly allowance.
        const r = d.reserveOtp(email.replace(/\+[^@]*@/, "@"));
        if (!r.ok) throw APIError.from("TOO_MANY_REQUESTS", { code: "SAVING_BUSY", message: SAVING_BUSY });
        const st = authRequestState.getStore();
        if (st) st.otpReservation = r.id;
      }),
      after: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== "/email-otp/send-verification-otp") return;
        const st = authRequestState.getStore();
        if (!st?.otpReservation) return;
        const failed = st.otpSendFailed || isAPIError(ctx.context.returned);
        if (!failed) return;
        d.releaseOtp(st.otpReservation);
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
