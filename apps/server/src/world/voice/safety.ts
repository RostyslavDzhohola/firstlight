// Voice safety records: blocks and reports go to game.db (the shared persistence API); admin voice
// mutes are process-wide by account. Without an open game.db (unit tests, bare dev runs) blocks and
// reports fall back to memory so the rules still hold.

import { blockUser, fileReport, gameDb, isBanned, isBlockedEitherWay, type Db } from "../../db/index.ts";

function db(): Db | null {
  try {
    return gameDb();
  } catch {
    return null;
  }
}

const memBlocks = new Set<string>();
let memReportId = 0;

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
    if (userId === blockedUserId) return false;
    const d = db();
    if (d) return blockUser(d, userId, blockedUserId, now);
    const key = `${userId}\n${blockedUserId}`;
    if (memBlocks.has(key)) return false;
    memBlocks.add(key);
    return true;
  },

  blockedEitherWay(a: string, b: string): boolean {
    const d = db();
    if (d) return isBlockedEitherWay(d, a, b);
    return memBlocks.has(`${a}\n${b}`) || memBlocks.has(`${b}\n${a}`);
  },

  /** Banned accounts lose voice at once (the ban itself kicks them; that's the admin tools' job). */
  isBanned(userId: string, now = Date.now()): boolean {
    const d = db();
    return d ? isBanned(d, userId, now) : false;
  },

  /** File a report (who, when, where, why; never audio). Returns the report id. */
  report(r: VoiceReport, now = Date.now()): number {
    const d = db();
    if (d) return fileReport(d, { reporter: r.reporter, target: r.target, body: r.body, pos: r.pos, reason: r.reason, now });
    return ++memReportId;
  },
};

const mutedUsers = new Set<string>();

/** Admin voice mutes by account id; survive rejoining within this server process. */
export const voiceMutes = {
  set(userId: string, on: boolean): void {
    if (on) mutedUsers.add(userId);
    else mutedUsers.delete(userId);
  },
  has(userId: string): boolean {
    return mutedUsers.has(userId);
  },
  rekey(fromUserId: string, toUserId: string): void {
    if (mutedUsers.delete(fromUserId)) mutedUsers.add(toUserId);
  },
};
