// Hall of Firsts: engrave the first finder of each secret (global, once per secret) and tell every
// room in this process, so the wall in Portus updates live.

import type { HallLine } from "@firstlight/shared/content/secrets";
import { progressStore } from "./store.ts";
import { sandboxed } from "../../sandbox.ts";

type Listener = (lines: HallLine[]) => void;
/** Every room hears a new engraving; a sandbox's (memory only) reach only its own rooms. */
const hallListeners = sandboxed(new Set<Listener>(), () => new Set<Listener>());

export function onHallChanged(fn: Listener): () => void {
  const set = hallListeners.current;
  set.add(fn);
  return () => set.delete(fn);
}

export function hallLines(): HallLine[] {
  return progressStore.current.hall().map((e) => ({ id: e.secretId, name: e.displayName, foundAt: e.foundAt }));
}

/** Reserve the first finder. With `deferred`, publish the Hall only after the caller commits. */
export function engrave(secretId: string, userId: string, name: string, deferred?: (() => void)[]): boolean {
  const { won } = progressStore.current.claimFirst(secretId, userId, name);
  const publish = () => {
    const lines = hallLines();
    for (const fn of [...hallListeners.current]) {
      try {
        fn(lines);
      } catch (err) {
        console.error("hall listener failed", err);
      }
    }
  };
  if (won) {
    if (deferred) deferred.push(publish);
    else publish();
  }
  return won;
}
