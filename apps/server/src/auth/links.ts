// Account-link events: a guest saved (or signed into an existing account) and their user id changed.
// Rooms subscribe to re-key live clients. Listeners run synchronously right after the game.db rows
// moved (before any other autosave can run), each isolated in try/catch.

import { AsyncLocalStorage } from "node:async_hooks";
import type { LinkResult } from "../db/link.ts";
import type { LiveSession } from "./sessions.ts";

export interface AccountLinkedEvent {
  fromUserId: string;
  toUserId: string;
  /** Name to show from now on (display name if picked, else the account's auth name). */
  name: string;
  /** Whose character survived the merge. If "account", the guest's in-memory character is stale: reload it from game.db (or make the client rejoin) before the next autosave. */
  character: LinkResult["character"];
  merged: boolean;
  /** The guest's live session, now registered under `toUserId` (null if they weren't in a room). */
  moved: LiveSession | null;
  /** The target account's previous live session (another browser). Kick it. */
  displaced: LiveSession | null;
}

export type AccountLinkedListener = (ev: AccountLinkedEvent) => void;

export type BeforeLinkListener = (fromUserId: string, toUserId: string) => void;

export class LinkEvents {
  private listeners = new Set<AccountLinkedListener>();
  private before = new Set<BeforeLinkListener>();

  /** Called synchronously before rows move, so rooms can flush live characters of both ids. */
  onBeforeLink(fn: BeforeLinkListener): () => void {
    this.before.add(fn);
    return () => this.before.delete(fn);
  }

  emitBefore(fromUserId: string, toUserId: string): void {
    for (const fn of this.before) {
      try {
        fn(fromUserId, toUserId);
      } catch (err) {
        console.error("before-link listener failed", err);
      }
    }
  }

  /**
   * Subscribe; returns an unsubscribe function (call it in the room's onDispose). A listener runs in
   * the context it subscribed from: an admin sandbox room's listeners stay in its sandbox (D-admin-3).
   */
  on(fn: AccountLinkedListener): () => void {
    const bound = AsyncLocalStorage.bind(fn);
    this.listeners.add(bound);
    return () => this.listeners.delete(bound);
  }

  emit(ev: AccountLinkedEvent): void {
    for (const fn of this.listeners) {
      try {
        fn(ev);
      } catch (err) {
        console.error("account link listener failed", err);
      }
    }
  }
}

/** The process-wide link event bus rooms subscribe to. */
export const accountLinks = new LinkEvents();
