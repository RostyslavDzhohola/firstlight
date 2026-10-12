// Who is joining. The auth module (Better Auth) produces this from a verified JWT; tests and
// local development may use dev guest tokens when ALLOW_DEV_GUESTS=1.

export interface Identity {
  userId: string;
  name: string;
  guest: boolean;
  admin: boolean;
  loadtest: boolean;
}

export type TokenVerifier = (token: string) => Promise<Identity | null>;

/** Dev tokens look like `dev:<userId>:<name>`. Only accepted when explicitly enabled. */
export function devVerifier(enabled: boolean): TokenVerifier {
  return async (token) => {
    if (!enabled || !token.startsWith("dev:")) return null;
    const [, userId, name] = token.split(":");
    if (!userId) return null;
    return { userId, name: name || `Wanderer-${userId.slice(0, 4)}`, guest: true, admin: false, loadtest: false };
  };
}

/** Try verifiers in order; first identity wins. */
export function chainVerifiers(...vs: TokenVerifier[]): TokenVerifier {
  return async (token) => {
    for (const v of vs) {
      const id = await v(token);
      if (id) return id;
    }
    return null;
  };
}
