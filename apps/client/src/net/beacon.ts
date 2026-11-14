// What only the page knows, sent to our own server (#85, D-ship-6): the funnel's first-time steps of
// this browser (pressed Play, the world on screen and how long it took, each tutorial step, a
// renderer fallback, a failure screen) and uncaught errors. No third-party service, nothing personal.
//
// The server issues the visit: when the page loads it asks POST /api/visit for a signed token (the
// server also records "opened the page" then) and every step and error report goes with it; the
// token also rides along with /api/play so the server sees the visit join a world. The token is
// kept in memory and, where storage works, in localStorage, so one browser stays one visit and a page
// without storage still makes only one. Each step is sent until the server acknowledges it: steps
// wait in a small pending list (kept in storage across pages), are marked sent only when the answer
// names them, and a failed or rate-limited post is retried a few times with a backoff; whatever is
// left goes on the next page. Sent and pending steps belong to one visit id: a new visit starts with
// nothing sent, and a step an old visit left pending never goes out under another visit's token. Error reports are scrubbed here before sending (shared/net/scrub.ts)
// and once per kind per page session.
//
// Off without a server (`?offline`, `?bench`), with Do Not Track or Global Privacy Control, and when
// the home page's Privacy card opted this browser out (`fl.noAnalytics`). An automated browser
// (navigator.webdriver, `?e2e`, `?bench`) asks for a test visit, counted apart from people.
// Bodies are text/plain JSON, a CORS "simple" request: no preflight, and they survive the page
// closing (fetch keepalive). Pure apart from the `BeaconEnv` it is given (unit-tested with fakes).

import { describeThrown, scrubReport } from "@firstlight/shared/net/scrub";

export interface BeaconEnv {
  apiUrl: string;
  buildId: string;
  store: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null;
  /** POST a text/plain JSON body: the status and JSON answer, or null when no answer came. */
  post(url: string, body: string): Promise<{ status: number; json: unknown } | null>;
  /** Off: nothing is recorded or sent. */
  enabled: boolean;
  /** An automated browser or a test URL: the visit is a test one. */
  automated: boolean;
  now(): number;
  /** Run `fn` later (the default: setTimeout). */
  later(fn: () => void, ms: number): void;
}

const VISIT_KEY = "fl.visit.v2";
/** {visit, sent, pending}: what the server acknowledged and what waits, for one visit id (review round two #9). */
const STATE_KEY = "fl.funnel.v3";
/** Earlier versions' browser-wide keys: their pending steps are adopted by the next visit, then they go. */
const OLD_SENT_KEY = "fl.funnel.v2";
const OLD_PENDING_KEY = "fl.funnel.pending";
/** Kinds of errors one page session reports at most. */
export const MAX_ERROR_KINDS = 8;
/** Steps waiting for an acknowledgement at most (more are dropped). */
export const MAX_PENDING = 32;
const FLUSH_MS = 1500;
/** Failed posts retried per page, with a doubling backoff from RETRY_MS. */
const MAX_RETRIES = 6;
const RETRY_MS = 2000;

export interface Step {
  step: string;
  value?: number;
  detail?: string;
}

interface Token {
  token: string;
  exp: number;
}

/** A step waiting for an acknowledgement, and the visit it belongs to (none yet: this page's visit, once known). */
interface Pend extends Step {
  v?: string;
}

/** The visit's id inside a server token (`v1.<id>.…`); the whole token for anything else. */
const visitIdOf = (token: string) => token.split(".")[1] || token;

export class Beacon {
  private token: Token | null = null;
  /** The last token this browser had (for renewing it). */
  private prev: string | null = null;
  private asking: Promise<string | null> | null = null;
  private off = false;
  /** Sent and pending steps, kept for one visit id (`visit`): a new visit starts with nothing sent. */
  private state: { visit: string | null; sent: Set<string>; pending: Pend[] } | null = null;
  /** This page's visit id, once a live token says which. */
  private pageVisit: string | null = null;
  private timer = false;
  private flushing: Promise<void> | null = null;
  private retries = 0;
  private readonly errorKinds = new Set<string>();
  private readonly errors: Record<string, unknown>[] = [];
  /** The renderer and tier once the game knows them (error reports carry them). */
  gfx: { backend: string; tier: string } | null = null;

  constructor(private readonly env: BeaconEnv) {}

  private read(key: string): string | null {
    try {
      return this.env.store?.getItem(key) ?? null;
    } catch {
      return null; // private mode or blocked storage
    }
  }

  private write(key: string, value: string): void {
    try {
      this.env.store?.setItem(key, value);
    } catch {
      /* storage unavailable: memory only */
    }
  }

  /** Start the visit (main.ts, as the page loads): ask for a token, send what an earlier page left. */
  start(): void {
    if (!this.env.enabled) return;
    void this.visit();
    if (this.st().pending.length) this.schedule(0);
  }

  /** The visit token if this page has a live one (memory, then storage), without asking the server. */
  currentToken(): string | null {
    if (!this.env.enabled) return null;
    if (this.token && this.token.exp > this.env.now()) {
      this.learn(this.token.token);
      return this.token.token;
    }
    let t: Token | null = null;
    try {
      const v: unknown = JSON.parse(this.read(VISIT_KEY) ?? "null");
      if (v && typeof (v as Token).token === "string" && typeof (v as Token).exp === "number") t = v as Token;
    } catch {
      /* corrupt */
    }
    if (t) this.prev ??= t.token;
    if (t && t.exp > this.env.now()) {
      this.token = t;
      this.learn(t.token);
      return t.token;
    }
    return null;
  }

  /** The visit token, asking the server for one (or a renewal) when there is none. Null if it can't be had. */
  private visit(): Promise<string | null> {
    const have = this.currentToken();
    if (have) return Promise.resolve(have);
    if (this.off) return Promise.resolve(null);
    this.asking ??= (async () => {
      try {
        const body = { ...(this.prev ? { prev: this.prev } : {}), auto: this.env.automated };
        const r = await this.env.post(`${this.env.apiUrl}/api/visit`, JSON.stringify(body)).catch(() => null);
        const j = (r?.status === 200 ? r.json : null) as { visit?: unknown; exp?: unknown; off?: unknown } | null;
        if (j?.off === true) this.off = true; // the server isn't taking more visits today
        if (typeof j?.visit !== "string") return null;
        this.token = { token: j.visit, exp: typeof j.exp === "number" ? j.exp : this.env.now() + 3_600_000 };
        this.prev = j.visit;
        this.write(VISIT_KEY, JSON.stringify(this.token));
        this.learn(j.visit);
        return j.visit;
      } finally {
        this.asking = null;
      }
    })();
    return this.asking;
  }

  /** The token was refused (expired, or the server's key changed): renew it next time. */
  private dropToken(): void {
    this.token = null;
    this.write(VISIT_KEY, "null");
  }

  /** The stored state (once per page), adopting what an earlier version left pending. */
  private st(): { visit: string | null; sent: Set<string>; pending: Pend[] } {
    if (this.state) return this.state;
    const parse = (key: string): unknown => {
      try {
        return JSON.parse(this.read(key) ?? "null");
      } catch {
        return null; // corrupt
      }
    };
    const steps = (list: unknown): Pend[] =>
      (Array.isArray(list) ? list : []).filter((x): x is Pend => !!x && typeof x === "object" && typeof (x as Pend).step === "string" && ((x as Pend).v === undefined || typeof (x as Pend).v === "string")).slice(0, MAX_PENDING);
    const raw = parse(STATE_KEY) as { visit?: unknown; sent?: unknown; pending?: unknown } | null;
    if (raw && typeof raw === "object") {
      this.state = {
        visit: typeof raw.visit === "string" ? raw.visit : null,
        sent: new Set(Array.isArray(raw.sent) ? raw.sent.filter((x): x is string => typeof x === "string") : []),
        pending: steps(raw.pending),
      };
    } else {
      // An earlier version's browser-wide lists: their pending steps go to this page's visit (the
      // server ignores a step a visit already has); their sent list belonged to no visit in particular.
      this.state = { visit: null, sent: new Set(), pending: steps(parse(OLD_PENDING_KEY)).map(({ v: _v, ...x }) => x) };
      try {
        this.env.store?.removeItem(OLD_SENT_KEY);
        this.env.store?.removeItem(OLD_PENDING_KEY);
      } catch {
        /* storage unavailable */
      }
    }
    return this.state;
  }

  private save(): void {
    const s = this.st();
    this.write(STATE_KEY, JSON.stringify({ visit: s.visit, sent: [...s.sent], pending: s.pending }));
  }

  /**
   * This page's visit is `token`'s. Another visit than the stored one starts with nothing sent, and
   * steps an old visit left pending are dropped (only that visit's token could carry them; the server
   * renews a visit while it can, so they are weeks old). Steps made before the page knew its visit
   * are this visit's.
   */
  private learn(token: string): void {
    const id = visitIdOf(token);
    if (this.pageVisit === id) return;
    this.pageVisit = id;
    const s = this.st();
    if (s.visit !== id) {
      s.visit = id;
      s.sent = new Set();
    }
    const seen = new Set<string>();
    s.pending = s.pending
      .filter((p) => (!p.v || p.v === id) && !s.sent.has(p.step) && !seen.has(p.step) && (seen.add(p.step), true))
      .map((p) => (p.v ? p : { ...p, v: id }));
    this.save();
  }

  /** Steps waiting for this page's visit (all of them while it isn't known yet). */
  private mine(): Pend[] {
    const v = this.pageVisit;
    return this.st().pending.filter((p) => !v || !p.v || p.v === v);
  }

  /** Has the server acknowledged `step` for this page's visit? */
  has(step: string): boolean {
    if (this.env.enabled) this.currentToken();
    const s = this.st();
    return this.pageVisit !== null && s.visit === this.pageVisit && s.sent.has(step);
  }

  /** Report a first-time step (later calls for the same step are dropped). */
  step(step: string, value?: number, detail?: string): void {
    if (!this.env.enabled) return;
    this.currentToken(); // a live token names this page's visit
    const s = this.st();
    const v = this.pageVisit;
    if ((v && s.visit === v && s.sent.has(step)) || this.mine().some((p) => p.step === step) || s.pending.length >= MAX_PENDING) return;
    s.pending.push({ step, ...(value !== undefined && Number.isFinite(value) ? { value: Math.round(value * 10) / 10 } : {}), ...(detail ? { detail } : {}), ...(v ? { v } : {}) });
    this.save();
    this.schedule(FLUSH_MS);
  }

  private schedule(ms: number): void {
    if (this.timer) return;
    this.timer = true;
    this.env.later(() => {
      this.timer = false;
      void this.flush();
    }, ms);
  }

  /** Send what is pending now (also on pagehide); resolves when the answers are in. */
  flush(): Promise<void> {
    if (!this.env.enabled) return Promise.resolve();
    this.flushing ??= this.deliver().finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }

  private async deliver(): Promise<void> {
    const token = await this.visit();
    if (!token) return this.retry();
    await this.sendErrors(token);
    const id = visitIdOf(token);
    const st = this.st();
    // Only this visit's steps go with its token (learn() tagged the untagged ones).
    const batch = st.pending.filter((p) => p.v === id).slice(0, 16);
    if (!batch.length) return;
    const steps = batch.map(({ v: _v, ...x }) => x);
    const r = await this.env.post(`${this.env.apiUrl}/api/funnel`, JSON.stringify({ visit: token, steps })).catch(() => null);
    if (r?.status === 401) {
      this.dropToken();
      return this.retry();
    }
    const now = this.st();
    if (r?.status === 400) {
      // A body the server can't read won't read better later.
      now.pending = now.pending.filter((p) => !batch.includes(p));
      this.save();
      return;
    }
    if (r?.status !== 200) return this.retry();
    const j = r.json as { done?: unknown; full?: unknown } | null;
    const done = new Set(Array.isArray(j?.done) ? j.done.filter((x): x is string => typeof x === "string") : []);
    // Acknowledged for this visit: sent, if the stored state is still this visit's.
    if (now.visit === id) for (const p of batch) if (done.has(p.step)) now.sent.add(p.step);
    now.pending = now.pending.filter((p) => !(batch.includes(p) && done.has(p.step)));
    this.save();
    this.retries = 0;
    if (j?.full === true) return; // today's budget is spent: the rest waits for a later page
    if (now.pending.some((p) => p.v === id && !batch.includes(p))) this.schedule(0);
  }

  private retry(): void {
    if (this.retries >= MAX_RETRIES || (!this.st().pending.length && !this.errors.length)) return;
    const wait = RETRY_MS * 2 ** this.retries++;
    this.schedule(Math.min(wait, 60_000));
  }

  /** Report an uncaught error or rejection, once per kind per page session (sent once the visit is issued). */
  error(err: unknown): boolean {
    if (!this.env.enabled) return false;
    const raw = describeThrown(err);
    const { message, stack } = scrubReport(raw.message, raw.stack);
    if (!message || IGNORED.some((re) => re.test(message))) return false;
    const kind = `${message.replace(/\d+/g, "#").slice(0, 120)}|${stack.split("\n")[0]?.replace(/:\d+(:\d+)?\)?$/, "") ?? ""}`;
    if (this.errorKinds.has(kind) || this.errorKinds.size >= MAX_ERROR_KINDS) return false;
    this.errorKinds.add(kind);
    this.errors.push({ message, stack, build: this.env.buildId, tier: this.gfx?.tier ?? "", backend: this.gfx?.backend ?? "" });
    void this.flush();
    return true;
  }

  private async sendErrors(token: string): Promise<void> {
    while (this.errors.length) {
      const e = this.errors.shift()!;
      // Best effort: an error report is not retried (the next page reports its own).
      await this.env.post(`${this.env.apiUrl}/api/client-error`, JSON.stringify({ visit: token, ...e })).catch(() => null);
    }
  }
}

/** Noise that isn't ours to fix (extensions, the browser's own resize loop warning). */
const IGNORED: readonly RegExp[] = [/^ResizeObserver loop/i, /^Script error\.?$/i, /extension:\/\//i];

export interface PageFacts {
  search: string;
  webdriver: boolean;
  /** navigator.doNotTrack (or window.doNotTrack). */
  doNotTrack: string | null;
  /** navigator.globalPrivacyControl. */
  gpc: boolean;
  /** The Privacy card's opt-out (localStorage fl.noAnalytics = "1", home/datafast.ts). */
  optOut: boolean;
  hasFetch: boolean;
}

/** Whether the page reports at all, and whether its visit is an automated one. */
export function pageFlags(p: PageFacts): { enabled: boolean; automated: boolean } {
  const params = new URLSearchParams(p.search);
  // Same rule as config.offlineRun(): no server, nothing to send to.
  const offline = params.has("offline") || (params.has("bench") && !params.has("online"));
  const declined = p.doNotTrack === "1" || p.doNotTrack === "yes" || p.gpc || p.optOut;
  return { enabled: p.hasFetch && !offline && !declined, automated: p.webdriver || params.has("e2e") || params.has("bench") };
}

/** The Privacy card's opt-out key (the same one home/datafast.ts reads for DataFast). */
const OPT_OUT_KEY = "fl.noAnalytics";

let current: Beacon | null = null;

/** The page's beacon (made on first use from the real browser). */
export function beacon(): Beacon {
  if (current) return current;
  let store: BeaconEnv["store"] = null;
  try {
    store = typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    /* blocked storage */
  }
  let optOut = false;
  try {
    optOut = store?.getItem(OPT_OUT_KEY) === "1";
  } catch {
    /* unavailable */
  }
  const nav = typeof navigator === "undefined" ? null : (navigator as Navigator & { globalPrivacyControl?: boolean });
  const flags = pageFlags({
    search: typeof location === "undefined" ? "" : location.search,
    webdriver: !!nav?.webdriver,
    doNotTrack: nav?.doNotTrack ?? ((typeof window === "undefined" ? undefined : (window as Window & { doNotTrack?: string }).doNotTrack) ?? null),
    gpc: nav?.globalPrivacyControl === true,
    optOut,
    hasFetch: typeof fetch !== "undefined",
  });
  current = new Beacon({
    apiUrl: (import.meta.env.VITE_API_URL as string | undefined) ?? "http://localhost:2567",
    buildId: (import.meta.env.VITE_BUILD_ID as string | undefined) ?? "dev",
    store,
    ...flags,
    post: async (url, body) => {
      const r = await fetch(url, { method: "POST", body, keepalive: true, credentials: "omit", headers: { "content-type": "text/plain;charset=UTF-8" } }).catch(() => null);
      if (!r) return null;
      const json: unknown = await r.json().catch(() => null);
      return { status: r.status, json };
    },
    now: () => Date.now(),
    later: (fn, ms) => void setTimeout(fn, ms),
  });
  return current;
}

/** Shorthand: report a first-time funnel step. */
export function funnelStep(step: string, value?: number, detail?: string): void {
  beacon().step(step, value, detail);
}

let installed = false;

/** Start the visit, report uncaught errors and unhandled rejections, and flush the funnel as the page goes. */
export function installErrorReporting(w: Window = window): void {
  if (installed) return;
  installed = true;
  beacon().start();
  w.addEventListener("error", (e) => void beacon().error(e.error ?? e.message));
  w.addEventListener("unhandledrejection", (e) => void beacon().error(e.reason));
  w.addEventListener("pagehide", () => void beacon().flush());
}

let playAt: number | null = null;

/** Play was pressed (main.ts): the funnel's `play` step, and the clock for `world`. */
export function markPlay(now = performance.now()): void {
  playAt ??= now;
  funnelStep("play");
}

/** The world is on screen for the first time (Game.handOver): seconds since Play, and the renderer picked. */
export function markWorld(backend: string, tier: string, now = performance.now()): void {
  const b = beacon();
  b.gfx = { backend, tier };
  b.step("world", playAt === null ? undefined : (now - playAt) / 1000, `${backend}/${tier}`);
}
