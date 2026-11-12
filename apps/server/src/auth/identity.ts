// Who is joining. The auth module (Better Auth) produces this from a verified JWT; tests and
// local development may use dev guest tokens when ALLOW_DEV_GUESTS=1.

export interface Identity {
  userId: string;
  name: string;
  guest: boolean;
  admin: boolean;
  loadtest: boolean;
  /** Verified from a Better Auth account JWT (revalidated when a seat is used; dev tokens aren't). */
  account?: boolean;
  /** One of our own automation accounts (D-home-6): plays normally, never on a public surface. */
  test?: boolean;
  /** An AI agent plays this character (D-agents-1): labelled for everyone, kept off the people's boards and counts. */
  agent?: boolean;
  /** The address an agent's seat was asked from (the per-address agent cap, world/agents.ts). */
  agentIp?: string;
  /** This /api/play request's own agent claim (world/agents.ts): the seat it becomes is used up by this handle alone. */
  agentClaim?: string;
  /** The Better Auth session that issued the token (D-security-5): bearer calls and seat use need it alive. */
  authSession?: string;
}

/** Request facts a verifier may use (IP bans; our test tools' marker). */
export interface VerifyContext {
  ip?: string | null;
  /** The request's x-loadtest-secret header: with the right secret, a guest is flagged as a test account. */
  toolSecret?: string | null;
  /** The request says an AI agent is playing (/api/play only): a guest account is flagged for good. */
  agent?: boolean;
  /** Set by the accounts verifier: the token it checked and its payload (null: bad signature or expired), for reuse. */
  jwt?: { token: string; payload: Record<string, unknown> | null };
}

export type TokenVerifier = (token: string, ctx?: VerifyContext) => Promise<Identity | null>;

/** Dev tokens look like `dev:<userId>:<name>[:admin|:loadtest]`. Only accepted when explicitly enabled. */
export function devVerifier(enabled: boolean): TokenVerifier {
  return async (token) => {
    if (!enabled || !token.startsWith("dev:")) return null;
    const [, userId, name, role] = token.split(":");
    if (!userId) return null;
    return { userId, name: name || `Wanderer-${userId.slice(0, 4)}`, guest: true, admin: role === "admin", loadtest: role === "loadtest" };
  };
}

/** Try verifiers in order; first identity wins. */
export function chainVerifiers(...vs: TokenVerifier[]): TokenVerifier {
  return async (token, ctx) => {
    for (const v of vs) {
      const id = await v(token, ctx);
      if (id) return id;
    }
    return null;
  };
}
