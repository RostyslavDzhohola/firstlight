// Record restrictions per world copy (`body:copy`, copyState.ts): until when the copy counts as
// staged (an admin scene ran there) and until when its boss fight counts as admin-assisted. While
// either holds, the quest system writes no permanent records there (medals, Hall of Firsts;
// QuestSystem.official).
//
// Absolute expiry times live in the per-copy state store, not in the room (F12 review B3): emptying
// and recreating a copy keeps them, and so does a restart, because main.ts installs the SQLite copy
// state (game.db `copy_state`) at boot.

import { loadCopy, saveCopy } from "../copyState.ts";

export interface CopyRestrictions {
  /** Staged scene: no medals or Hall of Firsts entries in the copy until then (ms since epoch). */
  stagedUntil: number;
  /** Admin-assisted boss fight: no boss medals or plaques until then. */
  assistedUntil: number;
}

export interface CopyRestrictionStore {
  get(key: string): CopyRestrictions | undefined;
  set(key: string, value: CopyRestrictions): void;
}

/** The copy-state system name the restrictions are saved under. */
export const RESTRICTIONS_SYSTEM = "restrictions";

/** Restrictions kept in the per-copy state store (memory in tests and dev, SQLite in production). */
export class CopyStateRestrictions implements CopyRestrictionStore {
  get(key: string): CopyRestrictions | undefined {
    const v = loadCopy<CopyRestrictions>(key, RESTRICTIONS_SYSTEM);
    if (!v || typeof v.stagedUntil !== "number" || typeof v.assistedUntil !== "number") return undefined;
    if (Math.max(v.stagedUntil, v.assistedUntil) <= Date.now()) {
      saveCopy(key, RESTRICTIONS_SYSTEM, null); // both over: forget the row
      return undefined;
    }
    return v;
  }

  set(key: string, value: CopyRestrictions) {
    saveCopy(key, RESTRICTIONS_SYSTEM, { stagedUntil: value.stagedUntil, assistedUntil: value.assistedUntil });
  }
}

export const copyRestrictions: { current: CopyRestrictionStore } = { current: new CopyStateRestrictions() };
