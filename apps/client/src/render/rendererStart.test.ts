import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  browserMajor, deviceBackendMemory, initWithin, startRenderer, WEBGPU_FAILED_KEY, WEBGPU_INIT_TIMEOUT_MS, WEBGPU_RETRY_MS,
  WEBGPU_SLOW_NOTICE_MS, webgpuSecondChance, type BackendMemory, type BackendStatus, type DeviceMemoryEnv, type GpuAdapterLike, type GpuLike, type Startable, type StorageLike,
} from "./rendererStart.ts";

/** A renderer whose init() the test settles by hand. */
class FakeRenderer implements Startable {
  disposed = 0;
  inits = 0;
  private settle!: { resolve: () => void; reject: (e: unknown) => void };
  private readonly pending = new Promise<void>((resolve, reject) => {
    this.settle = { resolve, reject };
  });
  constructor(readonly forceWebGL: boolean) {}
  init() {
    this.inits++;
    return this.pending;
  }
  dispose() {
    this.disposed++;
  }
  resolve() {
    this.settle.resolve();
  }
  reject(e: unknown) {
    this.settle.reject(e);
  }
}

function harness(memoryStart = false) {
  const made: FakeRenderer[] = [];
  const logs: string[] = [];
  let skipped = memoryStart;
  const memory: BackendMemory = {
    webgpuSkipped: () => skipped,
    rememberWebgpuSkipped: () => {
      skipped = true;
    },
    forgetWebgpuSkipped: () => {
      skipped = false;
    },
    noteLateStart: () => {},
    grantSecondChance: () => false,
  };
  const create = (forceWebGL: boolean) => {
    const r = new FakeRenderer(forceWebGL);
    made.push(r);
    return r;
  };
  return { made, logs, memory, create, log: (m: string) => logs.push(m), isSkipped: () => skipped };
}

/** Let promise callbacks run without moving the fake clock. */
const flush = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("startRenderer", () => {
  it("keeps WebGPU when init finishes in time (no fallback, nothing remembered)", async () => {
    const h = harness();
    const started = startRenderer({ create: h.create, forceWebGL: false, memory: h.memory, log: h.log });
    await flush();
    h.made[0]!.resolve();
    const { renderer, fallback } = await started;
    expect(renderer).toBe(h.made[0]);
    expect(renderer.forceWebGL).toBe(false);
    expect(fallback).toBeNull();
    expect(h.made).toHaveLength(1);
    expect(h.isSkipped()).toBe(false);
    expect(h.logs).toEqual([]);
    expect(vi.getTimerCount()).toBe(0); // the deadline is cleared
  });

  it("falls back to WebGL2 when WebGPU init never answers, and remembers it", async () => {
    const h = harness();
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const started = startRenderer({ create: h.create, forceWebGL: false, memory: h.memory });
    await vi.advanceTimersByTimeAsync(WEBGPU_INIT_TIMEOUT_MS - 1);
    expect(h.made).toHaveLength(1); // still waiting
    await vi.advanceTimersByTimeAsync(1);
    expect(h.made).toHaveLength(2);
    expect(h.made[1]!.forceWebGL).toBe(true);
    h.made[1]!.resolve();
    const { renderer, fallback } = await started;
    expect(renderer).toBe(h.made[1]);
    expect(fallback).toBe("timeout");
    expect(h.isSkipped()).toBe(true);
    expect(info).toHaveBeenCalledTimes(1); // one info line, no error
    expect(String(info.mock.calls[0]![0])).toMatch(/WebGPU did not start within 20 s/);
    expect(error).not.toHaveBeenCalled();
  });

  it("uses a 20 s deadline by default (D-showcase-1: WebGPU wins more often on a slow start)", () => {
    expect(WEBGPU_INIT_TIMEOUT_MS).toBe(20_000);
    expect(WEBGPU_SLOW_NOTICE_MS).toBeLessThan(WEBGPU_INIT_TIMEOUT_MS);
  });

  it("tells the loader while WebGPU is still starting, and when WebGL2 takes over", async () => {
    const h = harness();
    const stages: string[] = [];
    const started = startRenderer({ create: h.create, forceWebGL: false, memory: h.memory, log: h.log, onStage: (s) => stages.push(s) });
    await vi.advanceTimersByTimeAsync(WEBGPU_SLOW_NOTICE_MS - 1);
    expect(stages).toEqual([]); // a normal start says nothing extra
    await vi.advanceTimersByTimeAsync(1);
    expect(stages).toEqual(["webgpu-slow"]);
    await vi.advanceTimersByTimeAsync(WEBGPU_INIT_TIMEOUT_MS - WEBGPU_SLOW_NOTICE_MS - 1);
    expect(stages).toEqual(["webgpu-slow"]); // once, and still waiting for WebGPU
    expect(h.made).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(stages).toEqual(["webgpu-slow", "webgl2-fallback"]);
    expect(h.made).toHaveLength(2);
    h.made[1]!.resolve();
    expect((await started).fallback).toBe("timeout");
  });

  it("says nothing extra when WebGPU starts in time, WebGL2 was asked for, or WebGPU is skipped here", async () => {
    // In time, just before the notice: the notice's timer goes with the deadline's.
    const h = harness();
    const stages: string[] = [];
    const onStage = (s: string) => stages.push(s);
    const fast = startRenderer({ create: h.create, forceWebGL: false, memory: h.memory, log: h.log, onStage });
    await vi.advanceTimersByTimeAsync(WEBGPU_SLOW_NOTICE_MS - 1);
    h.made[0]!.resolve();
    expect((await fast).fallback).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(WEBGPU_INIT_TIMEOUT_MS);
    // ?webgl, and a device that skips WebGPU: WebGL2 at once, nothing to say.
    for (const [forceWebGL, skipped] of [[true, false], [false, true]] as const) {
      const g = harness(skipped);
      const s = startRenderer({ create: g.create, forceWebGL, memory: g.memory, log: g.log, onStage });
      await flush();
      g.made[0]!.resolve();
      await s;
    }
    expect(stages).toEqual([]);
  });

  it("an init that fails at once hands over to WebGL2 with the fallback cue only; a throwing cue changes nothing", async () => {
    const h = harness();
    const stages: string[] = [];
    const started = startRenderer({ create: h.create, forceWebGL: false, memory: h.memory, log: h.log, onStage: (s) => stages.push(s) });
    await flush();
    h.made[0]!.reject(new Error("no adapter"));
    await flush();
    h.made[1]!.resolve();
    expect((await started).fallback).toBe("error");
    expect(stages).toEqual(["webgl2-fallback"]);
    const g = harness();
    const s = startRenderer({ create: g.create, forceWebGL: false, memory: g.memory, log: g.log, onStage: () => { throw new Error("loader gone"); } });
    await vi.advanceTimersByTimeAsync(WEBGPU_INIT_TIMEOUT_MS);
    g.made[1]!.resolve();
    expect((await s).fallback).toBe("timeout");
  });

  it("tears down an abandoned renderer whose init finishes late (no leaked device or loop)", async () => {
    const h = harness();
    const started = startRenderer({ create: h.create, forceWebGL: false, memory: h.memory, log: h.log, timeoutMs: 100 });
    await vi.advanceTimersByTimeAsync(100);
    h.made[1]!.resolve();
    await started;
    const abandoned = h.made[0]!;
    expect(abandoned.disposed).toBe(0); // dispose before init finishes would leave the device behind
    abandoned.resolve(); // the adapter finally answered
    await flush();
    expect(abandoned.disposed).toBe(1);
    expect(h.made[1]!.disposed).toBe(0);
  });

  it("does not dispose an abandoned renderer whose init finally fails (nothing was created)", async () => {
    const h = harness();
    const started = startRenderer({ create: h.create, forceWebGL: false, memory: h.memory, log: h.log, timeoutMs: 100 });
    await vi.advanceTimersByTimeAsync(100);
    h.made[1]!.resolve();
    await started;
    h.made[0]!.reject(new Error("device lost before it started"));
    await flush();
    expect(h.made[0]!.disposed).toBe(0);
  });

  it("falls back to WebGL2 when WebGPU init rejects", async () => {
    const h = harness();
    const started = startRenderer({ create: h.create, forceWebGL: false, memory: h.memory, log: h.log });
    await flush();
    h.made[0]!.reject(new Error("Unable to create WebGPU adapter"));
    await flush();
    expect(h.made).toHaveLength(2);
    expect(h.made[1]!.forceWebGL).toBe(true);
    h.made[1]!.resolve();
    const { renderer, fallback } = await started;
    expect(renderer).toBe(h.made[1]);
    expect(fallback).toBe("error");
    expect(h.isSkipped()).toBe(true);
    expect(h.logs).toHaveLength(1);
    expect(h.logs[0]).toMatch(/WebGPU failed to start \(Unable to create WebGPU adapter\)/);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("fails with the WebGL2 error, and remembers nothing, when both backends fail", async () => {
    const h = harness();
    const started = startRenderer({ create: h.create, forceWebGL: false, memory: h.memory, log: h.log });
    const settled = started.catch((e: unknown) => e);
    await flush();
    h.made[0]!.reject(new Error("no adapter"));
    await flush();
    h.made[1]!.reject(new Error("no webgl2"));
    expect(await settled).toEqual(new Error("no webgl2"));
    expect(h.isSkipped()).toBe(false);
  });

  it("goes straight to WebGL2 when this session already gave up on WebGPU", async () => {
    const h = harness(true);
    const started = startRenderer({ create: h.create, forceWebGL: false, memory: h.memory, log: h.log });
    await flush();
    expect(h.made).toHaveLength(1);
    expect(h.made[0]!.forceWebGL).toBe(true);
    h.made[0]!.resolve();
    const { fallback } = await started;
    expect(fallback).toBe("remembered");
    expect(h.logs).toHaveLength(1);
    expect(h.logs[0]).toMatch(/WebGPU skipped/);
    expect(vi.getTimerCount()).toBe(0); // no deadline on the WebGL2 path
  });

  it("?webgl asks for WebGL2 outright: no deadline, no fallback, no memory", async () => {
    const h = harness();
    const started = startRenderer({ create: h.create, forceWebGL: true, memory: h.memory, log: h.log });
    await vi.advanceTimersByTimeAsync(5 * WEBGPU_INIT_TIMEOUT_MS);
    expect(h.made).toHaveLength(1); // a slow WebGL2 init is waited for, not replaced
    h.made[0]!.resolve();
    const { renderer, fallback } = await started;
    expect(renderer.forceWebGL).toBe(true);
    expect(fallback).toBeNull();
    expect(h.isSkipped()).toBe(false);
    expect(h.logs).toEqual([]);
  });
});

describe("initWithin", () => {
  it("reports ready, timeout and error without ever rejecting", async () => {
    const ok = new FakeRenderer(false);
    const okP = initWithin(ok, 50);
    ok.resolve();
    expect(await okP).toEqual({ status: "ready" });

    const slow = new FakeRenderer(false);
    const slowP = initWithin(slow, 50);
    await vi.advanceTimersByTimeAsync(50);
    expect(await slowP).toEqual({ status: "timeout" });

    const bad = new FakeRenderer(false);
    const badP = initWithin(bad, 50);
    const err = new Error("nope");
    bad.reject(err);
    expect(await badP).toEqual({ status: "error", error: err });
  });

  it("treats a synchronous throw from init() as an error", async () => {
    const r: Startable = {
      init() {
        throw new Error("sync");
      },
      dispose() {},
    };
    expect(await initWithin(r, 50)).toEqual({ status: "error", error: new Error("sync") });
  });

  it("logs, rather than rejects, when disposing the abandoned renderer fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = new FakeRenderer(false);
    r.dispose = () => {
      throw new Error("destroy failed");
    };
    const p = initWithin(r, 50);
    await vi.advanceTimersByTimeAsync(50);
    expect(await p).toEqual({ status: "timeout" });
    r.resolve();
    await flush();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------------- device memory

const DAY = 24 * 60 * 60 * 1000;
const CHROME = "Chrome/141";
const M1 = "ANGLE (Apple, ANGLE Metal Renderer: Apple M1, Unspecified Version)";

function fakeStorage(init: Record<string, string> = {}) {
  const m = new Map(Object.entries(init));
  const s: StorageLike & { map: Map<string, string> } = {
    map: m,
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
  };
  return s;
}

/** A device: its local storage, a hand-moved clock, the browser's major version and the GPU name. */
function device(opts: { record?: unknown; browser?: string; gpu?: string; now?: number; storage?: StorageLike | null } = {}) {
  const storage = opts.storage !== undefined ? opts.storage : fakeStorage(opts.record === undefined ? {} : { [WEBGPU_FAILED_KEY]: JSON.stringify(opts.record) });
  const env = { now: opts.now ?? 100 * DAY, browser: opts.browser ?? CHROME, gpu: opts.gpu ?? M1, gpuProbes: 0 };
  const memEnv: DeviceMemoryEnv = {
    storage,
    now: () => env.now,
    browser: () => env.browser,
    gpu: () => {
      env.gpuProbes++;
      return env.gpu;
    },
  };
  const record = () => {
    const raw = (storage as ReturnType<typeof fakeStorage> | null)?.map.get(WEBGPU_FAILED_KEY);
    return raw === undefined ? null : (JSON.parse(raw) as Record<string, unknown>);
  };
  return { env, memory: deviceBackendMemory(memEnv), storage, record };
}

/** Start like a page load does; returns which backend was tried first and how it ended. */
async function load(d: ReturnType<typeof device>, opts: { forceWebGPU?: boolean; forceWebGL?: boolean; webgpu: "ready" | "hang" | "reject" | "untried" | "internal-fallback" }) {
  const h = harness();
  // three r186 catches a failed WebGPU init itself, switches to its WebGL2 backend and resolves init().
  const isWebGPU = (r: FakeRenderer) => !r.forceWebGL && opts.webgpu !== "internal-fallback";
  const started = startRenderer({ create: h.create, forceWebGL: !!opts.forceWebGL, forceWebGPU: opts.forceWebGPU, memory: d.memory, log: h.log, isWebGPU });
  await flush();
  const first = h.made[0]!;
  const triedWebgpu = !first.forceWebGL;
  if (triedWebgpu) {
    if (opts.webgpu === "ready" || opts.webgpu === "internal-fallback") first.resolve();
    else if (opts.webgpu === "reject") first.reject(new Error("Unable to create WebGPU adapter"));
    else await vi.advanceTimersByTimeAsync(WEBGPU_INIT_TIMEOUT_MS);
    await flush();
  }
  const webgl = h.made.find((r) => r.forceWebGL);
  webgl?.resolve();
  const out = await started;
  return { triedWebgpu, fallback: out.fallback, logs: h.logs, made: h.made };
}

const fresh = (over: Record<string, unknown> = {}) => ({ v: 1, reason: "timeout", at: 100 * DAY - DAY, browser: CHROME, gpu: M1, ...over });

describe("startRenderer with the device memory (WebGPU that didn't start, across visits)", () => {
  it("a fresh record for this browser and GPU skips WebGPU: no 20 s wait", async () => {
    const d = device({ record: fresh() });
    const r = await load(d, { webgpu: "untried" });
    expect(r.triedWebgpu).toBe(false);
    expect(r.fallback).toBe("remembered");
    expect(r.logs[0]).toMatch(/WebGPU skipped/);
    expect(r.logs[0]).toMatch(/\?webgpu/); // says how to try again
    expect(d.record()).toEqual(fresh()); // still remembered for the next visit
  });

  it("skips until the record is ~7 days old, then tries WebGPU again", async () => {
    const at = 100 * DAY;
    const almost = device({ record: fresh({ at }), now: at + WEBGPU_RETRY_MS - 1 });
    expect((await load(almost, { webgpu: "untried" })).triedWebgpu).toBe(false);
    const expired = device({ record: fresh({ at }), now: at + WEBGPU_RETRY_MS });
    const r = await load(expired, { webgpu: "ready" });
    expect(r.triedWebgpu).toBe(true);
    expect(r.fallback).toBeNull();
    expect(WEBGPU_RETRY_MS).toBe(7 * DAY);
  });

  it("tries WebGPU again after a browser update", async () => {
    const d = device({ record: fresh({ browser: "Chrome/140" }), browser: "Chrome/141" });
    expect((await load(d, { webgpu: "ready" })).triedWebgpu).toBe(true);
  });

  it("tries WebGPU again on a different GPU (new machine, eGPU, other adapter)", async () => {
    const d = device({ record: fresh(), gpu: "ANGLE (AMD, ANGLE Metal Renderer: AMD Radeon Pro 5500M, Unspecified Version)" });
    expect((await load(d, { webgpu: "ready" })).triedWebgpu).toBe(true);
  });

  it("tries WebGPU when the record is from the future (a clock set back) or unreadable", async () => {
    expect((await load(device({ record: fresh({ at: 200 * DAY }) }), { webgpu: "ready" })).triedWebgpu).toBe(true);
    const junk = device({ storage: fakeStorage({ [WEBGPU_FAILED_KEY]: "{not json" }) });
    expect((await load(junk, { webgpu: "ready" })).triedWebgpu).toBe(true);
    const wrong = device({ record: { reason: "timeout", at: "yesterday" } });
    expect((await load(wrong, { webgpu: "ready" })).triedWebgpu).toBe(true);
  });

  it("?webgpu tries WebGPU despite a fresh record, and clears the record", async () => {
    const d = device({ record: fresh() });
    const h = harness();
    const started = startRenderer({ create: h.create, forceWebGL: false, forceWebGPU: true, memory: d.memory, log: h.log });
    await flush();
    expect(h.made[0]!.forceWebGL).toBe(false);
    expect(d.record()).toBeNull(); // cleared before the attempt, so a closed tab doesn't keep it
    h.made[0]!.resolve();
    expect((await started).fallback).toBeNull();
    expect(d.record()).toBeNull();
  });

  it("?webgpu that fails again writes a new record (the next plain visit skips)", async () => {
    const d = device({ record: fresh({ at: 1 }) });
    const r = await load(d, { forceWebGPU: true, webgpu: "hang" });
    expect(r.fallback).toBe("timeout");
    expect(d.record()).toEqual({ v: 1, reason: "timeout", at: 100 * DAY, browser: CHROME, gpu: M1 });
  });

  it("?webgl forces WebGL2 and leaves the record alone", async () => {
    const d = device({ record: fresh() });
    const r = await load(d, { forceWebGL: true, webgpu: "untried" });
    expect(r.made).toHaveLength(1);
    expect(r.fallback).toBeNull();
    expect(d.record()).toEqual(fresh());
    const none = device();
    await load(none, { forceWebGL: true, webgpu: "untried" });
    expect(none.record()).toBeNull();
  });

  it("a timeout writes the record: reason, time, browser major version and GPU name, nothing else", async () => {
    const d = device();
    const r = await load(d, { webgpu: "hang" });
    expect(r.fallback).toBe("timeout");
    expect(d.record()).toEqual({ v: 1, reason: "timeout", at: 100 * DAY, browser: CHROME, gpu: M1 });
    // the next visit goes straight to WebGL2
    const again = await load(device({ storage: d.storage }), { webgpu: "untried" });
    expect(again.triedWebgpu).toBe(false);
    expect(again.fallback).toBe("remembered");
  });

  it("an error writes the record with reason error", async () => {
    const d = device();
    const r = await load(d, { webgpu: "reject" });
    expect(r.fallback).toBe("error");
    expect(d.record()).toMatchObject({ reason: "error", at: 100 * DAY });
  });

  it("init() that resolves on three's own WebGL2 fallback is a failed start: recorded as an error, not cleared", async () => {
    const d = device({ record: fresh({ browser: "Chrome/139" }) }); // stale: WebGPU is tried
    const r = await load(d, { webgpu: "internal-fallback" });
    expect(r.triedWebgpu).toBe(true);
    expect(r.made).toHaveLength(1); // three's WebGL2 backend is already up: no second renderer
    expect(r.fallback).toBe("error");
    expect(d.record()).toEqual({ v: 1, reason: "error", at: 100 * DAY, browser: CHROME, gpu: M1 });
    expect(r.logs.join("\n")).toMatch(/WebGPU failed to start/);
    // the next visit skips WebGPU
    expect((await load(device({ storage: d.storage }), { webgpu: "untried" })).fallback).toBe("remembered");
  });

  it("a successful WebGPU start clears an old record", async () => {
    const d = device({ record: fresh({ browser: "Chrome/139" }) });
    const r = await load(d, { webgpu: "ready" });
    expect(r.fallback).toBeNull();
    expect(d.record()).toBeNull();
  });

  it("probes the GPU name only when there is a record to check or one to write", async () => {
    const clean = device();
    await load(clean, { webgpu: "ready" });
    expect(clean.env.gpuProbes).toBe(0); // a working WebGPU device pays nothing
    const failing = device();
    await load(failing, { webgpu: "hang" });
    expect(failing.env.gpuProbes).toBe(1);
  });

  it("storage that is missing, disabled or full means no memory, never a failed boot", async () => {
    const none = device({ storage: null });
    expect((await load(none, { webgpu: "hang" })).fallback).toBe("timeout");
    expect((await load(none, { webgpu: "ready" })).triedWebgpu).toBe(true);
    const throwing: StorageLike = {
      getItem() {
        throw new Error("denied");
      },
      setItem() {
        throw new Error("QuotaExceededError");
      },
      removeItem() {
        throw new Error("denied");
      },
    };
    const d = device({ storage: throwing });
    expect((await load(d, { webgpu: "hang" })).fallback).toBe("timeout");
    expect((await load(d, { webgpu: "ready" })).fallback).toBeNull();
    expect((await load(d, { forceWebGPU: true, webgpu: "ready" })).fallback).toBeNull();
  });

  it("defaults to localStorage, and tolerates a page with none (node, blocked cookies)", async () => {
    const ls = fakeStorage();
    vi.stubGlobal("localStorage", ls);
    const mem = deviceBackendMemory({ now: () => 5, browser: () => CHROME, gpu: () => M1 });
    mem.rememberWebgpuSkipped("error");
    expect(JSON.parse(ls.map.get(WEBGPU_FAILED_KEY)!)).toMatchObject({ reason: "error", at: 5 });
    expect(mem.webgpuSkipped()).toBe(true);
    mem.forgetWebgpuSkipped();
    expect(ls.map.has(WEBGPU_FAILED_KEY)).toBe(false);
    vi.unstubAllGlobals();
    const bare = deviceBackendMemory({ now: () => 5, browser: () => CHROME, gpu: () => M1 });
    expect(bare.webgpuSkipped()).toBe(false);
    expect(() => bare.rememberWebgpuSkipped("timeout")).not.toThrow();
    expect(() => bare.forgetWebgpuSkipped()).not.toThrow();
  });
});

// ------------------------------------------------------------------- D-renderer-2: a second chance

describe("an abandoned WebGPU start that answers late (D-renderer-2)", () => {
  /** A page load whose WebGPU init hangs past the deadline; the test settles it later by hand. */
  async function hangingStart(d: ReturnType<typeof device>, opts: { internalFallback?: boolean } = {}) {
    const h = harness();
    const isWebGPU = (r: FakeRenderer) => !r.forceWebGL && !opts.internalFallback;
    const started = startRenderer({ create: h.create, forceWebGL: false, memory: d.memory, log: h.log, isWebGPU, now: () => Date.now() });
    await vi.advanceTimersByTimeAsync(WEBGPU_INIT_TIMEOUT_MS);
    return { h, started, webgpu: h.made[0]!, webgl: () => h.made[1]! };
  }

  it("notes how late it answered, in the device record and in the session's status", async () => {
    const d = device();
    const s = await hangingStart(d);
    s.webgl().resolve();
    const { status } = await s.started;
    expect(status).toEqual({ fallback: "timeout", lateMs: null, secondChance: null });
    expect(d.record()).toEqual({ v: 1, reason: "timeout", at: 100 * DAY, browser: CHROME, gpu: M1 });
    await vi.advanceTimersByTimeAsync(3000);
    s.webgpu.resolve(); // the adapter finally answered, 3 s after the deadline
    await flush();
    expect(status.lateMs).toBe(WEBGPU_INIT_TIMEOUT_MS + 3000);
    expect(d.record()).toEqual({ v: 1, reason: "timeout", at: 100 * DAY, browser: CHROME, gpu: M1, lateMs: WEBGPU_INIT_TIMEOUT_MS + 3000 });
    expect(s.webgpu.disposed).toBe(1); // still torn down: the session stays on WebGL2
    expect(s.h.logs.join("\n")).toContain(`answered ${((WEBGPU_INIT_TIMEOUT_MS + 3000) / 1000).toFixed(1)} s after it began (deadline ${WEBGPU_INIT_TIMEOUT_MS / 1000} s)`);
  });

  it("an answer that comes while WebGL2 is still starting lands in the record all the same", async () => {
    const d = device();
    const s = await hangingStart(d);
    await vi.advanceTimersByTimeAsync(500);
    s.webgpu.resolve();
    await flush();
    s.webgl().resolve();
    const { status } = await s.started;
    expect(status.lateMs).toBe(WEBGPU_INIT_TIMEOUT_MS + 500);
    expect(d.record()).toMatchObject({ reason: "timeout", lateMs: WEBGPU_INIT_TIMEOUT_MS + 500 });
  });

  it("a late finish on three's own WebGL2 fallback, or a late failure, is not a WebGPU answer", async () => {
    for (const late of ["internal-fallback", "reject"] as const) {
      const d = device();
      const s = await hangingStart(d, { internalFallback: late === "internal-fallback" });
      s.webgl().resolve();
      const { status } = await s.started;
      if (late === "reject") s.webgpu.reject(new Error("device lost"));
      else s.webgpu.resolve();
      await flush();
      expect(status.lateMs, late).toBeNull();
      expect(d.record(), late).toEqual({ v: 1, reason: "timeout", at: 100 * DAY, browser: CHROME, gpu: M1 });
    }
  });

  it("a WebGPU start in time, a remembered skip and ?webgl report no fallback lateness", async () => {
    const ok = harness();
    const p = startRenderer({ create: ok.create, forceWebGL: false, memory: ok.memory, log: ok.log });
    await flush();
    ok.made[0]!.resolve();
    expect((await p).status).toEqual({ fallback: null, lateMs: null, secondChance: null });
    const remembered = await load(device({ record: fresh() }), { webgpu: "untried" });
    expect(remembered.fallback).toBe("remembered");
  });
});

/** A navigator.gpu stand-in: how it answers the adapter and device requests, and what was asked. */
function fakeGpu(mode: "ok" | "no-adapter" | "hang" | "adapter-fails" | "device-fails" | "adapter-late") {
  const calls = { adapter: 0, device: 0, destroyed: 0, options: [] as unknown[] };
  let answer: (() => void) | null = null;
  const gpu: GpuLike = {
    requestAdapter(o) {
      calls.adapter++;
      calls.options.push(o);
      if (mode === "no-adapter") return Promise.resolve(null);
      if (mode === "adapter-fails") return Promise.reject(new Error("adapter failed"));
      const adapter: GpuAdapterLike = {
        requestDevice() {
          calls.device++;
          if (mode === "device-fails") return Promise.reject(new Error("device lost"));
          const dev = { destroy: () => void calls.destroyed++ };
          if (mode === "hang") return new Promise((r) => (answer = () => r(dev)));
          return Promise.resolve(dev);
        },
      };
      // The adapter itself answers only when the test says so.
      if (mode === "adapter-late") return new Promise((r) => (answer = () => r(adapter)));
      return Promise.resolve(adapter);
    },
  };
  return { gpu, calls, answerLate: () => answer?.() };
}

/** The session's start status after a WebGL2 fallback (or none). */
const fellBack = (fallback: BackendStatus["fallback"]): BackendStatus => ({ fallback, lateMs: null, secondChance: null });

/** A hand-scheduled idle callback: the test decides when the page is idle. */
function idle() {
  let queued: (() => void) | null = null;
  return {
    schedule: (run: () => void) => void (queued = run),
    run: async () => {
      queued?.();
      queued = null;
      await flush();
    },
    pending: () => queued !== null,
  };
}

describe("WebGPU's second chance after a WebGL2 fallback (D-renderer-2)", () => {
  it("checks WebGPU quietly once the page is idle (adapter + device, no rendering) and, if it answers in time, lets the next visit try it", async () => {
    const d = device({ record: fresh() });
    const g = fakeGpu("ok");
    const i = idle();
    const logs: string[] = [];
    const status = fellBack("remembered");
    const done = webgpuSecondChance(status, { memory: d.memory, gpu: g.gpu, schedule: i.schedule, log: (m) => logs.push(m) });
    await flush();
    expect(g.calls.adapter).toBe(0); // nothing until the page is idle
    expect(status.secondChance).toBe("pending");
    await i.run();
    expect(await done).toBe("cleared");
    expect(status.secondChance).toBe("cleared");
    expect(g.calls).toMatchObject({ adapter: 1, device: 1, destroyed: 1 }); // the test device is released at once
    expect(g.calls.options).toEqual([{ powerPreference: "high-performance" }]);
    expect(logs.join("\n")).toMatch(/WebGPU answered .* the next visit tries it again/);
    // The next visit tries WebGPU; when it works, the record goes.
    const next = await load(device({ storage: d.storage }), { webgpu: "ready" });
    expect(next.triedWebgpu).toBe(true);
    expect(next.fallback).toBeNull();
    expect(d.record()).toBeNull();
  });

  it("gives a record one second chance: when the next try fails too, WebGPU stays off for the rest of the week", async () => {
    const d = device({ record: fresh() });
    const i = idle();
    void webgpuSecondChance(fellBack("remembered"), { memory: d.memory, gpu: fakeGpu("ok").gpu, schedule: i.schedule, log: () => {} });
    await i.run();
    expect(d.record()).toMatchObject({ second: "granted" });
    // The next visit tries WebGPU and it hangs again: a new record that has had its second chance.
    const again = await load(device({ storage: d.storage }), { webgpu: "hang" });
    expect(again.triedWebgpu).toBe(true);
    expect(again.fallback).toBe("timeout");
    expect(d.record()).toEqual({ v: 1, reason: "timeout", at: 100 * DAY, browser: CHROME, gpu: M1, second: "used" });
    // That session's second chance answers, but the record keeps WebGPU off: no 20 s wait every visit.
    const i2 = idle();
    const status = fellBack("timeout");
    const done = webgpuSecondChance(status, { memory: d.memory, gpu: fakeGpu("ok").gpu, schedule: i2.schedule, log: () => {} });
    await i2.run();
    expect(await done).toBe("spent");
    expect(d.record()).toMatchObject({ second: "used" });
    expect((await load(device({ storage: d.storage }), { webgpu: "untried" })).fallback).toBe("remembered");
    // A week on, the record has expired: WebGPU is tried again as before.
    const later = device({ storage: d.storage, now: 100 * DAY + WEBGPU_RETRY_MS });
    expect((await load(later, { webgpu: "ready" })).triedWebgpu).toBe(true);
  });

  it("only a grant that still applies here is spent by a failure: an expired one, or another browser's or GPU's, is not", async () => {
    const granted = (over: Record<string, unknown> = {}) => fresh({ second: "granted", ...over });
    const cases = [
      ["expired", device({ record: granted({ at: 100 * DAY - WEBGPU_RETRY_MS }) })],
      ["browser update", device({ record: granted({ browser: "Chrome/140" }) })],
      ["other GPU", device({ record: granted({ gpu: "ANGLE (AMD, ANGLE Metal Renderer: AMD Radeon Pro 5500M, Unspecified Version)" }) })],
    ] as const;
    for (const [why, d] of cases) {
      const r = await load(d, { webgpu: "hang" });
      expect(r.fallback, why).toBe("timeout");
      // A first failure in this environment: a fresh record that still has its second chance.
      expect(d.record(), why).toEqual({ v: 1, reason: "timeout", at: 100 * DAY, browser: CHROME, gpu: M1 });
      const i = idle();
      const done = webgpuSecondChance(fellBack("timeout"), { memory: d.memory, gpu: fakeGpu("ok").gpu, schedule: i.schedule, log: () => {} });
      await i.run();
      expect(await done, why).toBe("cleared");
    }
    // The grant that applies here is spent by the failure, as before.
    const d = device({ record: granted() });
    await load(d, { webgpu: "hang" });
    expect(d.record()).toMatchObject({ second: "used" });
  });

  it("a WebGPU that fails inside init (three's own fallback) on the second try also spends the chance", async () => {
    const d = device({ record: fresh({ reason: "error" }) });
    const i = idle();
    void webgpuSecondChance(fellBack("remembered"), { memory: d.memory, gpu: fakeGpu("ok").gpu, schedule: i.schedule, log: () => {} });
    await i.run();
    await load(device({ storage: d.storage }), { webgpu: "internal-fallback" });
    expect(d.record()).toMatchObject({ reason: "error", second: "used" });
  });

  it("keeps the record when WebGPU answers too late, has no adapter, or a request fails; a late device is released", async () => {
    const cases = [
      ["hang", "timeout"],
      ["no-adapter", "unavailable"],
      ["adapter-fails", "error"],
      ["device-fails", "error"],
    ] as const;
    for (const [mode, outcome] of cases) {
      const d = device({ record: fresh() });
      const g = fakeGpu(mode);
      const i = idle();
      const done = webgpuSecondChance(fellBack("timeout"), { memory: d.memory, gpu: g.gpu, schedule: i.schedule, log: () => {} });
      await i.run();
      if (mode === "hang") {
        await vi.advanceTimersByTimeAsync(WEBGPU_INIT_TIMEOUT_MS - 1);
        expect(g.calls.destroyed).toBe(0);
        await vi.advanceTimersByTimeAsync(1);
      }
      expect(await done, mode).toBe(outcome);
      expect(d.record(), mode).toEqual(fresh());
      if (mode === "hang") {
        g.answerLate();
        await flush();
        expect(g.calls.destroyed, "a device that comes after the deadline is destroyed").toBe(1);
      }
    }
    // No WebGPU in this browser at all.
    const d = device({ record: fresh() });
    const i = idle();
    const done = webgpuSecondChance(fellBack("error"), { memory: d.memory, gpu: null, schedule: i.schedule, log: () => {} });
    await i.run();
    expect(await done).toBe("unavailable");
    expect(d.record()).toEqual(fresh());
  });

  it("an adapter that answers after the deadline gets no device request: no GPU work once the check has failed", async () => {
    const d = device({ record: fresh() });
    const g = fakeGpu("adapter-late");
    const i = idle();
    const done = webgpuSecondChance(fellBack("timeout"), { memory: d.memory, gpu: g.gpu, schedule: i.schedule, log: () => {} });
    await i.run();
    await vi.advanceTimersByTimeAsync(WEBGPU_INIT_TIMEOUT_MS);
    expect(await done).toBe("timeout");
    g.answerLate(); // the adapter, too late
    await flush();
    expect(g.calls).toMatchObject({ adapter: 1, device: 0, destroyed: 0 });
    expect(d.record()).toEqual(fresh());
  });

  it("counts 'in time' against the start deadline: a device that answers 12 s in (past the old 8 s) is in time", async () => {
    const d = device({ record: fresh() });
    const g = fakeGpu("hang");
    const i = idle();
    const lines: string[] = [];
    const done = webgpuSecondChance(fellBack("timeout"), { memory: d.memory, gpu: g.gpu, schedule: i.schedule, log: (m) => lines.push(m) });
    await i.run();
    await vi.advanceTimersByTimeAsync(12_000);
    g.answerLate();
    expect(await done).toBe("cleared");
    expect(d.record()).toMatchObject({ second: "granted" });
    expect(lines.join("\n")).toMatch(/answered in 12\.0 s/);
  });

  it("runs once per session, and never when the session is on WebGPU or asked for WebGL2", async () => {
    const g = fakeGpu("ok");
    const i = idle();
    const d = device({ record: fresh() });
    expect(await webgpuSecondChance(fellBack(null), { memory: d.memory, gpu: g.gpu, schedule: i.schedule })).toBeNull();
    expect(i.pending()).toBe(false);
    const status = fellBack("timeout");
    const first = webgpuSecondChance(status, { memory: d.memory, gpu: g.gpu, schedule: i.schedule, log: () => {} });
    expect(await webgpuSecondChance(status, { memory: d.memory, gpu: g.gpu, schedule: i.schedule, log: () => {} })).toBeNull();
    await i.run();
    expect(await first).toBe("cleared");
    expect(await webgpuSecondChance(status, { memory: d.memory, gpu: g.gpu, schedule: i.schedule, log: () => {} })).toBeNull();
    expect(g.calls.adapter).toBe(1);
  });

  it("by default waits a few seconds after the hand-over, then for an idle moment", async () => {
    const g = fakeGpu("ok");
    const d = device({ record: fresh() });
    const idleCalls: unknown[] = [];
    vi.stubGlobal("requestIdleCallback", (cb: () => void, o: unknown) => {
      idleCalls.push(o);
      queueMicrotask(cb); // the page is idle at once
      return 1;
    });
    const done = webgpuSecondChance(fellBack("remembered"), { memory: d.memory, gpu: g.gpu, log: () => {} });
    await vi.advanceTimersByTimeAsync(4999);
    expect(idleCalls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(idleCalls).toEqual([{ timeout: 10_000 }]);
    await flush();
    expect(await done).toBe("cleared");
    vi.unstubAllGlobals();
    // A browser without requestIdleCallback just runs it after the delay.
    const d2 = device({ record: fresh() });
    const g2 = fakeGpu("ok");
    const done2 = webgpuSecondChance(fellBack("remembered"), { memory: d2.memory, gpu: g2.gpu, log: () => {} });
    await vi.advanceTimersByTimeAsync(5000);
    expect(await done2).toBe("cleared");
  });
});

describe("browserMajor", () => {
  it("reads the browser and its major version from the user agent", () => {
    expect(browserMajor("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36")).toBe("Chrome/141");
    expect(browserMajor("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/141.0.7390.37 Safari/537.36")).toBe("Chrome/141");
    expect(browserMajor("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.3537.71")).toBe("Edg/141");
    expect(browserMajor("Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:144.0) Gecko/20100101 Firefox/144.0")).toBe("Firefox/144");
    expect(browserMajor("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15")).toBe("Safari/26");
    expect(browserMajor("")).toBe("");
  });
});
