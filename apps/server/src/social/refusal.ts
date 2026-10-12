// Why a play token was refused. The accounts verifier returns null for banned accounts and networks
// (so every route treats them as signed out); /api/play asks this afterwards so the client can show
// "banned" instead of retrying sign-in. Only a correctly signed token gets an answer, so nobody can
// probe other accounts' ban status.

import type { Accounts } from "../auth/accounts.ts";
import { normalizeIp } from "../auth/ip.ts";
import { isBanned, isIpBanned } from "../db/index.ts";

export type RefusalExplainer = (token: string, ip: string | null) => Promise<"banned" | null>;

export function banExplainer(a: Pick<Accounts, "auth" | "db" | "hashIp">): RefusalExplainer {
  return async (token, ip) => {
    let sub: unknown;
    try {
      sub = ((await a.auth.api.verifyJWT({ body: { token } })).payload as Record<string, unknown> | null)?.sub;
    } catch {
      return null;
    }
    if (typeof sub !== "string" || !sub) return null;
    const now = Date.now();
    if (isBanned(a.db, sub, now)) return "banned";
    const n = normalizeIp(ip);
    if (n && isIpBanned(a.db, a.hashIp(n), now)) return "banned";
    return null;
  };
}
