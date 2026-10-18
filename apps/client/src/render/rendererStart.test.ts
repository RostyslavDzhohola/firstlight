import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  browserMajor, deviceBackendMemory, initWithin, startRenderer, WEBGPU_FAILED_KEY, WEBGPU_INIT_TIMEOUT_MS, WEBGPU_RETRY_MS,
  type BackendMemory, type DeviceMemoryEnv, type Startable, type StorageLike,
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
    expect(String(info.mock.calls[0]![0])).toMatch(/WebGPU did not start within 8 s/);
    expect(error).not.toHaveBeenCalled();
  });

  it("uses an 8 s deadline by default", () => {
    expect(WEBGPU_INIT_TIMEOUT_MS).toBe(8000);
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
async function load(d: ReturnType<typeof device>, opts: { forceWebGPU?: boolean; forceWebGL?: boolean; webgpu: "ready" | "hang" | "reject" | "untried" }) {
  const h = harness();
  const started = startRenderer({ create: h.create, forceWebGL: !!opts.forceWebGL, forceWebGPU: opts.forceWebGPU, memory: d.memory, log: h.log });
  await flush();
  const first = h.made[0]!;
  const triedWebgpu = !first.forceWebGL;
  if (triedWebgpu) {
    if (opts.webgpu === "ready") first.resolve();
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
  it("a fresh record for this browser and GPU skips WebGPU: no 8 s wait", async () => {
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
