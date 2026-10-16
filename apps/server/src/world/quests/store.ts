// Account-level quest progress: discovered pads (D2, kept on death), medals, the worn title, account
// counters and the global Hall of Firsts. In-memory for tests and dev; SQLite (game.db) in
// production, installed at boot next to the character and pile stores.

import {
  addAccountStat,
  awardMedal,
  claimFirst,
  ensureAccount,
  getAccount,
  getAccountStat,
  listDiscoveredPads,
  listHallOfFirsts,
  listMedals,
  setTitleMedal,
  discoverPad,
  type Db,
  type HallEntry,
} from "../../db/index.ts";
import { sandboxed } from "../../sandbox.ts";

export type { HallEntry };

export interface ProgressStore {
  /** True if newly discovered. */
  discoverPad(userId: string, body: string, pad: number): boolean;
  pads(userId: string, body: string): number[];
  /** True if newly earned. */
  awardMedal(userId: string, medalId: string): boolean;
  medals(userId: string): string[];
  /** False when the medal isn't earned. */
  setTitle(userId: string, medalId: string | null): boolean;
  title(userId: string): string | null;
  addStat(userId: string, stat: string, delta: number): number;
  stat(userId: string, stat: string): number;
  /** First finder wins; `won` only for the call that engraved it. */
  claimFirst(secretId: string, userId: string, name: string): { won: boolean; entry: HallEntry };
  hall(): HallEntry[];
}

export class MemoryProgressStore implements ProgressStore {
  private readonly padSet = new Map<string, Set<string>>();
  private readonly medalList = new Map<string, string[]>();
  private readonly titles = new Map<string, string | null>();
  private readonly stats = new Map<string, number>();
  private readonly firsts = new Map<string, HallEntry>();

  discoverPad(userId: string, body: string, pad: number): boolean {
    let s = this.padSet.get(userId);
    if (!s) this.padSet.set(userId, (s = new Set()));
    const k = `${body}:${pad}`;
    if (s.has(k)) return false;
    s.add(k);
    return true;
  }
  pads(userId: string, body: string): number[] {
    const out: number[] = [];
    for (const k of this.padSet.get(userId) ?? []) {
      const [b, p] = k.split(":");
      if (b === body) out.push(Number(p));
    }
    return out;
  }
  awardMedal(userId: string, medalId: string): boolean {
    const l = this.medalList.get(userId) ?? [];
    if (l.includes(medalId)) return false;
    l.push(medalId);
    this.medalList.set(userId, l);
    return true;
  }
  medals(userId: string): string[] {
    return [...(this.medalList.get(userId) ?? [])];
  }
  setTitle(userId: string, medalId: string | null): boolean {
    if (medalId !== null && !this.medals(userId).includes(medalId)) return false;
    this.titles.set(userId, medalId);
    return true;
  }
  title(userId: string): string | null {
    return this.titles.get(userId) ?? null;
  }
  addStat(userId: string, stat: string, delta: number): number {
    const k = `${userId}:${stat}`;
    const v = (this.stats.get(k) ?? 0) + Math.trunc(delta);
    this.stats.set(k, v);
    return v;
  }
  stat(userId: string, stat: string): number {
    return this.stats.get(`${userId}:${stat}`) ?? 0;
  }
  claimFirst(secretId: string, userId: string, name: string): { won: boolean; entry: HallEntry } {
    const had = this.firsts.get(secretId);
    if (had) return { won: false, entry: had };
    const entry = { secretId, userId, displayName: name, foundAt: Date.now() };
    this.firsts.set(secretId, entry);
    return { won: true, entry };
  }
  hall(): HallEntry[] {
    return [...this.firsts.values()].sort((a, b) => a.foundAt - b.foundAt);
  }
}

export class SqliteProgressStore implements ProgressStore {
  private readonly db: Db;
  constructor(db: Db) {
    this.db = db;
  }
  discoverPad(userId: string, body: string, pad: number): boolean {
    return discoverPad(this.db, userId, body, String(pad));
  }
  pads(userId: string, body: string): number[] {
    return listDiscoveredPads(this.db, userId)
      .filter((p) => p.body === body)
      .map((p) => Number(p.padId))
      .filter((n) => Number.isInteger(n));
  }
  awardMedal(userId: string, medalId: string): boolean {
    return awardMedal(this.db, userId, medalId);
  }
  medals(userId: string): string[] {
    return listMedals(this.db, userId).map((m) => m.medalId);
  }
  setTitle(userId: string, medalId: string | null): boolean {
    ensureAccount(this.db, userId);
    return setTitleMedal(this.db, userId, medalId);
  }
  title(userId: string): string | null {
    return getAccount(this.db, userId)?.titleMedal ?? null;
  }
  addStat(userId: string, stat: string, delta: number): number {
    return addAccountStat(this.db, userId, stat, delta);
  }
  stat(userId: string, stat: string): number {
    return getAccountStat(this.db, userId, stat);
  }
  claimFirst(secretId: string, userId: string, name: string): { won: boolean; entry: HallEntry } {
    return claimFirst(this.db, secretId, userId, name);
  }
  hall(): HallEntry[] {
    return listHallOfFirsts(this.db);
  }
}

/**
 * An admin sandbox's account progress (D-admin-3): the real account's pads, medals, title, counters
 * and Hall of Firsts read through; what the sandbox adds stays here and is gone with it.
 */
export class SandboxProgressStore implements ProgressStore {
  private readonly real: () => ProgressStore;
  private readonly mine = new MemoryProgressStore();
  private readonly titles = new Map<string, string | null>();
  constructor(real: () => ProgressStore) {
    this.real = real;
  }
  discoverPad(userId: string, body: string, pad: number): boolean {
    return !this.real().pads(userId, body).includes(pad) && this.mine.discoverPad(userId, body, pad);
  }
  pads(userId: string, body: string): number[] {
    return [...new Set([...this.real().pads(userId, body), ...this.mine.pads(userId, body)])];
  }
  awardMedal(userId: string, medalId: string): boolean {
    return !this.real().medals(userId).includes(medalId) && this.mine.awardMedal(userId, medalId);
  }
  medals(userId: string): string[] {
    return [...new Set([...this.real().medals(userId), ...this.mine.medals(userId)])];
  }
  setTitle(userId: string, medalId: string | null): boolean {
    if (medalId !== null && !this.medals(userId).includes(medalId)) return false;
    this.titles.set(userId, medalId);
    return true;
  }
  title(userId: string): string | null {
    return this.titles.has(userId) ? this.titles.get(userId)! : this.real().title(userId);
  }
  addStat(userId: string, stat: string, delta: number): number {
    return this.real().stat(userId, stat) + this.mine.addStat(userId, stat, delta);
  }
  stat(userId: string, stat: string): number {
    return this.real().stat(userId, stat) + this.mine.stat(userId, stat);
  }
  claimFirst(secretId: string, userId: string, name: string): { won: boolean; entry: HallEntry } {
    const had = this.real().hall().find((e) => e.secretId === secretId);
    return had ? { won: false, entry: had } : this.mine.claimFirst(secretId, userId, name);
  }
  hall(): HallEntry[] {
    const real = this.real().hall();
    const taken = new Set(real.map((e) => e.secretId));
    return [...real, ...this.mine.hall().filter((e) => !taken.has(e.secretId))].sort((a, b) => a.foundAt - b.foundAt);
  }
}

/** Process-wide store; main.ts installs the SQLite one at boot. Sandboxes get their own (sandbox.ts). */
export const progressStore = sandboxed<ProgressStore>(new MemoryProgressStore(), (real) => new SandboxProgressStore(() => real()));
