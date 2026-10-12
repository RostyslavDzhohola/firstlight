// Loot piles (SPEC §5.5, §6.6): per body (shared by both copies), never expire, capped at 1,000 per
// body with the oldest evicted. Every take is a transaction, so the first taker wins.
//
// Items are stored as `{ key, item }` entries; `key` is stable within a pile (0..n-1 at drop time),
// so "take item 3" can't accidentally grab a different item after someone else took one.

import { parseJson, stmt, tx, type Db } from "./game-db.ts";

export const PILE_CAP_PER_BODY = 1000;

export interface PileEntry<T = unknown> {
  key: number;
  item: T;
}

export interface Pile<T = unknown> {
  id: number;
  body: string;
  x: number;
  y: number;
  z: number;
  items: PileEntry<T>[];
  coins: number;
  ownerId: string | null;
  ownerName: string;
  createdAt: number;
  /** "death" | "loot" | "staged" (eviction order past the cap: staged, loot, then death). */
  kind: string;
  expiresAt: number | null;
}

interface PileRow {
  id: number;
  body: string;
  pos_x: number;
  pos_y: number;
  pos_z: number;
  items_json: string;
  coins: number;
  owner_id: string | null;
  owner_name: string;
  created_at: number;
  kind: string;
  expires_at: number | null;
}

function toPile<T>(r: PileRow): Pile<T> {
  return {
    id: r.id,
    body: r.body,
    x: r.pos_x,
    y: r.pos_y,
    z: r.pos_z,
    items: parseJson<PileEntry<T>[]>(r.items_json, []),
    coins: r.coins,
    ownerId: r.owner_id,
    ownerName: r.owner_name,
    createdAt: r.created_at,
    kind: r.kind,
    expiresAt: r.expires_at,
  };
}

export interface DropPileInput<T> {
  body: string;
  x: number;
  y: number;
  z: number;
  items: readonly T[];
  coins: number;
  ownerId?: string | null;
  ownerName: string;
  now?: number;
  kind?: "death" | "loot" | "staged";
  expiresAt?: number | null;
}

/**
 * Insert a pile; beyond the cap evicts other piles on that body: staged, then loot, then death piles,
 * oldest first (never the new one). Returns evicted ids.
 */
export function dropPile<T>(db: Db, input: DropPileInput<T>, cap = PILE_CAP_PER_BODY): { pile: Pile<T>; evicted: number[] } {
  return tx(db, () => {
    const entries: PileEntry<T>[] = input.items.map((item, key) => ({ key, item }));
    const now = input.now ?? Date.now();
    const res = stmt(
      db,
      "INSERT INTO pile (body, pos_x, pos_y, pos_z, items_json, coins, owner_id, owner_name, created_at, kind, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(input.body, input.x, input.y, input.z, JSON.stringify(entries), Math.max(0, Math.floor(input.coins)), input.ownerId ?? null, input.ownerName, now, input.kind ?? "death", input.expiresAt ?? null);
    const id = Number(res.lastInsertRowid);
    const count = (stmt(db, "SELECT COUNT(*) AS n FROM pile WHERE body = ?").get(input.body) as { n: number }).n;
    let evicted: number[] = [];
    if (count > cap) {
      evicted = (
        stmt(
          db,
          `DELETE FROM pile WHERE id IN (SELECT id FROM pile WHERE body = ? AND id <> ?
             ORDER BY CASE kind WHEN 'staged' THEN 0 WHEN 'loot' THEN 1 ELSE 2 END, created_at, id LIMIT ?) RETURNING id`,
        ).all(input.body, id, count - cap) as { id: number }[]
      ).map((r) => r.id);
    }
    return { pile: getPile<T>(db, id)!, evicted };
  });
}

/** Delete a body's piles whose expiry has passed. Returns their ids. */
export function sweepPiles(db: Db, body: string, now: number): number[] {
  return (stmt(db, "DELETE FROM pile WHERE body = ? AND expires_at IS NOT NULL AND expires_at <= ? RETURNING id").all(body, now) as { id: number }[]).map((r) => r.id);
}

export function getPile<T = unknown>(db: Db, id: number): Pile<T> | null {
  const r = stmt(db, "SELECT * FROM pile WHERE id = ?").get(id) as PileRow | undefined;
  return r ? toPile<T>(r) : null;
}

export function listPiles<T = unknown>(db: Db, body: string): Pile<T>[] {
  return (stmt(db, "SELECT * FROM pile WHERE body = ? ORDER BY created_at, id").all(body) as PileRow[]).map((r) => toPile<T>(r));
}

export type TakeResult<T> =
  | {
      ok: true;
      items: T[];
      coins: number;
      /** The pile is now empty and was deleted. */
      emptied: boolean;
      /** What's left (null when emptied). */
      pile: Pile<T> | null;
    }
  | { ok: false; reason: "gone" | "taken" };

function finish<T>(db: Db, pile: Pile<T>, items: T[], coins: number): TakeResult<T> {
  if (pile.items.length === 0 && pile.coins === 0) {
    stmt(db, "DELETE FROM pile WHERE id = ?").run(pile.id);
    return { ok: true, items, coins, emptied: true, pile: null };
  }
  stmt(db, "UPDATE pile SET items_json = ?, coins = ? WHERE id = ?").run(JSON.stringify(pile.items), pile.coins, pile.id);
  return { ok: true, items, coins, emptied: false, pile };
}

/** Take everything (E). `{ok:false, reason:"gone"}` if someone else got there first. */
export function takeAll<T = unknown>(db: Db, pileId: number): TakeResult<T> {
  return tx(db, () => {
    const pile = getPile<T>(db, pileId);
    if (!pile) return { ok: false, reason: "gone" };
    stmt(db, "DELETE FROM pile WHERE id = ?").run(pileId);
    return { ok: true, items: pile.items.map((e) => e.item), coins: pile.coins, emptied: true, pile: null };
  });
}

/** Take one item by its key. `taken` if that item is no longer there. */
export function takeItem<T = unknown>(db: Db, pileId: number, key: number): TakeResult<T> {
  return tx(db, () => {
    const pile = getPile<T>(db, pileId);
    if (!pile) return { ok: false, reason: "gone" };
    const i = pile.items.findIndex((e) => e.key === key);
    if (i < 0) return { ok: false, reason: "taken" };
    const [entry] = pile.items.splice(i, 1);
    return finish(db, pile, [entry!.item], 0);
  });
}

/** Take only the coins. */
export function takeCoins<T = unknown>(db: Db, pileId: number): TakeResult<T> {
  return tx(db, () => {
    const pile = getPile<T>(db, pileId);
    if (!pile) return { ok: false, reason: "gone" };
    if (pile.coins === 0) return { ok: false, reason: "taken" };
    const coins = pile.coins;
    pile.coins = 0;
    return finish(db, pile, [], coins);
  });
}
