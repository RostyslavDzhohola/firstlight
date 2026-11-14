// What only the page knows, sent to our own server (#85): the funnel's first-time steps of this
// browser (opened the page, pressed Play, the world on screen and how long it took, each tutorial
// step, a renderer fallback, a failure screen) and uncaught errors. No third-party service, nothing
// personal: a random visit id kept in localStorage, step names and a few numbers. Each step is sent
// once per browser (the server keeps the first anyway); each kind of error once per page session.
// Bodies are text/plain JSON, a CORS "simple" request, so no preflight and they survive the page
// closing (fetch keepalive). Runs without a server (`?offline`, `?bench`) send nothing.
// Pure apart from the `Env` it is given (unit-tested with fakes).

export interface BeaconEnv {
  apiUrl: string;
  buildId: string;
  store: Pick<Storage, "getItem" | "setItem"> | null;
  /** fetch(url, init); the default posts with keepalive. */
  send(url: string, body: string): void;
  /** Off: nothing is recorded or sent. */
  enabled: boolean;
  now(): number;
  random(): string;
  /** Debounce a flush (the default: setTimeout). */
  later(fn: () => void, ms: number): void;
}

const VISIT_KEY = "fl.visit";
const SENT_KEY = "fl.funnel.v1";
/** Kinds of errors one page session reports at most. */
export const MAX_ERROR_KINDS = 8;
const FLUSH_MS = 1500;

export interface Step {
  step: string;
  value?: number;
  detail?: string;
}

export class Beacon {
  private queue: Step[] = [];
  private sent: Set<string> | null = null;
  private flushing = false;
  private readonly errorKinds = new Set<string>();
  /** The renderer and tier once the game knows them (error reports carry them). */
  gfx: { backend: string; tier: string } | null = null;

  constructor(private readonly env: BeaconEnv) {}

  /** This browser's visit id (made on first use). */
  visit(): string {
    let v: string | null = null;
    try {
      v = this.env.store?.getItem(VISIT_KEY) ?? null;
    } catch {
      /* private mode */
    }
    if (v && /^[A-Za-z0-9_-]{8,40}$/.test(v)) return v;
    v = this.env.random();
    try {
      this.env.store?.setItem(VISIT_KEY, v);
    } catch {
      /* unavailable storage: a new visit each page */
    }
    return v;
  }

  private sentSet(): Set<string> {
    if (this.sent) return this.sent;
    let list: unknown = [];
    try {
      list = JSON.parse(this.env.store?.getItem(SENT_KEY) ?? "[]");
    } catch {
      /* corrupt or unavailable */
    }
    this.sent = new Set(Array.isArray(list) ? list.filter((x): x is string => typeof x === "string") : []);
    return this.sent;
  }

  /** Has this browser already reported `step`? */
  has(step: string): boolean {
    return this.sentSet().has(step);
  }

  /** Report a first-time step (later calls for the same step are dropped). */
  step(step: string, value?: number, detail?: string): void {
    if (!this.env.enabled) return;
    const sent = this.sentSet();
    if (sent.has(step) || this.queue.some((s) => s.step === step)) return;
    this.queue.push({ step, ...(value !== undefined && Number.isFinite(value) ? { value: Math.round(value * 10) / 10 } : {}), ...(detail ? { detail } : {}) });
    if (!this.flushing) {
      this.flushing = true;
      this.env.later(() => this.flush(), FLUSH_MS);
    }
  }

  /** Send what is queued now (also on pagehide). */
  flush(): void {
    this.flushing = false;
    if (!this.queue.length) return;
    const steps = this.queue.splice(0, 16);
    const sent = this.sentSet();
    for (const s of steps) sent.add(s.step);
    try {
      this.env.store?.setItem(SENT_KEY, JSON.stringify([...sent]));
    } catch {
      /* the server dedupes too */
    }
    try {
      this.env.send(`${this.env.apiUrl}/api/funnel`, JSON.stringify({ visit: this.visit(), steps }));
    } catch {
      /* analytics never break the game */
    }
    if (this.queue.length) this.flush();
  }

  /** Report an uncaught error or rejection, once per kind per page session. */
  error(err: unknown): boolean {
    if (!this.env.enabled) return false;
    const { message, stack } = describe(err);
    if (!message || IGNORED.some((re) => re.test(message))) return false;
    const kind = `${message.replace(/\d+/g, "#").slice(0, 120)}|${firstFrame(stack, message)}`;
    if (this.errorKinds.has(kind) || this.errorKinds.size >= MAX_ERROR_KINDS) return false;
    this.errorKinds.add(kind);
    const body = JSON.stringify({
      visit: this.visit(),
      message: message.slice(0, 300),
      stack: stack.slice(0, 600),
      build: this.env.buildId,
      tier: this.gfx?.tier ?? "",
      backend: this.gfx?.backend ?? "",
    });
    try {
      this.env.send(`${this.env.apiUrl}/api/client-error`, body);
    } catch {
      /* never throw from the error path */
    }
    return true;
  }
}

/** Noise that isn't ours to fix (extensions, the browser's own resize loop warning). */
const IGNORED: readonly RegExp[] = [/^ResizeObserver loop/i, /^Script error\.?$/i, /extension:\/\//i];

function describe(err: unknown): { message: string; stack: string } {
  if (err instanceof Error) return { message: `${err.name}: ${err.message}`, stack: err.stack ?? "" };
  if (typeof err === "string") return { message: err, stack: "" };
  try {
    return { message: JSON.stringify(err)?.slice(0, 300) ?? String(err), stack: "" };
  } catch {
    return { message: String(err), stack: "" };
  }
}

function firstFrame(stack: string, message: string): string {
  const line = stack.split("\n").map((l) => l.trim()).find((l) => l && !message.includes(l)) ?? "";
  return line.replace(/:\d+(:\d+)?\)?$/, "").replace(/\?[^\s)]*/g, "");
}

function randomId(): string {
  const b = new Uint8Array(12);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(36).padStart(2, "0")).join("").slice(0, 20);
}

let current: Beacon | null = null;

/** The page's beacon (made on first use from the real browser). */
export function beacon(): Beacon {
  if (current) return current;
  const params = new URLSearchParams(typeof location === "undefined" ? "" : location.search);
  // Same rule as config.offlineRun(): no server, nothing to send to.
  const offline = params.has("offline") || (params.has("bench") && !params.has("online"));
  let store: BeaconEnv["store"] = null;
  try {
    store = typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    /* blocked storage */
  }
  current = new Beacon({
    apiUrl: (import.meta.env.VITE_API_URL as string | undefined) ?? "http://localhost:2567",
    buildId: (import.meta.env.VITE_BUILD_ID as string | undefined) ?? "dev",
    store,
    enabled: !offline && typeof fetch !== "undefined",
    send: (url, body) => void fetch(url, { method: "POST", body, keepalive: true, credentials: "omit", headers: { "content-type": "text/plain;charset=UTF-8" } }).catch(() => {}),
    now: () => Date.now(),
    random: randomId,
    later: (fn, ms) => void setTimeout(fn, ms),
  });
  return current;
}

/** Shorthand: report a first-time funnel step. */
export function funnelStep(step: string, value?: number, detail?: string): void {
  beacon().step(step, value, detail);
}

let installed = false;

/** Report uncaught errors and unhandled rejections, and flush the funnel as the page goes. */
export function installErrorReporting(w: Window = window): void {
  if (installed) return;
  installed = true;
  w.addEventListener("error", (e) => void beacon().error(e.error ?? e.message));
  w.addEventListener("unhandledrejection", (e) => void beacon().error(e.reason));
  w.addEventListener("pagehide", () => beacon().flush());
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
