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

/** Is `ip` a loopback address (127.0.0.0/8, ::1, or either mapped)? */
export function isLoopback(ip: string | null | undefined): boolean {
  const n = validIp(ip);
  return !!n && (n === "::1" || /^127\.\d+\.\d+\.\d+$/.test(n));
}

function loopbackHost(host: string | undefined): boolean {
  if (!host) return false;
  const name = host.trim().toLowerCase().replace(/:\d+$/, "");
  return name === "localhost" || name === "[::1]" || /^127\.\d+\.\d+\.\d+$/.test(name);
}

/** Every address a forwarding header names (`for=` entries of RFC 7239 Forwarded), unparsed ones as "". */
function forwardedAddresses(req: IncomingMessage): string[] {
  const out: string[] = [];
  for (const name of ["x-forwarded-for", "x-real-ip"]) {
    const v = header(req, name);
    if (v !== undefined) out.push(...v.split(",").map((s) => s.trim()));
  }
  const fwd = header(req, "forwarded");
  if (fwd !== undefined) {
    const fors = fwd.split(/[;,]/).map((p) => p.trim()).filter((p) => /^for=/i.test(p));
    if (!fors.length) out.push("");
    for (const f of fors) out.push(f.slice(4).replace(/^"|"$/g, "").replace(/^\[([^\]]+)\](?::\d+)?$/, "$1").replace(/^(\d+\.\d+\.\d+\.\d+):\d+$/, "$1"));
  }
  return out;
}

/**
 * The person at this machine, for development-only routes that would leak something to anyone else
 * (#84's sign-in code). Only the TCP socket's own address grants it: it must be loopback. Headers can
 * only take it away, never give it: a forwarding header naming anyone but loopback (a proxy on this
 * machine passing on a remote caller, e.g. Vite's xfwd or nginx) refuses, and so does a Host that isn't
 * a loopback name (a page whose domain was rebound to 127.0.0.1). The `x-forwarded-*` and `x-real-ip`
 * headers are never read as the caller's address here.
 */
export function localDevRequest(req: IncomingMessage): boolean {
  return loopbackCaller(req) && loopbackHost(header(req, "host")) && header(req, "via") === undefined;
}

/**
 * Did this request come from this machine: the socket's own address is loopback and no forwarding
 * header names anyone else? The development exemptions from per-address limits use it, so a remote
 * caller can't earn them by sending `X-Real-IP: 127.0.0.1` to a server that isn't production.
 */
export function loopbackCaller(req: IncomingMessage): boolean {
  return isLoopback(req.socket?.remoteAddress) && forwardedAddresses(req).every(isLoopback);
}
