// Where the journeys run: a local stack on its own ports (server + production client build served by
// `vite preview`) or production (read-only smoke subset). All paths are absolute.

import { readFileSync } from "node:fs";
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

/** Server env: dev guests (admin placement), the dev mail log (email codes on stdout), fresh databases. */
export const SERVER_ENV: Record<string, string> = {
  PORT: String(PORT),
  CLIENT_ORIGIN: LOCAL_ORIGIN,
  BETTER_AUTH_URL: LOCAL_ORIGIN,
  AUTH_DB_PATH: path.join(DB_DIR, "auth.db"),
  GAME_DB_PATH: path.join(DB_DIR, "game.db"),
  DEV_MAIL_LOG: "1",
  ALLOW_DEV_GUESTS: "1",
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
