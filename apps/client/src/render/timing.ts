// Frame timing helpers: GPU timestamp queries (WebGPU 'timestamp-query' or WebGL2
// EXT_disjoint_timer_query_webgl2 through three's trackTimestamp), percentiles, the runtime
// resolution ladder (SPEC §7.3: [1, 0.79, 0.62, 0.5]; at the floor, drop a tier) and the probe's
// tier decision.

import { installPassUnion, type TimestampPool } from "./gpuUnion.ts";
import { TIER_TABLE, type Tier } from "./quality.ts";

export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.floor(p * (s.length - 1) + 0.5)));
  return s[i]!;
}

/** Largest value without spreading (no argument-count limit on long runs). */
export function maxOf(values: readonly number[]): number {
  let m = 0;
  for (const v of values) if (v > m) m = v;
  return m;
}

/** What GpuTimer needs from the renderer (a fake in tests). */
export interface TimestampSource {
  backend: unknown;
  resolveTimestampsAsync(type?: "render" | "compute"): Promise<number | undefined>;
  info: { frame: number; reset(): void };
}

/**
 * Per-frame GPU time from three's timestamp pool. In r186 `resolveTimestampsAsync` returns the GPU
 * time of the *last frame* it has queries for (queries are tagged with `renderer.info.frame`), so
 * the value is recorded as is. Resolves are asynchronous, so a sample arrives every 1–3 frames.
 * Outside the animation loop `info.frame` doesn't advance: call `beginManualFrame()` before each
 * manually rendered frame so samples stay per-frame there too.
 *
 * That value sums the frame's passes (see gpuPlausible). On WebGPU the timer also records each
 * frame's busy time, the union of the same passes' intervals (gpuUnion.ts, D-framerate-2): real GPU
 * cost on tile-based GPUs too. The probe decides on it; the ladder keeps three's sum.
 */
export class GpuTimer {
  /** Most recent GPU ms per frame, or null when the backend has no timer. */
  last: number | null = null;
  private pending = false;
  /** Rolling window for display (F3). */
  private readonly recent: number[] = [];
  /** Samples not yet taken by the ladder/probe. */
  private fresh: number[] = [];
  readonly available: boolean;
  /** Most recent GPU busy ms per frame (WebGPU pass union), or null. */
  busyLast: number | null = null;
  private readonly recentBusy: number[] = [];
  private freshBusy: number[] = [];
  /** WebGPU: waiting for three's timestamp pool (made on the first timed pass) to read its frames' busy time. */
  private watchBusy: boolean;

  constructor(private readonly renderer: TimestampSource) {
    const b = renderer.backend as { trackTimestamp?: boolean; disjoint?: unknown; isWebGPUBackend?: boolean };
    // WebGPU: trackTimestamp is cleared at init when the feature is missing. WebGL2: needs the disjoint extension.
    this.available = !!b.trackTimestamp && (b.isWebGPUBackend ? true : !!b.disjoint);
    this.watchBusy = this.available && !!b.isWebGPUBackend;
  }

  private busy(ms: number) {
    if (!(ms > 0) || !Number.isFinite(ms)) return;
    this.busyLast = ms;
    this.recentBusy.push(ms);
    if (this.recentBusy.length > 120) this.recentBusy.shift();
    this.freshBusy.push(ms);
    if (this.freshBusy.length > 600) this.freshBusy.shift();
  }

  /** Call once after each rendered frame. */
  frame() {
    if (this.watchBusy) {
      const pool = (this.renderer.backend as { timestampQueryPool?: { render?: unknown } }).timestampQueryPool?.render;
      if (pool) {
        this.watchBusy = false;
        installPassUnion(pool as TimestampPool, (ms) => this.busy(ms));
      }
    }
    if (!this.available || this.pending) return;
    this.pending = true;
    this.renderer
      .resolveTimestampsAsync("render")
      .then((ms) => {
        if (typeof ms === "number" && ms > 0 && Number.isFinite(ms)) {
          this.last = ms;
          this.recent.push(ms);
          if (this.recent.length > 120) this.recent.shift();
          this.fresh.push(ms);
          if (this.fresh.length > 600) this.fresh.shift();
        }
      })
      .catch(() => {})
      .finally(() => {
        this.pending = false;
      });
  }

  /** Median of the recent samples (display only; ~2–6 s depending on frame rate). */
  p50(): number | null {
    return this.recent.length ? percentile(this.recent, 0.5) : null;
  }

  /** Samples that arrived since the last call. */
  takeSamples(): number[] {
    const s = this.fresh;
    this.fresh = [];
    return s;
  }

  /** Start a fresh measurement: returns pending samples and clears the display window too. */
  drain(): number[] {
    this.recent.length = 0;
    return this.takeSamples();
  }

  /** Median of the recent busy-time samples (display), or null. */
  busyP50(): number | null {
    return this.recentBusy.length ? percentile(this.recentBusy, 0.5) : null;
  }

  /** Busy-time samples since the last call (clears the display window too). */
  drainBusy(): number[] {
    this.recentBusy.length = 0;
    const s = this.freshBusy;
    this.freshBusy = [];
    return s;
  }
}

/** Emulate the animation loop's per-frame bookkeeping for frames rendered manually (probe, warm-up). */
export function beginManualFrame(renderer: TimestampSource) {
  renderer.info.reset();
  renderer.info.frame++;
}

/**
 * three sums the begin→end time of every render pass in a frame. On tile-based GPUs (Apple M-series)
 * passes overlap, so that sum can be several times the real frame cost (measured 48–68 ms "GPU time"
 * on an M1 holding 60 fps). A GPU frame time can't exceed the frame interval by much in a steady
 * state, so a median over 1.25× the rAF median means the timer can't be trusted on this machine.
 */
export function gpuPlausible(gpuP50: number, rafP50: number): boolean {
  return gpuP50 <= rafP50 * 1.25;
}

export const LADDER = [1, 0.79, 0.62, 0.5] as const;

const MIN_FRAMES_PER_WINDOW = 5;
/** After a suspension (a full-screen overlay closed), samples from this long are ignored (D-view-4). */
export const LADDER_RESUME_GRACE_MS = 1000;
const UP_HOLD_INITIAL = 30_000;
const UP_HOLD_MAX = 480_000;
/**
 * "At vsync" (D-view-4): a window's frame-time median within 5% + 0.3 ms of the display's frame
 * interval, measured as the lowest window median seen (rAF can't run faster than the display).
 */
const VSYNC_TOLERANCE = 0.05;
const VSYNC_SLACK_MS = 0.3;
/** Untrusted timer: steady windows in a row before a trial up-step, and steady windows that keep it. */
const TRIAL_STEADY_WINDOWS = 4;
const TRIAL_PROBATION_WINDOWS = 2;

/**
 * Runtime resolution ladder over ≥ 2 s windows (a window stays open until it has at least
 * 5 frames, so it keeps adapting at very low frame rates).
 * - With a GPU timer: slow = GPU p50 over 1.15× the tier budget while frames also miss 60 Hz;
 *   fast = GPU p50 under 0.6× the budget. Steps up after 4 fast windows.
 * - Without one, rAF time is vsync-limited and can't show headroom: it only steps down
 *   (p50 over 20 ms); it never steps up.
 * - With an untrusted one (gpuPlausible failed: the M1), it steps down the same way, and makes a
 *   trial up-step after the hold-off and 4 windows at vsync (median within 5% + 0.3 ms of the
 *   display's frame interval, the lowest window median seen: 50, 60, 120 Hz alike). The trial is kept if
 *   the 2 windows after its cooldown stay at vsync; otherwise it steps back down at once and the
 *   hold-off doubles, so trials stay few (D-view-4).
 * Up-steps are held off after any down-step; the hold-off doubles each time an up-step is
 * followed by a quick down-step, so it can't oscillate. Windows are cleared on every change, so
 * decisions never use samples from the previous resolution. At the floor it calls `onFloor`.
 * While suspended (a full-screen overlay is up, D-view-4) samples are ignored; resuming goes back to
 * the rung held when the suspension began and ignores the first LADDER_RESUME_GRACE_MS of samples.
 * Cooldowns and hold-offs keep running in wall time.
 */
export class ResolutionLadder {
  index = 0;
  enabled = true;
  /** Whether GPU samples will arrive (enables up-steps). */
  hasGpuTimer = false;
  /** Set once GPU samples prove implausible (see gpuPlausible): frame times only from then on. */
  gpuUntrusted = false;
  private frames: number[] = [];
  private gpu: number[] = [];
  private windowStart = 0;
  private slow = 0;
  private fast = 0;
  private cooldownUntil = 0;
  private noUpUntil = 0;
  private upHold = UP_HOLD_INITIAL;
  private lastUpAt = -Infinity;
  /** A step the e2e hook asked for (+1 down, −1 up), taken at the next sample. */
  private forced: 1 | -1 | 0 = 0;
  private isSuspended = false;
  /** The rung to come back to when the suspension ends. */
  private heldIndex = 0;
  /** Resumed: the grace starts at the next sample (the ladder has no clock of its own). */
  private graceFromNext = false;
  private graceUntil = 0;
  /** Steady windows in a row (untrusted timer), and windows a trial up-step still has to pass. */
  private steady = 0;
  private probation = 0;
  /** The display's frame interval as measured: the lowest window median so far. */
  private vsyncMs = Infinity;
  /** Trial up-steps this session (untrusted timer): taken, kept after probation, reverted. */
  readonly trials = { taken: 0, kept: 0, reverted: 0 };
  onChange: (() => void) | null = null;
  onFloor: (() => void) | null = null;

  get scale(): number {
    return LADDER[this.index]!;
  }

  get suspended(): boolean {
    return this.isSuspended;
  }

  /**
   * Suspend while a full-screen overlay slows frames (the pause menu, a panel, the death screen…), and
   * resume when it closes. Either way the current window and streaks are dropped.
   */
  setSuspended(on: boolean) {
    if (on === this.isSuspended) return;
    this.isSuspended = on;
    this.slow = this.fast = this.steady = 0;
    this.clearWindow(0);
    if (on) {
      this.heldIndex = this.index;
      return;
    }
    this.graceFromNext = true;
    if (this.index !== this.heldIndex) {
      this.index = this.heldIndex;
      this.onChange?.();
    }
  }

  reset() {
    this.index = 0;
    this.heldIndex = 0; // a tier change under the menu: full resolution after it too
    this.noUpUntil = 0;
    this.upHold = UP_HOLD_INITIAL;
    this.lastUpAt = -Infinity;
    this.slow = this.fast = this.steady = this.probation = 0;
    this.clearWindow(0);
  }

  private clearWindow(now: number) {
    this.frames = [];
    this.gpu = [];
    this.windowStart = now;
  }

  /**
   * Test hook (e2e): take one step (+1 down, −1 up) at the next sample, inside the frame's bookkeeping
   * where a natural step happens. Clamped to the ladder. A step down starts the up-step hold-off like a
   * natural one; neither changes the back-off.
   */
  forceStep(dir: 1 | -1) {
    this.forced = dir;
  }

  /** Per frame: the frame interval and any GPU samples that arrived since the last call. */
  sample(now: number, frameMs: number, gpuSamples: readonly number[] | null, targetMs: number) {
    if (this.forced !== 0) {
      const next = Math.min(LADDER.length - 1, Math.max(0, this.index + this.forced));
      this.forced = 0;
      if (next === this.index) return;
      if (next > this.index) this.noUpUntil = Math.max(this.noUpUntil, now + this.upHold);
      this.index = next;
      this.heldIndex = next; // an explicit step under the menu is the rung to come back to
      this.slow = this.fast = this.steady = this.probation = 0;
      this.cooldownUntil = now + 3000;
      this.clearWindow(now);
      this.onChange?.();
      return;
    }
    if (!this.enabled || this.isSuspended) return;
    if (this.graceFromNext) {
      this.graceFromNext = false;
      this.graceUntil = now + LADDER_RESUME_GRACE_MS;
    }
    if (now < this.graceUntil) return;
    // Frames over 2 s are tab switches or loading stalls, not rendering cost.
    if (frameMs > 0 && frameMs < 2000) this.frames.push(frameMs);
    if (gpuSamples) for (const g of gpuSamples) this.gpu.push(g);
    if (this.windowStart === 0) this.windowStart = now;
    if (now - this.windowStart < 2000 || this.frames.length < MIN_FRAMES_PER_WINDOW) return;
    if (now < this.cooldownUntil) {
      this.clearWindow(now);
      return;
    }
    const rafP50 = percentile(this.frames, 0.5);
    let gpuP50 = this.hasGpuTimer && this.gpu.length >= 3 ? percentile(this.gpu, 0.5) : null;
    if (gpuP50 !== null && !gpuPlausible(gpuP50, rafP50)) {
      this.gpuUntrusted = true; // e.g. overlapping passes on tile-based GPUs: fall back to frame times
    }
    if (this.gpuUntrusted) gpuP50 = null;
    this.clearWindow(now);
    this.vsyncMs = Math.min(this.vsyncMs, rafP50);
    const steady = rafP50 <= this.vsyncMs * (1 + VSYNC_TOLERANCE) + VSYNC_SLACK_MS;
    if (this.probation > 0) {
      // After a trial up-step: kept only while the windows stay at vsync.
      this.slow = this.steady = 0;
      if (!steady) {
        this.probation = 0;
        this.trials.reverted++;
        this.stepDown(now, true);
      } else if (--this.probation === 0) this.trials.kept++;
      return;
    }
    let isSlow: boolean;
    let isFast: boolean;
    if (gpuP50 !== null) {
      isSlow = gpuP50 > targetMs * 1.15 && rafP50 > 17.5;
      isFast = gpuP50 < targetMs * 0.6;
    } else {
      isSlow = rafP50 > 20;
      isFast = false;
    }
    if (isSlow) {
      this.fast = this.steady = 0;
      if (++this.slow >= 2) {
        this.slow = 0;
        if (this.index < LADDER.length - 1) {
          this.stepDown(now);
        } else {
          this.cooldownUntil = now + 6000;
          this.onFloor?.();
        }
      }
    } else if (isFast) {
      this.slow = 0;
      if (++this.fast >= 4 && this.index > 0 && now >= this.noUpUntil) {
        this.fast = 0;
        this.stepUp(now);
      }
    } else {
      this.slow = Math.max(0, this.slow - 1);
      this.fast = 0;
      if (this.gpuUntrusted) this.trialUp(now, steady);
    }
  }

  private stepUp(now: number) {
    this.index--;
    this.lastUpAt = now;
    this.cooldownUntil = now + 4000;
    this.onChange?.();
  }

  /** `failedTrial`: a trial up-step's probation failed (however long a menu paused it). */
  private stepDown(now: number, failedTrial = false) {
    this.index++;
    this.cooldownUntil = now + 3000;
    // An up-step that didn't hold: back off twice as long next time.
    if (failedTrial || now - this.lastUpAt < this.upHold) this.upHold = Math.min(UP_HOLD_MAX, this.upHold * 2);
    this.noUpUntil = now + this.upHold;
    this.steady = 0;
    this.onChange?.();
  }

  /** Untrusted timer: frame time can't show headroom at vsync, so try the rung above after a steady hold. */
  private trialUp(now: number, steady: boolean) {
    this.steady = steady ? this.steady + 1 : 0;
    if (this.steady < TRIAL_STEADY_WINDOWS || this.index === 0 || now < this.noUpUntil) return;
    this.steady = 0;
    this.probation = TRIAL_PROBATION_WINDOWS;
    this.trials.taken++;
    this.stepUp(now);
  }
}

export interface ProbeSamples {
  /** Frame intervals (ms) at Medium. */
  raf: readonly number[];
  /** GPU ms per frame at Medium (three's figure: the passes summed). */
  gpu: readonly number[];
  /** GPU busy ms per frame at Medium (WebGPU pass union, D-framerate-2), when the timer has it. */
  busy?: readonly number[];
  gpuAvailable: boolean;
  /** document.visibilityState was "visible" for the whole measurement. */
  visible: boolean;
}

export interface ProbeDecision {
  tier: Tier;
  /** False → use Medium for this session and don't save anything. */
  valid: boolean;
  method: "gpu-busy" | "gpu-timer" | "raf" | "invalid";
  gpuP50: number | null;
  rafP50: number;
  /** Ask for a short re-probe at High (GPU timer only) to decide Ultra. */
  reprobeHigh: boolean;
}

export const PROBE_MIN_FRAMES = 30;
export const PROBE_MIN_GPU = 20;

/** The GPU p50 to decide on: busy time where there is enough of it, else three's sum if plausible. */
function gpuEvidence(gpu: readonly number[], busy: readonly number[] | undefined, rafP50: number, min: number): { g: number; method: "gpu-busy" | "gpu-timer" } | null {
  if (busy && busy.length >= min) {
    const g = percentile(busy, 0.5);
    if (gpuPlausible(g, rafP50)) return { g, method: "gpu-busy" };
  }
  if (gpu.length >= min) {
    const g = percentile(gpu, 0.5);
    if (gpuPlausible(g, rafP50)) return { g, method: "gpu-timer" };
  }
  return null;
}

/** Frame interval (ms) above which Medium's frames miss a 60 Hz display (the ladder's "slow" too). */
const MISSES_60HZ_MS = 17.5;

/**
 * SPEC §7.3 thresholds. GPU timer (busy time where there is one): p50 > 14 ms → Low, only while
 * Medium's frames also miss the display (frame rate first: a timer that reads high while frames
 * hold 60 Hz, the M1 on WebGL2, keeps Medium; D-framerate-2); < 6 ms → High (and re-probe at High),
 * else Medium. rAF only (vsync-limited): > 20 ms → Low, < 6 ms → High (very high refresh
 * displays), else Medium. Too few frames or a hidden tab → invalid (Medium, not saved).
 */
export function decideProbe(s: ProbeSamples): ProbeDecision {
  const rafP50 = percentile(s.raf, 0.5);
  if (!s.visible || s.raf.length < PROBE_MIN_FRAMES) {
    return { tier: "medium", valid: false, method: "invalid", gpuP50: null, rafP50, reprobeHigh: false };
  }
  const ev = s.gpuAvailable ? gpuEvidence(s.gpu, s.busy, rafP50, PROBE_MIN_GPU) : null;
  if (ev) {
    const { g, method } = ev;
    if (g > 14 && rafP50 > MISSES_60HZ_MS) return { tier: "low", valid: true, method, gpuP50: g, rafP50, reprobeHigh: false };
    if (g >= 6) return { tier: "medium", valid: true, method, gpuP50: g, rafP50, reprobeHigh: false };
    return { tier: "high", valid: true, method, gpuP50: g, rafP50, reprobeHigh: true };
  }
  const tier: Tier = rafP50 > 20 ? "low" : rafP50 < 6 ? "high" : "medium";
  return { tier, valid: true, method: "raf", gpuP50: null, rafP50, reprobeHigh: false };
}

/**
 * After a re-probe at High: Ultra only with clear headroom (p50 < 4 ms over ≥ 15 samples), and back
 * to Medium when High itself takes more than High's budget (frame rate first, D-framerate-1), on
 * the busy time where there are enough samples of it.
 */
export function decideUltra(highGpu: readonly number[], highBusy?: readonly number[]): { tier: Tier; gpuP50: number | null } {
  const s = highBusy && highBusy.length >= 15 ? highBusy : highGpu;
  if (s.length < 15) return { tier: "high", gpuP50: null };
  const g = percentile(s, 0.5);
  return { tier: g < 4 ? "ultra" : g > TIER_TABLE.high.gpuTargetMs ? "medium" : "high", gpuP50: g };
}
