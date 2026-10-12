// Client IP handling.
//
// /api/auth/* arrives through the Vercel proxy: the origin-secret-gated middleware copies the first
// X-Forwarded-For entry into CLIENT_IP_HEADER (any client-supplied copy is stripped first), and Better
// Auth reads only that header (rate limits, IP bans).
//
// /api/play and the other API routes are called directly on the API host (Railway's edge in front):
// we use X-Real-IP, else the last X-Forwarded-For entry (the one our own edge appended), else the socket.

import type { IncomingMessage } from "node:http";

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

export function firstForwardedFor(req: IncomingMessage): string | null {
  const xff = header(req, "x-forwarded-for");
  return normalizeIp(xff?.split(",")[0]);
}

/** IP for requests that hit the API host directly (not via the Vercel auth proxy). */
export function directRequestIp(req: IncomingMessage): string | null {
  const real = normalizeIp(header(req, "x-real-ip"));
  if (real) return real;
  const xff = header(req, "x-forwarded-for");
  if (xff) {
    const parts = xff.split(",");
    const last = normalizeIp(parts[parts.length - 1]);
    if (last) return last;
  }
  return normalizeIp(req.socket?.remoteAddress);
}
