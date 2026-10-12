// Kill and boss payouts whose save failed are tried again on later ticks, a few times with backoff
// (F12 confirm Sonnet SF1). A failed transaction leaves nothing behind (persist puts the characters
// back and the pile writes roll back), so another try can't pay twice. Each payout is keyed (one per
// kill, one per boss winner): a key is never queued twice, and once an attempt commits, the key is
// settled and never runs again, even if publishing the news afterwards throws.

import type { PlayerActor } from "../actors.ts";
import type { NpcWorld } from "./world.ts";

/** Waits before each retry (ms after the failed attempt): three retries, the last ~10 s after the kill. */
export const PAYOUT_RETRY = { delaysMs: [1000, 3000, 6000] };

/** How long a settled key is remembered (ms): far longer than every retry together. */
const SETTLED_MS = 60_000;

/** Who a share is for, as the kill saw them: account, session and life. */
export interface Recipient {
  userId: string;
  sid: string;
  life: number;
}

export function recipientOf(p: PlayerActor): Recipient {
  return { userId: p.identity.userId, sid: p.id, life: p.char.lifeStartedAt };
}

/** The live actor of an account in this room (connected players only), preferring its last session. */
export function actorOf(world: NpcWorld, userId: string, sid: string): PlayerActor | null {
  const bySid = world.playerById(sid);
  if (bySid && bySid.identity.userId === userId) return bySid;
  for (const p of world.connected()) if (p.identity.userId === userId) return p;
  return null;
}

/**
 * The recipient's actor if a share may still be paid to it: in this room (connected, or its body
 * lingering under the same session), alive, and on the life that earned it. Someone who left the
 * room, died or was reborn since the kill forfeits that share.
 */
export function stillEligible(world: NpcWorld, r: Recipient): PlayerActor | null {
  const p = actorOf(world, r.userId, r.sid);
  return p && !p.dead && p.char.lifeStartedAt === r.life ? p : null;
}

/**
 * One try at a payout: commits it in one transaction and returns what to publish afterwards, or
 * throws having changed nothing (the save failed).
 */
export type PayoutCommit = () => () => void;

interface Pending {
  what: string;
  commit: PayoutCommit;
  failures: number;
  dueAt: number;
}

export class PayoutQueue {
  private readonly pending = new Map<string, Pending>();
  private readonly settled = new Map<string, number>(); // key → when it committed or was given up

  /**
   * Pay now; if the save throws, try again after each PAYOUT_RETRY delay, then give up. A key that
   * is waiting or already settled is ignored.
   */
  pay(key: string, what: string, commit: PayoutCommit, now: number): void {
    if (this.pending.has(key) || this.settled.has(key)) return;
    this.attempt(key, { what, commit, failures: 0, dueAt: now }, now);
  }

  /** Retry the payouts whose wait is over; forget old settled keys. */
  tick(now: number): void {
    for (const [key, p] of [...this.pending]) if (now >= p.dueAt) this.attempt(key, p, now);
    for (const [key, at] of this.settled) {
      if (now - at < SETTLED_MS) break; // the rest settled later
      this.settled.delete(key);
    }
  }

  /**
   * The room is closing: give every waiting payout one last try now, whatever its wait, then give up
   * on the rest. Recipients who left forfeit their share as usual, but the ground loot (drops, camp
   * chest) still lands, since piles belong to the body, not the room (T9 review).
   */
  flush(now: number): void {
    for (const [key, p] of [...this.pending]) {
      this.pending.delete(key);
      try {
        const publish = p.commit();
        this.settled.set(key, now);
        try {
          publish();
        } catch (err) {
          console.error(`[npc] ${p.what} paid at close; publishing it failed`, err);
        }
      } catch (err) {
        this.settled.set(key, now);
        console.error(`[npc] ${p.what} not paid before its room closed, given up: ${(err as Error)?.message ?? err}`);
      }
    }
  }

  /** Payouts waiting for a retry. */
  size(): number {
    return this.pending.size;
  }

  private attempt(key: string, p: Pending, now: number): void {
    this.pending.delete(key);
    let publish: () => void;
    try {
      publish = p.commit();
    } catch (err) {
      p.failures++;
      const wait = PAYOUT_RETRY.delaysMs[p.failures - 1];
      const why = (err as Error)?.message ?? err;
      if (wait === undefined) {
        this.settled.set(key, now);
        console.error(`[npc] ${p.what} not paid after ${p.failures} tries, given up: ${why}`);
        return;
      }
      p.dueAt = now + wait;
      this.pending.set(key, p);
      console.error(`[npc] ${p.what} not paid (try ${p.failures}), retrying in ${wait} ms: ${why}`);
      return;
    }
    this.settled.set(key, now);
    try {
      publish();
    } catch (err) {
      console.error(`[npc] ${p.what} paid; publishing it failed`, err);
    }
  }
}
