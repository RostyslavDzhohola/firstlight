// Admin sandboxes (D-admin-3): an admin's test switches only work in a private copy of a body, a
// BodyRoom of its own that nobody else can join, and nothing done in one is ever saved.
//
// The boundary is a scope (AsyncLocalStorage), not a flag each system has to check. Everything a
// sandbox room runs (lifecycle hooks, messages, its tick and the timers those start, and any method
// another room calls on it: BodyRoom.scopeTo) runs inside its sandbox. Inside a sandbox:
//   - every process-wide store (`sandboxed` holders: characters, piles, account progress, copy state,
//     the one-actor-per-user hub, the pile/NPC/Hall event buses, account timers) resolves to the
//     sandbox's own copy, which reads the real store where that makes sense but writes only memory;
//   - game.db refuses every write at its single entry point (db/game-db.ts stmt): a writer that
//     forgot to go through a sandboxed store changes nothing either (counted in `refusedWrites`).
// The real character's row is never touched: "Back to normal" is leaving the sandbox and joining the
// normal room as the real character, from the database.

import { AsyncLocalStorage } from "node:async_hooks";
import type { BodyId } from "@firstlight/shared";

export interface AdminSwitches {
  fly: boolean;
  god: boolean;
  speed: boolean;
}

/** One admin's sandbox, shared by their sandbox rooms (travel between bodies stays inside it). */
export class Sandbox {
  readonly owner: string;
  /** Where the real character is ("Back to normal" goes there). */
  readonly home: BodyId;
  /** The switches live here, not on an actor: only a sandbox has them, and they survive travel. */
  readonly switches: AdminSwitches = { fly: false, god: false, speed: false };
  /** This sandbox's copy of each sandboxed store, made on first use. */
  readonly stores = new Map<object, unknown>();
  /** Live sandbox rooms using it, and since when none has been. */
  rooms = 0;
  idleSince: number;
  /** Closed (Back to normal, or a normal join): the next sandbox for the owner starts fresh. */
  closed = false;

  constructor(owner: string, home: BodyId, now: number) {
    this.owner = owner;
    this.home = home;
    this.idleSince = now;
  }
}

const scope = new AsyncLocalStorage<Sandbox>();

/** The sandbox the current code runs in, if any. */
export function currentSandbox(): Sandbox | undefined {
  return scope.getStore();
}

/** Run `fn` inside `sb` (already inside it: just run it). */
export function runIn<T>(sb: Sandbox, fn: () => T): T {
  return scope.getStore() === sb ? fn() : scope.run(sb, fn);
}

/**
 * A process-wide value that each sandbox gets its own copy of: `current` is the real value outside
 * any sandbox, and `make(real)` (made once per sandbox) inside one. Only boot code and tests replace
 * the real value; replacing it from inside a sandbox throws.
 */
export function sandboxed<T>(initial: T, make: (real: () => T) => T): { current: T } {
  let real = initial;
  const key = {};
  const getReal = () => real;
  return {
    get current(): T {
      const sb = scope.getStore();
      if (!sb) return real;
      if (!sb.stores.has(key)) sb.stores.set(key, make(getReal));
      return sb.stores.get(key) as T;
    },
    set current(v: T) {
      if (scope.getStore()) throw new Error("sandbox: a store can't be replaced from inside a sandbox");
      real = v;
    },
  };
}

// ---- the game.db write guard ------------------------------------------------------------------

/** game.db writes refused inside a sandbox (db/game-db.ts). Tests read it; a warning names each statement once. */
export const refusedWrites = { count: 0, statements: new Set<string>() };

/** Called by stmt() for a statement that writes: true (refuse it) inside a sandbox. */
export function refuseWrite(sql: string): boolean {
  if (!scope.getStore()) return false;
  refusedWrites.count++;
  const key = sql.replace(/\s+/g, " ").trim().slice(0, 80);
  if (!refusedWrites.statements.has(key)) {
    refusedWrites.statements.add(key);
    console.warn(`[sandbox] refused a game.db write: ${key}`);
  }
  return true;
}

// ---- the registry -------------------------------------------------------------------------------

/** A sandbox nobody has been in for this long is forgotten. */
export const SANDBOX = { IDLE_MS: 10 * 60_000 };

const open = new Map<string, Sandbox>();

/** The owner's sandbox, opened now if there is none (home = where the real character is). */
export function openSandbox(owner: string, home: BodyId, now = Date.now()): Sandbox {
  for (const [k, sb] of open) if (sb.rooms === 0 && now - sb.idleSince > SANDBOX.IDLE_MS) open.delete(k);
  let sb = open.get(owner);
  if (!sb) open.set(owner, (sb = new Sandbox(owner, home, now)));
  return sb;
}

export function sandboxOf(owner: string): Sandbox | undefined {
  return open.get(owner);
}

/** Forget the owner's sandbox (rooms still holding it keep it until they close). */
export function closeSandbox(owner: string): Sandbox | undefined {
  const sb = open.get(owner);
  open.delete(owner);
  if (sb) sb.closed = true;
  return sb;
}

export function sandboxRoomOpened(sb: Sandbox): void {
  sb.rooms++;
}

export function sandboxRoomClosed(sb: Sandbox, now = Date.now()): void {
  sb.rooms = Math.max(0, sb.rooms - 1);
  if (!sb.rooms) sb.idleSince = now;
}

/** Tests: forget every sandbox and the refusal counter. */
export function resetSandboxes(): void {
  open.clear();
  refusedWrites.count = 0;
  refusedWrites.statements.clear();
}
