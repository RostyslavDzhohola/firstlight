// The page's three small endpoints for the funnel (#85, db/funnel.ts; D-ship-6):
//   POST /api/visit         {prev?, auto?}             → {visit: token, exp} | {off: true}
//   POST /api/funnel        {visit: token, steps: [{step, value?, detail?}]} → {done: [step…]}
//   POST /api/client-error  {visit: token, message, stack, build, tier, backend} → 204
// The server issues every visit (auth/visitToken.ts) and fixes its kind then: a request carrying our
// tools' LOADTEST_SECRET (the right one), or a page that says it is automated (navigator.webdriver,
// ?e2e, ?bench), is a test visit; the agent header an agent's. Steps and error reports are taken only
// with a live token, so nothing lands on a visit the server didn't make and no later request can
// move a visit into or out of the people's figures. An anonymous caller costs a bounded amount:
// visits are rate-limited per address and overall and capped per day, each visit holds at most
// MAX_VISIT_ROWS rows, every write spends the day's budget (FUNNEL_LIMITS) and goes through the
// batched queue, and each body is limited to INGEST.bodyLimit before any other parser reads it
// (mounted ahead of express.json, whatever the content type).
// Bodies are JSON sent as text/plain (a CORS "simple" request: no preflight; fetch keepalive).

import express, { type Express, type Request, type Response } from "express";
import { AGENT_HEADER } from "@firstlight/shared/net/agents";
import { scrubReport } from "@firstlight/shared/net/scrub";
import { banKey, directRequestIp } from "../auth/ip.ts";
import { WindowLimiter } from "../auth/limiter.ts";
import { safeEqual } from "../auth/crypto.ts";
import { issueVisit, readVisit, renewVisit, VISIT_TOKEN, visitLive, visitRenewable, type VisitKind } from "../auth/visitToken.ts";
import {
  hasStep,
  MAX_TUTORIAL_STEPS,
  MAX_VISIT_ROWS,
  pageStepAllowed,
  queueClientError,
  queueStep,
  subjectRowCount,
  takeBudget,
  TUTORIAL_PREFIX,
  visitSubject,
  type Db,
} from "../db/index.ts";
import { currentDb } from "../social/store.ts";
import { redact } from "./errors.ts";

export const INGEST = {
  /** Visits issued (or renewed) per address per 10 minutes, and overall per minute. */
  visitsPerIp: 10,
  visitsGlobal: 600,
  /** Funnel posts per address per minute and overall, and per visit per hour. */
  funnelPerIp: 30,
  funnelGlobal: 3000,
  funnelPerVisit: 30,
  /** Error reports per address and overall per 10 minutes, and per visit per day. */
  errorsPerIp: 10,
  errorsGlobal: 300,
  errorsPerVisit: 8,
  /** Steps per post. */
  maxSteps: 16,
  bodyLimit: "4kb",
};

/** Our tools' secret (LOADTEST_SECRET) marks a test visit (the process environment; mutable for tests). */
export const ingestConfig = { loadtestSecret: process.env.LOADTEST_SECRET ?? "" };

const DETAIL = /^[\w./:-]{1,48}$/;
const SHORT = /^[\w./:-]{1,40}$/;

function parse(req: Request): Record<string, unknown> | null {
  const raw: unknown = req.body;
  if (typeof raw !== "string" || !raw) return null;
  try {
    const v: unknown = JSON.parse(raw);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const str = (v: unknown, max: number): string => (typeof v === "string" ? v.slice(0, max) : "");

/** The kind a new visit gets, from this request alone (fixed for the visit's life). */
function kindAtIssue(req: Request, body: Record<string, unknown> | null): VisitKind {
  const tool = req.headers["x-loadtest-secret"];
  if (typeof tool === "string" && tool && ingestConfig.loadtestSecret && safeEqual(tool, ingestConfig.loadtestSecret)) return "test";
  const a = req.headers[AGENT_HEADER];
  if (a === "1" || a === "true") return "agent";
  return body?.auto === true ? "test" : "person";
}

/**
 * Mount /api/visit, /api/funnel and /api/client-error. Call before the global JSON parser (app.ts):
 * the bodies are read here, under INGEST.bodyLimit, whatever their content type.
 */
export function mountFunnelIngest(app: Express, dbOf: () => Db | null = currentDb): void {
  const visitIp = new WindowLimiter(INGEST.visitsPerIp, 10 * 60_000);
  const visitAll = new WindowLimiter(INGEST.visitsGlobal, 60_000, 1);
  const funnelIp = new WindowLimiter(INGEST.funnelPerIp, 60_000);
  const funnelAll = new WindowLimiter(INGEST.funnelGlobal, 60_000, 1);
  const funnelVisit = new WindowLimiter(INGEST.funnelPerVisit, 3_600_000);
  const errorIp = new WindowLimiter(INGEST.errorsPerIp, 10 * 60_000);
  const errorAll = new WindowLimiter(INGEST.errorsGlobal, 10 * 60_000, 1);
  const errorVisit = new WindowLimiter(INGEST.errorsPerVisit, 86_400_000);
  const limits = () => {
    visitIp.max = INGEST.visitsPerIp;
    visitAll.max = INGEST.visitsGlobal;
    funnelIp.max = INGEST.funnelPerIp;
    funnelAll.max = INGEST.funnelGlobal;
    funnelVisit.max = INGEST.funnelPerVisit;
    errorIp.max = INGEST.errorsPerIp;
    errorAll.max = INGEST.errorsGlobal;
    errorVisit.max = INGEST.errorsPerVisit;
  };
  // Every content type, one limit, before express.json (which would take 32 kb of application/json).
  const body = (req: Request, res: Response, next: (err?: unknown) => void) =>
    express.text({ type: () => true, limit: INGEST.bodyLimit })(req, res, (err?: unknown) => {
      if (err) {
        const status = (err as { status?: number }).status ?? 400;
        res.status(status === 413 ? 413 : 400).json({ error: status === 413 ? "too large" : "bad body" });
        return;
      }
      next();
    });
  const addr = (req: Request) => {
    const ip = directRequestIp(req);
    return ip ? banKey(ip) : "unknown";
  };
  const slow = (res: Response) => res.status(429).json({ error: "slow down" });

  app.post("/api/visit", body, (req, res) => {
    limits();
    res.set("Cache-Control", "no-store");
    const db = dbOf();
    if (!db) return void res.json({ off: true });
    if (!visitAll.take("all") || !visitIp.take(addr(req))) return void slow(res);
    const m = parse(req);
    const now = Date.now();
    // The same browser again: the same visit (id, kind and start) while it is renewable.
    const prev = readVisit(m?.prev);
    if (prev && visitRenewable(prev, now)) return void res.json({ visit: renewVisit(prev, now), exp: now + VISIT_TOKEN.TOKEN_TTL_MS });
    if (!takeBudget(db, "visits", now)) return void res.json({ off: true }); // today's visits are all issued
    const { token, visit } = issueVisit(kindAtIssue(req, m), now);
    queueStep(db, { subject: visitSubject(visit.id), step: "page", at: now, kind: visit.kind }, now);
    res.json({ visit: token, exp: now + VISIT_TOKEN.TOKEN_TTL_MS });
  });

  app.post("/api/funnel", body, (req, res) => {
    limits();
    const db = dbOf();
    if (!db) return void res.json({ done: [], off: true });
    if (!funnelAll.take("all") || !funnelIp.take(addr(req))) return void slow(res);
    const m = parse(req);
    if (!m || !Array.isArray(m.steps)) return void res.status(400).json({ error: "bad body" });
    const now = Date.now();
    const v = readVisit(m.visit);
    if (!v || !visitLive(v, now)) return void res.status(401).json({ error: "visit" });
    if (!funnelVisit.take(v.id)) return void slow(res);
    const subject = visitSubject(v.id);
    const counts = subjectRowCount(db, subject);
    const done: string[] = [];
    let full = false;
    for (const s of (m.steps as unknown[]).slice(0, INGEST.maxSteps)) {
      if (!s || typeof s !== "object") continue;
      const o = s as Record<string, unknown>;
      const step = str(o.step, 40);
      if (!pageStepAllowed(step)) {
        if (step) done.push(step); // refused for good: the page drops it
        continue;
      }
      if (hasStep(db, subject, step)) {
        done.push(step);
        continue;
      }
      const tutorial = step.startsWith(TUTORIAL_PREFIX);
      if (counts.rows >= MAX_VISIT_ROWS || (tutorial && counts.tutorial >= MAX_TUTORIAL_STEPS)) {
        done.push(step);
        continue;
      }
      const value = typeof o.value === "number" && Number.isFinite(o.value) ? Math.max(0, Math.min(o.value, 1e7)) : null;
      const detail = typeof o.detail === "string" && DETAIL.test(o.detail) ? o.detail : null;
      if (!queueStep(db, { subject, step, at: now, value, detail, kind: v.kind }, now)) {
        full = true; // today's budget: the page keeps it for later
        continue;
      }
      counts.rows++;
      if (tutorial) counts.tutorial++;
      done.push(step);
    }
    res.json(full ? { done, full: true } : { done });
  });

  app.post("/api/client-error", body, (req, res) => {
    limits();
    const db = dbOf();
    if (!db) return void res.status(204).end();
    if (!errorAll.take("all") || !errorIp.take(addr(req))) return void slow(res);
    const m = parse(req);
    if (!m) return void res.status(400).json({ error: "bad body" });
    const now = Date.now();
    const v = readVisit(m.visit);
    if (!v || !visitLive(v, now)) return void res.status(401).json({ error: "visit" });
    if (!errorVisit.take(v.id)) return void slow(res);
    // Scrubbed again here whatever the page did (shared/net/scrub.ts), then our own secrets.
    const clean = scrubReport(str(m.message, 2000), str(m.stack, 4000));
    const message = redact(clean.message);
    if (!message) return void res.status(400).json({ error: "bad body" });
    const stack = redact(clean.stack);
    const build = str(m.build, 40);
    const tier = str(m.tier, 16);
    const backend = str(m.backend, 16);
    queueClientError(db, { at: now, sig: errorSignature(message, stack), message, stack, build: SHORT.test(build) ? build : "unknown", tier: SHORT.test(tier) ? tier : null, backend: SHORT.test(backend) ? backend : null, kind: v.kind }, now);
    const subject = visitSubject(v.id);
    if (!hasStep(db, subject, "crash") && subjectRowCount(db, subject).rows < MAX_VISIT_ROWS) queueStep(db, { subject, step: "crash", at: now, kind: v.kind }, now);
    res.status(204).end();
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
