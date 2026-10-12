// Accounts, display names, admin flag, bans, blocks and reports (game.db).

import { stmt, tx, type Db } from "./game-db.ts";
import { displayNameProblem, type NameProblem } from "./names.ts";

export interface Account {
  userId: string;
  displayName: string | null;
  isAdmin: boolean;
  titleMedal: string | null;
  createdAt: number;
  lastSeenAt: number;
  bannedUntil: number | null;
  lastIpHash: string | null;
}

interface AccountRow {
  user_id: string;
  display_name: string | null;
  is_admin: number;
  title_medal: string | null;
  created_at: number;
  last_seen_at: number;
  banned_until: number | null;
  last_ip_hash: string | null;
}

function toAccount(r: AccountRow): Account {
  return {
    userId: r.user_id,
    displayName: r.display_name,
    isAdmin: r.is_admin === 1,
    titleMedal: r.title_medal,
    createdAt: r.created_at,
    lastSeenAt: r.last_seen_at,
    bannedUntil: r.banned_until,
    lastIpHash: r.last_ip_hash,
  };
}

export function getAccount(db: Db, userId: string): Account | null {
  const r = stmt(db, "SELECT * FROM account WHERE user_id = ?").get(userId) as AccountRow | undefined;
  return r ? toAccount(r) : null;
}

/** Create the account row if missing and stamp last-seen (and the last IP hash when given). */
export function ensureAccount(db: Db, userId: string, now = Date.now(), ipHash?: string | null): Account {
  stmt(
    db,
    `INSERT INTO account (user_id, created_at, last_seen_at, last_ip_hash) VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET last_seen_at = excluded.last_seen_at,
       last_ip_hash = COALESCE(excluded.last_ip_hash, account.last_ip_hash)`,
  ).run(userId, now, now, ipHash ?? null);
  return getAccount(db, userId)!;
}

export function findAccountByName(db: Db, name: string): Account | null {
  const r = stmt(db, "SELECT * FROM account WHERE display_name = ? COLLATE NOCASE").get(name) as AccountRow | undefined;
  return r ? toAccount(r) : null;
}

export type SetNameResult = { ok: true; name: string } | { ok: false; error: NameProblem | "taken" };

/** Validate and set a display name (3–16 chars [A-Za-z0-9_], filtered, unique ignoring case). */
export function setDisplayName(db: Db, userId: string, raw: string, now = Date.now()): SetNameResult {
  const name = raw.trim();
  const problem = displayNameProblem(name);
  if (problem) return { ok: false, error: problem };
  return tx(db, () => {
    const holder = findAccountByName(db, name);
    if (holder && holder.userId !== userId) return { ok: false as const, error: "taken" as const };
    ensureAccount(db, userId, now);
    try {
      stmt(db, "UPDATE account SET display_name = ? WHERE user_id = ?").run(name, userId);
    } catch (e) {
      if (String((e as Error).message).includes("UNIQUE")) return { ok: false as const, error: "taken" as const };
      throw e;
    }
    return { ok: true as const, name };
  });
}

export function setAdmin(db: Db, userId: string, admin: boolean, now = Date.now()): void {
  ensureAccount(db, userId, now);
  stmt(db, "UPDATE account SET is_admin = ? WHERE user_id = ?").run(admin ? 1 : 0, userId);
}

export function isAdmin(db: Db, userId: string): boolean {
  const r = stmt(db, "SELECT is_admin FROM account WHERE user_id = ?").get(userId) as { is_admin: number } | undefined;
  return r?.is_admin === 1;
}

/** Wear an earned medal as a title (null clears). Returns false if the medal isn't earned. */
export function setTitleMedal(db: Db, userId: string, medalId: string | null): boolean {
  if (medalId !== null) {
    const has = stmt(db, "SELECT 1 FROM medal WHERE user_id = ? AND medal_id = ?").get(userId, medalId);
    if (!has) return false;
  }
  return stmt(db, "UPDATE account SET title_medal = ? WHERE user_id = ?").run(medalId, userId).changes === 1;
}

// ---------------------------------------------------------------------------------------------
// Admin claim (one-time token, burnt state persisted)

export type ClaimResult = "claimed" | "burnt";

/** Burn the claim token (by hash) for `userId` and make them admin, atomically. */
export function claimAdmin(db: Db, tokenHash: string, userId: string, now = Date.now()): ClaimResult {
  return tx(db, () => {
    const used = stmt(db, "SELECT 1 FROM admin_claim WHERE token_hash = ?").get(tokenHash);
    if (used) return "burnt";
    stmt(db, "INSERT INTO admin_claim (token_hash, user_id, claimed_at) VALUES (?, ?, ?)").run(tokenHash, userId, now);
    setAdmin(db, userId, true, now);
    return "claimed";
  });
}

export function isClaimBurnt(db: Db, tokenHash: string): boolean {
  return !!stmt(db, "SELECT 1 FROM admin_claim WHERE token_hash = ?").get(tokenHash);
}

// ---------------------------------------------------------------------------------------------
// Bans (account and/or IP hash). `until` null = permanent.

export interface Ban {
  id: number;
  userId: string | null;
  ipHash: string | null;
  until: number | null;
  reason: string;
  createdBy: string | null;
  createdAt: number;
}

interface BanRow {
  id: number;
  user_id: string | null;
  ip_hash: string | null;
  until: number | null;
  reason: string;
  created_by: string | null;
  created_at: number;
}

const toBan = (r: BanRow): Ban => ({
  id: r.id,
  userId: r.user_id,
  ipHash: r.ip_hash,
  until: r.until,
  reason: r.reason,
  createdBy: r.created_by,
  createdAt: r.created_at,
});

export interface BanInput {
  userId?: string | null;
  /** Defaults to the account's last seen IP hash when banning a user. Pass null to skip the IP ban. */
  ipHash?: string | null;
  until?: number | null;
  reason?: string;
  createdBy?: string | null;
  now?: number;
}

/** Ban an account (and by default its last IP hash). Returns the ban id. */
export function banUser(db: Db, input: BanInput): number {
  const now = input.now ?? Date.now();
  return tx(db, () => {
    const userId = input.userId ?? null;
    let ipHash = input.ipHash;
    if (ipHash === undefined) ipHash = userId ? (getAccount(db, userId)?.lastIpHash ?? null) : null;
    if (!userId && !ipHash) throw new Error("banUser needs a userId or ipHash");
    const r = stmt(
      db,
      "INSERT INTO ban (user_id, ip_hash, until, reason, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(userId, ipHash, input.until ?? null, input.reason ?? "", input.createdBy ?? null, now);
    if (userId) {
      ensureAccount(db, userId, now);
      stmt(db, "UPDATE account SET banned_until = ? WHERE user_id = ?").run(input.until ?? Number.MAX_SAFE_INTEGER, userId);
    }
    return Number(r.lastInsertRowid);
  });
}

/** Lift every ban on the account (not IP bans recorded separately). */
export function unbanUser(db: Db, userId: string): number {
  return tx(db, () => {
    const n = stmt(db, "DELETE FROM ban WHERE user_id = ?").run(userId).changes;
    stmt(db, "UPDATE account SET banned_until = NULL WHERE user_id = ?").run(userId);
    return n;
  });
}

export function liftBan(db: Db, banId: number): boolean {
  return stmt(db, "DELETE FROM ban WHERE id = ?").run(banId).changes === 1;
}

export function isBanned(db: Db, userId: string, now = Date.now()): boolean {
  return !!stmt(db, "SELECT 1 FROM ban WHERE user_id = ? AND (until IS NULL OR until > ?) LIMIT 1").get(userId, now);
}

export function isIpBanned(db: Db, ipHash: string, now = Date.now()): boolean {
  return !!stmt(db, "SELECT 1 FROM ban WHERE ip_hash = ? AND (until IS NULL OR until > ?) LIMIT 1").get(ipHash, now);
}

export function listBans(db: Db, now = Date.now(), includeExpired = false): Ban[] {
  const rows = (
    includeExpired
      ? stmt(db, "SELECT * FROM ban ORDER BY created_at DESC").all()
      : stmt(db, "SELECT * FROM ban WHERE until IS NULL OR until > ? ORDER BY created_at DESC").all(now)
  ) as BanRow[];
  return rows.map(toBan);
}

// ---------------------------------------------------------------------------------------------
// Blocks

export function blockUser(db: Db, userId: string, blockedUserId: string, now = Date.now()): boolean {
  if (userId === blockedUserId) return false;
  return stmt(db, "INSERT OR IGNORE INTO block (user_id, blocked_user_id, created_at) VALUES (?, ?, ?)").run(userId, blockedUserId, now).changes === 1;
}

export function unblockUser(db: Db, userId: string, blockedUserId: string): boolean {
  return stmt(db, "DELETE FROM block WHERE user_id = ? AND blocked_user_id = ?").run(userId, blockedUserId).changes === 1;
}

export function listBlocked(db: Db, userId: string): string[] {
  return (stmt(db, "SELECT blocked_user_id FROM block WHERE user_id = ? ORDER BY created_at").all(userId) as { blocked_user_id: string }[]).map(
    (r) => r.blocked_user_id,
  );
}

/** True when either player blocked the other (voice, phrases and party invites are suppressed). */
export function isBlockedEitherWay(db: Db, a: string, b: string): boolean {
  return !!stmt(db, "SELECT 1 FROM block WHERE (user_id = ? AND blocked_user_id = ?) OR (user_id = ? AND blocked_user_id = ?) LIMIT 1").get(a, b, b, a);
}

// ---------------------------------------------------------------------------------------------
// Reports

export interface Report {
  id: number;
  reporter: string;
  target: string;
  body: string | null;
  pos: [number, number, number] | null;
  reason: string;
  createdAt: number;
}

export interface ReportInput {
  reporter: string;
  target: string;
  body?: string | null;
  pos?: readonly [number, number, number] | null;
  reason: string;
  now?: number;
}

export function fileReport(db: Db, r: ReportInput): number {
  const pos = r.pos ?? null;
  const res = stmt(
    db,
    "INSERT INTO report (reporter, target, body, pos_x, pos_y, pos_z, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(r.reporter, r.target, r.body ?? null, pos?.[0] ?? null, pos?.[1] ?? null, pos?.[2] ?? null, r.reason.slice(0, 500), r.now ?? Date.now());
  return Number(res.lastInsertRowid);
}

export function listReports(db: Db, limit = 100, offset = 0): Report[] {
  const rows = stmt(db, "SELECT * FROM report ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?").all(limit, offset) as {
    id: number;
    reporter: string;
    target: string;
    body: string | null;
    pos_x: number | null;
    pos_y: number | null;
    pos_z: number | null;
    reason: string;
    created_at: number;
  }[];
  return rows.map((r) => ({
    id: r.id,
    reporter: r.reporter,
    target: r.target,
    body: r.body,
    pos: r.pos_x === null ? null : [r.pos_x, r.pos_y ?? 0, r.pos_z ?? 0],
    reason: r.reason,
    createdAt: r.created_at,
  }));
}

export function deleteReport(db: Db, id: number): boolean {
  return stmt(db, "DELETE FROM report WHERE id = ?").run(id).changes === 1;
}
