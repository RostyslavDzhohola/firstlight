// Seat reservations /api/play issued that haven't been used yet (F12 review S2 seat hoarding, B5
// stale seats). A seat is only good once, for the account it was issued to, until it expires or
// the account changes (merge, ban); the room revalidates everything else when it is consumed.

import type { BodyId } from "@firstlight/shared";

export interface PendingSeat {
  userId: string;
  ip: string | null;
  sessionId: string;
  roomId: string;
  body: BodyId;
  expiresAt: number;
}

/** A little longer than the room's seat reservation timeout (8 s). */
export const SEAT_TTL_MS = 10_000;

const bySession = new Map<string, PendingSeat>();

function prune(now: number): void {
  for (const [k, r] of bySession) if (r.expiresAt <= now) bySession.delete(k);
}

export const pendingSeats = {
  add(seat: PendingSeat): void {
    bySession.set(seat.sessionId, seat);
  },
  /** Unused, unexpired reservations of an account. */
  forUser(userId: string, now = Date.now()): number {
    prune(now);
    let n = 0;
    for (const r of bySession.values()) if (r.userId === userId) n++;
    return n;
  },
  /** Unused, unexpired reservations requested from an address. */
  forIp(ip: string, now = Date.now()): number {
    prune(now);
    let n = 0;
    for (const r of bySession.values()) if (r.ip === ip) n++;
    return n;
  },
  /** Use the seat (once): null if it was never issued, is for someone else, expired or was invalidated. */
  consume(sessionId: string, userId: string, now = Date.now()): PendingSeat | null {
    const r = bySession.get(sessionId);
    if (!r) return null;
    bySession.delete(sessionId);
    return r.userId === userId && r.expiresAt > now ? r : null;
  },
  /** Void every unused seat of these accounts (merge, ban). */
  invalidate(...userIds: string[]): void {
    const set = new Set(userIds);
    for (const [k, r] of bySession) if (set.has(r.userId)) bySession.delete(k);
  },
  get size(): number {
    return bySession.size;
  },
  clear(): void {
    bySession.clear();
  },
};
