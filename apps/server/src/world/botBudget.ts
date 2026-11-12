// Load-test bots' own finite budgets (security pass finding 1, D-security-1). Bots skip the public
// ceilings (global cap, per-address limits, unused-seat caps per address) so a load test isn't
// throttled by them, but whoever holds the load-test credential could mint any number of
// identities, so bots get ceilings of their own: how many are online, how many load-test copies
// exist, how many unused bot seats are pending, and how fast bot rooms, play calls and bot tokens
// come. Sized for the SPEC's F2 runs (40 bots on one copy, then 2 copies × 4 bodies).

import { WindowLimiter } from "../auth/limiter.ts";

export const BOT_BUDGET = {
  /** Bots online at once, every load-test room together (pending bot seats count too). */
  population: 320,
  /** Load-test copies of one body. */
  copiesPerBody: 2,
  /** Load-test copies in all. */
  rooms: 8,
  /** Unused bot seat reservations at once. */
  seats: 40,
  /** New load-test rooms per minute. */
  roomsPerMinute: 8,
  /** Bot /api/play calls per 10 s, all bots together. */
  playCallsPer10s: 100,
  /** Bot tokens minted per 10 s (POST /api/test/bot-token). */
  tokensPer10s: 60,
};

/** pendingSeats address key for bot claims, so the bot seat cap can count them. */
export const BOT_SEAT_KEY = "loadtest-bots";

const rooms = new WindowLimiter(BOT_BUDGET.roomsPerMinute, 60_000, 1);
const calls = new WindowLimiter(BOT_BUDGET.playCallsPer10s, 10_000, 1);
const tokens = new WindowLimiter(BOT_BUDGET.tokensPer10s, 10_000, 1);

function sync(): void {
  rooms.max = BOT_BUDGET.roomsPerMinute;
  calls.max = BOT_BUDGET.playCallsPer10s;
  tokens.max = BOT_BUDGET.tokensPer10s;
}

export const botBudget = {
  /** One bot /api/play call, if the bots' call budget allows it. */
  takePlayCall(now = Date.now()): boolean {
    sync();
    return calls.take("all", now);
  },
  /** One new bot token, if the minting budget allows it. */
  takeToken(now = Date.now()): boolean {
    sync();
    return tokens.take("all", now);
  },
  /**
   * May a new load-test copy of a body open now? `ofBody` and `total` are the load-test copies that
   * exist. Takes a creation slot when it says yes.
   */
  takeRoom(ofBody: number, total: number, now = Date.now()): boolean {
    sync();
    if (ofBody >= BOT_BUDGET.copiesPerBody || total >= BOT_BUDGET.rooms) return false;
    return rooms.take("all", now);
  },
  reset(): void {
    rooms.clear();
    calls.clear();
    tokens.clear();
  },
};
