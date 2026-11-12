// Small crypto helpers: keyed hashes for emails/IPs/tokens and constant-time comparison.

import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export function hmacHex(secret: string, value: string): string {
  return createHmac("sha256", secret).update(value).digest("hex");
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** A secret worth honouring: at least 32 random bytes' worth (43 base64 / 64 hex characters). */
export function strongSecret(s: string): boolean {
  return s.length >= 43 && new Set(s).size >= 12;
}

/** Constant-time string comparison (hashes both sides so lengths don't leak). */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb) && a.length === b.length;
}
