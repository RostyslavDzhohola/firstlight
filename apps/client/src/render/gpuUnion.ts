// GPU busy time per frame on WebGPU (#49, D-framerate-2). three r186 times each render pass with a
// pair of timestamps and reports a frame's GPU time as the sum of its passes' begin→end times. On a
// tile-based GPU (Apple M-series) passes overlap, so that sum ran at 3–6× the real cost (52 ms "GPU
// time" on an M1 holding 60 fps, D-view-4 marks it untrusted). The union of the same intervals (each
// moment the GPU was inside one of the frame's passes, counted once) is its real busy time; on GPUs
// that don't overlap passes it equals the sum.
//
// installPassUnion() reads the timestamps three resolves anyway (no extra GPU work): it wraps the
// pool's resolve to note the queries it is about to read, and the result buffer's mapped range to
// read the same values three reads. three's own result is unchanged.

/** The parts of three's WebGPUTimestampQueryPool this reads (three is pinned, SPEC §3). */
export interface TimestampPool {
  /** uid (`<context id>:f<frame>`) → index of its begin timestamp (end = +1). */
  queryOffsets: Map<string, number>;
  resultBuffer: { getMappedRange(offset?: number, size?: number): ArrayBuffer };
  _resolveQueries(): Promise<number | undefined>;
}

export interface FrameUnion {
  frame: number;
  /** Time the GPU spent inside at least one of the frame's passes. */
  unionMs: number;
  /** three's figure: the passes' times added up. */
  sumMs: number;
  passes: number;
}

/** Per-frame union and sum of the pass intervals in a resolved timestamp buffer (frames in first-seen order). */
export function frameUnions(times: BigUint64Array, offsets: ReadonlyMap<string, number>): FrameUnion[] {
  const byFrame = new Map<number, [bigint, bigint][]>();
  for (const [uid, at] of offsets) {
    const m = /:f(\d+)$/.exec(uid);
    if (!m || at + 1 >= times.length) continue;
    const a = times[at]!, b = times[at + 1]!;
    if (!(b > a)) continue; // empty, or a slot the GPU never wrote
    const f = Number(m[1]);
    let list = byFrame.get(f);
    if (!list) byFrame.set(f, (list = []));
    list.push([a, b]);
  }
  const out: FrameUnion[] = [];
  for (const [frame, list] of byFrame) {
    let sum = 0n;
    for (const [a, b] of list) sum += b - a;
    list.sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0));
    let union = 0n;
    let [cs, ce] = list[0]!;
    for (let i = 1; i < list.length; i++) {
      const [a, b] = list[i]!;
      if (a > ce) {
        union += ce - cs;
        cs = a;
        ce = b;
      } else if (b > ce) ce = b;
    }
    union += ce - cs;
    out.push({ frame, unionMs: Number(union) / 1e6, sumMs: Number(sum) / 1e6, passes: list.length });
  }
  return out;
}

const installed = new WeakSet<object>();

/**
 * Report each frame's GPU busy time (ms) to `onFrame` whenever three resolves `pool`'s timestamps.
 * Once per pool; false when the pool lacks three's fields (nothing changed).
 */
export function installPassUnion(pool: TimestampPool, onFrame: (unionMs: number) => void): boolean {
  if (!pool || !(pool.queryOffsets instanceof Map) || typeof pool._resolveQueries !== "function" || typeof pool.resultBuffer?.getMappedRange !== "function") return false;
  if (installed.has(pool)) return true;
  installed.add(pool);
  let reading: Map<string, number> | null = null;
  const resolve = pool._resolveQueries;
  pool._resolveQueries = function (this: TimestampPool) {
    reading = new Map(this.queryOffsets); // what three is about to read (it clears its own map)
    return resolve.call(this);
  };
  const buffer = pool.resultBuffer;
  const getMappedRange = buffer.getMappedRange;
  buffer.getMappedRange = function (this: typeof buffer, offset?: number, size?: number) {
    const range = getMappedRange.call(this, offset, size);
    const offsets = reading;
    reading = null;
    if (offsets && offsets.size) {
      try {
        for (const f of frameUnions(new BigUint64Array(range), offsets)) onFrame(f.unionMs);
      } catch {
        /* measurement only: never break three's resolve */
      }
    }
    return range;
  };
  return true;
}
