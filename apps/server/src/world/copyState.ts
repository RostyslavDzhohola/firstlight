// Per-copy world state that must outlive one room instance (SPEC §5.1, §6.5; F12 B2). A copy that
// empties auto-disposes and the next /api/play opens a fresh room on the same copy number, and a
// deploy restarts the process, so boss respawn timers, cleared spawn groups (packs, camps, beasts,
// egg NPCs) and broken props are kept here under `body:copy`: systems save a snapshot when it
// changes and when their room goes away, and restore it in their constructor. In memory for tests
// and dev; main.ts installs the SQLite store (game.db) so restarts keep the timers too.

import { loadCopyState, saveCopyState, type Db } from "../db/index.ts";
import type { BodyRoom } from "./BodyRoom.ts";

export interface CopyStateStore {
  load<T>(copyKey: string, system: string): T | null;
  /** `null` forgets the copy's state for this system. */
  save(copyKey: string, system: string, state: unknown): void;
}

export class MemoryCopyStateStore implements CopyStateStore {
  private readonly map = new Map<string, string>();
  load<T>(copyKey: string, system: string): T | null {
    const s = this.map.get(`${copyKey}|${system}`);
    return s === undefined ? null : (JSON.parse(s) as T);
  }
  save(copyKey: string, system: string, state: unknown): void {
    const k = `${copyKey}|${system}`;
    if (state === null || state === undefined) this.map.delete(k);
    else this.map.set(k, JSON.stringify(state));
  }
}

export class SqliteCopyStateStore implements CopyStateStore {
  private readonly db: Db;
  constructor(db: Db) {
    this.db = db;
  }
  load<T>(copyKey: string, system: string): T | null {
    return loadCopyState<T>(this.db, copyKey, system);
  }
  save(copyKey: string, system: string, state: unknown): void {
    // A closed database (shutdown already ran) must not take the room's dispose down with it.
    if (!this.db.open) return;
    saveCopyState(this.db, copyKey, system, state);
  }
}

/** Process-wide store; main.ts installs the SQLite one at boot. */
export const copyStateStore: { current: CopyStateStore } = { current: new MemoryCopyStateStore() };

/** `body:copy`; load-test copies are numbered separately, so they get their own prefix. */
export function copyKey(body: string, copy: number, loadtest = false): string {
  return `${loadtest ? "lt:" : ""}${body}:${copy}`;
}

export function roomCopyKey(room: BodyRoom): string {
  return copyKey(room.bodyDef.id, room.state.copy, !!room.metadata?.loadtest);
}

/** Load without letting a broken row stop a room from opening. */
export function loadCopy<T>(key: string, system: string): T | null {
  try {
    return copyStateStore.current.load<T>(key, system);
  } catch (err) {
    console.error(`copy state ${key}/${system}: load failed`, err);
    return null;
  }
}

/** Save without letting a storage error break the tick or the dispose. */
export function saveCopy(key: string, system: string, state: unknown): void {
  try {
    copyStateStore.current.save(key, system, state);
  } catch (err) {
    console.error(`copy state ${key}/${system}: save failed`, err);
  }
}
