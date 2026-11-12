// Play tokens for an agent, without a browser.
//
// The real flow (what the browser client does through Better Auth, apps/client/src/net/auth.ts):
// sign in as a guest (POST /api/auth/sign-in/anonymous sets a session cookie), then trade the cookie
// for a 15-minute JWT (GET /api/auth/token) and send that to /api/play. The cookie is the character:
// keep it in `sessionFile` and the same guest comes back on the next run.
//
// A play token is bound to the session that issued it (its `sid` claim, D-security-5): the server
// takes it, and keeps the seat it bought, only while that session exists. So a token is never kept
// past its session: a 401 from the game drops the cached token and asks the session for a new one,
// and a session that is gone (signed out, expired, pruned) can't be revived: the saved cookie is
// dropped and a new guest is made, which `onNewGuest` reports, because that is a new character.
//
// Local servers started with ALLOW_DEV_GUESTS=1 (and the in-process test server) also take dev
// tokens, `dev:<id>:<name>`: no auth round trip at all.

import { randomBytes } from "node:crypto";
import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

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
  /**
   * A token for /api/play; `fresh` drops any cached one first. `sameSession`: never sign in anew: if
   * the session behind this source has ended, throw AgentError("session ended") instead (a character
   * in play stays that character; a new guest would be someone else).
   */
  get(fresh?: boolean, sameSession?: boolean): Promise<string>;
  /** The display name the token carries, when known without asking the server. */
  readonly name: string | null;
}

/** A fixed token (dev tokens; a JWT handed in by the caller). */
export function fixedToken(token: string): TokenSource {
  const dev = token.startsWith("dev:") ? (token.split(":")[2] ?? null) : null;
  return { get: async () => token, name: dev };
}

export interface SavedSession {
  authUrl: string;
  cookie: string;
}

/** Never through a symlink (0 where the platform has no O_NOFOLLOW; the lstat checks still apply). */
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

/** Is something other than a regular file at `file` (a symlink, a directory, a device)? Nothing there: false. */
function notPlainFile(file: string): boolean {
  try {
    return !lstatSync(file).isFile();
  } catch {
    return false;
  }
}

/**
 * The saved session's cookie, or null. The file is the character's key: it is read through a
 * descriptor that doesn't follow a symlink, and a file left readable by others is made private
 * (0600) on the way.
 */
export function readSession(file: string | undefined, authUrl: string): string | null {
  if (!file || notPlainFile(file)) return null;
  let fd: number | null = null;
  try {
    fd = openSync(file, constants.O_RDONLY | NOFOLLOW);
    const st = fstatSync(fd);
    if (!st.isFile()) return null;
    if ((st.mode & 0o077) !== 0) fchmodSync(fd, 0o600);
    const s = JSON.parse(readFileSync(fd, "utf8")) as SavedSession;
    return s.authUrl === authUrl && typeof s.cookie === "string" && s.cookie ? s.cookie : null;
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/**
 * Save the session. Written to a new private file next to it (created exclusively, 0600 enforced on
 * the descriptor whatever the umask) and renamed into place, so the cookie never lands in a file
 * that was readable by others, a reader never sees half a file, and nothing is ever written through
 * a symlink: a path that is anything but a regular file is refused. True when it was saved; a
 * session that can't be saved still plays, and the next run is a new guest.
 */
export function writeSession(file: string | undefined, s: SavedSession): boolean {
  if (!file) return false;
  let tmp: string | null = null;
  let fd: number | null = null;
  try {
    const dir = dirname(file);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (notPlainFile(file)) return false;
    tmp = join(dir, `.${basename(file)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
    fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600);
    fchmodSync(fd, 0o600);
    writeFileSync(fd, JSON.stringify(s));
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(tmp, file);
    tmp = null;
    return true;
  } catch {
    return false;
  } finally {
    if (fd !== null) closeSync(fd);
    if (tmp) {
      try {
        unlinkSync(tmp);
      } catch {
        /* never created, or already gone */
      }
    }
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

/** Read (not verify) the session a play token is bound to (`sid`), or null for a token without one. */
export function sessionOf(token: string): string | null {
  try {
    const p = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as { sid?: unknown };
    return typeof p.sid === "string" && p.sid ? p.sid : null;
  } catch {
    return null;
  }
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
 * itself locally). `sessionFile` keeps the session cookie between runs (it is the character: keep it private).
 */
export function guestSession(authUrl: string, sessionFile?: string, origin?: string, onNewGuest?: (why: string) => void): TokenSource {
  const base = authUrl.replace(/\/+$/, "");
  let cookie = readSession(sessionFile, base);
  const hadSaved = !!cookie;
  let cached: { token: string; exp: number } | null = null;
  // Better Auth checks the Origin of requests that carry its cookie against the server's trusted
  // origins (the site's own origin): `origin` names it when `authUrl` isn't it (a dev server reached
  // directly, whose trusted origin is the Vite one).
  const headers = (): Record<string, string> => ({ Origin: (origin ?? base).replace(/\/+$/, ""), ...(cookie ? { Cookie: cookie } : {}) });

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
    async get(fresh = false, sameSession = false) {
      if (!fresh && cached && cached.exp - 60_000 > Date.now()) return cached.token;
      const cached0 = !!cached;
      cached = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        if (!cookie) await signIn();
        const t = await token();
        if (t) {
          cached = { token: t, exp: expiryOf(t) };
          return t;
        }
        // The session is gone (pruned guest, signed out, expired): its tokens and seats went with it.
        if (sameSession && cookie) throw new AgentError("session ended", "the guest session this character belongs to has ended (signed out or expired): connect again to play as a new guest");
        if (attempt === 0 && (hadSaved || cached0)) onNewGuest?.("the saved guest session has ended (signed out or expired): signing in as a new guest, a new character");
        cookie = null;
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
