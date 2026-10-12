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
      const min = 60_000;
      const death1 = s.add(pile(1 * min, "death")).pile.id;
      const loot = s.add(pile(2 * min, "loot")).pile.id;
      const death2 = s.add(pile(3 * min, "death")).pile.id;
      // Over the cap: the loot pile goes, though the first death pile is older.
      const death4 = s.add(pile(20 * min, "death"));
      expect(death4.evicted).toEqual([loot]);
      // Only death piles left to make room: the oldest (past its grace period) goes.
      const staged = s.add(pile(21 * min, "staged"));
      expect(staged.evicted).toEqual([death1]);
      // A staged pile goes before any death pile.
      const loot6 = s.add(pile(22 * min, "loot"));
      expect(loot6.evicted).toEqual([staged.pile.id]);
      expect(s.list("arcadia").map((p) => p.id).sort()).toEqual([death2, death4.pile.id, loot6.pile.id].sort());
      expect(s.get(death2)?.kind).toBe("death");
    });

    it("keeps death piles younger than 10 minutes (their owners are on the way back), up to twice the cap", () => {
      const s = make(3);
      const min = 60_000;
      const old = s.add(pile(0, "death")).pile.id;
      const young = [s.add(pile(11 * min, "death")).pile.id, s.add(pile(11.5 * min, "death")).pile.id];
      // Over the cap: the old pile goes.
      const d = s.add(pile(12 * min, "death"));
      expect(d.evicted).toEqual([old]);
      // Every pile is young now: nothing goes, the body runs over the cap…
      expect(s.add(pile(12.5 * min, "death")).evicted).toEqual([]);
      expect(s.add(pile(13 * min, "death")).evicted).toEqual([]);
      expect(s.add(pile(13.5 * min, "death")).evicted).toEqual([]);
      expect(s.list("arcadia")).toHaveLength(6);
      // …until twice the cap, where the oldest young pile has to go.
      expect(s.add(pile(14 * min, "death")).evicted).toEqual([young[0]]);
      // Once they age past 10 minutes, the next pile brings the body back to the cap.
      const later = s.add(pile(30 * min, "death"));
      expect(later.evicted).toHaveLength(4);
      expect(s.list("arcadia")).toHaveLength(3);
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
