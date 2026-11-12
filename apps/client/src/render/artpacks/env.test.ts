// The strip worker's client (env.ts stripDecoder): jobs by id, a worker that fails or hangs fails
// every job it holds and is replaced, so the group's own cleanup and retry (ArtPacks) take over.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STRIP_DECODE_TIMEOUT_MS, stripDecoder, type StripWorker } from "./env.ts";
import type { StripJob, StripResult } from "./strip.worker.ts";

class FakeWorker implements StripWorker {
  static made: FakeWorker[] = [];
  onmessage: ((e: MessageEvent<StripResult>) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  onmessageerror: ((e: MessageEvent) => void) | null = null;
  jobs: StripJob[] = [];
  terminated = false;
  constructor() {
    FakeWorker.made.push(this);
  }
  postMessage(job: StripJob) {
    this.jobs.push(job);
  }
  terminate() {
    this.terminated = true;
  }
  answer(id: number, data = new ArrayBuffer(4)) {
    this.onmessage?.({ data: { id, data } } as MessageEvent<StripResult>);
  }
}

const blob = new Blob([new Uint8Array(4)]);
const settled = <T,>(p: Promise<T>) => p.then((v) => ({ ok: v }), (e: unknown) => ({ err: e as Error }));

describe("stripDecoder (the HD strips' decode worker)", () => {
  beforeEach(() => {
    FakeWorker.made = [];
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());
  const decoder = () => stripDecoder(() => new FakeWorker());

  it("answers each job by its id, from one worker", async () => {
    const decode = decoder();
    const a = decode(blob, 1024, 16, 2, new AbortController().signal);
    const b = decode(blob, 1024, 9, 1, new AbortController().signal);
    const w = FakeWorker.made[0]!;
    expect(FakeWorker.made).toHaveLength(1);
    w.answer(w.jobs[1]!.id, new ArrayBuffer(8));
    w.answer(w.jobs[0]!.id, new ArrayBuffer(4));
    expect((await a).byteLength).toBe(4);
    expect((await b).byteLength).toBe(8);
  });

  it("a worker error fails every job it holds and the next job gets a fresh worker", async () => {
    const decode = decoder();
    const a = settled(decode(blob, 1024, 16, 2, new AbortController().signal));
    const b = settled(decode(blob, 1024, 16, 2, new AbortController().signal));
    const w = FakeWorker.made[0]!;
    const ev = { message: "boom", preventDefault: vi.fn() } as unknown as ErrorEvent;
    w.onerror!(ev);
    expect((await a)).toMatchObject({ err: { message: expect.stringContaining("boom") } });
    expect((await b)).toHaveProperty("err");
    expect(w.terminated).toBe(true);
    const c = decode(blob, 1024, 16, 2, new AbortController().signal);
    expect(FakeWorker.made).toHaveLength(2);
    const fresh = FakeWorker.made[1]!;
    fresh.answer(fresh.jobs[0]!.id);
    expect((await c).byteLength).toBe(4);
  });

  it("a message that can't be read (messageerror) does the same", async () => {
    const decode = decoder();
    const a = settled(decode(blob, 1024, 16, 2, new AbortController().signal));
    FakeWorker.made[0]!.onmessageerror!({} as MessageEvent);
    expect(await a).toHaveProperty("err");
    expect(FakeWorker.made[0]!.terminated).toBe(true);
  });

  it("a decode past its deadline fails, and the hung worker is replaced", async () => {
    const decode = decoder();
    const a = settled(decode(blob, 1024, 16, 2, new AbortController().signal));
    await vi.advanceTimersByTimeAsync(STRIP_DECODE_TIMEOUT_MS - 1);
    expect(FakeWorker.made[0]!.terminated).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await a).toMatchObject({ err: { message: expect.stringContaining("deadline") } });
    expect(FakeWorker.made[0]!.terminated).toBe(true);
    // a late answer from the old worker is ignored; a new job goes to a new worker
    FakeWorker.made[0]!.answer(1);
    void decode(blob, 1024, 16, 2, new AbortController().signal);
    expect(FakeWorker.made).toHaveLength(2);
  });

  it("an answered job's deadline is cleared; an aborted job rejects at once and its answer is dropped", async () => {
    const decode = decoder();
    const ok = decode(blob, 1024, 16, 2, new AbortController().signal);
    const w = FakeWorker.made[0]!;
    w.answer(w.jobs[0]!.id);
    await ok;
    await vi.advanceTimersByTimeAsync(STRIP_DECODE_TIMEOUT_MS * 2);
    expect(w.terminated).toBe(false);
    const ac = new AbortController();
    const gone = settled(decode(blob, 1024, 16, 2, ac.signal));
    ac.abort(new Error("paused"));
    expect(await gone).toMatchObject({ err: { message: "paused" } });
    w.answer(w.jobs[1]!.id); // lands later: nothing to do
    expect(w.terminated).toBe(false);
  });
});
