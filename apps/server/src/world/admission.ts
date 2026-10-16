// Who may take a seat in which body, checked when /api/play reserves a seat and again when the
// seat is consumed (D26 travel tickets; F12 review B3, B5 and "new characters start home").

import type { BodyId } from "@firstlight/shared";
import type { CharacterData } from "@firstlight/shared/content/character";
import type { Identity } from "../auth/identity.ts";
import { characterRepo, withTx } from "./characters.ts";
import { hub } from "./hub.ts";
import { currentSandbox } from "../sandbox.ts";

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
 * rejoin alive and die again.
 *
 * Memory is bounded apart from that rule (F12 confirm Codex N-S2): a mark lapses after LAPSE_MS and
 * the oldest is evicted beyond MAX_MARKS, but a dropped mark's account isn't forgotten as safe.
 * Until some health write succeeds (storage works again), every account with a character runs the
 * check before it is admitted, so a lapse never readmits anyone while saving still fails.
 */
export const STORAGE_RECOVERY = { LAPSE_MS: 3_600_000, MAX_MARKS: 10_000 };

const recovering = new Map<string, number>(); // userId → marked at, oldest first
/** A mark was dropped before its account passed a check: check everyone until a health write succeeds. */
let unverified = false;

function sweep(now: number): void {
  for (const [u, at] of recovering) {
    if (now - at < STORAGE_RECOVERY.LAPSE_MS && recovering.size <= STORAGE_RECOVERY.MAX_MARKS) break; // the rest are newer
    recovering.delete(u);
    unverified = true;
  }
}

/** Read the account's character row and write it back in one transaction; `wrote` if there was one. */
function healthCheck(userId: string): { ok: boolean; wrote: boolean } {
  let wrote = false;
  try {
    withTx(() => {
      const c = characterRepo.current.load(userId);
      if (c) {
        characterRepo.current.save(userId, c);
        wrote = true;
      }
    });
  } catch {
    return { ok: false, wrote: false };
  }
  return { ok: true, wrote };
}

export const storageRecovery = {
  mark(userId: string, now = Date.now()): void {
    if (currentSandbox()) return; // a sandbox saves nothing, so it can't fail to (D-admin-3)
    recovering.delete(userId); // a new failure moves the account to the newest end
    recovering.set(userId, now);
    sweep(now);
  },
  /** May the account play? True unless it (or a forgotten mark) needs a health check that fails. */
  ok(userId: string, now = Date.now()): boolean {
    // A sandbox seat is checked in /api/play (outside); a health write from inside proves nothing.
    if (currentSandbox()) return true;
    if (!recovering.size && !unverified) return true;
    sweep(now);
    if (!recovering.has(userId) && !unverified) return true;
    const check = healthCheck(userId);
    if (!check.ok) return false;
    recovering.delete(userId);
    // Only a real write proves saving works (an account with no character wrote nothing).
    if (check.wrote) unverified = false;
    return true;
  },
  /** Marked accounts (tests). */
  size(): number {
    return recovering.size;
  },
  clear(): void {
    recovering.clear();
    unverified = false;
  },
};
