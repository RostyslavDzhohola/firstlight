// POST /api/account/name limits (security pass finding 6, D-security-6). Each change writes game.db
// and the auth user, so attempts are limited per account and per client address (IPv6 per /64),
// a successful change starts a cooldown, and asking for the name the account already has is
// answered without writing anything.

import { banKey } from "./ip.ts";
import { WindowLimiter } from "./limiter.ts";

export const NAME_LIMITS = {
  windowMs: 10 * 60_000,
  /** Attempts (refused ones too) per account per window. */
  perAccount: 6,
  /** Attempts per client address per window. */
  perIp: 20,
  /** After a change, the next one waits this long. */
  cooldownMs: 60_000,
};

export const NAME_LIMIT_MESSAGE = "Too many name changes. Try again in a minute or two.";

export function createNameLimits() {
  const byAccount = new WindowLimiter(NAME_LIMITS.perAccount, NAME_LIMITS.windowMs);
  const byIp = new WindowLimiter(NAME_LIMITS.perIp, NAME_LIMITS.windowMs);
  const changed = new Map<string, number>(); // userId → last change (ms)
  const sync = () => {
    byAccount.max = NAME_LIMITS.perAccount;
    byIp.max = NAME_LIMITS.perIp;
    byAccount.windowMs = byIp.windowMs = NAME_LIMITS.windowMs;
  };
  return {
    /** One attempt for this account from this address, or false when either budget is spent. */
    attempt(userId: string, ip: string | null, now = Date.now()): boolean {
      sync();
      const ipKey = ip ? banKey(ip) : "unknown";
      if (!byAccount.allows(userId, now) || !byIp.allows(ipKey, now)) return false;
      byAccount.add(userId, now);
      byIp.add(ipKey, now);
      return true;
    },
    /** Is the account still cooling down from its last change? */
    coolingDown(userId: string, now = Date.now()): boolean {
      for (const [u, at] of changed) {
        if (now - at < NAME_LIMITS.cooldownMs) break; // the rest changed later
        changed.delete(u);
      }
      const at = changed.get(userId);
      return at !== undefined && now - at < NAME_LIMITS.cooldownMs;
    },
    /** The account's name just changed. */
    changed(userId: string, now = Date.now()): void {
      changed.delete(userId);
      changed.set(userId, now);
    },
  };
}
