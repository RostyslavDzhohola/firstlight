// OTP email delivery. Resend in production; without RESEND_API_KEY outside production, a dev outbox
// keeps the last code per email in memory (tests read it through `lastCode`). Codes are never logged
// in production paths.

import { Resend } from "resend";

export type SendResult = { ok: true } | { ok: false; error: string };

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
        if (error) return { ok: false, error: error.name };
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

/** Production without a Resend key: every send fails, so the UI shows "Saving is busy". */
export function disabledMailer(): Mailer {
  return { kind: "disabled", async sendOtp() { return { ok: false, error: "mail_not_configured" }; } };
}
