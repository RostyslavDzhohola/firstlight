// Our own OTP send budget (SPEC §5.4.4, D11, D20): ≤ 3 codes per email per hour, a cap per asking
// account per day (F12 final review S7) and a global daily cap (OTP_DAILY_BUDGET); days reset at
// 00:00 UTC like Resend's. Persisted in game.db so restarts don't reset it. Emails are stored only
// as keyed hashes.

import { stmt, tx, type Db } from "./game-db.ts";

const HOUR = 3_600_000;
const DAY = 86_400_000;

export interface OtpLimits {
  perEmailPerHour: number;
  perDay: number;
  /** Sends one account may ask for per UTC day (F12 final review S7); no cap when unset. */
  perAccountPerDay?: number;
}

export type OtpReservation = { ok: true; id: number } | { ok: false; reason: "email" | "global" | "account" };

/**
 * One account's sends on one UTC day, kept in account_stat (no migration). Only today's row is kept:
 * older ones are deleted on the account's next send. A save moves (sums) it like any other stat.
 */
const ACCOUNT_STAT = "otp-sends:";
const accountStat = (day: number) => `${ACCOUNT_STAT}${day}`;

/**
 * Reserve one send. Call `releaseOtpSend` if the send then fails, so failures don't use the budget.
 * `userId`: the signed-in account asking (its daily cap applies), or omitted for a public send.
 */
export function reserveOtpSend(db: Db, emailHash: string, limits: OtpLimits, now = Date.now(), userId: string | null = null): OtpReservation {
  return tx(db, () => {
    const day = Math.floor(now / DAY);
    if (userId && limits.perAccountPerDay !== undefined) {
      const used = (stmt(db, "SELECT value FROM account_stat WHERE user_id = ? AND stat = ?").get(userId, accountStat(day)) as { value: number } | undefined)?.value ?? 0;
      if (used >= limits.perAccountPerDay) return { ok: false as const, reason: "account" as const };
    }
    const perEmail = (stmt(db, "SELECT COUNT(*) AS n FROM otp_send WHERE email_hash = ? AND sent_at > ?").get(emailHash, now - HOUR) as { n: number }).n;
    if (perEmail >= limits.perEmailPerHour) return { ok: false as const, reason: "email" as const };
    const today = (stmt(db, "SELECT COUNT(*) AS n FROM otp_send WHERE sent_at >= ?").get(day * DAY) as { n: number }).n;
    if (today >= limits.perDay) return { ok: false as const, reason: "global" as const };
    const r = stmt(db, "INSERT INTO otp_send (email_hash, sent_at) VALUES (?, ?)").run(emailHash, now);
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
