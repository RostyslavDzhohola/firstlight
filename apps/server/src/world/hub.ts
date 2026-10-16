// One authoritative in-memory character per user across every room in this process (review
// blockers: cloning, overwrites). A user's actor may be connected, dropped (reconnect window) or
// lingering; whichever room holds it is recorded here. Joining anywhere takes the actor over.

import type { PlayerActor } from "./actors.ts";
import { sandboxed } from "../sandbox.ts";

export interface HubRoom {
  readonly roomId: string;
  /** Remove the actor from the room without saving; kick its client with `code` if connected. */
  retire(actor: PlayerActor, code: number, reason: string): void;
  /** Persist the actor now. */
  saveActor(actor: PlayerActor): void;
}

interface Entry {
  room: HubRoom;
  actor: PlayerActor;
}

/** An admin sandbox has its own (D-admin-3): its actors are never the real ones, nor reachable from outside. */
const live = sandboxed(new Map<string, Entry>(), () => new Map<string, Entry>());

export const hub = {
  get(userId: string): Entry | undefined {
    return live.current.get(userId);
  },
  set(userId: string, room: HubRoom, actor: PlayerActor) {
    live.current.set(userId, { room, actor });
  },
  /** Forget the user only if `actor` is still the authoritative one. */
  release(userId: string, actor: PlayerActor) {
    if (live.current.get(userId)?.actor === actor) live.current.delete(userId);
  },
  /** Save the live actor of each user (before an account merge). */
  flush(...userIds: string[]) {
    for (const u of userIds) {
      const e = live.current.get(u);
      if (e && !e.actor.superseded) e.room.saveActor(e.actor);
    }
  },
  /** Retire (no save) the live actor of each user, kicking with `code`. */
  retireAll(code: number, reason: string, ...userIds: string[]) {
    for (const u of userIds) {
      const e = live.current.get(u);
      if (!e) continue;
      live.current.delete(u);
      e.room.retire(e.actor, code, reason);
    }
  },
  clear() {
    live.current.clear();
  },
};

/** App close codes: one table shared with the client (packages/shared net/social.ts). */
export { CLOSE } from "@firstlight/shared/net/social";
