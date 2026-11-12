// When the load-test features are on (security pass findings 1 and 2, D-security-1, D-security-2).
// LOADTEST_SECRET does two things. It flags our tools' guests as test accounts (D-home-6), which is
// always on while the secret is set. And it unlocks the load-test features (bot tokens from
// POST /api/test/bot-token, bot JWTs at /api/play, /api/metrics), which in production also need the
// explicit switch LOADTEST_ENABLED=1, so a secret left set after a load test opens nothing.
// A short secret switches those features off everywhere (like ADMIN_CLAIM_TOKEN), and wrong guesses
// at the two endpoints that compare it are limited per client address and overall (D-security-2).

import { safeEqual, strongSecret } from "./crypto.ts";
import { banKey } from "./ip.ts";
import { WindowLimiter } from "./limiter.ts";

export interface LoadtestConfig {
  production: boolean;
  loadtestSecret: string;
  /** LOADTEST_ENABLED=1: production only runs load tests with this switch on. */
  loadtestEnabled?: boolean;
}

/** The secret the load-test features accept, or "" when they are off. */
export function botSecret(cfg: LoadtestConfig): string {
  if (!cfg.loadtestSecret || !strongSecret(cfg.loadtestSecret)) return "";
  if (cfg.production && !cfg.loadtestEnabled) return "";
  return cfg.loadtestSecret;
}

/** The same, from the process environment (for routes built without the accounts config). */
export function botSecretFromEnv(e: Record<string, string | undefined> = process.env): string {
  return botSecret({ production: e.NODE_ENV === "production", loadtestSecret: e.LOADTEST_SECRET ?? "", loadtestEnabled: e.LOADTEST_ENABLED === "1" });
}

/** Why the load-test features are off although a secret is set (a boot warning), or null. */
export function botSecretWarning(cfg: LoadtestConfig): string | null {
  if (!cfg.loadtestSecret || botSecret(cfg)) return null;
  if (!strongSecret(cfg.loadtestSecret)) return "[loadtest] LOADTEST_SECRET is too short (use 32 random bytes, e.g. `openssl rand -base64 32`): bot tokens and /api/metrics are off (test guests are still flagged)";
  return "[loadtest] LOADTEST_SECRET is set but LOADTEST_ENABLED=1 isn't: bot tokens and /api/metrics are off (test guests are still flagged)";
}

/** Wrong load-test secrets allowed per client address (IPv6 per /64) and overall, per 10 minutes. */
export const TOOL_GUESSES = { perIp: 10, global: 100, windowMs: 10 * 60_000 };

const guessesByIp = new WindowLimiter(TOOL_GUESSES.perIp, TOOL_GUESSES.windowMs);
const guessesAll = new WindowLimiter(TOOL_GUESSES.global, TOOL_GUESSES.windowMs, 1);

/**
 * Check a load-test secret sent to /api/test/bot-token or /api/metrics: "limited" (before any
 * comparison) once the address or everyone together has spent the wrong-guess budget, else "ok" or
 * "wrong" (which spends one guess). Callers answer "wrong" and "limited" without saying more.
 */
export function checkToolSecret(given: unknown, secret: string, ip: string | null, now = Date.now()): "ok" | "wrong" | "limited" {
  guessesByIp.max = TOOL_GUESSES.perIp;
  guessesAll.max = TOOL_GUESSES.global;
  const key = ip ? banKey(ip) : "unknown";
  if (!guessesAll.allows("all", now) || !guessesByIp.allows(key, now)) return "limited";
  if (typeof given === "string" && given && safeEqual(given, secret)) return "ok";
  guessesAll.add("all", now);
  guessesByIp.add(key, now);
  return "wrong";
}

export function resetToolGuesses(): void {
  guessesByIp.clear();
  guessesAll.clear();
}
