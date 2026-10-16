import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  initWithin, sessionBackendMemory, startRenderer, WEBGPU_INIT_TIMEOUT_MS, WEBGPU_SKIPPED_KEY,
  type BackendMemory, type Startable,
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

describe("sessionBackendMemory", () => {
  function fakeStorage(init: Record<string, string> = {}) {
    const m = new Map(Object.entries(init));
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
  }

  it("round-trips through sessionStorage", () => {
    vi.stubGlobal("sessionStorage", fakeStorage());
    const mem = sessionBackendMemory();
    expect(mem.webgpuSkipped()).toBe(false);
    mem.rememberWebgpuSkipped();
    expect(sessionStorage.getItem(WEBGPU_SKIPPED_KEY)).toBe("1");
    expect(sessionBackendMemory().webgpuSkipped()).toBe(true);
  });

  it("tolerates storage that throws or is missing (private mode, node)", () => {
    vi.stubGlobal("sessionStorage", {
      getItem() {
        throw new Error("denied");
      },
      setItem() {
        throw new Error("denied");
      },
    });
    const mem = sessionBackendMemory();
    expect(mem.webgpuSkipped()).toBe(false);
    expect(() => mem.rememberWebgpuSkipped()).not.toThrow();
    vi.unstubAllGlobals();
    expect(sessionBackendMemory().webgpuSkipped()).toBe(false); // no sessionStorage at all
  });
});
