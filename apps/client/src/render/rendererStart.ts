// Starting the renderer's backend with a deadline. WebGPURenderer.init() awaits
// navigator.gpu.requestAdapter() and adapter.requestDevice(), and either can stay pending forever
// (a busy GPU process, a driver hiccup, two tabs or browsers starting at the same moment). Without
// a deadline the loading screen sat on "Starting the renderer" for good. Now WebGPU gets
// WEBGPU_INIT_TIMEOUT_MS; past that, or when init() rejects, a fresh WebGL2 renderer starts instead.
//
// The failure is remembered on this device (D-renderer-1): a small localStorage record (reason, time,
// browser major version, GPU name) makes later visits go straight to WebGL2 for WEBGPU_RETRY_MS, as
// long as the browser version and GPU still match. `?webgpu` tries anyway and clears the record; a
// WebGPU start that works clears it too. No network, no identifiers.
//
// A second chance (D-renderer-2): an abandoned start that answers after all notes how late it was
// (`lateMs`, in the record and the session's status). After the hand-over, a WebGL2 session asks for a
// WebGPU adapter and device once more, at an idle moment and without rendering; if they answer within
// the start deadline, the next visit tries WebGPU again (`second: "granted"`). A record written when
// that try fails too (`second: "used"`) gets no further second chance, so a device whose WebGPU only
// hangs at page load pays one extra 20 s wait per record, not one per visit.
//
// The deadline is 20 s (D-showcase-1, was 8 s): WebGPU wins more often on a slow start, and the
// loader says in plain words that WebGPU is still starting (`onStage`) while it waits.
//
// Pure apart from the memory's defaults (localStorage, navigator.userAgent, one WebGL2 probe context
// for the GPU name), so the seam is unit-tested with fakes.

/**
 * Adapter + device + the renderer's own setup, all inside init(). Shader warm-up runs later
 * (warmup.ts), so this only has to cover a cold GPU process. 20 s (D-showcase-1, the owner: "let's
 * stay open"): a slow start still gets WebGPU (High's GTAO and TRAA), at up to 12 s more wait than
 * the old 8 s when WebGPU doesn't come; the device record (D-renderer-1) keeps that to one wait.
 */
export const WEBGPU_INIT_TIMEOUT_MS = 20_000;

/** A WebGPU start still pending this long gets a plain-words line on the loader (`onStage`). */
export const WEBGPU_SLOW_NOTICE_MS = 4000;

/** localStorage key of the device's WebGPU failure record (WebgpuFailureRecord as JSON). */
export const WEBGPU_FAILED_KEY = "fl.gfx.webgpu-failed";

/** How long a failure record makes visits skip WebGPU before it is tried again (~a week). */
export const WEBGPU_RETRY_MS = 7 * 24 * 60 * 60 * 1000;

/** What `WebGPURenderer` offers that the start path needs. */
export interface Startable {
  init(): Promise<unknown>;
  dispose(): void | Promise<void>;
}

/** Why the renderer is on WebGL2 although the URL didn't ask for it; null: it was not a fallback. */
export type FallbackReason = "timeout" | "error" | "remembered";

/**
 * Cues for the loading screen: "webgpu-slow" once WebGPU has been starting for WEBGPU_SLOW_NOTICE_MS
 * (it is still within its deadline: not an error), "webgl2-fallback" when WebGL2 takes over from a
 * WebGPU try that timed out or failed.
 */
export type StartStage = "webgpu-slow" | "webgl2-fallback";

export interface StartedRenderer<R> {
  renderer: R;
  fallback: FallbackReason | null;
  /** Live: a late WebGPU answer and the second chance update it after the start resolved. */
  status: BackendStatus;
}

/** The memory of a WebGPU that didn't start. */
export interface BackendMemory {
  /** True: WebGPU didn't start here recently, go straight to WebGL2. */
  webgpuSkipped(): boolean;
  /** `lateMs`: the abandoned start already answered, this long after it began. */
  rememberWebgpuSkipped(reason: "timeout" | "error", lateMs?: number): void;
  /** WebGPU started (or `?webgpu` asked for it): forget any failure. */
  forgetWebgpuSkipped(): void;
  /** The abandoned start answered after all, `ms` after it began: noted in the record, if there is one. */
  noteLateStart(ms: number): void;
  /**
   * The second chance answered in time: the next visit tries WebGPU. False (nothing changes) when
   * there is no record, or it was written by a second try that failed.
   */
  grantSecondChance(): boolean;
}

/** What the session knows about its renderer start, filled in as it learns more (D-renderer-2). */
export interface BackendStatus {
  /** Why the session is on WebGL2 although the URL didn't ask for it; null: WebGPU, or `?webgl`. */
  fallback: FallbackReason | null;
  /** The abandoned WebGPU start answered after the deadline, this many ms after it began; null: not (yet). */
  lateMs: number | null;
  /** The background re-check after the hand-over (webgpuSecondChance); null: not run. */
  secondChance: SecondChanceOutcome | "pending" | null;
}

/** The record kept on the device: the only things stored, never sent anywhere. */
export interface WebgpuFailureRecord {
  v: 1;
  reason: "timeout" | "error";
  /** Date.now() when WebGPU failed. */
  at: number;
  /** browserMajor(): e.g. "Chrome/141". */
  browser: string;
  /** The WebGL2 renderer string (webglGpuName()); "" when unknown. */
  gpu: string;
  /** The abandoned start answered after all, this many ms after it began (D-renderer-2). */
  lateMs?: number;
  /** "granted": a later check answered, the next visit tries WebGPU; "used": that try failed too. */
  second?: "granted" | "used";
}

export type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export interface DeviceMemoryEnv {
  /** Default: localStorage; null or a throwing storage means no memory. */
  storage?: StorageLike | null;
  now?: () => number;
  browser?: () => string;
  /** The GPU name; called only when there is a record to check or one to write. */
  gpu?: () => string;
}

/** The browser and its major version from a user agent ("Chrome/141"); "" when unknown. */
export function browserMajor(ua: string): string {
  const rules: [RegExp, string][] = [
    [/\bEdg(?:e|A|iOS)?\/(\d+)/, "Edg"],
    [/\bOPR\/(\d+)/, "OPR"],
    [/\bFirefox\/(\d+)/, "Firefox"],
    [/\b(?:Headless)?Chrome\/(\d+)/, "Chrome"],
    [/\bCriOS\/(\d+)/, "Chrome"],
    [/\bVersion\/(\d+).*\bSafari\//, "Safari"],
  ];
  for (const [re, name] of rules) {
    const m = re.exec(ua);
    if (m) return `${name}/${m[1]}`;
  }
  return "";
}

let probedGpu: string | null = null;

/**
 * The GPU name without WebGPU: the unmasked WebGL2 renderer string from a throwaway context
 * (the same string renderer.ts reports for a WebGL2 backend), probed once per page load.
 */
export function webglGpuName(): string {
  if (probedGpu !== null) return probedGpu;
  probedGpu = "";
  try {
    if (typeof document === "undefined") return probedGpu;
    const gl = document.createElement("canvas").getContext("webgl2", { powerPreference: "high-performance" });
    if (gl) {
      const ext = gl.getExtension("WEBGL_debug_renderer_info");
      probedGpu = String(gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER) ?? "");
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    }
  } catch {
    probedGpu = "";
  }
  return probedGpu;
}

function isRecord(x: unknown): x is WebgpuFailureRecord {
  const r = x as Partial<WebgpuFailureRecord> | null;
  return !!r && typeof r === "object" && r.v === 1 && (r.reason === "timeout" || r.reason === "error") &&
    typeof r.at === "number" && Number.isFinite(r.at) && typeof r.browser === "string" && typeof r.gpu === "string" &&
    (r.lateMs === undefined || (typeof r.lateMs === "number" && Number.isFinite(r.lateMs))) &&
    (r.second === undefined || r.second === "granted" || r.second === "used");
}

/**
 * Device-level memory (localStorage). WebGPU is skipped while the record is under WEBGPU_RETRY_MS
 * old and the browser major version and GPU name still match. Storage that is missing, disabled or
 * full just means no memory.
 */
export function deviceBackendMemory(env: DeviceMemoryEnv = {}): BackendMemory {
  const storage = (): StorageLike | null => {
    if (env.storage !== undefined) return env.storage;
    try {
      return typeof localStorage === "undefined" ? null : localStorage;
    } catch {
      return null; // blocked site data: touching localStorage throws
    }
  };
  const now = env.now ?? (() => Date.now());
  const browser = env.browser ?? (() => (typeof navigator === "undefined" ? "" : browserMajor(navigator.userAgent)));
  const gpu = env.gpu ?? webglGpuName;
  /** The stored record, if it is one (any age, any browser); null when missing or unreadable. */
  const read = (): WebgpuFailureRecord | null => {
    try {
      const raw = storage()?.getItem(WEBGPU_FAILED_KEY);
      if (!raw) return null;
      const r: unknown = JSON.parse(raw);
      return isRecord(r) ? r : null;
    } catch {
      return null;
    }
  };
  /** The record applies to this visit: under WEBGPU_RETRY_MS old, same browser version and GPU. */
  const current = (r: WebgpuFailureRecord) => {
    const age = now() - r.at;
    return age >= 0 && age < WEBGPU_RETRY_MS && r.browser === browser() && r.gpu === gpu();
  };
  const write = (r: WebgpuFailureRecord) => {
    try {
      storage()?.setItem(WEBGPU_FAILED_KEY, JSON.stringify(r));
    } catch {
      /* private mode or full: the next visit waits again */
    }
  };
  return {
    webgpuSkipped() {
      try {
        const r = read();
        return !!r && r.second !== "granted" && current(r);
      } catch {
        return false;
      }
    },
    rememberWebgpuSkipped(reason, lateMs) {
      try {
        if (!storage()) return;
        // A failure on the try a second chance granted here (the grant still applies: same browser
        // version and GPU, not expired): this record gets no second chance of its own.
        const prev = read();
        const retried = !!prev && prev.second === "granted" && current(prev);
        const r: WebgpuFailureRecord = { v: 1, reason, at: now(), browser: browser(), gpu: gpu() };
        if (lateMs !== undefined) r.lateMs = lateMs;
        if (retried) r.second = "used";
        write(r);
      } catch {
        /* the next visit waits again */
      }
    },
    forgetWebgpuSkipped() {
      try {
        storage()?.removeItem(WEBGPU_FAILED_KEY);
      } catch {
        /* nothing to forget */
      }
    },
    noteLateStart(ms) {
      const r = read();
      if (r) write({ ...r, lateMs: ms });
    },
    grantSecondChance() {
      const r = read();
      if (!r || r.second === "used") return false;
      if (r.second !== "granted") write({ ...r, second: "granted" });
      return true;
    },
  };
}

export type InitOutcome = { status: "ready" } | { status: "timeout" } | { status: "error"; error: unknown };

export interface InitWithinOptions {
  /** An abandoned init settled after all (`ready` or `error`), `ms` after it began; called before its dispose. */
  onLate?: (outcome: InitOutcome, ms: number) => void;
  /** Clock for `onLate`'s ms (default performance.now). */
  now?: () => number;
}

/**
 * Wait up to `ms` for `r.init()`. On a timeout the renderer is abandoned: three's dispose() does
 * nothing for the backend until init has finished (it only then destroys the GPU device), and a
 * pending init still creates its device and starts an animation loop when the adapter finally
 * answers. So the dispose is queued behind init: a late success is torn down at once, a late
 * failure has nothing to release.
 */
export function initWithin(r: Startable, ms: number, opts: InitWithinOptions = {}): Promise<InitOutcome> {
  const now = opts.now ?? (() => performance.now());
  const t0 = now();
  return new Promise((resolve) => {
    const init = (async () => r.init())();
    let abandoned = false;
    const late = (outcome: InitOutcome) => {
      try {
        opts.onLate?.(outcome, now() - t0);
      } catch (e) {
        console.warn("[gfx] noting the late WebGPU answer failed", e);
      }
    };
    const timer = setTimeout(() => {
      abandoned = true;
      resolve({ status: "timeout" });
      void init.then(
        () => {
          late({ status: "ready" });
          return r.dispose();
        },
        (error: unknown) => late({ status: "error", error }),
      ).catch((e: unknown) => console.warn("[gfx] disposing the abandoned WebGPU renderer failed", e));
    }, ms);
    init.then(
      () => {
        clearTimeout(timer);
        if (!abandoned) resolve({ status: "ready" });
      },
      (error: unknown) => {
        clearTimeout(timer);
        if (!abandoned) resolve({ status: "error", error });
      },
    );
  });
}

export interface StartOptions<R extends Startable> {
  /** A new, un-initialised renderer (a fresh canvas each time; never reuse one that failed). */
  create(forceWebGL: boolean): R;
  /** `?webgl`: WebGL2 was asked for, so there is nothing to fall back from and no deadline. */
  forceWebGL: boolean;
  /** `?webgpu`: try WebGPU even if it failed here before, and forget that failure. */
  forceWebGPU?: boolean;
  /**
   * Whether an initialised renderer really runs on WebGPU. three r186 catches a failed WebGPU init
   * itself, switches to its WebGL2 backend and resolves init(), so "ready" alone isn't a success.
   * Default: yes.
   */
  isWebGPU?: (renderer: R) => boolean;
  timeoutMs?: number;
  memory?: BackendMemory;
  /** One info line per decision (console.info by default). */
  log?: (message: string) => void;
  /** Clock for how late an abandoned start answered (default performance.now). */
  now?: () => number;
  /** The loader's cues (StartStage); a throwing callback is ignored. */
  onStage?: (stage: StartStage) => void;
  /** When "webgpu-slow" comes (default WEBGPU_SLOW_NOTICE_MS); never at or past the deadline. */
  slowNoticeMs?: number;
}

const reason = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Create and init the renderer: WebGPU with a deadline, WebGL2 when WebGPU doesn't come up. */
export async function startRenderer<R extends Startable>(opts: StartOptions<R>): Promise<StartedRenderer<R>> {
  const timeoutMs = opts.timeoutMs ?? WEBGPU_INIT_TIMEOUT_MS;
  const memory = opts.memory ?? deviceBackendMemory();
  const log = opts.log ?? ((m: string) => console.info(m));
  const status: BackendStatus = { fallback: null, lateMs: null, secondChance: null };
  const stage = (s: StartStage) => {
    try {
      opts.onStage?.(s);
    } catch (e) {
      console.warn("[gfx] the loader's start cue failed", e);
    }
  };

  if (opts.forceWebGL) {
    const renderer = opts.create(true);
    await renderer.init();
    return { renderer, fallback: null, status };
  }

  if (opts.forceWebGPU) {
    memory.forgetWebgpuSkipped();
    log("[gfx] ?webgpu: trying WebGPU; any remembered failure on this device is forgotten");
  }
  let fallback: FallbackReason;
  /** The failure record of this visit is written: a late answer updates it instead. */
  let recorded = false;
  if (!opts.forceWebGPU && memory.webgpuSkipped()) {
    fallback = "remembered";
    log("[gfx] WebGPU skipped: it did not start on this device recently; using WebGL2 (?webgpu tries again)");
  } else {
    const renderer = opts.create(false);
    const slowMs = opts.slowNoticeMs ?? WEBGPU_SLOW_NOTICE_MS;
    const slow = opts.onStage && slowMs < timeoutMs ? setTimeout(() => stage("webgpu-slow"), slowMs) : null;
    const outcome = await initWithin(renderer, timeoutMs, {
      now: opts.now,
      // A late answer on WebGPU itself (not three's own WebGL2 fallback) is worth knowing: how late it was.
      onLate: (late, ms) => {
        if (late.status !== "ready" || !(opts.isWebGPU?.(renderer) ?? true)) return;
        status.lateMs = Math.round(ms);
        log(`[gfx] the abandoned WebGPU start answered ${(ms / 1000).toFixed(1)} s after it began (deadline ${timeoutMs / 1000} s); noted on this device`);
        if (recorded) memory.noteLateStart(status.lateMs);
      },
    });
    if (slow !== null) clearTimeout(slow);
    if (outcome.status === "ready") {
      if (opts.isWebGPU?.(renderer) ?? true) {
        memory.forgetWebgpuSkipped();
        return { renderer, fallback: null, status };
      }
      // three's own fallback: WebGPU failed inside init(), which carried on with WebGL2.
      log("[gfx] WebGPU failed to start (three fell back to WebGL2 inside init()); using WebGL2 on this device for a while");
      memory.rememberWebgpuSkipped("error");
      status.fallback = "error";
      return { renderer, fallback: "error", status };
    }
    if (outcome.status === "timeout") {
      fallback = "timeout";
      log(`[gfx] WebGPU did not start within ${timeoutMs / 1000} s; using WebGL2 on this device for a while`);
    } else {
      fallback = "error";
      log(`[gfx] WebGPU failed to start (${reason(outcome.error)}); using WebGL2 on this device for a while`);
      // init() rejected, so it holds nothing: three has already given up on it.
    }
    stage("webgl2-fallback");
  }

  const renderer = opts.create(true);
  await renderer.init();
  if (fallback !== "remembered") {
    memory.rememberWebgpuSkipped(fallback, status.lateMs ?? undefined);
    recorded = true;
  }
  status.fallback = fallback;
  return { renderer, fallback, status };
}

// ------------------------------------------------------------------------------ the second chance

/** How the background re-check went: "cleared" lets the next visit try WebGPU; "spent": it answered,
 *  but this record already had its second chance; the rest keep the record. */
export type SecondChanceOutcome = "cleared" | "spent" | "timeout" | "error" | "unavailable";

/** The part of navigator.gpu the re-check uses. */
export interface GpuLike {
  requestAdapter(options?: { powerPreference?: "high-performance" | "low-power" }): Promise<GpuAdapterLike | null>;
}
export interface GpuAdapterLike {
  requestDevice(): Promise<{ destroy(): void }>;
}

/** After the hand-over the re-check waits this long, then for an idle moment (requestIdleCallback). */
export const SECOND_CHANCE_DELAY_MS = 5000;
const SECOND_CHANCE_IDLE_TIMEOUT_MS = 10_000;

export interface SecondChanceOptions {
  memory?: BackendMemory;
  /** Default navigator.gpu; null: no WebGPU in this browser. */
  gpu?: GpuLike | null;
  /** "In time": the start deadline (default WEBGPU_INIT_TIMEOUT_MS), so the next visit's start can make it. */
  timeoutMs?: number;
  /** Runs the check at a quiet moment (default: SECOND_CHANCE_DELAY_MS, then requestIdleCallback). */
  schedule?: (run: () => void) => void;
  log?: (message: string) => void;
}

function whenIdle(run: () => void) {
  setTimeout(() => {
    const ric = (globalThis as { requestIdleCallback?: (cb: () => void, o: { timeout: number }) => number }).requestIdleCallback;
    if (ric) ric(run, { timeout: SECOND_CHANCE_IDLE_TIMEOUT_MS });
    else run();
  }, SECOND_CHANCE_DELAY_MS);
}

function navigatorGpu(): GpuLike | null {
  return (typeof navigator === "undefined" ? null : (navigator as { gpu?: GpuLike }).gpu) ?? null;
}

/**
 * WebGPU's second chance (D-renderer-2), once per session, for a session on WebGL2 because WebGPU
 * didn't start (now or recently): at an idle moment after the hand-over, ask for an adapter and a
 * device (nothing is rendered; the device is destroyed at once). If both answer within the start
 * deadline, the next visit tries WebGPU again. Resolves with the outcome, or null when not run
 * (WebGPU or `?webgl` session, or already run). Never rejects.
 */
export function webgpuSecondChance(status: BackendStatus, opts: SecondChanceOptions = {}): Promise<SecondChanceOutcome | null> {
  if (!status.fallback || status.secondChance !== null) return Promise.resolve(null);
  status.secondChance = "pending";
  const memory = opts.memory ?? deviceBackendMemory();
  const timeoutMs = opts.timeoutMs ?? WEBGPU_INIT_TIMEOUT_MS;
  const log = opts.log ?? ((m: string) => console.info(m));
  const schedule = opts.schedule ?? whenIdle;
  return new Promise<SecondChanceOutcome>((resolve) => {
    schedule(() => {
      const gpu = opts.gpu !== undefined ? opts.gpu : navigatorGpu();
      let settled = false;
      const finish = (outcome: SecondChanceOutcome, line: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        status.secondChance = outcome;
        log(line);
        resolve(outcome);
      };
      const timer = setTimeout(() => finish("timeout", `[gfx] second chance: WebGPU did not answer within ${timeoutMs / 1000} s; WebGL2 stays on this device for now`), timeoutMs);
      if (!gpu) return finish("unavailable", "[gfx] second chance: no WebGPU in this browser; WebGL2 stays");
      const t0 = Date.now();
      void (async () => {
        const adapter = await gpu.requestAdapter({ powerPreference: "high-performance" });
        if (settled) return; // past the deadline: no device request, no GPU work for a check that failed
        if (!adapter) return finish("unavailable", "[gfx] second chance: no WebGPU adapter; WebGL2 stays on this device for now");
        const device = await adapter.requestDevice();
        // Only asked to see that it answers: release it at once (also when a request made in time
        // answers too late).
        try {
          device.destroy();
        } catch {
          /* already gone */
        }
        if (settled) return;
        const s = ((Date.now() - t0) / 1000).toFixed(1);
        if (memory.grantSecondChance()) finish("cleared", `[gfx] second chance: WebGPU answered in ${s} s; the next visit tries it again`);
        else finish("spent", `[gfx] second chance: WebGPU answered in ${s} s, but it already failed on its second try here; WebGL2 stays until the record expires`);
      })().catch((e: unknown) => finish("error", `[gfx] second chance: WebGPU failed (${reason(e)}); WebGL2 stays on this device for now`));
    });
  });
}
