// Pure measuring helpers for the E2E hook (debug/e2eHook.ts): a frame-time ring buffer, frame
// statistics, canvas luma, flash (blink) detection, DOM flap detection and camera-space aiming. No DOM,
// no three: unit-tested in node (e2eProbe.test.ts).

/** Fixed-size ring of (time, value) pairs. Allocation-free after construction. */
export class Ring {
  private readonly t: Float64Array;
  private readonly v: Float32Array;
  private head = 0;
  private count = 0;

  constructor(readonly size: number) {
    this.t = new Float64Array(size);
    this.v = new Float32Array(size);
  }

  push(t: number, v: number) {
    this.t[this.head] = t;
    this.v[this.head] = v;
    this.head = (this.head + 1) % this.size;
    if (this.count < this.size) this.count++;
  }

  clear() {
    this.head = this.count = 0;
  }

  get length(): number {
    return this.count;
  }

  /** Entries with time ≥ `since`, oldest first. */
  since(since = -Infinity): { t: number; v: number }[] {
    const out: { t: number; v: number }[] = [];
    const start = (this.head - this.count + this.size) % this.size;
    for (let i = 0; i < this.count; i++) {
      const k = (start + i) % this.size;
      if (this.t[k]! >= since) out.push({ t: this.t[k]!, v: this.v[k]! });
    }
    return out;
  }
}

export interface FrameStats {
  frames: number;
  /** Wall time covered (ms). */
  spanMs: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  /** Frames longer than 50 / 100 / 250 ms. */
  over50: number;
  over100: number;
  over250: number;
  /** Start time and length of the 5 longest frames (ms). */
  worst: { t: number; ms: number }[];
}

function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
}

/** Statistics over requestAnimationFrame deltas (`v` = ms since the previous frame, `t` = frame time). */
export function frameStats(frames: { t: number; v: number }[]): FrameStats {
  const ms = frames.map((f) => f.v);
  const sorted = [...ms].sort((a, b) => a - b);
  const worst = [...frames].sort((a, b) => b.v - a.v).slice(0, 5).map((f) => ({ t: Math.round(f.t), ms: Math.round(f.v * 10) / 10 }));
  return {
    frames: ms.length,
    spanMs: frames.length ? Math.round(frames[frames.length - 1]!.t - frames[0]!.t + frames[0]!.v) : 0,
    p50: quantile(sorted, 0.5),
    p95: quantile(sorted, 0.95),
    p99: quantile(sorted, 0.99),
    max: sorted.length ? sorted[sorted.length - 1]! : 0,
    over50: ms.filter((x) => x > 50).length,
    over100: ms.filter((x) => x > 100).length,
    over250: ms.filter((x) => x > 250).length,
    worst,
  };
}

/** Mean Rec. 601 luma (0–255) of RGBA pixels. */
export function meanLuma(rgba: ArrayLike<number>): number {
  let sum = 0;
  const n = Math.floor(rgba.length / 4);
  for (let i = 0; i < n; i++) sum += 0.299 * rgba[i * 4]! + 0.587 * rgba[i * 4 + 1]! + 0.114 * rgba[i * 4 + 2]!;
  return n ? sum / n : 0;
}

export interface Flash {
  /** Time of the odd sample. */
  t: number;
  /** Luma jump into the odd sample (positive: a bright flash, negative: a dark blink). */
  jump: number;
  /** Samples it lasted before the picture came back. */
  samples: number;
}

/**
 * Blinks in a luma series: the picture jumps by more than `threshold` and comes back (within a third
 * of the threshold of where it was) within `maxSamples` samples. A lasting change (walking into shade,
 * turning toward the sun) is not a blink. The owner's recording showed +72 then −72 in one frame.
 */
export function detectFlashes(series: { t: number; v: number }[], threshold = 40, maxSamples = 3): Flash[] {
  const out: Flash[] = [];
  for (let i = 1; i < series.length; i++) {
    const before = series[i - 1]!.v;
    const jump = series[i]!.v - before;
    if (Math.abs(jump) < threshold) continue;
    for (let k = 1; k <= maxSamples && i + k < series.length; k++) {
      if (Math.abs(series[i + k]!.v - before) <= threshold / 3) {
        out.push({ t: series[i]!.t, jump: Math.round(jump), samples: k });
        i += k;
        break;
      }
    }
  }
  return out;
}

/** An element whose `hidden` (or display) flipped twice within `windowMs`: something on screen blinked. */
export function detectFlaps(toggles: { t: number; key: string }[], windowMs = 250): { key: string; t: number; gapMs: number }[] {
  const last = new Map<string, number>();
  const out: { key: string; t: number; gapMs: number }[] = [];
  for (const x of toggles) {
    const prev = last.get(x.key);
    if (prev !== undefined && x.t - prev <= windowMs) out.push({ key: x.key, t: Math.round(x.t), gapMs: Math.round(x.t - prev) });
    last.set(x.key, x.t);
  }
  return out;
}

/** Column-major 4×4 (three.js `Matrix4.elements`) times (x, y, z, 1). */
export function transform(m: ArrayLike<number>, x: number, y: number, z: number): [number, number, number, number] {
  return [
    m[0]! * x + m[4]! * y + m[8]! * z + m[12]!,
    m[1]! * x + m[5]! * y + m[9]! * z + m[13]!,
    m[2]! * x + m[6]! * y + m[10]! * z + m[14]!,
    m[3]! * x + m[7]! * y + m[11]! * z + m[15]!,
  ];
}

export interface ScreenAim {
  /** In front of the camera and inside the picture. */
  onScreen: boolean;
  /** Normalised device coordinates (−1…1, +y up); null behind the camera. */
  ndc: [number, number] | null;
  /** Radians to turn right (+) / look up (+) to put the point under the crosshair (screen centre). */
  yaw: number;
  pitch: number;
}

/** Where a world point is relative to the camera (`view` = matrixWorldInverse, `proj` = projectionMatrix). */
export function screenAim(view: ArrayLike<number>, proj: ArrayLike<number>, x: number, y: number, z: number): ScreenAim {
  const [cx, cy, cz] = transform(view, x, y, z);
  const yaw = Math.atan2(cx, -cz);
  const pitch = Math.atan2(cy, Math.hypot(cx, cz));
  if (cz >= 0) return { onScreen: false, ndc: null, yaw, pitch };
  const [px, py, , pw] = transform(proj, cx, cy, cz);
  const nx = px / pw;
  const ny = py / pw;
  return { onScreen: Math.abs(nx) <= 1 && Math.abs(ny) <= 1, ndc: [nx, ny], yaw, pitch };
}
