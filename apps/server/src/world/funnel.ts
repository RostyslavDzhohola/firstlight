// The first-session funnel's account steps (#85, db/funnel.ts), taken where the server already decides
// them: the first join, kill, mission, level 2 and 5, the tutorial's end. Saving is recorded by the
// account link (db/link.ts) and the first session's length and a later day's return by the session
// tracker (social/analytics.ts). Load-test bots and admin sandboxes are never recorded; our test
// accounts and AI agents are, under their own kind, and /stats counts them apart.

import type { Identity } from "../auth/identity.ts";
import { ACCOUNT_STEPS, accountSubject, recordStep, type FunnelKind } from "../db/funnel.ts";
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
    recordStep(db, { subject: accountSubject(actor.identity.userId), step, at: now, value, kind: funnelKind(actor.identity) });
  } catch (err) {
    console.warn(`funnel: ${step} not recorded: ${(err as Error).message}`);
  }
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
      const a = room.playerById(sessionId);
      if (!a) return;
      accountStep(a, ACCOUNT_STEPS.join);
      // A character that is already past a milestone when the funnel starts (older accounts) is not
      // backfilled: the funnel counts first times from here on.
    },
    dispose: off,
  };
}
