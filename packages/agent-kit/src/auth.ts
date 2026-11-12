// Play tokens for an agent, without a browser.
//
// The real flow (what the browser client does through Better Auth, apps/client/src/net/auth.ts):
// sign in as a guest (POST /api/auth/sign-in/anonymous sets a session cookie), then trade the cookie
// for a 15-minute JWT (GET /api/auth/token) and send that to /api/play. The cookie is the character:
// keep it in `sessionFile` and the same guest comes back on the next run.
//
// Local servers started with ALLOW_DEV_GUESTS=1 (and the in-process test server) also take dev
// tokens, `dev:<id>:<name>`: no auth round trip at all.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export class AgentError extends Error {
  /** Short machine-readable cause ("unauthorized", "agent limit", "version", …). */
  readonly code: string;
  constructor(code: string, message = code) {
    super(message);
    this.name = "AgentError";
    this.code = code;
  }
}

export interface TokenSource {
  /** A token for /api/play; `fresh` drops any cached one first. */
  get(fresh?: boolean): Promise<string>;
  /** The display name the token carries, when known without asking the server. */
  readonly name: string | null;
}

/** A fixed token (dev tokens; a JWT handed in by the caller). */
export function fixedToken(token: string): TokenSource {
  const dev = token.startsWith("dev:") ? (token.split(":")[2] ?? null) : null;
  return { get: async () => token, name: dev };
}

interface SavedSession {
  authUrl: string;
  cookie: string;
}

function readSession(file: string | undefined, authUrl: string): string | null {
  if (!file) return null;
  try {
    const s = JSON.parse(readFileSync(file, "utf8")) as SavedSession;
    return s.authUrl === authUrl && typeof s.cookie === "string" && s.cookie ? s.cookie : null;
  } catch {
    return null;
  }
}

function writeSession(file: string | undefined, s: SavedSession): void {
  if (!file) return;
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(s), { mode: 0o600 });
  } catch {
    /* a session that can't be saved still plays; the next run is a new guest */
  }
}

/** `name=value` pairs of a response's Set-Cookie headers, as one Cookie header. */
function cookiesOf(res: Response, had: string | null): string {
  const jar = new Map<string, string>();
  for (const part of (had ?? "").split(/;\s*/)) {
    const i = part.indexOf("=");
    if (i > 0) jar.set(part.slice(0, i), part.slice(i + 1));
  }
  for (const line of res.headers.getSetCookie()) {
    const pair = line.split(";")[0] ?? "";
    const i = pair.indexOf("=");
    if (i > 0) jar.set(pair.slice(0, i).trim(), pair.slice(i + 1));
  }
  return [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
}

/** Read (not verify) a JWT's expiry in ms. */
function expiryOf(token: string): number {
  try {
    const part = token.split(".")[1] ?? "";
    const p = JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as { exp?: number };
    return typeof p.exp === "number" ? p.exp * 1000 : Date.now() + 14 * 60_000;
  } catch {
    return Date.now() + 14 * 60_000;
  }
}

/**
 * A guest account through Better Auth at `authUrl` (the site origin in production, the game server
 * itself locally). `sessionFile` keeps the session cookie between runs.
 */
export function guestSession(authUrl: string, sessionFile?: string): TokenSource {
  const base = authUrl.replace(/\/+$/, "");
  let cookie = readSession(sessionFile, base);
  let cached: { token: string; exp: number } | null = null;
  const headers = (): Record<string, string> => ({ Origin: base, ...(cookie ? { Cookie: cookie } : {}) });

  async function signIn(): Promise<void> {
    const res = await fetch(`${base}/api/auth/sign-in/anonymous`, { method: "POST", headers: { ...headers(), "Content-Type": "application/json" }, body: "{}", signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new AgentError("auth", `guest sign-in failed (${res.status}) at ${base}/api/auth: is this the site origin?`);
    cookie = cookiesOf(res, null);
    if (!cookie) throw new AgentError("auth", "guest sign-in returned no session cookie");
    writeSession(sessionFile, { authUrl: base, cookie });
  }

  async function token(): Promise<string | null> {
    const res = await fetch(`${base}/api/auth/token`, { headers: headers(), signal: AbortSignal.timeout(20_000) });
    if (res.status === 401) return null;
    if (!res.ok) throw new AgentError("auth", `couldn't get a play token (${res.status})`);
    const refreshed = cookiesOf(res, cookie);
    if (refreshed && refreshed !== cookie) {
      cookie = refreshed;
      writeSession(sessionFile, { authUrl: base, cookie });
    }
    const body = (await res.json().catch(() => null)) as { token?: string } | null;
    return body?.token ?? null;
  }

  return {
    name: null,
    async get(fresh = false) {
      if (!fresh && cached && cached.exp - 60_000 > Date.now()) return cached.token;
      cached = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        if (!cookie) await signIn();
        const t = await token();
        if (t) {
          cached = { token: t, exp: expiryOf(t) };
          return t;
        }
        cookie = null; // the session is gone (pruned guest, signed out): a new guest
      }
      throw new AgentError("auth", "couldn't get a play token");
    },
  };
}

/** Ask for a display name (3-16 letters, digits or _; unique). Returns the name in use, or why not. */
export async function claimName(url: string, token: string, name: string): Promise<{ ok: true; name: string } | { ok: false; message: string }> {
  try {
    const res = await fetch(`${url.replace(/\/+$/, "")}/api/account/name`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
      signal: AbortSignal.timeout(20_000),
    });
    const body = (await res.json().catch(() => ({}))) as { ok?: boolean; name?: string; message?: string };
    if (res.ok && body.ok && body.name) return { ok: true, name: body.name };
    return { ok: false, message: body.message ?? `the server refused that name (${res.status})` };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
}
