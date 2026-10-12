// Character storage interface. The in-memory implementation keeps characters for the server's
// lifetime; the SQLite implementation (accounts lane) plugs in behind the same interface.

import type { CharacterData } from "@firstlight/shared/content/character";

export interface CharacterRepo {
  load(userId: string): CharacterData | null;
  save(userId: string, data: CharacterData): void;
}

export class MemoryCharacterRepo implements CharacterRepo {
  private readonly map = new Map<string, CharacterData>();
  load(userId: string): CharacterData | null {
    const c = this.map.get(userId);
    return c ? structuredClone(c) : null;
  }
  save(userId: string, data: CharacterData): void {
    this.map.set(userId, structuredClone(data));
  }
}

/** Process-wide repo; replaced at boot when the database is available. */
export const characterRepo: { current: CharacterRepo } = { current: new MemoryCharacterRepo() };
