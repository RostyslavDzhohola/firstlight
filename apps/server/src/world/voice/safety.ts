// Voice safety records, shared with the social lane so the Tab player list and the voice panel see
// the same state: blocks, reports and bans live in game.db through the social store (with its
// in-memory fallback when no database is open); admin voice mutes are the moderation module's.

import { isVoiceMuted, setVoiceMuted } from "../../social/moderation.ts";
import { blockedBy, blockedEitherWay, setBlocked, storeReport, userBanned } from "../../social/store.ts";

export interface VoiceReport {
  reporter: string;
  target: string;
  body: string;
  pos: readonly [number, number, number] | null;
  reason: string;
}

export const voiceSafety = {
  /** Persist `userId` blocking `blockedUserId`. True if it is a new block. */
  block(userId: string, blockedUserId: string, now = Date.now()): boolean {
    if (userId === blockedUserId || blockedBy(userId).includes(blockedUserId)) return false;
    return setBlocked(userId, blockedUserId, true, now);
  },

  /** Everyone `userId` has blocked (the client's copy of the list). */
  blockedBy(userId: string): string[] {
    return blockedBy(userId);
  },

  blockedEitherWay(a: string, b: string): boolean {
    return blockedEitherWay(a, b);
  },

  /** Banned accounts lose voice at once (the ban itself also removes them from the world). */
  isBanned(userId: string, now = Date.now()): boolean {
    return userBanned(userId, now);
  },

  /** File a report (who, when, where, why; never audio). Returns the report id. */
  report(r: VoiceReport, now = Date.now()): number {
    return storeReport({ reporter: r.reporter, target: r.target, body: r.body, pos: r.pos ? [r.pos[0], r.pos[1], r.pos[2]] : null, reason: r.reason, now });
  },
};

/** Admin voice mutes (process-wide by account; the moderation module owns them). */
export const voiceMutes = {
  set(userId: string, on: boolean): void {
    setVoiceMuted(userId, on);
  },
  has(userId: string): boolean {
    return isVoiceMuted(userId);
  },
};
