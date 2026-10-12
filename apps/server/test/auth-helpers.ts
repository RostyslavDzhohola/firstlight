// Seam 1 helpers for accounts: an in-process server with temp SQLite files, and a cookie-jar
// "browser" that drives the real Better Auth client library over HTTP, like apps/client does.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, type Room } from "@colyseus/sdk";
import type { PlayResponse } from "@firstlight/shared/net/protocol";
import { createAuthClient } from "better-auth/client";
import { anonymousClient, emailOTPClient, jwtClient } from "better-auth/client/plugins";
import type { Express } from "express";
import { createGame, type Game } from "../src/app.ts";
import { createAccounts, type Accounts, type AccountsConfig } from "../src/auth/accounts.ts";
import { devVerifier } from "../src/auth/identity.ts";
import { LinkEvents } from "../src/auth/links.ts";
import { SessionRegistry } from "../src/auth/sessions.ts";
import { grantTravel } from "./helpers.ts";

export const ORIGIN = "http://localhost:5173";
export const TEST_SECRET = "test-secret-0123456789-test-secret-0123456789";

export interface AuthServer {
  game: Game;
  accounts: Accounts;
  base: string;
  dir: string;
  originSecret: string;
  /** Close the server and databases (keeps the temp dir when `keepFiles`). */
  close(keepFiles?: boolean): Promise<void>;
}

export function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "fl-auth-"));
}

export async function startAuthServer(over: Partial<AccountsConfig> & { dir?: string; extraRoutes?: (app: Express, a: Accounts) => void } = {}): Promise<AuthServer> {
  const { dir: givenDir, extraRoutes, ...cfgOver } = over;
  const dir = givenDir ?? tempDir();
  const accounts = await createAccounts({
    production: false,
    baseURL: ORIGIN,
    secret: TEST_SECRET,
    authDbPath: join(dir, "auth.db"),
    gameDbPath: join(dir, "game.db"),
    trustedOrigins: [ORIGIN],
    originSecret: "",
    emailFrom: "FIRSTLIGHT <login@test.invalid>",
    resendKey: "",
    adminClaimToken: "",
    loadtestSecret: "",
    otpPerEmailPerHour: 3,
    otpDailyBudget: 1000,
    sessions: new SessionRegistry(),
    links: new LinkEvents(),
    fallbackVerifier: devVerifier(true),
    ...cfgOver,
  });
  const game = await createGame({
    port: 0,
    verify: accounts.verify,
    limits: { maxClients: 40, soloFillLimit: 36, maxCopiesPerBody: 2, globalCap: 320 },
    allowedOrigins: [ORIGIN],
    mountBeforeJson: accounts.mountBeforeJson,
    mountAfterJson: (app) => {
      accounts.mountAfterJson(app);
      extraRoutes?.(app, accounts);
    },
  });
  const base = `http://127.0.0.1:${game.port}`;
  return {
    game,
    accounts,
    base,
    dir,
    originSecret: cfgOver.originSecret ?? "",
    async close(keepFiles = false) {
      await game.close();
      accounts.close();
      if (!keepFiles) rmSync(dir, { recursive: true, force: true });
    },
  };
}

function makeAuthClient(base: string, fetchImpl: typeof fetch) {
  return createAuthClient({
    baseURL: base,
    plugins: [anonymousClient(), emailOTPClient(), jwtClient()],
    fetchOptions: { customFetchImpl: fetchImpl },
  });
}

/** A browser profile: its own cookie jar, client IP, and (like the Vercel proxy) the origin secret on /api/auth. */
export class Browser {
  readonly server: AuthServer;
  readonly cookies = new Map<string, string>();
  ip: string;
  sendOriginSecret = true;
  readonly client: ReturnType<typeof makeAuthClient>;

  constructor(server: AuthServer, ip = "198.51.100.7") {
    this.server = server;
    this.ip = ip;
    this.client = makeAuthClient(server.base, this.fetch);
  }

  fetch = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input.toString() : input.url, this.server.base);
    const headers = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined));
    if (this.cookies.size) headers.set("cookie", [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "));
    headers.set("origin", ORIGIN);
    if (url.pathname.startsWith("/api/auth/")) {
      if (this.server.originSecret && this.sendOriginSecret) headers.set("x-origin-secret", this.server.originSecret);
      headers.set("x-forwarded-for", `${this.ip}, 10.0.0.1`);
    }
    const res = await fetch(url, { ...init, headers, method: init.method ?? (input instanceof Request ? input.method : "GET") });
    for (const sc of res.headers.getSetCookie()) {
      const [pair, ...attrs] = sc.split(";");
      const eq = pair!.indexOf("=");
      const name = pair!.slice(0, eq).trim();
      const value = pair!.slice(eq + 1).trim();
      const expired = attrs.some((a) => /^\s*max-age=0\s*$/i.test(a)) || value === "";
      if (expired) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    return res;
  };

  /** The client's getPlayToken flow: getSession() first (stale-cookie workaround), else signIn.anonymous(), then token(). */
  async playToken(): Promise<string> {
    const s = await this.client.getSession();
    if (!s.data) {
      const r = await this.client.signIn.anonymous();
      if (r.error) throw new Error(`anonymous sign-in failed: ${JSON.stringify(r.error)}`);
    }
    const t = await this.client.token();
    if (t.error || !t.data) throw new Error(`token failed: ${JSON.stringify(t.error)}`);
    return t.data.token;
  }

  async sendCode(email: string) {
    return this.client.emailOtp.sendVerificationOtp({ email, type: "sign-in" });
  }

  async signInWithCode(email: string, otp: string, name?: string) {
    return this.client.signIn.emailOtp({ email, otp, ...(name ? { name } : {}) });
  }

  /** Request a code and sign in with it (dev outbox). */
  async saveWithEmail(email: string, name?: string) {
    const sent = await this.sendCode(email);
    if (sent.error) throw new Error(`send failed: ${JSON.stringify(sent.error)}`);
    const code = this.server.accounts.devOutbox!.lastCode(email);
    if (!code) throw new Error("no code in the dev outbox");
    const r = await this.signInWithCode(email, code, name);
    if (r.error) throw new Error(`sign-in failed: ${JSON.stringify(r.error)}`);
    return r.data!;
  }
}

export function decodeJwt(token: string): Record<string, unknown> {
  const part = token.split(".")[1]!;
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>;
}

export async function play(server: AuthServer, token: string, body: Record<string, unknown> = { body: "portus" }, headers: Record<string, string> = {}): Promise<{ status: number; json: PlayResponse }> {
  const res = await fetch(`${server.base}/api/play`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as PlayResponse };
}

/** The account id a dev token or JWT plays as. */
export function userIdOf(token: string): string {
  return token.startsWith("dev:") ? token.split(":")[1]! : String(decodeJwt(token).sub);
}

/** Give the token's character a travel ticket to `body` (new characters otherwise start in Portus). */
export function ticketFor(token: string, body: string): void {
  grantTravel(userIdOf(token), body);
}

export async function joinWithToken(server: AuthServer, token: string, body = "portus"): Promise<Room> {
  ticketFor(token, body);
  const r = await play(server, token, { body });
  if (!r.json.ok) throw new Error(`play refused: ${JSON.stringify(r.json)}`);
  const client = new Client(server.base);
  return client.consumeSeatReservation(r.json.reservation as never);
}

export async function api(server: AuthServer, path: string, token: string | null, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  const res = await fetch(`${server.base}${path}`, {
    method: init.method ?? (init.body ? "POST" : "GET"),
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...init.headers,
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, json, text, headers: res.headers };
}
