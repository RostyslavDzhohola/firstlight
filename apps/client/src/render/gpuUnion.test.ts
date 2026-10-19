// GPU busy time per frame from WebGPU pass timestamps (#49, D-framerate-2): the union of the frame's
// pass intervals, which on tile-based GPUs overlap (three sums them).

import { describe, expect, it } from "vitest";
import { frameUnions, installPassUnion, type TimestampPool } from "./gpuUnion.ts";

const ns = (ms: number) => BigInt(Math.round(ms * 1e6));

/** A resolved timestamp buffer and three's query offsets (uid `<context>:f<frame>` → first of 2 slots). */
function resolved(passes: { uid: string; begin: number; end: number }[]): { times: BigUint64Array; offsets: Map<string, number> } {
  const times = new BigUint64Array(passes.length * 2);
  const offsets = new Map<string, number>();
  passes.forEach((p, i) => {
    times[i * 2] = ns(p.begin);
    times[i * 2 + 1] = ns(p.end);
    offsets.set(p.uid, i * 2);
  });
  return { times, offsets };
}

describe("frameUnions", () => {
  it("counts overlapping passes once and gaps not at all, per frame", () => {
    const { times, offsets } = resolved([
      { uid: "12:f7", begin: 100, end: 104 }, // shadow map
      { uid: "3:f7", begin: 101, end: 109 }, // scene pass, overlapping it (tile-based GPU)
      { uid: "5:f7", begin: 111, end: 112 }, // post, after a 2 ms gap
      { uid: "12:f8", begin: 120, end: 121.5 },
      { uid: "3:f8", begin: 121, end: 126 },
    ]);
    const f = frameUnions(times, offsets);
    expect(f.map((x) => x.frame)).toEqual([7, 8]);
    expect(f[0]!.unionMs).toBeCloseTo(10, 6); // 100–109 and 111–112
    expect(f[0]!.sumMs).toBeCloseTo(13, 6); // what three reports
    expect(f[0]!.passes).toBe(3);
    expect(f[1]!.unionMs).toBeCloseTo(6, 6);
    expect(f[1]!.sumMs).toBeCloseTo(6.5, 6);
  });

  it("handles nested and out-of-order passes, and skips empty or reversed ones", () => {
    const { times, offsets } = resolved([
      { uid: "a:f1", begin: 5, end: 6 },
      { uid: "b:f1", begin: 0, end: 10 }, // contains the first
      { uid: "c:f1", begin: 9, end: 9 }, // empty
      { uid: "d:f1", begin: 12, end: 11 }, // reversed (an unwritten slot)
    ]);
    const [f] = frameUnions(times, offsets);
    expect(f!.unionMs).toBeCloseTo(10, 6);
    expect(f!.passes).toBe(2);
  });

  it("ignores uids without a frame tag", () => {
    const { times, offsets } = resolved([{ uid: "odd", begin: 0, end: 1 }]);
    expect(frameUnions(times, offsets)).toEqual([]);
  });
});

/** A stand-in for three's WebGPUTimestampQueryPool: resolve maps the result buffer, then reads it. */
interface FakePool {
  queryOffsets: Map<string, number>;
  resultBuffer: { mapState: string; getMappedRange(o: number, size: number): ArrayBuffer };
  reads: number;
  _resolveQueries(): Promise<number>;
}

function fakePool(passes: { uid: string; begin: number; end: number }[]): FakePool {
  const { times, offsets } = resolved(passes);
  const pool: FakePool = {
    queryOffsets: new Map(offsets),
    resultBuffer: {
      mapState: "unmapped",
      getMappedRange: (_o: number, size: number) => (times.buffer as ArrayBuffer).slice(0, size),
    },
    reads: 0,
    async _resolveQueries(this: FakePool) {
      const bytes = this.queryOffsets.size * 16;
      this.queryOffsets.clear(); // three resets its offsets before the GPU work
      await Promise.resolve();
      new BigUint64Array(this.resultBuffer.getMappedRange(0, bytes));
      this.reads++;
      return 42; // three's sum
    },
  };
  return pool;
}

describe("installPassUnion", () => {
  it("reports each resolved frame's union and leaves three's own result alone", async () => {
    const pool = fakePool([
      { uid: "1:f3", begin: 0, end: 4 },
      { uid: "2:f3", begin: 1, end: 6 },
    ]);
    const got: number[] = [];
    expect(installPassUnion(pool as unknown as TimestampPool, (u) => got.push(u))).toBe(true);
    expect(installPassUnion(pool as unknown as TimestampPool, () => {})).toBe(true); // once per pool
    expect(await pool._resolveQueries()).toBe(42);
    expect(pool.reads).toBe(1);
    expect(got).toHaveLength(1);
    expect(got[0]).toBeCloseTo(6, 6);
    // the next resolve with nothing new reports nothing
    expect(await pool._resolveQueries()).toBe(42);
    expect(got).toHaveLength(1);
  });

  it("does nothing on a pool without three's fields", () => {
    expect(installPassUnion({} as TimestampPool, () => {})).toBe(false);
  });
});
