// The two small ingest endpoints for what only the page knows (#85, db/funnel.ts):
//   POST /api/funnel        {visit, steps: [{step, value?, detail?}]}: first-time steps of a visit
//   POST /api/client-error  {visit?, message, stack, build, tier, backend}: an uncaught error or rejection
// Both take a text/plain JSON body (a CORS "simple" request: no preflight, and the page can send it as
// it unloads), answer 204 whatever happens to the data, and are rate-limited per address and overall.
// Nothing personal is stored: a random visit id the page made, the step names and a few numbers. A
// request carrying our tools' header (x-loadtest-secret, any value) is counted as a test visit, the
// agent header as an agent's: neither enters the people's figures.

import express, { type Express, type Request } from "express";
import { AGENT_HEADER } from "@firstlight/shared/net/agents";
import { banKey, directRequestIp } from "../auth/ip.ts";
import { WindowLimiter } from "../auth/limiter.ts";
import {
  MAX_TUTORIAL_STEPS,
  recordClientError,
  recordStep,
  TUTORIAL_PREFIX,
  tutorialStepCount,
  visitStepAllowed,
  visitSubject,
  type Db,
  type FunnelKind,
} from "../db/index.ts";
import { redact } from "./errors.ts";

export const INGEST = {
  /** Funnel posts per address per minute (a visit sends a handful; a reload storm more). */
  funnelPerIp: 30,
  funnelGlobal: 3000,
  /** Error reports per address and overall per 10 minutes. */
  errorsPerIp: 10,
  errorsGlobal: 300,
  /** Steps per post. */
  maxSteps: 16,
  bodyLimit: "4kb",
};

const VISIT_ID = /^[A-Za-z0-9_-]{8,40}$/;
const DETAIL = /^[\w./:-]{1,48}$/;
const SHORT = /^[\w./:-]{1,40}$/;

function kindOf(req: Request): FunnelKind {
  if (req.headers["x-loadtest-secret"]) return "test";
  const a = req.headers[AGENT_HEADER];
  return a === "1" || a === "true" ? "agent" : "person";
}

function parse(req: Request): Record<string, unknown> | null {
  const raw: unknown = req.body;
  if (typeof raw === "string") {
    try {
      const v: unknown = JSON.parse(raw);
      return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
}

const str = (v: unknown, max: number): string => (typeof v === "string" ? v.slice(0, max) : "");

export interface IngestDeps {
  db: Db;
}

/** Mount /api/funnel and /api/client-error (any time; the bodies are parsed here). */
export function mountFunnelIngest(app: Express, deps: IngestDeps): void {
  const funnelIp = new WindowLimiter(INGEST.funnelPerIp, 60_000);
  const funnelAll = new WindowLimiter(INGEST.funnelGlobal, 60_000, 1);
  const errorIp = new WindowLimiter(INGEST.errorsPerIp, 10 * 60_000);
  const errorAll = new WindowLimiter(INGEST.errorsGlobal, 10 * 60_000, 1);
  const body = express.text({ type: ["text/plain", "application/json"], limit: INGEST.bodyLimit });
  const addr = (req: Request) => {
    const ip = directRequestIp(req);
    return ip ? banKey(ip) : "unknown";
  };

  app.post("/api/funnel", body, (req, res) => {
    res.status(204).end();
    const key = addr(req);
    if (!funnelAll.take("all") || !funnelIp.take(key)) return;
    const m = parse(req);
    const visit = str(m?.visit, 41);
    if (!VISIT_ID.test(visit) || !Array.isArray(m?.steps)) return;
    const kind = kindOf(req);
    const subject = visitSubject(visit);
    const now = Date.now();
    try {
      let tutorial = -1;
      for (const s of (m.steps as unknown[]).slice(0, INGEST.maxSteps)) {
        if (!s || typeof s !== "object") continue;
        const o = s as Record<string, unknown>;
        const step = str(o.step, 40);
        if (!visitStepAllowed(step)) continue;
        if (step.startsWith(TUTORIAL_PREFIX)) {
          if (tutorial < 0) tutorial = tutorialStepCount(deps.db, subject);
          if (tutorial >= MAX_TUTORIAL_STEPS) continue;
        }
        const value = typeof o.value === "number" && Number.isFinite(o.value) ? Math.max(0, Math.min(o.value, 1e7)) : null;
        const detail = typeof o.detail === "string" && DETAIL.test(o.detail) ? o.detail : null;
        if (recordStep(deps.db, { subject, step, at: now, value, detail, kind }) && step.startsWith(TUTORIAL_PREFIX)) tutorial++;
      }
    } catch (err) {
      console.warn(`funnel ingest: ${(err as Error).message}`);
    }
  });

  app.post("/api/client-error", body, (req, res) => {
    res.status(204).end();
    const key = addr(req);
    if (!errorAll.take("all") || !errorIp.take(key)) return;
    const m = parse(req);
    const message = redact(str(m?.message, 300)).replace(/\s+/g, " ").trim();
    if (!message) return;
    const stack = redact(str(m?.stack, 600));
    const build = str(m?.build, 40);
    const tier = str(m?.tier, 16);
    const backend = str(m?.backend, 16);
    const kind = kindOf(req);
    const now = Date.now();
    try {
      recordClientError(deps.db, {
        at: now,
        sig: errorSignature(message, stack),
        message,
        stack,
        build: SHORT.test(build) ? build : "unknown",
        tier: SHORT.test(tier) ? tier : null,
        backend: SHORT.test(backend) ? backend : null,
        kind,
      });
      const visit = str(m?.visit, 41);
      if (VISIT_ID.test(visit)) recordStep(deps.db, { subject: visitSubject(visit), step: "crash", at: now, detail: null, kind });
    } catch (err) {
      console.warn(`client error ingest: ${(err as Error).message}`);
    }
  });
}

/** One kind of error: its message with numbers blanked, and the first stack frame without line/column. */
export function errorSignature(message: string, stack: string): string {
  const top = stack.split("\n").map((l) => l.trim()).find((l) => l && !l.startsWith(message.slice(0, 20))) ?? "";
  const norm = `${message.replace(/\d+/g, "#")}|${top.replace(/:\d+(:\d+)?\)?$/, "").replace(/\?[^\s)]*/g, "")}`;
  // FNV-1a, 32 bits ×2: a short stable key (not a security boundary).
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < norm.length; i++) {
    const c = norm.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x811c9dc5) >>> 0;
  }
  return h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");
}
