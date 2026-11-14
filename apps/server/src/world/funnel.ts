// The first-session funnel's account steps (#85, db/funnel.ts), taken where the server already decides
// them: the character's creation, the first join, kill, mission, level 2 and 5, the tutorial's end.
// Saving is recorded by the account link (db/link.ts) and the first session's length and a later
// day's return by the session tracker (social/analytics.ts). And the visit's verified step: the page
// sent its visit token with /api/play (app.ts → expectVisit), so when that seat joins, the visit is
// recorded as having joined a world. Load-test bots and admin sandboxes are never recorded; our test
// accounts and AI agents are, under their own kind, and /stats counts them apart. Every write is
// queued (db/funnel.ts): nothing here touches the database inside the room's tick.

import type { Identity } from "../auth/identity.ts";
import { readVisit, stricterKind, visitLive, type Visit } from "../auth/visitToken.ts";
import { ACCOUNT_STEPS, accountSubject, queueStep, visitSubject, type FunnelKind } from "../db/funnel.ts";
import { currentDb } from "../social/store.ts";
import type { PlayerActor } from "./actors.ts";
import type { BodyRoom } from "./BodyRoom.ts";
import { onGameEvent } from "./events.ts";
import type { RoomSystem } from "./systems.ts";

export function funnelKind(identity: Pick<Identity, "test" | "agent">): FunnelKind {
  return identity.test ? "test" : identity.agent ? "agent" : "person";
}

/** Record an account step for a live player (first time only). Never throws: analytics must not break play. */
export function accountStep(actor: PlayerActor, step: string, value?: number, now = Date.now()): void {
  if (actor.identity.loadtest || actor.sandbox) return;
  const db = currentDb();
  if (!db) return;
  try {
    queueStep(db, { subject: accountSubject(actor.identity.userId), step, at: now, value, kind: funnelKind(actor.identity) }, now);
  } catch (err) {
    console.warn(`funnel: ${step} not recorded: ${(err as Error).message}`);
  }
}

/** Seats reserved with a visit token, by session id, until they join (bounded, short-lived). */
const expected = new Map<string, { visit: Visit; until: number }>();
const EXPECT_MAX = 5_000;
const EXPECT_MS = 2 * 60_000;

/** /api/play reserved a seat for a page that sent its visit token: remember it for the join. */
export function expectVisit(sessionId: string, token: unknown, now = Date.now()): void {
  const visit = readVisit(token);
  if (!visit || !visitLive(visit, now)) return;
  for (const [k, e] of expected) {
    if (e.until > now && expected.size < EXPECT_MAX) break;
    expected.delete(k);
  }
  expected.set(sessionId, { visit, until: now + EXPECT_MS });
}

function takeVisit(sessionId: string, now: number): Visit | null {
  const e = expected.get(sessionId);
  expected.delete(sessionId);
  return e && e.until > now ? e.visit : null;
}

/** The room side: joins and the game events that are first-session milestones. */
export function createFunnelSystem(room: BodyRoom): RoomSystem | null {
  // Bots and sandboxes are refused per player (accountStep), whatever the room's metadata says yet.
  const off = onGameEvent(room, (e) => {
    switch (e.type) {
      case "kill":
        for (const id of e.creditIds ?? (e.killerId ? [e.killerId] : [])) {
          const a = room.playerById(id);
          if (a) accountStep(a, ACCOUNT_STEPS.kill);
        }
        return;
      case "levelUp": {
        const a = room.playerById(e.playerId);
        if (!a) return;
        if (e.level >= 2) accountStep(a, ACCOUNT_STEPS.level2);
        if (e.level >= 5) accountStep(a, ACCOUNT_STEPS.level5);
        return;
      }
      case "onboardingDone": {
        const a = room.playerById(e.playerId);
        if (a) accountStep(a, ACCOUNT_STEPS.tutorialDone);
        return;
      }
      case "missionAccepted": {
        const a = room.playerById(e.playerId);
        if (a) accountStep(a, ACCOUNT_STEPS.mission);
        return;
      }
    }
  });
  return {
    tick() {},
    onPlayerJoin(sessionId) {
      const now = Date.now();
      const visit = takeVisit(sessionId, now);
      const a = room.playerById(sessionId);
      if (!a) return;
      // A character made by this join is a new one: the funnel's cohort. Characters from before the
      // funnel (or any returning one) record their steps but are never counted as new (review #9).
      if (a.charCreated) accountStep(a, ACCOUNT_STEPS.created, undefined, now);
      accountStep(a, ACCOUNT_STEPS.join, undefined, now);
      if (visit && !a.identity.loadtest && !a.sandbox) {
        const db = currentDb();
        // The visit's kind stays what it was issued as, unless the account is ours or an agent's.
        if (db) queueStep(db, { subject: visitSubject(visit.id), step: "join", at: now, kind: stricterKind(visit.kind, funnelKind(a.identity)) }, now);
      }
    },
    dispose: off,
  };
}
