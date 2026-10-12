// Recent server errors for /admin: a ring buffer of the last 100 console.error calls and uncaught
// exceptions, with tokens, emails and configured secrets redacted. Logging itself is unchanged.

import { format } from "node:util";

export interface ErrorEntry {
  at: number;
  source: string;
  message: string;
  /** Identical consecutive errors are folded into one entry. */
  count: number;
}

const MAX = 100;
const ring: ErrorEntry[] = [];

const SECRET_ENV = ["BETTER_AUTH_SECRET", "RESEND_API_KEY", "ORIGIN_SECRET", "TURN_KEY_API_TOKEN", "ADMIN_CLAIM_TOKEN", "LOADTEST_SECRET"];

export function redact(text: string): string {
  let t = text;
  for (const k of SECRET_ENV) {
    const v = process.env[k];
    if (v && v.length >= 8) t = t.split(v).join(`[${k}]`);
  }
  return t
    .replace(/eyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/g, "[jwt]")
    .replace(/\b(Bearer|bearer)\s+[^\s"']+/g, "$1 [redacted]")
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email]")
    .replace(/\b(re_|sk_|pk_)[A-Za-z0-9_]{12,}/g, "[key]")
    .replace(/\b[a-f0-9]{40,}\b/gi, "[hex]");
}

export function recordError(source: string, err: unknown, now = Date.now()): void {
  const raw = err instanceof Error ? `${err.message}\n${(err.stack ?? "").split("\n").slice(1, 6).join("\n")}` : String(err);
  const message = redact(raw).slice(0, 1500);
  const last = ring[ring.length - 1];
  if (last && last.source === source && last.message === message) {
    last.count++;
    last.at = now;
    return;
  }
  ring.push({ at: now, source, message, count: 1 });
  if (ring.length > MAX) ring.shift();
}

/** Newest first. */
export function recentErrors(): ErrorEntry[] {
  return [...ring].reverse();
}

export function clearErrors(): void {
  ring.length = 0;
}

let installed = false;

/** Capture console.error and uncaught exceptions into the ring buffer (idempotent). */
export function installErrorCapture(): void {
  if (installed) return;
  installed = true;
  const original = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    try {
      const err = args.find((a) => a instanceof Error);
      const text = args.filter((a) => !(a instanceof Error)).map((a) => (typeof a === "string" ? a : format("%o", a))).join(" ");
      recordError("console", err ? Object.assign(new Error(`${text ? `${text}: ` : ""}${(err as Error).message}`), { stack: (err as Error).stack }) : text);
    } catch {}
    original(...args);
  };
  // Observes without changing Node's crash behaviour.
  process.on("uncaughtExceptionMonitor", (err) => recordError("uncaught", err));
}
