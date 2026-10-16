// Countdown for the tutorial's end card ("You're ready"). It only runs while the player can actually
// see and use the game: behind a loading screen (the last step is walking into a portal, so the card
// is shown just before the travel), in the pause menu, in a panel, in photo mode or in a background
// tab the time stands still, and it goes on from where it stopped. Pure logic: the clock and the
// visibility check are injected (OnboardingClient passes performance.now and Input.inPlay).

export interface DoneCardTimerOptions {
  /** Visible, playable time the card stays up, in ms. */
  durationMs: number;
  /** Milliseconds on any monotonic clock (performance.now). */
  now: () => number;
  /** The game is on screen and playable right now: no loading screen, pause menu, panel or hidden tab. */
  visible: () => boolean;
  /** One tick counts at most this much, so a long hitch (shader warm-up right after arriving) can't eat the card. */
  maxStepMs?: number;
}

export class DoneCardTimer {
  private readonly o: DoneCardTimerOptions;
  private readonly maxStepMs: number;
  private left = 0;
  private lastAt = 0;
  private on = false;

  constructor(o: DoneCardTimerOptions) {
    this.o = o;
    this.maxStepMs = o.maxStepMs ?? 500;
  }

  /** The card is up and a countdown is pending or running (until it runs out or `stop()`). */
  get running(): boolean {
    return this.on;
  }

  /** Visible time still to go, in ms (the full duration until the game is first visible). */
  get remainingMs(): number {
    return this.on ? this.left : 0;
  }

  /** The card just appeared: full time, counted from the next visible tick. */
  start(): void {
    this.on = true;
    this.left = this.o.durationMs;
    this.lastAt = this.o.now();
  }

  stop(): void {
    this.on = false;
    this.left = 0;
  }

  /** Call every frame (or on a short interval). Counts the time since the last call while visible;
   *  true once the card's time is up (it keeps returning true until `stop()`/`start()`). */
  tick(): boolean {
    if (!this.on) return false;
    const t = this.o.now();
    const dt = Math.max(0, t - this.lastAt);
    this.lastAt = t;
    if (this.o.visible()) this.left -= Math.min(dt, this.maxStepMs);
    return this.left <= 0;
  }
}
