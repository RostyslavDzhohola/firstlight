// The pause menu's look switch (Kappa and Unit 7 have two looks). The server's PlayerState.look is
// the truth: a click sends one `look` request and the menu shows it as pending (controls disabled)
// until the server's look matches, or until the request times out (refused, or lost), when the menu
// falls back to the server's look. Requests are spaced so that at most two land in any one-second
// window of the server's rate cap (MESSAGE_RATES.look = 2), so a quick B → A → B is never dropped.
// Pure (no DOM): unit-tested in lookSwitch.test.ts.

export const LOOK_SWITCH = {
  /** Minimum time between two requests (ms): 2 per server window at most. */
  minGapMs: 550,
  /** A request the server hasn't confirmed by then is given up (ms). */
  timeoutMs: 1500,
} as const;

export interface LookSwitchView {
  /** The look to show selected. */
  look: number;
  /** A request is in flight or the spacing hasn't passed: the controls take no clicks. */
  busy: boolean;
}

export class LookSwitch {
  private pending: { look: number; at: number } | null = null;
  private lastSent = Number.NEGATIVE_INFINITY;

  /** A click on `look` while the server says `server`: true when the request should be sent now. */
  request(look: number, server: number, now: number): boolean {
    this.settle(server, now);
    if (this.pending || look === server || now - this.lastSent < LOOK_SWITCH.minGapMs) return false;
    this.pending = { look, at: now };
    this.lastSent = now;
    return true;
  }

  /** What the menu shows for the server's current look. */
  view(server: number, now: number): LookSwitchView {
    this.settle(server, now);
    if (this.pending) return { look: this.pending.look, busy: true };
    return { look: server, busy: now - this.lastSent < LOOK_SWITCH.minGapMs };
  }

  private settle(server: number, now: number) {
    if (this.pending && (server === this.pending.look || now - this.pending.at > LOOK_SWITCH.timeoutMs)) this.pending = null;
  }
}
