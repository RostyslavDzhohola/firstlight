// The hologram board's data feed (D-gfx-hub-3, review A3): GET /api/home, but only while the board
// is on. Off (the Holo toggle, `?noholo`, offline) it asks for nothing and drops a request already
// under way; back on, it asks again if what it has is older than the refresh interval. No DOM, no three.

import type { HomeData } from "@firstlight/shared/net/home";
import { HOLO_REFRESH_MS } from "./holoBoardModel.ts";

/** A request with no answer after this long is dropped (ms). */
export const HOLO_FETCH_TIMEOUT_MS = 8000;

type Fetch = (url: string, init: { signal: AbortSignal }) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

export class HoloFeed {
  private enabled = false;
  private disposed = false;
  /** The next request may start at this time (ms, the caller's clock). */
  private due = 0;
  private flight: { ctl: AbortController; timer: ReturnType<typeof setTimeout> } | null = null;

  constructor(
    private readonly url: string,
    private readonly onData: (data: HomeData) => void,
    private readonly fetchFn: Fetch = (u, init) => fetch(u, init),
    private readonly refreshMs = HOLO_REFRESH_MS,
  ) {}

  /** A request is under way. */
  get busy(): boolean {
    return this.flight !== null;
  }

  /**
   * The board's resolved state. Off drops the request under way (its answer is never used, and the
   * data counts as stale: turning the board on again asks at once).
   */
  setEnabled(on: boolean, now: number) {
    if (on === this.enabled || this.disposed) return;
    this.enabled = on;
    if (on) this.tick(now);
    else if (this.cancel()) this.due = 0;
  }

  /** Once a frame while the board lives: asks when it is on and its data is due. */
  tick(now: number) {
    if (!this.enabled || this.disposed || this.flight || now < this.due) return;
    this.due = now + this.refreshMs;
    void this.load();
  }

  dispose() {
    this.disposed = true;
    this.cancel();
  }

  private cancel(): boolean {
    const f = this.flight;
    if (!f) return false;
    this.flight = null;
    clearTimeout(f.timer);
    f.ctl.abort();
    return true;
  }

  private async load() {
    const ctl = new AbortController();
    const flight = { ctl, timer: setTimeout(() => ctl.abort(), HOLO_FETCH_TIMEOUT_MS) };
    this.flight = flight;
    try {
      const r = await this.fetchFn(this.url, { signal: ctl.signal });
      if (!r.ok || this.flight !== flight) return;
      const data = (await r.json()) as HomeData;
      if (this.flight === flight) this.onData(data);
    } catch {
      /* the board keeps what it has */
    } finally {
      if (this.flight === flight) {
        clearTimeout(flight.timer);
        this.flight = null;
      }
    }
  }
}
