// Never ask the GPU process a synchronous question while it is busy (#39, D-load-3; Fable's diagnosis).
//
// In Chrome a WebGL query is a round trip to the GPU process that first runs every command queued
// before it. three polls a parallel link with gl.getProgramParameter(COMPLETION_STATUS_KHR) right after
// gl.linkProgram and then once a frame, and on a cold Metal cache the GPU process can be busy for
// seconds (Chrome compiling its own raster pipelines, a Metal pipeline-state build at a first draw):
// the first poll of the warm-up then blocked the main thread 1.5–5.7 s.
//
// guardStatusPolls() puts a fence right after each linkProgram and answers COMPLETION_STATUS_KHR polls
// itself (false, no round trip) until that fence has signalled and no first-draw batch is in flight;
// then three's own query runs on an idle queue, and so do the uniform lookups that follow a completed
// link. Fences are read without blocking (Chrome answers getSyncParameter from shared memory; the
// first-draw pacer relies on that too). It also notes how long each program took from its link to the
// first poll that found it complete, counted from its fence: a quick link means a cached program,
// the warm-up's pricing uses it. gpuIdle() waits for everything queued so far the same way, polling once a frame.
// Installed for the warm-up only; `?syncpoll` keeps three's own polls.

import { glFence, type FenceGL } from "./parallelCompile.ts";

/** KHR_parallel_shader_compile's COMPLETION_STATUS_KHR. */
export const COMPLETION_STATUS_KHR = 0x91b1;

/**
 * A link that completed within this (ms from when the GPU process reached it, its fence, to the first
 * poll that found it done) found its program cached, and so very likely its Metal pipeline too: the
 * warm-up prices its first draw at the warm rate (#39). A cached program is done at its first poll;
 * a cold one compiles for 100 ms or more. Measured from the fence, not the linkProgram call, so the
 * queue of other work ahead of it in the GPU process doesn't count.
 */
export const FAST_LINK_MS = 30;

/** Whether a link time says the program was cached (null: never seen: cold). */
export function warmLink(ms: number | null): boolean {
  return ms !== null && ms <= FAST_LINK_MS;
}

/** The WebGL2 calls the guard wraps. */
export interface PollGL extends FenceGL {
  linkProgram(program: WebGLProgram): void;
  getProgramParameter(program: WebGLProgram, pname: number): unknown;
}

export interface StatusPollGuard {
  /** False without a WebGL2 context (WebGPU): nothing wrapped. */
  readonly active: boolean;
  /** ms from when the GPU process reached `program`'s link (its fence) to the first poll that found it complete (null: not yet, or linked before the guard). */
  linkMs(program: object): number | null;
  /** Polls answered locally so far (round trips saved). */
  answered(): number;
  /** Back to three's own calls (idempotent). */
  release(): void;
}

interface Link {
  at: number;
  fence: (() => boolean) | null;
  /** When a poll first found the fence signalled (the GPU process had reached the link). */
  fenceAt: number | null;
  doneAt: number | null;
}

/** Every program linked under a guard (kept across warm-ups: a program linked in the probe's warm-up draws in the next). */
const links = new WeakMap<object, Link>();

export function guardStatusPolls(gl: PollGL | null | undefined, busy: () => boolean, now: () => number = () => performance.now()): StatusPollGuard {
  if (!gl || typeof gl.linkProgram !== "function" || typeof gl.getProgramParameter !== "function") {
    return { active: false, linkMs: () => null, answered: () => 0, release() {} };
  }
  let answered = 0;
  const target = gl as unknown as Record<string, unknown>;
  const ownLink = Object.prototype.hasOwnProperty.call(target, "linkProgram");
  const ownPoll = Object.prototype.hasOwnProperty.call(target, "getProgramParameter");
  const link = gl.linkProgram;
  const poll = gl.getProgramParameter;
  gl.linkProgram = function (this: PollGL, program: WebGLProgram) {
    link.call(this, program);
    links.set(program as object, { at: now(), fence: glFence(gl), fenceAt: null, doneAt: null });
  };
  gl.getProgramParameter = function (this: PollGL, program: WebGLProgram, pname: number) {
    if (pname !== COMPLETION_STATUS_KHR) return poll.call(this, program, pname);
    const l = links.get(program as object);
    const reached = !l?.fence || l.fence();
    if (l && reached && l.fenceAt === null) l.fenceAt = now();
    if (!reached || busy()) {
      answered++;
      return false; // the GPU process still has work queued: asking would wait for all of it
    }
    const out = poll.call(this, program, pname);
    if (out && l && l.doneAt === null) l.doneAt = now();
    return out;
  };
  let released = false;
  return {
    active: true,
    linkMs(program) {
      const l = links.get(program);
      return l?.doneAt != null ? l.doneAt - (l.fenceAt ?? l.at) : null;
    },
    answered: () => answered,
    release() {
      if (released) return;
      released = true;
      if (ownLink) target.linkProgram = link;
      else delete target.linkProgram;
      if (ownPoll) target.getProgramParameter = poll;
      else delete target.getProgramParameter;
    },
  };
}

/**
 * Wait, a frame at a time, until the GPU process has run everything queued so far (a fence), at most
 * `capMs`. Returns the ms waited (0 without fences).
 */
export async function gpuIdle(gl: FenceGL | null | undefined, nextFrame: () => Promise<void>, capMs = 10_000, now: () => number = () => performance.now()): Promise<number> {
  const done = glFence(gl);
  if (!done) return 0;
  const t = now();
  while (!done() && now() - t < capMs) await nextFrame();
  return now() - t;
}
