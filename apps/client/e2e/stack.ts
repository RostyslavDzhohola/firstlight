// Where the journeys run: a local stack on its own ports (server + production client build served by
// `vite preview`) or production (read-only smoke subset). All paths are absolute.

import type { BrowserContext } from "@playwright/test";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

export const ROOT = path.resolve(here, "../../..");
export const CLIENT_DIR = path.resolve(here, "..");
export const SERVER_DIR = path.resolve(ROOT, "apps/server");

/** `local` (default) or `prod` (E2E_TARGET=prod: https://firstlight.one4all.dev, smoke tests only). */
export const TARGET = process.env.E2E_TARGET === "prod" ? "prod" : "local";

/** Ports: E2E_PORT / E2E_CLIENT_PORT, default 2601 / 5201 (the e2e lane's own; other worktrees use others). */
export const PORT = Number(process.env.E2E_PORT ?? 2601);
export const CLIENT_PORT = Number(process.env.E2E_CLIENT_PORT ?? 5201);

/** Screenshots, traces, the server log, the client build and the databases (E2E_OUT). */
export const OUT = path.resolve(process.env.E2E_OUT ?? path.join(here, ".out"));
export const SERVER_LOG = path.join(OUT, "server.log");
export const DB_DIR = path.join(OUT, "db");
export const DIST = path.join(OUT, "dist");

export const LOCAL_ORIGIN = `http://127.0.0.1:${CLIENT_PORT}`;
export const LOCAL_API = `http://127.0.0.1:${PORT}`;
export const PROD_ORIGIN = "https://firstlight.one4all.dev";

export const BASE_URL = TARGET === "prod" ? PROD_ORIGIN : LOCAL_ORIGIN;

/** The game server the client bundle calls directly (/api/play, /api/account/*). */
export const PROD_API = "https://api.firstlight.one4all.dev";
export const API_ORIGIN = TARGET === "prod" ? PROD_API : LOCAL_API;

/**
 * Every guest these journeys create is one of our test accounts (D-home-6): its requests to the game
 * server carry LOADTEST_SECRET in `x-loadtest-secret`, and the server keeps it off the leaderboard,
 * "online now" and /stats. The local stack gets a throwaway secret; production runs read the real
 * one from the environment or ~/.config/firstlight/.env (never printed) and refuse to run without it.
 */
export const LOCAL_TOOL_SECRET = "e2e-local-tool-secret";

export function toolSecret(): string {
  if (TARGET !== "prod") return LOCAL_TOOL_SECRET;
  const fromEnv = process.env.LOADTEST_SECRET?.trim();
  if (fromEnv) return fromEnv;
  const file = process.env.FIRSTLIGHT_ENV_FILE ?? path.join(os.homedir(), ".config/firstlight/.env");
  let text = "";
  try {
    text = readFileSync(file, "utf8");
  } catch {}
  const v = dotenvValue(text, "LOADTEST_SECRET");
  if (!v) throw new Error("pnpm e2e:prod needs LOADTEST_SECRET (in the environment or ~/.config/firstlight/.env) so its guests are flagged as test accounts (D-home-6); refusing to create unflagged guests on production");
  return v;
}

/** A key's value in a .env text, dotenv-style: quoted values verbatim (a # inside stays), unquoted ones end at " #". */
export function dotenvValue(text: string, key: string): string {
  const m = new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=\\s*(.*)$`, "m").exec(text);
  const raw = (m?.[1] ?? "").trim();
  const q = /^(['"])(.*?)\1/.exec(raw);
  return q ? q[2]! : raw.replace(/\s+#.*$/, "").trim();
}

/** Add our tools' header to this context's requests to the game server (and nowhere else). */
export async function markToolRequests(context: BrowserContext): Promise<void> {
  const secret = toolSecret();
  await context.route(`${API_ORIGIN}/api/**`, (route) => route.continue({ headers: { ...route.request().headers(), "x-loadtest-secret": secret } }));
}

/** Server env: dev guests (admin placement), the dev mail log (email codes on stdout), fresh databases. */
export const SERVER_ENV: Record<string, string> = {
  PORT: String(PORT),
  CLIENT_ORIGIN: LOCAL_ORIGIN,
  BETTER_AUTH_URL: LOCAL_ORIGIN,
  AUTH_DB_PATH: path.join(DB_DIR, "auth.db"),
  GAME_DB_PATH: path.join(DB_DIR, "game.db"),
  DEV_MAIL_LOG: "1",
  ALLOW_DEV_GUESTS: "1",
  // Our tools' guests are flagged as test accounts (D-home-6): the journeys send this with every guest.
  LOADTEST_SECRET: LOCAL_TOOL_SECRET,
  // No Resend locally: codes go to the log. Never inherit a real key into a test stack.
  RESEND_API_KEY: "",
  NODE_ENV: "development",
};

/** Client build env (VITE_API_URL is baked into the bundle; the preview server proxies /api/auth). */
export const CLIENT_ENV: Record<string, string> = {
  VITE_API_URL: LOCAL_API,
  API_PROXY_TARGET: LOCAL_API,
  CLIENT_PORT: String(CLIENT_PORT),
};

function mailCodes(email: string): string[] {
  const re = new RegExp(`\\[dev-mail\\] FIRSTLIGHT code for ${email.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}: (\\d{6})`, "g");
  let text = "";
  try {
    text = readFileSync(SERVER_LOG, "utf8");
  } catch {}
  return [...text.matchAll(re)].map((m) => m[1]!);
}

/** How many codes the local server has "sent" to `email` so far (take it before clicking Send). */
export function mailCount(email: string): number {
  return mailCodes(email).length;
}

/**
 * The 6-digit code the local server "sent" to `email` after `seen` earlier ones (DEV_MAIL_LOG=1 prints
 * `[dev-mail] FIRSTLIGHT code for <email>: <code>`). Waits for a code written after the Send click,
 * so a second send to the same address (save, then sign in) never reuses the first, spent code.
 */
export async function mailCode(email: string, seen: number, timeoutMs = 15_000): Promise<string> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const all = mailCodes(email);
    if (all.length > seen) return all[all.length - 1]!;
    if (Date.now() > until) throw new Error(`no new dev-mail code for ${email} in ${SERVER_LOG} (had ${seen})`);
    await new Promise((r) => setTimeout(r, 250));
  }
}
