// Record restrictions per world copy (`${body}:${copy}`): until when the copy counts as staged (an
// admin scene ran there) and until when its boss fight counts as admin-assisted. While either holds,
// the quest system writes no permanent records there (medals, Hall of Firsts; QuestSystem.official).
//
// Absolute expiry times live outside the room instance, so emptying and recreating a copy keeps them
// (F12 review B3). The store is a tiny get/set interface: in memory for now, and meant to be backed
// by the NPC lane's per-copy SQLite state (world/copyState.ts) at merge time so restarts keep it too.

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

export class MemoryCopyRestrictions implements CopyRestrictionStore {
  private readonly map = new Map<string, CopyRestrictions>();

  get(key: string): CopyRestrictions | undefined {
    const v = this.map.get(key);
    if (v && Math.max(v.stagedUntil, v.assistedUntil) <= Date.now()) {
      this.map.delete(key);
      return undefined;
    }
    return v;
  }

  set(key: string, value: CopyRestrictions) {
    this.map.set(key, { ...value });
  }
}

export const copyRestrictions: { current: CopyRestrictionStore } = { current: new MemoryCopyRestrictions() };

export function copyKey(body: string, copy: number): string {
  return `${body}:${copy}`;
}
