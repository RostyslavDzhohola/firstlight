// Per-copy world state that must outlive one room instance (SPEC §5.1, §6.5; F12 B2). A copy that
// empties auto-disposes and the next /api/play opens a fresh room on the same copy number, and a
// deploy restarts the process, so boss respawn timers, cleared spawn groups (packs, camps, beasts,
// egg NPCs) and broken props are kept here under `body:copy`: systems save a snapshot when it
// changes and when their room goes away, and restore it in their constructor. In memory for tests
// and dev; main.ts installs the SQLite store (game.db) so restarts keep the timers too.

import { loadCopyState, saveCopyState, type Db } from "../db/index.ts";
import type { BodyRoom } from "./BodyRoom.ts";

export interface CopyStateStore {
  load<T>(copyKey: string, system: string): T | null;
  /** `null` forgets the copy's state for this system. */
  save(copyKey: string, system: string, state: unknown): void;
}

export class MemoryCopyStateStore implements CopyStateStore {
  private readonly map = new Map<string, string>();
  load<T>(copyKey: string, system: string): T | null {
    const s = this.map.get(`${copyKey}|${system}`);
    return s === undefined ? null : (JSON.parse(s) as T);
  }
  save(copyKey: string, system: string, state: unknown): void {
    const k = `${copyKey}|${system}`;
    if (state === null || state === undefined) this.map.delete(k);
    else this.map.set(k, JSON.stringify(state));
  }
}

export class SqliteCopyStateStore implements CopyStateStore {
  private readonly db: Db;
  constructor(db: Db) {
    this.db = db;
  }
  load<T>(copyKey: string, system: string): T | null {
    return loadCopyState<T>(this.db, copyKey, system);
  }
  save(copyKey: string, system: string, state: unknown): void {
    // A closed database (shutdown already ran) must not take the room's dispose down with it.
    if (!this.db.open) return;
    saveCopyState(this.db, copyKey, system, state);
  }
}

/** Process-wide store; main.ts installs the SQLite one at boot. */
export const copyStateStore: { current: CopyStateStore } = { current: new MemoryCopyStateStore() };

/** `body:copy`; load-test copies are numbered separately, so they get their own prefix. */
export function copyKey(body: string, copy: number, loadtest = false): string {
  return `${loadtest ? "lt:" : ""}${body}:${copy}`;
}

export function roomCopyKey(room: BodyRoom): string {
  return copyKey(room.bodyDef.id, room.state.copy, !!room.metadata?.loadtest);
}

/**
 * Failed writes are retried with a bounded backoff (F12 final S3): the first retry after
 * `firstMs`, then twice as long each time up to `maxMs`.
 */
export const COPY_RETRY = { firstMs: 1000, maxMs: 30_000 };

interface PendingWrite {
  key: string;
  system: string;
  state: unknown;
  failures: number;
  /** Date.now() before which storage isn't tried again. */
  retryAt: number;
}

/**
 * Writes that failed, newest state per `key|system`, for the store they failed on: until one
 * succeeds this is the copy's state (loadCopy reads it), so restrictions keep holding and a new
 * room on the copy restores what the old one had. Dropped if another store is installed.
 */
const pending = new Map<string, PendingWrite>();
let pendingStore: CopyStateStore | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;

function pendingWrites(): Map<string, PendingWrite> {
  if (pendingStore !== copyStateStore.current) {
    pending.clear();
    pendingStore = copyStateStore.current;
  }
  return pending;
}

/** Load without letting a broken row stop a room from opening. A write still being retried wins. */
export function loadCopy<T>(key: string, system: string): T | null {
  const p = pendingWrites().get(`${key}|${system}`);
  if (p) return p.state === null || p.state === undefined ? null : (JSON.parse(JSON.stringify(p.state)) as T);
  try {
    return copyStateStore.current.load<T>(key, system);
  } catch (err) {
    console.error(`copy state ${key}/${system}: load failed`, err);
    return null;
  }
}

/**
 * Save without letting a storage error break the tick or the dispose. True when the state is in
 * storage; false when the write failed or is waiting out its backoff: the newest state is kept in
 * memory and written by a timer (or the caller's next save after the backoff), so callers keep
 * their dirty flag until this returns true.
 */
export function saveCopy(key: string, system: string, state: unknown): boolean {
  const writes = pendingWrites();
  const k = `${key}|${system}`;
  const p = writes.get(k);
  const now = Date.now();
  if (p && now < p.retryAt) {
    p.state = state;
    return false;
  }
  try {
    copyStateStore.current.save(key, system, state);
    writes.delete(k);
    return true;
  } catch (err) {
    const failures = (p?.failures ?? 0) + 1;
    const wait = Math.min(COPY_RETRY.maxMs, COPY_RETRY.firstMs * 2 ** (failures - 1));
    writes.set(k, { key, system, state, failures, retryAt: now + wait });
    console.error(`copy state ${key}/${system}: save failed (${failures}× in a row), retrying in ${wait} ms`, err);
    scheduleRetry();
    return false;
  }
}

/** Retry every failed write whose backoff is over (the timer calls this). */
export function retryCopySaves(): void {
  for (const p of [...pendingWrites().values()]) if (Date.now() >= p.retryAt) saveCopy(p.key, p.system, p.state);
  scheduleRetry();
}

function scheduleRetry() {
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
  if (!pending.size) return;
  let next = Infinity;
  for (const p of pending.values()) next = Math.min(next, p.retryAt);
  retryTimer = setTimeout(retryCopySaves, Math.max(0, next - Date.now()));
  retryTimer.unref?.();
}
