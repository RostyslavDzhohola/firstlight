// Loot pile stores (memory and SQLite) past the per-body cap and with expiry (F12 review): death piles
// are what the cap protects, so staged piles go first, then loot piles (NPC drops, chests, items a
// player dropped), then the oldest death piles. Staged piles expire on their own.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { InvItem } from "@firstlight/shared/net/protocol";
import { openGameDb } from "../src/db/index.ts";
import { MemoryPileStore, type PileData, type PileKind, type PileStore } from "../src/world/piles.ts";
import { SqlitePileStore } from "../src/world/sqliteStores.ts";

const stores: [string, (cap: number) => PileStore][] = [
  ["memory", (cap) => new MemoryPileStore(cap)],
  ["sqlite", (cap) => new SqlitePileStore(openGameDb(join(mkdtempSync(join(tmpdir(), "fl-piles-")), "game.db")), cap)],
];

const item: InvItem = { id: "carbine", tier: 1, qty: 1 };
function pile(createdAt: number, kind?: PileKind, expiresAt?: number): Omit<PileData, "id"> {
  return { body: "arcadia", x: createdAt, y: 0, z: 0, owner: "Ann", ownerUserId: "u1", createdAt, items: [item], coins: 0, ...(kind ? { kind } : {}), ...(expiresAt ? { expiresAt } : {}) };
}

for (const [name, make] of stores) {
  describe(`${name} pile store`, () => {
    it("evicts staged, then loot piles before death piles once the body is over the cap (never the new pile)", () => {
      const s = make(3);
      const death1 = s.add(pile(1, "death")).pile.id;
      const loot = s.add(pile(2, "loot")).pile.id;
      const death2 = s.add(pile(3, "death")).pile.id;
      // Over the cap: the loot pile goes, though the first death pile is older.
      const death4 = s.add(pile(4, "death"));
      expect(death4.evicted).toEqual([loot]);
      // Only death piles left to make room: the oldest goes.
      const staged = s.add(pile(5, "staged"));
      expect(staged.evicted).toEqual([death1]);
      // A staged pile goes before any death pile.
      const loot6 = s.add(pile(6, "loot"));
      expect(loot6.evicted).toEqual([staged.pile.id]);
      expect(s.list("arcadia").map((p) => p.id).sort()).toEqual([death2, death4.pile.id, loot6.pile.id].sort());
      expect(s.get(death2)?.kind).toBe("death");
    });

    it("piles without a kind count as death piles; expired piles are swept per body", () => {
      const s = make(10);
      const old = s.add(pile(1)).pile;
      expect(s.get(old.id)?.kind ?? "death").toBe("death");
      const staged = s.add(pile(2, "staged", 5000)).pile.id;
      const keep = s.add(pile(3, "loot")).pile.id;
      expect(s.sweep("arcadia", 4999)).toEqual([]);
      expect(s.sweep("hollowmere", 6000)).toEqual([]);
      expect(s.sweep("arcadia", 5000)).toEqual([staged]);
      expect(s.get(staged)).toBeUndefined();
      expect(s.list("arcadia").map((p) => p.id).sort()).toEqual([old.id, keep].sort());
    });
  });
}
