// Character storage interface. The in-memory implementation keeps characters for the server's
// lifetime; the SQLite implementation (accounts lane) plugs in behind the same interface.

import type { CharacterData } from "@firstlight/shared/content/character";
import { sandboxed } from "../sandbox.ts";

export interface CharacterRepo {
  load(userId: string): CharacterData | null;
  save(userId: string, data: CharacterData): void;
  /** Make sure the account row exists (called on join, never on save). */
  ensure?(userId: string): void;
  /** Run `fn` atomically with pile changes (same database). */
  transaction?<T>(fn: () => T): T;
}

/** Run character + pile writes atomically when the backend supports it. */
export function withTx<T>(fn: () => T): T {
  const repo = characterRepo.current;
  return repo.transaction ? repo.transaction(fn) : fn();
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

/**
 * An admin sandbox's characters (D-admin-3): a character is read from the real repo the first time,
 * then lives here; saves stay here. Nothing is ever written to the real repo.
 */
export class SandboxCharacterRepo implements CharacterRepo {
  private readonly real: () => CharacterRepo;
  private readonly map = new Map<string, CharacterData>();
  constructor(real: () => CharacterRepo) {
    this.real = real;
  }
  load(userId: string): CharacterData | null {
    const c = this.map.get(userId);
    return c ? structuredClone(c) : this.real().load(userId);
  }
  save(userId: string, data: CharacterData): void {
    this.map.set(userId, structuredClone(data));
  }
}

/** Process-wide repo; replaced at boot when the database is available. Sandboxes get their own (sandbox.ts). */
export const characterRepo = sandboxed<CharacterRepo>(new MemoryCharacterRepo(), (real) => new SandboxCharacterRepo(() => real()));
