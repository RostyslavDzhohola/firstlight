// Loot piles: everything a player carried, left where they died, forever (cap 1,000 per body).
// Piles belong to a body and are shared by both copies in this process; taking is
// first-come-first-served. A persistent backend can replace the in-memory store.
//
// Kinds (F12 review): death piles are what the cap protects. Past the cap, staged piles (admin scenes)
// go first, then loot piles (NPC drops, camp chests, boss overflow, items a player dropped), then the
// oldest death piles; the pile just added is never the one evicted. Staged piles also expire.

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
  /** Absent = "death" (rows from before kinds existed). */
  kind?: PileKind;
  /** Removed by sweep() at this time (ms); absent = never. */
  expiresAt?: number;
}

export type PileKind = "death" | "loot" | "staged";

/** Eviction order past the cap: lower goes first (then oldest first). */
export const PILE_EVICT_ORDER: Readonly<Record<PileKind, number>> = { staged: 0, loot: 1, death: 2 };

export type PileEvent = { kind: "add"; pile: PileData } | { kind: "update"; pile: PileData } | { kind: "remove"; id: string; body: BodyId };

export const PILE_CAP = 1000;

export interface PileStore {
  list(body: BodyId): PileData[];
  /** Store a new pile; the store assigns the id. Returns the stored pile and evicted pile ids. */
  add(input: Omit<PileData, "id">): { pile: PileData; evicted: string[] };
  /** Take one item (index) or everything (index undefined). Returns what was taken, or null if gone. */
  take(id: string, index?: number): { items: InvItem[]; coins: number; pile: PileData | null } | null;
  get(id: string): PileData | undefined;
  /** Remove the body's piles whose expiry has passed; returns their ids. */
  sweep(body: BodyId, now: number): string[];
}

export class MemoryPileStore implements PileStore {
  private readonly byBody = new Map<BodyId, Map<string, PileData>>();
  private readonly index = new Map<string, PileData>();
  private readonly cap: number;

  constructor(cap = PILE_CAP) {
    this.cap = cap;
  }

  list(body: BodyId): PileData[] {
    return [...(this.byBody.get(body)?.values() ?? [])];
  }

  get(id: string) {
    return this.index.get(id);
  }

  private seq = 0;

  add(input: Omit<PileData, "id">): { pile: PileData; evicted: string[] } {
    const pile: PileData = { ...input, id: `${input.body}-${input.createdAt.toString(36)}-${(this.seq++).toString(36)}` };
    let m = this.byBody.get(pile.body);
    if (!m) {
      m = new Map();
      this.byBody.set(pile.body, m);
    }
    m.set(pile.id, pile);
    this.index.set(pile.id, pile);
    const evicted: string[] = [];
    if (m.size > this.cap) {
      const order = (p: PileData) => PILE_EVICT_ORDER[p.kind ?? "death"];
      const sorted = [...m.values()].filter((p) => p !== pile).sort((a, b) => order(a) - order(b) || a.createdAt - b.createdAt);
      for (const p of sorted.slice(0, m.size - this.cap)) {
        m.delete(p.id);
        this.index.delete(p.id);
        evicted.push(p.id);
      }
    }
    return { pile, evicted };
  }

  sweep(body: BodyId, now: number): string[] {
    const m = this.byBody.get(body);
    if (!m) return [];
    const gone: string[] = [];
    for (const p of m.values()) {
      if (p.expiresAt === undefined || p.expiresAt > now) continue;
      m.delete(p.id);
      this.index.delete(p.id);
      gone.push(p.id);
    }
    return gone;
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
