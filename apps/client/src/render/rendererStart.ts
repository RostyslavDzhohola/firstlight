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
// Pure apart from the memory's defaults (localStorage, navigator.userAgent, one WebGL2 probe context
// for the GPU name), so the seam is unit-tested with fakes.

/**
 * Adapter + device + the renderer's own setup, all inside init(). Shader warm-up runs later
 * (warmup.ts), so this only has to cover a cold GPU process: seconds on a slow machine, not tens.
 */
export const WEBGPU_INIT_TIMEOUT_MS = 8000;

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

export interface StartedRenderer<R> {
  renderer: R;
  fallback: FallbackReason | null;
}

/** The memory of a WebGPU that didn't start. */
export interface BackendMemory {
  /** True: WebGPU didn't start here recently, go straight to WebGL2. */
  webgpuSkipped(): boolean;
  rememberWebgpuSkipped(reason: "timeout" | "error"): void;
  /** WebGPU started (or `?webgpu` asked for it): forget any failure. */
  forgetWebgpuSkipped(): void;
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
    typeof r.at === "number" && Number.isFinite(r.at) && typeof r.browser === "string" && typeof r.gpu === "string";
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
  return {
    webgpuSkipped() {
      try {
        const raw = storage()?.getItem(WEBGPU_FAILED_KEY);
        if (!raw) return false;
        const r: unknown = JSON.parse(raw);
        if (!isRecord(r)) return false;
        const age = now() - r.at;
        return age >= 0 && age < WEBGPU_RETRY_MS && r.browser === browser() && r.gpu === gpu();
      } catch {
        return false;
      }
    },
    rememberWebgpuSkipped(reason) {
      try {
        const s = storage();
        if (!s) return;
        const r: WebgpuFailureRecord = { v: 1, reason, at: now(), browser: browser(), gpu: gpu() };
        s.setItem(WEBGPU_FAILED_KEY, JSON.stringify(r));
      } catch {
        /* private mode or full: the next visit waits again */
      }
    },
    forgetWebgpuSkipped() {
      try {
        storage()?.removeItem(WEBGPU_FAILED_KEY);
      } catch {
        /* nothing to forget */
      }
    },
  };
}

export type InitOutcome = { status: "ready" } | { status: "timeout" } | { status: "error"; error: unknown };

/**
 * Wait up to `ms` for `r.init()`. On a timeout the renderer is abandoned: three's dispose() does
 * nothing for the backend until init has finished (it only then destroys the GPU device), and a
 * pending init still creates its device and starts an animation loop when the adapter finally
 * answers. So the dispose is queued behind init: a late success is torn down at once, a late
 * failure has nothing to release.
 */
export function initWithin(r: Startable, ms: number): Promise<InitOutcome> {
  return new Promise((resolve) => {
    const init = (async () => r.init())();
    let abandoned = false;
    const timer = setTimeout(() => {
      abandoned = true;
      resolve({ status: "timeout" });
      void init.then(
        () => r.dispose(),
        () => undefined,
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
  timeoutMs?: number;
  memory?: BackendMemory;
  /** One info line per decision (console.info by default). */
  log?: (message: string) => void;
}

const reason = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Create and init the renderer: WebGPU with a deadline, WebGL2 when WebGPU doesn't come up. */
export async function startRenderer<R extends Startable>(opts: StartOptions<R>): Promise<StartedRenderer<R>> {
  const timeoutMs = opts.timeoutMs ?? WEBGPU_INIT_TIMEOUT_MS;
  const memory = opts.memory ?? deviceBackendMemory();
  const log = opts.log ?? ((m: string) => console.info(m));

  if (opts.forceWebGL) {
    const renderer = opts.create(true);
    await renderer.init();
    return { renderer, fallback: null };
  }

  if (opts.forceWebGPU) {
    memory.forgetWebgpuSkipped();
    log("[gfx] ?webgpu: trying WebGPU; any remembered failure on this device is forgotten");
  }
  let fallback: FallbackReason;
  if (!opts.forceWebGPU && memory.webgpuSkipped()) {
    fallback = "remembered";
    log("[gfx] WebGPU skipped: it did not start on this device recently; using WebGL2 (?webgpu tries again)");
  } else {
    const renderer = opts.create(false);
    const outcome = await initWithin(renderer, timeoutMs);
    if (outcome.status === "ready") {
      memory.forgetWebgpuSkipped();
      return { renderer, fallback: null };
    }
    if (outcome.status === "timeout") {
      fallback = "timeout";
      log(`[gfx] WebGPU did not start within ${timeoutMs / 1000} s; using WebGL2 on this device for a while`);
    } else {
      fallback = "error";
      log(`[gfx] WebGPU failed to start (${reason(outcome.error)}); using WebGL2 on this device for a while`);
      // init() rejected, so it holds nothing: three has already given up on it.
    }
  }

  const renderer = opts.create(true);
  await renderer.init();
  if (fallback !== "remembered") memory.rememberWebgpuSkipped(fallback);
  return { renderer, fallback };
}
