// Starting the renderer's backend with a deadline. WebGPURenderer.init() awaits
// navigator.gpu.requestAdapter() and adapter.requestDevice(), and either can stay pending forever
// (a busy GPU process, a driver hiccup, two tabs or browsers starting at the same moment). Without
// a deadline the loading screen sat on "Starting the renderer" for good. Now WebGPU gets
// WEBGPU_INIT_TIMEOUT_MS; past that, or when init() rejects, a fresh WebGL2 renderer starts instead
// and the choice is remembered for the tab's session, so a reload doesn't wait again.
//
// Pure: no three, no DOM beyond an optional sessionStorage, so the seam is unit-tested with fakes.

/**
 * Adapter + device + the renderer's own setup, all inside init(). Shader warm-up runs later
 * (warmup.ts), so this only has to cover a cold GPU process: seconds on a slow machine, not tens.
 */
export const WEBGPU_INIT_TIMEOUT_MS = 8000;

/** sessionStorage key: WebGPU didn't start in this tab, go straight to WebGL2. */
export const WEBGPU_SKIPPED_KEY = "fl.gfx.webgpu-skipped";

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

/** The session's memory of a WebGPU that didn't start. */
export interface BackendMemory {
  webgpuSkipped(): boolean;
  rememberWebgpuSkipped(): void;
}

/** sessionStorage-backed memory; storage that is disabled or full just means no memory. */
export function sessionBackendMemory(): BackendMemory {
  return {
    webgpuSkipped() {
      try {
        return sessionStorage.getItem(WEBGPU_SKIPPED_KEY) === "1";
      } catch {
        return false;
      }
    },
    rememberWebgpuSkipped() {
      try {
        sessionStorage.setItem(WEBGPU_SKIPPED_KEY, "1");
      } catch {
        /* private mode: the next load waits again */
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
  timeoutMs?: number;
  memory?: BackendMemory;
  /** One info line per decision (console.info by default). */
  log?: (message: string) => void;
}

const reason = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Create and init the renderer: WebGPU with a deadline, WebGL2 when WebGPU doesn't come up. */
export async function startRenderer<R extends Startable>(opts: StartOptions<R>): Promise<StartedRenderer<R>> {
  const timeoutMs = opts.timeoutMs ?? WEBGPU_INIT_TIMEOUT_MS;
  const memory = opts.memory ?? sessionBackendMemory();
  const log = opts.log ?? ((m: string) => console.info(m));

  if (opts.forceWebGL) {
    const renderer = opts.create(true);
    await renderer.init();
    return { renderer, fallback: null };
  }

  let fallback: FallbackReason;
  if (memory.webgpuSkipped()) {
    fallback = "remembered";
    log("[gfx] WebGPU skipped: it did not start earlier in this session; using WebGL2");
  } else {
    const renderer = opts.create(false);
    const outcome = await initWithin(renderer, timeoutMs);
    if (outcome.status === "ready") return { renderer, fallback: null };
    if (outcome.status === "timeout") {
      fallback = "timeout";
      log(`[gfx] WebGPU did not start within ${timeoutMs / 1000} s; using WebGL2 for this session`);
    } else {
      fallback = "error";
      log(`[gfx] WebGPU failed to start (${reason(outcome.error)}); using WebGL2 for this session`);
      // init() rejected, so it holds nothing: three has already given up on it.
    }
  }

  const renderer = opts.create(true);
  await renderer.init();
  if (fallback !== "remembered") memory.rememberWebgpuSkipped();
  return { renderer, fallback };
}
