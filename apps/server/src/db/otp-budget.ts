// Our own OTP send budget (SPEC §5.4.4, D11, D20): ≤ 3 codes per email per hour and a global daily
// cap (OTP_DAILY_BUDGET, reset at 00:00 UTC like Resend's). Persisted in game.db so restarts don't
// reset it. Emails are stored only as keyed hashes.

import { stmt, tx, type Db } from "./game-db.ts";

const HOUR = 3_600_000;
const DAY = 86_400_000;

export interface OtpLimits {
  perEmailPerHour: number;
  perDay: number;
}

export type OtpReservation = { ok: true; id: number } | { ok: false; reason: "email" | "global" };

/** Reserve one send. Call `releaseOtpSend` if the send then fails, so failures don't use the budget. */
export function reserveOtpSend(db: Db, emailHash: string, limits: OtpLimits, now = Date.now()): OtpReservation {
  return tx(db, () => {
    const perEmail = (stmt(db, "SELECT COUNT(*) AS n FROM otp_send WHERE email_hash = ? AND sent_at > ?").get(emailHash, now - HOUR) as { n: number }).n;
    if (perEmail >= limits.perEmailPerHour) return { ok: false as const, reason: "email" as const };
    const dayStart = Math.floor(now / DAY) * DAY;
    const today = (stmt(db, "SELECT COUNT(*) AS n FROM otp_send WHERE sent_at >= ?").get(dayStart) as { n: number }).n;
    if (today >= limits.perDay) return { ok: false as const, reason: "global" as const };
    const r = stmt(db, "INSERT INTO otp_send (email_hash, sent_at) VALUES (?, ?)").run(emailHash, now);
    stmt(db, "DELETE FROM otp_send WHERE sent_at < ?").run(now - 2 * DAY);
    return { ok: true as const, id: Number(r.lastInsertRowid) };
  });
}

export function releaseOtpSend(db: Db, id: number): void {
  stmt(db, "DELETE FROM otp_send WHERE id = ?").run(id);
}

export function otpSendsToday(db: Db, now = Date.now()): number {
  return (stmt(db, "SELECT COUNT(*) AS n FROM otp_send WHERE sent_at >= ?").get(Math.floor(now / DAY) * DAY) as { n: number }).n;
}
