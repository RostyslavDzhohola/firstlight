// Hall of Firsts: engrave the first finder of each secret (global, once per secret) and tell every
// room in this process, so the wall in Portus updates live.

import type { HallLine } from "@firstlight/shared/content/secrets";
import { progressStore } from "./store.ts";

type Listener = (lines: HallLine[]) => void;
const listeners = new Set<Listener>();

export function onHallChanged(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function hallLines(): HallLine[] {
  return progressStore.current.hall().map((e) => ({ id: e.secretId, name: e.displayName, foundAt: e.foundAt }));
}

/** Try to engrave `name` for `secretId`. Returns true only for the first finder. */
export function engrave(secretId: string, userId: string, name: string): boolean {
  const { won } = progressStore.current.claimFirst(secretId, userId, name);
  if (won) {
    const lines = hallLines();
    for (const fn of [...listeners]) {
      try {
        fn(lines);
      } catch (err) {
        console.error("hall listener failed", err);
      }
    }
  }
  return won;
}
