// Per-copy world state (boss respawn timers, cleared spawn groups, broken props) that must survive
// a room disposing and a deploy restart (SPEC §5.1, §6.5). One JSON row per copy and system.

import { parseJson, stmt, type Db } from "./game-db.ts";

export function loadCopyState<T>(db: Db, copyKey: string, system: string): T | null {
  const r = stmt(db, "SELECT state_json FROM copy_state WHERE copy_key = ? AND system = ?").get(copyKey, system) as { state_json: string } | undefined;
  return r ? parseJson<T | null>(r.state_json, null) : null;
}

/** Upsert the state; `null` deletes the row (nothing left to remember). */
export function saveCopyState(db: Db, copyKey: string, system: string, state: unknown, now = Date.now()): void {
  if (state === null || state === undefined) {
    stmt(db, "DELETE FROM copy_state WHERE copy_key = ? AND system = ?").run(copyKey, system);
    return;
  }
  stmt(
    db,
    `INSERT INTO copy_state (copy_key, system, state_json, saved_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(copy_key, system) DO UPDATE SET state_json = excluded.state_json, saved_at = excluded.saved_at`,
  ).run(copyKey, system, JSON.stringify(state), now);
}
