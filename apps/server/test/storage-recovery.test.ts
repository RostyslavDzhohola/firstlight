// storageRecovery (F12 re-review S5): accounts whose death couldn't be saved stay out until a storage
// health check passes. Marks lapse, so accounts that never come back don't stay in memory for good
// (F12 final review nit).

import { afterEach, describe, expect, it } from "vitest";
import { newCharacter } from "@firstlight/shared/content/character";
import { STORAGE_RECOVERY, storageRecovery } from "../src/world/admission.ts";
import { characterRepo, MemoryCharacterRepo, type CharacterRepo } from "../src/world/characters.ts";

const saved = characterRepo.current;
afterEach(() => {
  characterRepo.current = saved;
  storageRecovery.clear();
});

/** A repo whose saves fail while `failing` is set. */
function flakyRepo(): CharacterRepo & { failing: boolean } {
  const mem = new MemoryCharacterRepo();
  return {
    failing: true,
    load: (id) => mem.load(id),
    save(id, c) {
      if (this.failing) throw new Error("disk I/O error");
      mem.save(id, c);
    },
  };
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

  it("lapse after STORAGE_RECOVERY.LAPSE_MS, so accounts that never come back are forgotten", () => {
    const repo = flakyRepo();
    characterRepo.current = repo;
    repo.failing = false;
    repo.save("u3", newCharacter(0, 0));
    repo.failing = true;
    const t = 2_000_000;
    storageRecovery.mark("gone", t);
    storageRecovery.mark("u3", t + 10);
    expect(storageRecovery.size()).toBe(2);
    expect(storageRecovery.ok("u3", t + 20)).toBe(false); // storage still failing
    // Any later check sweeps lapsed marks, whoever it is for.
    expect(storageRecovery.ok("someone-else", t + STORAGE_RECOVERY.LAPSE_MS)).toBe(true);
    expect(storageRecovery.size()).toBe(1);
    // A lapsed account may try again (a new failure marks it again).
    expect(storageRecovery.ok("u3", t + 10 + STORAGE_RECOVERY.LAPSE_MS)).toBe(true);
    expect(storageRecovery.size()).toBe(0);
  });
});
