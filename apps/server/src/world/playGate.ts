// /api/play's first gate (security pass finding 3, D-security-3), before any token is verified: a
// request budget per client address (IPv6 per /64) and one for everyone together, then the cheap
// field checks (body id, protocol version). Invalid tokens and bodies spend the budget too, so a
// flood of them can't make the server verify signatures and query the databases at will. The
// per-account and per-address limits after verification (PLAY_LIMITS) stay as they were.

import { PROTOCOL_VERSION } from "@firstlight/shared/net/protocol";
import { banKey } from "../auth/ip.ts";
import { WindowLimiter } from "../auth/limiter.ts";
import { isBodyId } from "./matchmaking.ts";

export const PLAY_GATE = {
  windowMs: 10_000,
  /** Requests per client address per window, whatever they carry (above PLAY_LIMITS.ipCalls). */
  ipCalls: 120,
  /** Requests per window from everyone together. */
  globalCalls: 1500,
};

const LOOPBACK: ReadonlySet<string> = new Set(["127.0.0.1", "::1"]);

export function createPlayGate(production: boolean) {
  const byIp = new WindowLimiter(PLAY_GATE.ipCalls, PLAY_GATE.windowMs);
  const all = new WindowLimiter(PLAY_GATE.globalCalls, PLAY_GATE.windowMs, 1);
  return {
    /** Spend one request of the budgets; false when either is spent. Loopback has no address budget outside production. */
    admit(ip: string | null, now = Date.now()): boolean {
      byIp.max = PLAY_GATE.ipCalls;
      all.max = PLAY_GATE.globalCalls;
      if (!all.take("all", now)) return false;
      if (!production && ip !== null && LOOPBACK.has(ip)) return true;
      return byIp.take(ip ? banKey(ip) : "unknown", now);
    },
  };
}

/** The refusal for a request body that can't be a play request, before its token is looked at; or null. */
export function playBodyRefusal(b: unknown): { status: number; json: Record<string, unknown> } | null {
  const body = (b as { body?: unknown; v?: unknown } | null | undefined) ?? {};
  if (!isBodyId(body.body)) return { status: 400, json: { ok: false, error: "bad body" } };
  // Stale tabs after a deploy: refuse other protocol versions so the client reloads.
  if (body.v !== PROTOCOL_VERSION) return { status: 409, json: { ok: false, error: "version", version: PROTOCOL_VERSION } };
  return null;
}
