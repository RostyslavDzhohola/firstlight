// When the load-test features are on (security pass findings 1 and 2, D-security-1, D-security-2).
// LOADTEST_SECRET does two things. It flags our tools' guests as test accounts (D-home-6), which is
// always on while the secret is set. And it unlocks the load-test features (bot tokens from
// POST /api/test/bot-token, bot JWTs at /api/play, /api/metrics), which in production also need the
// explicit switch LOADTEST_ENABLED=1, so a secret left set after a load test opens nothing.

export interface LoadtestConfig {
  production: boolean;
  loadtestSecret: string;
  /** LOADTEST_ENABLED=1: production only runs load tests with this switch on. */
  loadtestEnabled?: boolean;
}

/** The secret the load-test features accept, or "" when they are off. */
export function botSecret(cfg: LoadtestConfig): string {
  if (!cfg.loadtestSecret) return "";
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
  return "[loadtest] LOADTEST_SECRET is set but LOADTEST_ENABLED=1 isn't: bot tokens and /api/metrics are off (test guests are still flagged)";
}
