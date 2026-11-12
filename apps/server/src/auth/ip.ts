// Client IP: one trusted-proxy rule (security pass finding 4, D-security-4, docs/tech-facts.md).
//
// Production has two paths to the game server on Railway:
// - Direct (/api/play, /api/account/*, /api/online, /api/home, /api/metrics, /api/test/*): the
//   browser → Railway's edge → us. One trusted hop: the edge sets X-Real-IP to the address it took
//   the connection from. `directRequestIp` uses X-Real-IP and nothing else (no X-Forwarded-For,
//   which a client can send through the edge), else the socket address (local development, tests).
// - Through the Vercel rewrite (/api/auth/*, /admin, /stats): the browser → Vercel → Railway's edge
//   → us. Vercel puts the browser's address first in X-Forwarded-For and adds x-origin-secret.
//   `proxiedRequestIp` takes that first entry, and callers use it only after the origin secret
//   matched (with no ORIGIN_SECRET configured, which production refuses, that is development:
//   Vite's proxy). Without a usable entry it falls back to `directRequestIp`.
// Every address is validated (`net.isIP`); a header that isn't one counts as absent. Limits and bans
// key IPv6 by /64 (`banKey`). Loopback is exempt from per-address limits only outside production.
//
// /api/auth/* gets the proxied address in CLIENT_IP_HEADER (any client-supplied copy is stripped
// first); Better Auth reads only that header (rate limits, IP bans).

import type { IncomingMessage } from "node:http";
import { isIP } from "node:net";

export const CLIENT_IP_HEADER = "x-firstlight-client-ip";

function header(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

export function normalizeIp(ip: string | null | undefined): string | null {
  if (!ip) return null;
  const t = ip.trim();
  if (!t) return null;
  return t.toLowerCase().startsWith("::ffff:") && t.includes(".") ? t.slice(7) : t;
}

/** A normalised address if `ip` is a valid IPv4 or IPv6 address, else null. */
export function validIp(ip: string | null | undefined): string | null {
  const n = normalizeIp(ip);
  return n && isIP(n.split("%")[0]!) ? n : null;
}

/**
 * The unit an IP ban applies to: the address itself for IPv4, the /64 prefix for IPv6 (one home or
 * phone gets a whole /64, so banning a single v6 address is trivially dodged).
 */
export function banKey(ip: string): string {
  const n = normalizeIp(ip) ?? ip;
  if (!n.includes(":")) return n;
  const addr = n.split("%")[0]!.toLowerCase();
  const [head, tail] = addr.includes("::") ? addr.split("::") as [string, string] : [addr, null];
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const groups = tail === null ? left : [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right];
  return `${groups.slice(0, 4).map((g) => (g || "0").replace(/^0+(?=.)/, "")).join(":")}::/64`;
}

/** The first X-Forwarded-For entry, if it is a valid address (only meaningful behind the Vercel rewrite). */
export function firstForwardedFor(req: IncomingMessage): string | null {
  const xff = header(req, "x-forwarded-for");
  return validIp(xff?.split(",")[0]);
}

/** IP for requests that hit the API host directly: Railway's X-Real-IP, else the socket. */
export function directRequestIp(req: IncomingMessage): string | null {
  return validIp(header(req, "x-real-ip")) ?? validIp(req.socket?.remoteAddress);
}

/** IP for requests that came through the Vercel rewrite (call only after the origin-secret check). */
export function proxiedRequestIp(req: IncomingMessage): string | null {
  return firstForwardedFor(req) ?? directRequestIp(req);
}
