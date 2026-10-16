// Accounts on the client (SPEC §5.4).
//
// Better Auth lives behind the same origin (`/api/auth/*`, proxied by Vercel in production and by
// Vite in dev), so its session cookie is first-party. The game server is called directly with a
// 15-minute JWT: `getPlayToken()` → `getSession()` first (clears a stale cookie, better-auth #11533),
// else `signIn.anonymous()`, then `token()`; the JWT is cached until ~1 minute before it expires.
//
// `?devguest` keeps the old dev-token path (server must run with ALLOW_DEV_GUESTS=1).

import { createAuthClient } from "better-auth/client";
import { anonymousClient, emailOTPClient, jwtClient } from "better-auth/client/plugins";
import { config, flags, offlineRun } from "../config.ts";
import { saveStatusOf, sendCodeFailure, type SaveStatus, type SendFailure } from "../ui/saveOffer.ts";

export const SAVING_BUSY = "Saving is busy, try again later";

function makeClient() {
  return createAuthClient({
    baseURL: location.origin,
    plugins: [anonymousClient(), emailOTPClient(), jwtClient()],
  });
}

export type AuthClient = ReturnType<typeof makeClient>;

let client: AuthClient | null = null;

/** The Better Auth client (created on first use). */
export function authClient(): AuthClient {
  client ??= makeClient();
  return client;
}

export class AuthError extends Error {
  status: number;
  constructor(message: string, status = 0) {
    super(message);
    this.status = status;
  }
}

// ---------------------------------------------------------------------------------------------
// Play tokens

const DEV_KEY = "firstlight.devGuest";

export function isDevGuest(): boolean {
  return flags.has("devguest");
}

function devToken(): string {
  let id = localStorage.getItem(DEV_KEY);
  if (!id) {
    id = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
    localStorage.setItem(DEV_KEY, id);
  }
  return `dev:${id}:Wanderer-${id.slice(0, 4)}`;
}

export interface PlayClaims {
  sub: string;
  name: string;
  guest: boolean;
  exp: number;
}

/** Read (not verify) the claims of a play token. */
export function readClaims(token: string): PlayClaims | null {
  if (token.startsWith("dev:")) {
    const [, sub = "", name = ""] = token.split(":");
    return { sub, name, guest: true, exp: Number.MAX_SAFE_INTEGER };
  }
  try {
    const part = token.split(".")[1] ?? "";
    const json = atob(part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "="));
    const p = JSON.parse(new TextDecoder().decode(Uint8Array.from(json, (c) => c.charCodeAt(0)))) as Record<string, unknown>;
    return {
      sub: String(p.sub ?? ""),
      name: String(p.name ?? ""),
      guest: p.guest === true,
      exp: typeof p.exp === "number" ? p.exp * 1000 : Date.now() + 14 * 60_000,
    };
  } catch {
    return null;
  }
}

let cached: { token: string; exp: number } | null = null;
let inflight: Promise<string> | null = null;

/** A JWT for POST /api/play and the /api/account routes. Signs in as a guest if needed. */
export async function getPlayToken(): Promise<string> {
  if (isDevGuest()) return devToken();
  if (cached && cached.exp - 60_000 > Date.now()) return cached.token;
  inflight ??= fetchPlayToken().finally(() => {
    inflight = null;
  });
  return inflight;
}

async function fetchPlayToken(): Promise<string> {
  const c = authClient();
  for (let attempt = 0; attempt < 2; attempt++) {
    const s = await c.getSession();
    if (!s.data) {
      const r = await c.signIn.anonymous();
      if (r.error) throw new AuthError(r.error.message || "Couldn't start a guest session", r.error.status);
    }
    const t = await c.token();
    if (t.data?.token) {
      const claims = readClaims(t.data.token);
      cached = { token: t.data.token, exp: claims?.exp ?? Date.now() + 14 * 60_000 };
      return t.data.token;
    }
    // A session that vanished between the two calls: go round once more.
    if (t.error?.status !== 401) throw new AuthError(t.error?.message || "Couldn't get a play token", t.error?.status);
  }
  throw new AuthError("Couldn't get a play token", 401);
}

/** Drop the cached JWT (after saving, signing in, or renaming). */
export function invalidatePlayToken(): void {
  cached = null;
}

// ---------------------------------------------------------------------------------------------
// Account changes

/** `elsewhere`: another tab of this browser changed it (claims are then null: ask again if you need them). */
type AccountListener = (claims: PlayClaims | null, change: { elsewhere: boolean }) => void;
const listeners = new Set<AccountListener>();

/** Called after the account changes (saved, signed in, renamed), here or in another tab. Returns an unsubscribe function. */
export function onAccountChange(fn: AccountListener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Tabs share the session cookie but each caches its own play token: a save, sign-in or rename in one
 * tab makes the others' tokens (and any save prompt they show) stale (Codex review). They hear it here.
 */
export const ACCOUNT_CHANNEL = "fl.account";
let channel: BroadcastChannel | null = null;
if (typeof window !== "undefined" && typeof BroadcastChannel !== "undefined") {
  channel = new BroadcastChannel(ACCOUNT_CHANNEL);
  (channel as { unref?: () => void }).unref?.(); // Node (tests): don't hold the process open
  channel.onmessage = () => {
    invalidatePlayToken();
    for (const fn of listeners) fn(null, { elsewhere: true });
  };
}

async function accountChanged(): Promise<void> {
  invalidatePlayToken();
  channel?.postMessage("changed");
  let claims: PlayClaims | null = null;
  try {
    claims = readClaims(await getPlayToken());
  } catch {}
  for (const fn of listeners) fn(claims, { elsewhere: false });
}

export type Result = { ok: true } | { ok: false; message: string; failure?: SendFailure };

const SEND_MESSAGE: Record<SendFailure, string> = {
  unavailable: "Saving is temporarily unavailable",
  busy: SAVING_BUSY,
  rejected: "That email doesn't look right.",
  retry: "Couldn't send the code. Try again.",
};

/** Step 1 of "Save progress" / "Sign in": email a 6-digit code. */
export async function sendEmailCode(email: string): Promise<Result> {
  const r = await authClient()
    .emailOtp.sendVerificationOtp({ email: email.trim(), type: "sign-in" })
    .catch(() => ({ error: { status: 0 } }));
  if (!r.error) return { ok: true };
  const failure = sendCodeFailure(r.error as { status?: number; code?: string });
  return { ok: false, message: SEND_MESSAGE[failure], failure };
}

/**
 * Can this browser save: a guest session, a saved account, or neither (a `?devguest` token, an
 * offline run, no session yet)? Asks the session every time, never the cached play token: the cookie
 * is shared with other tabs, so a save in one of them shows here at once (Codex review). Never creates
 * a session: a first visit to the home page stays "none".
 */
export async function saveStatus(): Promise<SaveStatus> {
  const devGuest = isDevGuest();
  const offline = offlineRun();
  if (devGuest || offline) return saveStatusOf({ devGuest, offline, guest: null });
  const s = await authClient()
    .getSession()
    .catch(() => null);
  const user = s?.data?.user as { isAnonymous?: boolean | null } | undefined;
  return saveStatusOf({ devGuest, offline, guest: user ? !!user.isAnonymous : null });
}

/** Can sign-in codes go out right now (server: GET /api/account/save-status)? "ok" when unsure. */
export async function savingStatus(): Promise<"ok" | "busy" | "unavailable"> {
  try {
    const res = await fetch(`${config.apiUrl}/api/account/save-status`);
    const body = (await res.json()) as { saving?: unknown };
    return body.saving === "busy" || body.saving === "unavailable" ? body.saving : "ok";
  } catch {
    return "ok";
  }
}

/**
 * Step 2: sign in with the code. Pass the current name so a guest keeps it. On success the server
 * moves the character to the saved account (and re-keys the live session); the play token is refreshed.
 */
export async function verifyEmailCode(email: string, otp: string, name?: string): Promise<Result> {
  const r = await authClient().signIn.emailOtp({ email: email.trim(), otp: otp.trim(), ...(name ? { name } : {}) });
  if (r.error) {
    const e = r.error as { status?: number; code?: string };
    if (e.status === 429) return { ok: false, message: "Too many tries. Wait a minute." };
    // The server gives wrong, expired and used-up codes one answer (no hint whether an address is saved).
    return { ok: false, message: "That code isn't right, or it expired. Check it or send a new one." };
  }
  await accountChanged();
  return { ok: true };
}

// ---------------------------------------------------------------------------------------------
// Game-server account routes (Bearer JWT, direct to the API host)

export interface AccountInfo {
  userId: string;
  name: string;
  displayName: string | null;
  guest: boolean;
  admin: boolean;
  titleMedal: string | null;
  character: { level: number; xp: number; coins: number; starter: number; palette: number; look?: number; body: string } | null;
  /** A guest the server will email a code for (level 2+): saving works now. Older servers omit it. */
  saveReady?: boolean;
  medals: string[];
  pads: { body: string; padId: string }[];
}

async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const token = await getPlayToken();
  return fetch(`${config.apiUrl}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...(init.body ? { "Content-Type": "application/json" } : {}), ...init.headers },
  });
}

export async function getAccountInfo(): Promise<AccountInfo> {
  const res = await apiFetch("/api/account/me");
  if (!res.ok) throw new AuthError("Couldn't load the account", res.status);
  return (await res.json()) as AccountInfo;
}

export const NAME_PATTERN = /^[A-Za-z0-9_]{3,16}$/;

/** Set the display name (unique, filtered). Returns the server's message on refusal. */
export async function setDisplayName(name: string): Promise<{ ok: true; name: string } | { ok: false; message: string }> {
  const res = await apiFetch("/api/account/name", { method: "POST", body: JSON.stringify({ name }) });
  const body = (await res.json().catch(() => ({}))) as { ok?: boolean; name?: string; message?: string };
  if (res.ok && body.ok && body.name) {
    await accountChanged();
    return { ok: true, name: body.name };
  }
  return { ok: false, message: body.message ?? "Couldn't set that name. Try again." };
}
