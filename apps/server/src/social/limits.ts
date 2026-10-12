// Process-wide sliding-window limits keyed by account id, so they hold across rejoins, rooms and
// bodies. Shared by the Tab list and the voice panel (blocks, reports) so neither path is a bypass.

const rate = new Map<string, number[]>(); // key → recent timestamps

export const REPORT_LIMITS = {
  WINDOW_MS: 10 * 60_000,
  /** Reports per account per window (Tab-list and voice reports together). */
  PER_WINDOW: 5,
  /** Reports per account about the same player per window. */
  SAME_TARGET: 1,
};

function recent(key: string, windowMs: number, now: number): number[] {
  return (rate.get(key) ?? []).filter((t) => now - t < windowMs);
}

/** Take one slot under `key` if fewer than `max` were taken in the last `windowMs`. */
export function allow(key: string, max: number, windowMs: number, now = Date.now()): boolean {
  return allowAll([[key, max, windowMs]], now);
}

/** Take one slot under every key, or none if any of them is full. */
export function allowAll(rules: readonly (readonly [key: string, max: number, windowMs: number])[], now = Date.now()): boolean {
  const lists = rules.map(([key, max, windowMs]) => ({ key, max, list: recent(key, windowMs, now) }));
  const ok = lists.every((l) => l.list.length < l.max);
  for (const l of lists) {
    if (ok) l.list.push(now);
    rate.set(l.key, l.list);
  }
  return ok;
}

/** One report slot for `reporter` about `target` (per account, shared by every report path). */
export function allowReport(reporter: string, target: string, now = Date.now()): boolean {
  const { WINDOW_MS, PER_WINDOW, SAME_TARGET } = REPORT_LIMITS;
  return allowAll(
    [
      [`rep:${reporter}:${target}`, SAME_TARGET, WINDOW_MS],
      [`rep:${reporter}`, PER_WINDOW, WINDOW_MS],
    ],
    now,
  );
}

/** Drop keys idle for 15 minutes (bounded memory). */
export function sweepLimits(now = Date.now()): void {
  for (const [k, list] of rate) if (!list.length || now - list[list.length - 1]! > 15 * 60_000) rate.delete(k);
}

export function clearLimits(): void {
  rate.clear();
}
