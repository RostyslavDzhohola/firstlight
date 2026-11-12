// The board's feed asks only while the board is on (review A3).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HomeData } from "@firstlight/shared/net/home";
import { HOLO_FETCH_TIMEOUT_MS, HoloFeed } from "./holoFeed.ts";

const REFRESH = 1000;
const DATA = { online: { total: 3 } } as unknown as HomeData;

/** A server whose answers the test releases; it records each request and whether it was aborted. */
function server() {
  const calls: { signal: AbortSignal; answer(ok?: boolean): void }[] = [];
  const fetchFn = (_url: string, init: { signal: AbortSignal }) =>
    new Promise<{ ok: boolean; json(): Promise<unknown> }>((resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      calls.push({ signal: init.signal, answer: (ok = true) => resolve({ ok, json: async () => DATA }) });
    });
  return { calls, fetchFn };
}

const settle = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => void vi.useFakeTimers());
afterEach(() => void vi.useRealTimers());

describe("HoloFeed", () => {
  it("asks for nothing while the board is off, however long it lives", () => {
    const { calls, fetchFn } = server();
    const feed = new HoloFeed("/api/home", () => {}, fetchFn, REFRESH);
    for (let now = 0; now < REFRESH * 20; now += 16) feed.tick(now);
    expect(calls).toHaveLength(0);
    feed.dispose();
  });

  it("asks when turned on, hands the data over, then again only once it is due", async () => {
    const { calls, fetchFn } = server();
    const got: HomeData[] = [];
    const feed = new HoloFeed("/api/home", (d) => got.push(d), fetchFn, REFRESH);
    feed.setEnabled(true, 0);
    expect(calls).toHaveLength(1);
    expect(feed.busy).toBe(true);
    feed.tick(16); // nothing new while one is under way
    expect(calls).toHaveLength(1);
    calls[0]!.answer();
    await settle();
    expect(got).toEqual([DATA]);
    expect(feed.busy).toBe(false);
    feed.tick(REFRESH - 1);
    expect(calls).toHaveLength(1);
    feed.tick(REFRESH);
    expect(calls).toHaveLength(2);
    feed.dispose();
  });

  it("turning it off aborts the request under way and its answer is never used", async () => {
    const { calls, fetchFn } = server();
    const got: HomeData[] = [];
    const feed = new HoloFeed("/api/home", (d) => got.push(d), fetchFn, REFRESH);
    feed.setEnabled(true, 0);
    feed.setEnabled(false, 10);
    expect(calls[0]!.signal.aborted).toBe(true);
    expect(feed.busy).toBe(false);
    calls[0]!.answer();
    await settle();
    expect(got).toHaveLength(0);
    for (let now = 10; now < REFRESH * 5; now += 16) feed.tick(now);
    expect(calls).toHaveLength(1);
    // Back on: the aborted request left the data stale, so it asks at once.
    feed.setEnabled(true, 20);
    expect(calls).toHaveLength(2);
    calls[1]!.answer();
    await settle();
    expect(got).toEqual([DATA]);
    feed.dispose();
  });

  it("back on with fresh data it waits; with stale data it asks at once", async () => {
    const { calls, fetchFn } = server();
    const feed = new HoloFeed("/api/home", () => {}, fetchFn, REFRESH);
    feed.setEnabled(true, 0);
    calls[0]!.answer();
    await settle();
    feed.setEnabled(false, 100);
    feed.setEnabled(true, 200); // still fresh
    expect(calls).toHaveLength(1);
    feed.setEnabled(false, 300);
    feed.setEnabled(true, REFRESH + 5); // stale by now
    expect(calls).toHaveLength(2);
    feed.dispose();
  });

  it("dispose aborts the request under way; a late answer changes nothing", async () => {
    const { calls, fetchFn } = server();
    const got: HomeData[] = [];
    const feed = new HoloFeed("/api/home", (d) => got.push(d), fetchFn, REFRESH);
    feed.setEnabled(true, 0);
    feed.dispose();
    expect(calls[0]!.signal.aborted).toBe(true);
    calls[0]!.answer();
    await settle();
    expect(got).toHaveLength(0);
    feed.tick(REFRESH * 3);
    feed.setEnabled(true, REFRESH * 3);
    expect(calls).toHaveLength(1);
  });

  it("a request with no answer is dropped after the timeout and retried when next due", async () => {
    const { calls, fetchFn } = server();
    const feed = new HoloFeed("/api/home", () => {}, fetchFn, HOLO_FETCH_TIMEOUT_MS * 2);
    feed.setEnabled(true, 0);
    await vi.advanceTimersByTimeAsync(HOLO_FETCH_TIMEOUT_MS + 1);
    expect(calls[0]!.signal.aborted).toBe(true);
    expect(feed.busy).toBe(false);
    feed.tick(HOLO_FETCH_TIMEOUT_MS * 2);
    expect(calls).toHaveLength(2);
    feed.dispose();
  });

  it("a refused answer keeps what the board has", async () => {
    const { calls, fetchFn } = server();
    const got: HomeData[] = [];
    const feed = new HoloFeed("/api/home", (d) => got.push(d), fetchFn, REFRESH);
    feed.setEnabled(true, 0);
    calls[0]!.answer(false);
    await settle();
    expect(got).toHaveLength(0);
    expect(feed.busy).toBe(false);
    feed.dispose();
  });
});
