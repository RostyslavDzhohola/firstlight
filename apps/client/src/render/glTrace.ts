// `?gltrace` (#39 diagnostics): which synchronous WebGL calls make the main thread wait. In Chrome a
// WebGL query (getParameter, getProgramParameter, getUniformLocation, …) is a round trip to the GPU
// process that first runs every command queued before it; when the GPU process is busy (a cold Metal
// shader cache: Chrome's own raster pipelines, a Metal pipeline-state build) the call blocks the main
// thread for as long. Wrapped once after the renderer starts; calls over `minMs` are kept with their
// parameter and the warm-up phase they fell in, and the warm-up report carries them (`gl`).

import type { GlCall } from "./warmupReport.ts";

export type { GlCall } from "./warmupReport.ts";

/** The context's entry points that can wait on the GPU process (queries, plus uploads and compiles that can fill the command buffer). */
const SYNC_CALLS = [
  "getProgramParameter", "getShaderParameter", "getUniformLocation", "getUniformBlockIndex", "getParameter", "getError",
  "getExtension", "getSupportedExtensions", "checkFramebufferStatus", "getSyncParameter",
  "texImage2D", "texSubImage2D", "bufferData", "compileShader", "linkProgram",
] as const;

/** GL enums worth naming in the log. */
const ENUMS: Record<number, string> = {
  0x91b1: "COMPLETION_STATUS_KHR", 0x8b82: "LINK_STATUS", 0x8b81: "COMPILE_STATUS", 0x9114: "SYNC_STATUS", 0x0de1: "TEXTURE_2D",
};

let phase = "init";
const log: GlCall[] = [];
const traced = new WeakSet<object>();

/** The warm-up's current phase, for the log ("init" before any, "play" after). */
export function setGlPhase(p: string): void {
  phase = p;
}

/** Slow calls so far, oldest first. */
export function glSlowCalls(): readonly GlCall[] {
  return log;
}

/** Tests: forget the log. */
export function resetGlTrace(): void {
  log.length = 0;
}

function describeArg(name: string, args: unknown[]): string {
  const a = name === "getProgramParameter" || name === "getShaderParameter" || name === "getUniformLocation" || name === "getUniformBlockIndex" || name === "getSyncParameter"
    ? args[1]
    : args[0];
  if (typeof a === "number") return ENUMS[a] ?? `0x${a.toString(16)}`;
  return typeof a === "string" ? a : "";
}

/**
 * Time `gl`'s synchronous entry points (once per context); returns the restore. `now` defaults to
 * performance.now(); calls taking over `minMs` (50) go to the log.
 */
export function traceGlCalls(gl: object, opts: { now?: () => number; minMs?: number } = {}): () => void {
  if (traced.has(gl)) return () => {};
  traced.add(gl);
  const now = opts.now ?? (() => performance.now());
  const minMs = opts.minMs ?? 50;
  const target = gl as Record<string, unknown>;
  const restores: (() => void)[] = [];
  for (const name of SYNC_CALLS) {
    const original = target[name];
    if (typeof original !== "function") continue;
    const own = Object.prototype.hasOwnProperty.call(target, name);
    target[name] = function (this: unknown, ...args: unknown[]) {
      const t = now();
      const out = (original as (...a: unknown[]) => unknown).apply(this, args);
      const ms = now() - t;
      if (ms > minMs) log.push({ name, pname: describeArg(name, args), ms: Math.round(ms * 10) / 10, t: Math.round(t * 10) / 10, phase });
      return out;
    };
    restores.push(() => {
      if (own) target[name] = original;
      else delete target[name];
    });
  }
  return () => {
    for (const r of restores) r();
    traced.delete(gl);
  };
}
