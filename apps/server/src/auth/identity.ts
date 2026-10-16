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
}

/** Request facts a verifier may use (IP bans; our test tools' marker). */
export interface VerifyContext {
  ip?: string | null;
  /** The request's x-loadtest-secret header: with the right secret, a guest is flagged as a test account. */
  toolSecret?: string | null;
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
