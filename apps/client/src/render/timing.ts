// Frame timing helpers: GPU timestamp queries (WebGPU 'timestamp-query' or WebGL2
// EXT_disjoint_timer_query_webgl2 through three's trackTimestamp), percentiles, and the runtime
// resolution ladder (SPEC §7.3: [1, 0.79, 0.62, 0.5]; at the floor, drop a tier).

import type * as THREE from "three/webgpu";

export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.floor(p * (s.length - 1) + 0.5)));
  return s[i]!;
}

/**
 * Per-frame GPU time from three's timestamp pool. `resolveTimestampsAsync` returns the summed
 * duration of every timed pass since the previous resolve, so we divide by the frames it covers.
 */
export class GpuTimer {
  /** Most recent GPU ms per frame, or null when the backend has no timer. */
  last: number | null = null;
  private pending = false;
  private framesSinceResolve = 0;
  private readonly samples: number[] = [];
  readonly available: boolean;

  constructor(private readonly renderer: THREE.WebGPURenderer) {
    const b = renderer.backend as unknown as { trackTimestamp?: boolean; disjoint?: unknown; isWebGPUBackend?: boolean };
    // WebGPU: trackTimestamp is cleared at init when the feature is missing. WebGL2: needs the disjoint extension.
    this.available = !!b.trackTimestamp && (b.isWebGPUBackend ? true : !!b.disjoint);
  }

  /** Call once after each rendered frame. */
  frame() {
    if (!this.available) return;
    this.framesSinceResolve++;
    if (this.pending) return;
    this.pending = true;
    const frames = this.framesSinceResolve;
    this.framesSinceResolve = 0;
    this.renderer
      .resolveTimestampsAsync("render")
      .then((ms) => {
        if (typeof ms === "number" && ms > 0 && Number.isFinite(ms)) {
          this.last = ms / Math.max(1, frames);
          this.samples.push(this.last);
          if (this.samples.length > 240) this.samples.shift();
        }
      })
      .catch(() => {})
      .finally(() => {
        this.pending = false;
      });
  }

  p50(): number | null {
    return this.samples.length ? percentile(this.samples, 0.5) : null;
  }

  /** Start a fresh measurement window (returns the samples collected since the last call). */
  drain(): number[] {
    const s = this.samples.splice(0, this.samples.length);
    return s;
  }
}

export const LADDER = [1, 0.79, 0.62, 0.5] as const;

/**
 * Runtime resolution ladder. Looks at 2 s windows: GPU p50 when a timer exists, else rAF p50
 * (vsync-limited, so it can only detect "too slow"). Steps down after two slow windows, up after
 * four fast ones (GPU timer only, or rAF comfortably at refresh rate). At the floor it asks the
 * owner to drop a tier.
 */
export class ResolutionLadder {
  index = 0;
  enabled = true;
  private frameMs: number[] = [];
  private windowStart = 0;
  private slow = 0;
  private fast = 0;
  private cooldownUntil = 0;
  onChange: (() => void) | null = null;
  onFloor: (() => void) | null = null;

  get scale(): number {
    return LADDER[this.index]!;
  }

  reset() {
    this.index = 0;
    this.slow = this.fast = 0;
    this.frameMs = [];
    this.windowStart = 0;
  }

  sample(now: number, frameMs: number, gpuMs: number | null, targetMs: number) {
    if (!this.enabled) return;
    if (frameMs > 0 && frameMs < 250) this.frameMs.push(frameMs);
    if (this.windowStart === 0) this.windowStart = now;
    if (now - this.windowStart < 2000) return;
    this.windowStart = now;
    if (now < this.cooldownUntil || this.frameMs.length < 20) {
      this.frameMs = [];
      return;
    }
    const rafP50 = percentile(this.frameMs, 0.5);
    this.frameMs = [];
    let isSlow: boolean;
    let isFast: boolean;
    if (gpuMs !== null) {
      isSlow = gpuMs > targetMs * 1.15 && rafP50 > 17.5;
      isFast = gpuMs < targetMs * 0.6;
    } else {
      isSlow = rafP50 > 20;
      isFast = rafP50 < 17.2;
    }
    if (isSlow) {
      this.fast = 0;
      if (++this.slow >= 2) {
        this.slow = 0;
        if (this.index < LADDER.length - 1) {
          this.index++;
          this.cooldownUntil = now + 3000;
          this.onChange?.();
        } else {
          this.cooldownUntil = now + 6000;
          this.onFloor?.();
        }
      }
    } else if (isFast) {
      this.slow = 0;
      if (++this.fast >= 4 && this.index > 0) {
        this.fast = 0;
        this.index--;
        this.cooldownUntil = now + 4000;
        this.onChange?.();
      }
    } else {
      this.slow = Math.max(0, this.slow - 1);
      this.fast = 0;
    }
  }
}
