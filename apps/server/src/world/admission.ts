// Who may take a seat in which body, checked when /api/play reserves a seat and again when the
// seat is consumed (D26 travel tickets; F12 review B3, B5 and "new characters start home").

import type { BodyId } from "@firstlight/shared";
import type { CharacterData } from "@firstlight/shared/content/character";
import type { Identity } from "../auth/identity.ts";
import { characterRepo, withTx } from "./characters.ts";
import { hub } from "./hub.ts";

/** Where brand-new characters (and rebirths) start. */
export const HOME_BODY: BodyId = "portus";

/**
 * Accounts module hook: is a verified account still allowed in (row exists, so not a merged or
 * deleted guest; not banned; still signed in somewhere)? Returns a refusal reason or null.
 * Only identities from real accounts (`identity.account`) are checked; set by createGame.
 */
export const identityCheck: { current: (userId: string) => string | null } = { current: () => null };

/** Does `ch` hold an unexpired travel ticket to `body`? */
export function ticketFor(ch: Pick<CharacterData, "travelTo" | "travelUntil">, body: BodyId, now: number): boolean {
  return ch.travelTo === body && (ch.travelUntil ?? 0) > now;
}

/**
 * The body this identity must join instead of `body`, or null when `body` is allowed: the body the
 * character is on, or one its unexpired ticket names while it is out of combat. New characters
 * start home. Admins and load-test bots go anywhere.
 */
export function travelRedirect(identity: Identity, body: BodyId, now: number): BodyId | null {
  if (identity.admin || identity.loadtest) return null;
  const live = hub.get(identity.userId)?.actor;
  const ch = live?.char ?? characterRepo.current.load(identity.userId);
  if (!ch) return body === HOME_BODY ? null : HOME_BODY;
  if (body === ch.body) return null;
  const fighting = !!live && !live.dead && now < live.combatUntil;
  return ticketFor(ch, body, now) && !fighting ? null : ch.body;
}

/**
 * Accounts whose last change couldn't be saved (a death, F12 re-review S5). They aren't admitted
 * again until a storage health check for the account passes: its character row is read and written
 * back in a transaction. Otherwise a player whose saves keep failing would die, be sent back,
 * rejoin alive and die again. A mark lapses after LAPSE_MS (a new failure marks the account again),
 * so accounts that never come back aren't kept for good (F12 final review nit).
 */
export const STORAGE_RECOVERY = { LAPSE_MS: 3_600_000 };

const recovering = new Map<string, number>(); // userId → marked at

function sweepLapsed(now: number): void {
  for (const [u, at] of recovering) if (now - at >= STORAGE_RECOVERY.LAPSE_MS) recovering.delete(u);
}

export const storageRecovery = {
  mark(userId: string, now = Date.now()): void {
    sweepLapsed(now);
    recovering.set(userId, now);
  },
  /** May the account play? True unless recovering and the health check still fails. */
  ok(userId: string, now = Date.now()): boolean {
    if (!recovering.size) return true;
    sweepLapsed(now);
    if (!recovering.has(userId)) return true;
    try {
      withTx(() => {
        const c = characterRepo.current.load(userId);
        if (c) characterRepo.current.save(userId, c);
      });
    } catch {
      return false;
    }
    recovering.delete(userId);
    return true;
  },
  /** Marked accounts (tests). */
  size(): number {
    return recovering.size;
  },
  clear(): void {
    recovering.clear();
  },
};
