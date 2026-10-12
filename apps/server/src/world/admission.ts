// Who may take a seat in which body, checked when /api/play reserves a seat and again when the
// seat is consumed (D26 travel tickets; F12 review B3, B5 and "new characters start home").

import type { BodyId } from "@firstlight/shared";
import type { CharacterData } from "@firstlight/shared/content/character";
import type { Identity } from "../auth/identity.ts";
import { characterRepo } from "./characters.ts";
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
