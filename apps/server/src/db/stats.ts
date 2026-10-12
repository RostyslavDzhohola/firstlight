// Account-level counters (survive death), e.g. props broken for the Demolition Crew medal.

import { stmt, type Db } from "./game-db.ts";

/** Add `delta` to a counter and return the new value. */
export function addAccountStat(db: Db, userId: string, stat: string, delta: number): number {
  stmt(
    db,
    `INSERT INTO account_stat (user_id, stat, value) VALUES (?, ?, ?)
     ON CONFLICT(user_id, stat) DO UPDATE SET value = account_stat.value + excluded.value`,
  ).run(userId, stat, Math.trunc(delta));
  return getAccountStat(db, userId, stat);
}

export function getAccountStat(db: Db, userId: string, stat: string): number {
  const r = stmt(db, "SELECT value FROM account_stat WHERE user_id = ? AND stat = ?").get(userId, stat) as { value: number } | undefined;
  return r?.value ?? 0;
}
