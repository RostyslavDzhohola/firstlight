// Loot piles: everything a player carried, left where they died, forever (cap 1,000 per body,
// oldest evicted). Piles belong to a body and are shared by both copies in this process; taking is
// first-come-first-served. A persistent backend can replace the in-memory store.

import type { BodyId } from "@firstlight/shared";
import type { InvItem } from "@firstlight/shared/net/protocol";

export interface PileData {
  id: string;
  body: BodyId;
  x: number;
  y: number;
  z: number;
  owner: string; // display name of who died
  ownerUserId: string;
  createdAt: number;
  items: InvItem[];
  coins: number;
}

export type PileEvent = { kind: "add"; pile: PileData } | { kind: "update"; pile: PileData } | { kind: "remove"; id: string; body: BodyId };

export const PILE_CAP = 1000;

export interface PileStore {
  list(body: BodyId): PileData[];
  add(pile: PileData): PileData[]; // returns evicted piles
  /** Take one item (index) or everything (index undefined). Returns what was taken, or null if gone. */
  take(id: string, index?: number): { items: InvItem[]; coins: number; pile: PileData | null } | null;
  get(id: string): PileData | undefined;
}

export class MemoryPileStore implements PileStore {
  private readonly byBody = new Map<BodyId, Map<string, PileData>>();
  private readonly index = new Map<string, PileData>();

  list(body: BodyId): PileData[] {
    return [...(this.byBody.get(body)?.values() ?? [])];
  }

  get(id: string) {
    return this.index.get(id);
  }

  add(pile: PileData): PileData[] {
    let m = this.byBody.get(pile.body);
    if (!m) {
      m = new Map();
      this.byBody.set(pile.body, m);
    }
    m.set(pile.id, pile);
    this.index.set(pile.id, pile);
    const evicted: PileData[] = [];
    if (m.size > PILE_CAP) {
      const sorted = [...m.values()].sort((a, b) => a.createdAt - b.createdAt);
      for (const p of sorted.slice(0, m.size - PILE_CAP)) {
        m.delete(p.id);
        this.index.delete(p.id);
        evicted.push(p);
      }
    }
    return evicted;
  }

  take(id: string, index?: number) {
    const p = this.index.get(id);
    if (!p) return null;
    let items: InvItem[];
    let coins = 0;
    if (index === undefined) {
      items = p.items;
      coins = p.coins;
      p.items = [];
      p.coins = 0;
    } else {
      const it = p.items[index];
      if (!it) return { items: [], coins: 0, pile: p };
      items = [it];
      p.items = p.items.filter((_, i) => i !== index);
    }
    if (p.items.length === 0 && p.coins === 0) {
      this.byBody.get(p.body)?.delete(p.id);
      this.index.delete(p.id);
      return { items, coins, pile: null };
    }
    return { items, coins, pile: p };
  }
}

export const pileStore: { current: PileStore } = { current: new MemoryPileStore() };

type Listener = (e: PileEvent) => void;
const listeners = new Set<Listener>();
export function onPileEvent(l: Listener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}
export function emitPileEvent(e: PileEvent) {
  for (const l of listeners) {
    try {
      l(e);
    } catch (err) {
      console.error("pile listener failed", err);
    }
  }
}
