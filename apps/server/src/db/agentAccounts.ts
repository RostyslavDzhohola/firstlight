// Agent accounts (D-agents-1): guest accounts an AI agent plays (packages/agent-kit). They are real
// players by the rules, but not people: the levels and medals boards, the Hall of Firsts and the
// play statistics are the people's. A row in agent_account is the flag (migration 9); it's set when
// a guest asks /api/play for a seat as an agent (auth/accounts.ts) and it stays. Nothing is deleted.

import { stmt, type Db } from "./game-db.ts";

/** SQL: true when the account in `col` is an agent account. */
export const IS_AGENT = (col: string) => `EXISTS (SELECT 1 FROM agent_account g WHERE g.user_id = ${col})`;

export function isAgentAccount(db: Db, userId: string): boolean {
  return !!stmt(db, "SELECT 1 FROM agent_account WHERE user_id = ?").get(userId);
}

/** Flag an account as an agent's. True if it wasn't already. */
export function markAgentAccount(db: Db, userId: string, source: string, now = Date.now()): boolean {
  return stmt(db, "INSERT OR IGNORE INTO agent_account (user_id, source, marked_at) VALUES (?, ?, ?)").run(userId, source, now).changes === 1;
}
