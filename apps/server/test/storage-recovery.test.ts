// storageRecovery (F12 re-review S5): accounts whose death couldn't be saved stay out until a storage
// health check passes. Marks lapse (and are capped), so accounts that never come back don't stay in
// memory for good (F12 final review nit), but a dropped mark still needs a successful health write
// before anyone it covered gets back in (F12 confirm Codex N-S2).

import { afterEach, describe, expect, it } from "vitest";
import { newCharacter } from "@firstlight/shared/content/character";
import { STORAGE_RECOVERY, storageRecovery } from "../src/world/admission.ts";
import { characterRepo, MemoryCharacterRepo, type CharacterRepo } from "../src/world/characters.ts";

const saved = characterRepo.current;
const tuning = { ...STORAGE_RECOVERY };
afterEach(() => {
  characterRepo.current = saved;
  Object.assign(STORAGE_RECOVERY, tuning);
  storageRecovery.clear();
});

/** A repo whose saves fail while `failing` is set; `writes` counts the saves that went through. */
function flakyRepo(): CharacterRepo & { failing: boolean; writes: number } {
  const mem = new MemoryCharacterRepo();
  return {
    failing: true,
    writes: 0,
    load: (id) => mem.load(id),
    save(id, c) {
      if (this.failing) throw new Error("disk I/O error");
      mem.save(id, c);
      this.writes++;
    },
  };
}

/** A flaky repo (failing) holding a character for each of `users`. */
function withCharacters(...users: string[]) {
  const repo = flakyRepo();
  characterRepo.current = repo;
  repo.failing = false;
  for (const u of users) repo.save(u, newCharacter(0, 0));
  repo.failing = true;
  repo.writes = 0;
  return repo;
}

describe("storage recovery marks", () => {
  it("keep a marked account out while the health check fails, and let it in once storage works", () => {
    const repo = flakyRepo();
    characterRepo.current = repo;
    repo.failing = false;
    repo.save("u1", newCharacter(0, 0));
    repo.failing = true;
    const t = 1_000_000;
    storageRecovery.mark("u1", t);
    expect(storageRecovery.ok("u1", t + 1)).toBe(false);
    expect(storageRecovery.ok("u2", t + 1)).toBe(true);
    repo.failing = false;
    expect(storageRecovery.ok("u1", t + 2)).toBe(true);
    expect(storageRecovery.size()).toBe(0);
  });

  it("lapse after STORAGE_RECOVERY.LAPSE_MS, but a lapsed account stays out until a health write succeeds", () => {
    const repo = withCharacters("u3", "u4");
    const t = 2_000_000;
    const L = STORAGE_RECOVERY.LAPSE_MS;
    storageRecovery.mark("gone", t);
    storageRecovery.mark("u3", t + 10);
    expect(storageRecovery.size()).toBe(2);
    expect(storageRecovery.ok("u3", t + 20)).toBe(false); // storage still failing
    // Any later check sweeps lapsed marks, whoever it is for: memory stays bounded.
    expect(storageRecovery.ok("someone-else", t + L)).toBe(true); // no character, nothing to check
    expect(storageRecovery.size()).toBe(1);
    // u3's mark lapses too, while saving still fails: it is forgotten, yet u3 is still refused.
    expect(storageRecovery.ok("u3", t + 10 + L)).toBe(false);
    expect(storageRecovery.size()).toBe(0);
    expect(storageRecovery.ok("u3", t + 10 + 5 * L)).toBe(false);
    // So is any account with a character while the forgotten failure is unverified.
    expect(storageRecovery.ok("u4", t + 10 + 5 * L)).toBe(false);
    expect(repo.writes).toBe(0);
    // Saving works again: the first successful health write lets everyone back in.
    repo.failing = false;
    expect(storageRecovery.ok("u3", t + 10 + 5 * L + 1)).toBe(true);
    expect(repo.writes).toBe(1);
    expect(storageRecovery.ok("u4", t + 10 + 5 * L + 2)).toBe(true);
    // Verified: unmarked accounts are no longer checked, even if saving breaks again.
    repo.failing = true;
    expect(storageRecovery.ok("u4", t + 10 + 5 * L + 3)).toBe(true);
    expect(repo.writes).toBe(1);
  });

  it("are capped at STORAGE_RECOVERY.MAX_MARKS; an evicted account still needs a health write", () => {
    STORAGE_RECOVERY.MAX_MARKS = 2;
    const repo = withCharacters("a", "b", "c");
    const t = 3_000_000;
    storageRecovery.mark("a", t);
    storageRecovery.mark("b", t + 1);
    storageRecovery.mark("c", t + 2);
    expect(storageRecovery.size()).toBe(2); // "a", the oldest, was evicted
    expect(storageRecovery.ok("a", t + 3)).toBe(false);
    expect(storageRecovery.ok("b", t + 3)).toBe(false);
    repo.failing = false;
    expect(storageRecovery.ok("a", t + 4)).toBe(true);
    // "b" and "c" are still marked: each passes its own check.
    expect(storageRecovery.size()).toBe(2);
    expect(storageRecovery.ok("b", t + 5)).toBe(true);
    expect(storageRecovery.size()).toBe(1);
  });
});
