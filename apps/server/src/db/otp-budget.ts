// Our own OTP send budget (SPEC §5.4.4, D11, D20): ≤ 3 codes per email per hour, a cap per asking
// account per day (F12 final review S7), a share of the day and a cap per client IP for public sends
// (no account asking; F12 confirmation Opus SF2) and a global daily cap (OTP_DAILY_BUDGET); days
// reset at 00:00 UTC like Resend's. Persisted in game.db so restarts don't reset it. Emails and IPs
// are stored only as keyed hashes.

import { stmt, tx, type Db } from "./game-db.ts";

const HOUR = 3_600_000;
const DAY = 86_400_000;

export interface OtpLimits {
  perEmailPerHour: number;
  perDay: number;
  /** Sends one account may ask for per UTC day (F12 final review S7); no cap when unset. */
  perAccountPerDay?: number;
  /** Public sends per UTC day in all, so they can't use up what saving needs; no cap when unset. */
  publicPerDay?: number;
  /** Public sends per client IP (its ban key) per UTC day; no cap when unset. */
  publicPerIpPerDay?: number;
}

export type OtpReservation = { ok: true; id: number } | { ok: false; reason: "email" | "global" | "account" | "public" | "ip" };

/**
 * A public send's row key (no migration): `pub:<ip hash>|<email hash>`, so one table counts the
 * public share (prefix `pub:`), each IP (prefix) and each address (suffix). Saving sends keep the
 * plain email hash.
 */
const PUBLIC = "pub:";
const publicKey = (emailHash: string, ipHash: string) => `${PUBLIC}${ipHash}|${emailHash}`;

/**
 * One account's sends on one UTC day, kept in account_stat (no migration). Only today's row is kept:
 * older ones are deleted on the account's next send. A save moves (sums) it like any other stat.
 */
const ACCOUNT_STAT = "otp-sends:";
const accountStat = (day: number) => `${ACCOUNT_STAT}${day}`;

/**
 * Reserve one send. Call `releaseOtpSend` if the send then fails, so failures don't use the budget.
 * `userId`: the signed-in account asking (its daily cap applies), or null for a public send, which
 * counts against the public share and its client's `ipHash` (null: one shared "unknown" bucket).
 */
export function reserveOtpSend(db: Db, emailHash: string, limits: OtpLimits, now = Date.now(), userId: string | null = null, ipHash: string | null = null): OtpReservation {
  return tx(db, () => {
    const day = Math.floor(now / DAY);
    if (userId && limits.perAccountPerDay !== undefined) {
      const used = (stmt(db, "SELECT value FROM account_stat WHERE user_id = ? AND stat = ?").get(userId, accountStat(day)) as { value: number } | undefined)?.value ?? 0;
      if (used >= limits.perAccountPerDay) return { ok: false as const, reason: "account" as const };
    }
    const ip = ipHash ?? "unknown";
    const perEmail = userId
      ? (stmt(db, "SELECT COUNT(*) AS n FROM otp_send WHERE email_hash = ? AND sent_at > ?").get(emailHash, now - HOUR) as { n: number }).n
      : (stmt(db, "SELECT COUNT(*) AS n FROM otp_send WHERE substr(email_hash, 1, 4) = ? AND substr(email_hash, -length(?)) = ? AND sent_at > ?").get(PUBLIC, `|${emailHash}`, `|${emailHash}`, now - HOUR) as { n: number }).n;
    if (perEmail >= limits.perEmailPerHour) return { ok: false as const, reason: "email" as const };
    if (!userId && limits.publicPerIpPerDay !== undefined) {
      const prefix = `${PUBLIC}${ip}|`;
      const fromIp = (stmt(db, "SELECT COUNT(*) AS n FROM otp_send WHERE substr(email_hash, 1, length(?)) = ? AND sent_at >= ?").get(prefix, prefix, day * DAY) as { n: number }).n;
      if (fromIp >= limits.publicPerIpPerDay) return { ok: false as const, reason: "ip" as const };
    }
    if (!userId && limits.publicPerDay !== undefined) {
      const publicToday = (stmt(db, "SELECT COUNT(*) AS n FROM otp_send WHERE substr(email_hash, 1, 4) = ? AND sent_at >= ?").get(PUBLIC, day * DAY) as { n: number }).n;
      if (publicToday >= limits.publicPerDay) return { ok: false as const, reason: "public" as const };
    }
    const today = (stmt(db, "SELECT COUNT(*) AS n FROM otp_send WHERE sent_at >= ?").get(day * DAY) as { n: number }).n;
    if (today >= limits.perDay) return { ok: false as const, reason: "global" as const };
    const r = stmt(db, "INSERT INTO otp_send (email_hash, sent_at) VALUES (?, ?)").run(userId ? emailHash : publicKey(emailHash, ip), now);
    stmt(db, "DELETE FROM otp_send WHERE sent_at < ?").run(now - 2 * DAY);
    if (userId) {
      stmt(db, "DELETE FROM account_stat WHERE user_id = ? AND stat LIKE ? AND stat <> ?").run(userId, `${ACCOUNT_STAT}%`, accountStat(day));
      stmt(db, "INSERT INTO account_stat (user_id, stat, value) VALUES (?, ?, 1) ON CONFLICT(user_id, stat) DO UPDATE SET value = value + 1").run(userId, accountStat(day));
    }
    return { ok: true as const, id: Number(r.lastInsertRowid) };
  });
}

/** Undo a reservation (the send failed); `userId` as given to reserveOtpSend. */
export function releaseOtpSend(db: Db, id: number, userId: string | null = null): void {
  tx(db, () => {
    const row = stmt(db, "SELECT sent_at FROM otp_send WHERE id = ?").get(id) as { sent_at: number } | undefined;
    stmt(db, "DELETE FROM otp_send WHERE id = ?").run(id);
    if (row && userId) stmt(db, "UPDATE account_stat SET value = MAX(0, value - 1) WHERE user_id = ? AND stat = ?").run(userId, accountStat(Math.floor(row.sent_at / DAY)));
  });
}

export function otpSendsToday(db: Db, now = Date.now()): number {
  return (stmt(db, "SELECT COUNT(*) AS n FROM otp_send WHERE sent_at >= ?").get(Math.floor(now / DAY) * DAY) as { n: number }).n;
}
