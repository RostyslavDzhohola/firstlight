// Server configuration from the environment. Secrets are read here and never logged.

function num(name: string, fallback: number): number {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : Number(v);
}

export const env = {
  port: num("PORT", 2567),
  production: process.env.NODE_ENV === "production",
  clientOrigins: (process.env.CLIENT_ORIGIN ?? "http://localhost:5173")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  authUrl: process.env.BETTER_AUTH_URL ?? "http://localhost:5173",
  authSecret: process.env.BETTER_AUTH_SECRET || "dev-only-secret-change-me-dev-only-secret",
  authDbPath: process.env.AUTH_DB_PATH ?? "./data/auth.db",
  gameDbPath: process.env.GAME_DB_PATH ?? "./data/game.db",
  originSecret: process.env.ORIGIN_SECRET ?? "",
  resendKey: process.env.RESEND_API_KEY ?? "",
  emailFrom: process.env.EMAIL_FROM ?? "FIRSTLIGHT <login@firstlight.one4all.dev>",
  turnKeyId: process.env.TURN_KEY_ID ?? "",
  turnKeyToken: process.env.TURN_KEY_API_TOKEN ?? "",
  adminClaimToken: process.env.ADMIN_CLAIM_TOKEN ?? "",
  loadtestSecret: process.env.LOADTEST_SECRET ?? "",
  /** DataFast website API key (`df_…`) for the home page's visit counts (6f); empty = not shown. */
  datafastApiKey: process.env.DATAFAST_API_KEY ?? "",
  allowDevGuests: process.env.ALLOW_DEV_GUESTS === "1",
  maxClients: num("MAX_CLIENTS", 40),
  maxCopiesPerBody: num("MAX_COPIES_PER_BODY", 2),
  soloFillLimit: num("SOLO_FILL_LIMIT", 36),
  globalCap: num("GLOBAL_CAP", 320),
  otpDailyBudget: num("OTP_DAILY_BUDGET", 1000), // D20
  otpPerEmailPerHour: num("OTP_PER_EMAIL_PER_HOUR", 3),
  /** Print dev OTP codes to the console (dev outbox only: no RESEND_API_KEY and not production). */
  devMailLog: process.env.DEV_MAIL_LOG === "1",
  /** M11 extra #2 (SPEC §6.14): horses. On in dev and production; FEATURE_HORSES=0 turns them off
   *  (no whistle sales, H refused, clients told through `you.horses`). Mutable for tests. */
  horses: process.env.FEATURE_HORSES !== "0",
  /** M11 extra #5: new sources and puzzles. Existing owned cosmetics remain usable. */
  cosmeticsExtras: process.env.FEATURE_COSMETICS_EXTRAS !== "0",
};

/**
 * Why a production config must not boot (main.ts exits on any): dev guests would allow
 * impersonation, a missing origin secret makes forwarded IPs spoofable, and database paths must be
 * explicit (the ./data default is outside the Railway volume, so data would vanish on deploy).
 */
export function productionConfigProblems(e: Record<string, string | undefined> = process.env): string[] {
  const problems: string[] = [];
  if (e.ALLOW_DEV_GUESTS === "1") problems.push("ALLOW_DEV_GUESTS must not be set in production");
  for (const k of ["ORIGIN_SECRET", "BETTER_AUTH_URL", "CLIENT_ORIGIN", "BETTER_AUTH_SECRET", "AUTH_DB_PATH", "GAME_DB_PATH"]) if (!e[k]) problems.push(`${k} is required in production`);
  return problems;
}
