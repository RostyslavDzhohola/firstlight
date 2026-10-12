// Arriving in a world copy (join → our player in the state → world streamed → shaders warmed) can take
// seconds, and the room can close at any point in between (F12 S5). The arrival watch remembers a
// close of the room being entered; Game checks it at every await boundary and before handing over
// control, so a lost connection turns into the reconnect path instead of an endless spinner or a
// world with no connection. Pure (no DOM, no three) and unit-tested.

import { CLOSE } from "@firstlight/shared/net/social";

/** What to do when our room closes without us leaving it. */
export type CloseAction = "ignore" | "removed" | "rejoin" | "rejoin-fresh" | "storage";

export function closeAction(code: number): CloseAction {
  if (code === CLOSE.LOGGED_OUT) return "ignore"; // the logged-out screen is up
  if (code === CLOSE.STORAGE) return "storage"; // saving failed: rejoin later, spaced out (StorageBackoff)
  if (code === CLOSE.KICKED || code === CLOSE.BANNED || code === CLOSE.ELSEWHERE) return "removed";
  if (code === CLOSE.MERGED) return "rejoin-fresh"; // saved/signed in: rejoin with a fresh token
  return "rejoin"; // network drop, server restart, anything else
}

/** The room closed (or never showed our player) while we were arriving. */
export class ConnectionLost extends Error {
  readonly action: CloseAction;

  constructor(
    readonly code: number | null,
    readonly stage: string,
    readonly timedOut = false,
  ) {
    super(timedOut ? `timed out while ${stage}` : `connection lost while ${stage}${code === null ? "" : ` (code ${code})`}`);
    this.name = "ConnectionLost";
    this.action = code === null ? "rejoin" : closeAction(code);
  }
}

/** Remembers the first close of the room being entered. Hook `onClose` to that room's leave event. */
export class ArrivalWatch {
  private code: number | null = null;
  private lost = false;

  readonly onClose = (code: number) => {
    if (this.lost) return;
    this.lost = true;
    this.code = code;
  };

  get closed(): boolean {
    return this.lost;
  }

  /** Throw ConnectionLost if the room has closed. Call after every await while arriving. */
  check(stage: string): void {
    if (this.lost) throw new ConnectionLost(this.code, stage);
  }
}

/**
 * Poll `probe` until it returns a value. Rejects with ConnectionLost when the watched room closes,
 * or (timedOut) after `timeoutMs`.
 */
export function waitFor<T>(
  probe: () => T | null | undefined,
  opts: { stage: string; timeoutMs: number; pollMs?: number; watch?: ArrivalWatch },
): Promise<T> {
  const t0 = Date.now();
  return new Promise<T>((resolve, reject) => {
    const tick = () => {
      if (opts.watch?.closed) {
        try {
          opts.watch.check(opts.stage);
        } catch (e) {
          reject(e);
        }
        return;
      }
      const v = probe();
      if (v !== null && v !== undefined) return resolve(v);
      if (Date.now() - t0 >= opts.timeoutMs) return reject(new ConnectionLost(null, opts.stage, true));
      setTimeout(tick, opts.pollMs ?? 30);
    };
    tick();
  });
}

/**
 * Rejoining after "saving failed" closes (CLOSE.STORAGE), spaced out and bounded. The count
 * survives successful joins (a join that fails to save again must not restart the schedule) and
 * only forgets closes older than the window.
 */
export class StorageBackoff {
  private times: number[] = [];

  constructor(
    readonly max = 3,
    readonly windowMs = 10 * 60_000,
    readonly baseMs = 5_000,
  ) {}

  /** A storage close happened at `now`: the delay before rejoining, or null to stop and explain. */
  next(now: number): number | null {
    this.times = this.times.filter((t) => now - t < this.windowMs);
    this.times.push(now);
    if (this.times.length > this.max) return null;
    return this.baseMs * 2 ** (this.times.length - 1);
  }
}

