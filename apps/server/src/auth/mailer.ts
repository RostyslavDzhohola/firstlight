// OTP email delivery. Resend in production; without RESEND_API_KEY outside production, a dev outbox
// keeps the last code per email in memory (tests read it through `lastCode`). Codes are never logged
// in production paths.

import { Resend } from "resend";

/** `error`: the provider's error name (Resend's `name`, or "network"); `status`: its HTTP status. Never the message. */
export type SendResult = { ok: true } | { ok: false; error: string; status?: number | null };

/**
 * Why a code didn't go out, as the save card hears it (HANDOFF 5c: saving can be unavailable):
 * - "busy": the provider's quota or rate limit; try again later;
 * - "rejected": the provider refused this recipient (Resend 422 validation); check the address;
 * - "unavailable": the sending side is down: no key, the sending domain isn't verified (Resend 403),
 *   a bad key, the network or the provider itself.
 */
export type MailFailure = "busy" | "rejected" | "unavailable";

const PROVIDER_BUSY: ReadonlySet<string> = new Set(["daily_quota_exceeded", "monthly_quota_exceeded", "rate_limit_exceeded"]);

export function classifyMailFailure(r: { error: string; status?: number | null }): MailFailure {
  if (PROVIDER_BUSY.has(r.error) || r.status === 429) return "busy";
  // Resend answers an unverified domain or a testing-only key with validation_error 403; 422 is the request's own fields.
  if ((r.error === "validation_error" || r.error === "invalid_parameter") && r.status !== 401 && r.status !== 403) return "rejected";
  return "unavailable";
}

/** How long a sending-side failure marks saving as down before the next public request may try again. */
export const MAIL_DOWN_MS = 10 * 60_000;

/**
 * Whether codes can go out right now: "unavailable" without a mail transport, else the last
 * player-initiated send's outcome (a sending-side or quota failure holds for MAIL_DOWN_MS; a success
 * clears it at once). Only sends a player asked for synchronously are recorded: background sends to
 * saved addresses must not change anything another request can observe (no enumeration, D34).
 */
export class MailHealth {
  private down: { state: "busy" | "unavailable"; until: number } | null = null;
  private readonly mailer: Mailer;
  private readonly holdMs: number;

  constructor(mailer: Mailer, holdMs = MAIL_DOWN_MS) {
    this.mailer = mailer;
    this.holdMs = holdMs;
  }

  state(now = Date.now()): "ok" | "busy" | "unavailable" {
    if (this.mailer.kind === "disabled") return "unavailable";
    return this.down && now < this.down.until ? this.down.state : "ok";
  }

  record(r: SendResult, now = Date.now()): void {
    if (r.ok) {
      this.down = null;
      return;
    }
    const f = classifyMailFailure(r);
    if (f !== "rejected") this.down = { state: f, until: now + this.holdMs };
  }
}

export interface Mailer {
  readonly kind: "resend" | "dev" | "disabled";
  sendOtp(email: string, otp: string): Promise<SendResult>;
}

export function otpEmail(otp: string): { subject: string; text: string } {
  return {
    subject: `${otp} is your FIRSTLIGHT code`,
    text: `Your FIRSTLIGHT code is ${otp}.\n\nIt expires in 5 minutes. If you didn't ask for it, you can ignore this email.\n`,
  };
}

export function resendMailer(apiKey: string, from: string): Mailer {
  const resend = new Resend(apiKey);
  return {
    kind: "resend",
    async sendOtp(email, otp) {
      const { subject, text } = otpEmail(otp);
      try {
        const { error } = await resend.emails.send({ from, to: email, subject, text });
        if (error) return { ok: false, error: error.name, status: error.statusCode };
        return { ok: true };
      } catch {
        return { ok: false, error: "network" };
      }
    },
  };
}

/** Dev/test outbox. Never used in production. */
export class DevOutbox implements Mailer {
  readonly kind = "dev" as const;
  private last = new Map<string, { otp: string; at: number }>();
  sent = 0;
  log: boolean;

  constructor(log = false) {
    this.log = log;
  }

  async sendOtp(email: string, otp: string): Promise<SendResult> {
    this.last.set(email.toLowerCase(), { otp, at: Date.now() });
    this.sent++;
    if (this.log) console.log(`[dev-mail] FIRSTLIGHT code for ${email}: ${otp}`);
    return { ok: true };
  }

  /** Test-only: the most recent code sent to `email`. */
  lastCode(email: string): string | null {
    return this.last.get(email.toLowerCase())?.otp ?? null;
  }
}

/** Production without a Resend key: every send fails, so the UI shows "Saving is temporarily unavailable". */
export function disabledMailer(): Mailer {
  return { kind: "disabled", async sendOtp() { return { ok: false, error: "mail_not_configured" }; } };
}
