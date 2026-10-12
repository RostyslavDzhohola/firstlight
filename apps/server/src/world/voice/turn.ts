// Cloudflare Realtime TURN: per-player ICE credentials (tech-facts §6). One credential per player,
// minted when they enable voice and every 6 h after; revoked on leave, block and ban.
// The key token and minted credentials are secrets: never log them.

import { filterIceServers, VOICE, type IceServerConfig } from "@firstlight/shared/net/voice";
import { z } from "zod";
import { env } from "../../env.ts";

export const TURN_API = "https://rtc.live.cloudflare.com/v1/turn/keys";

const iceServerSchema = z.object({
  urls: z.union([z.string().max(512), z.array(z.string().max(512)).max(16)]),
  username: z.string().max(512).optional(),
  credential: z.string().max(512).optional(),
});
const mintResponseSchema = z.object({ iceServers: z.union([z.array(iceServerSchema).max(8), iceServerSchema]) });

export interface MintedIce {
  iceServers: IceServerConfig[];
  /** TURN usernames, for revocation. */
  usernames: string[];
}

/** Read at call time so tests (and a restarted config) see the current values. */
export function turnConfigured(): boolean {
  return !!(env.turnKeyId && env.turnKeyToken);
}

function keyUrl(path: string): string {
  return `${TURN_API}/${encodeURIComponent(env.turnKeyId)}/${path}`;
}

/** POST generate-ice-servers {ttl} → relay-only list (STUN and :53 URLs dropped). */
export async function mintIceServers(ttl: number = VOICE.TURN_TTL_S): Promise<MintedIce> {
  const res = await fetch(keyUrl("credentials/generate-ice-servers"), {
    method: "POST",
    headers: { Authorization: `Bearer ${env.turnKeyToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ ttl }),
    signal: AbortSignal.timeout(8000),
  });
  if (res.status !== 201 && res.status !== 200) throw new Error(`TURN mint failed: HTTP ${res.status}`);
  const parsed = mintResponseSchema.safeParse(await res.json().catch(() => null));
  if (!parsed.success) throw new Error("TURN mint failed: unexpected response");
  const list = Array.isArray(parsed.data.iceServers) ? parsed.data.iceServers : [parsed.data.iceServers];
  const iceServers = filterIceServers(list, true);
  const usernames = [...new Set(iceServers.map((s) => s.username).filter((u): u is string => !!u))];
  if (!iceServers.length) throw new Error("TURN mint failed: no relay servers");
  return { iceServers, usernames };
}

/** POST credentials/<username>/revoke → 204. Best effort; returns false on any failure. */
export async function revokeCredential(username: string): Promise<boolean> {
  if (!turnConfigured()) return false;
  try {
    const res = await fetch(keyUrl(`credentials/${encodeURIComponent(username)}/revoke`), {
      method: "POST",
      headers: { Authorization: `Bearer ${env.turnKeyToken}` },
      signal: AbortSignal.timeout(8000),
    });
    return res.status === 204 || res.status === 200;
  } catch {
    return false;
  }
}

// Process-wide registry of live (unrevoked) credentials: TURN username → owner account and expiry,
// so a ban (from any room or the admin page) can revoke them, and a failed revocation is retried.

interface LiveCredential {
  userId: string;
  expiresAt: number;
}

const live = new Map<string, LiveCredential>();
const RETRY_MS = [30_000, 120_000, 600_000];

function prune(now: number): void {
  for (const [u, c] of live) if (c.expiresAt <= now) live.delete(u);
}

async function revokeOne(username: string, attempt = 0): Promise<boolean> {
  if (await revokeCredential(username)) {
    live.delete(username);
    return true;
  }
  const wait = RETRY_MS[attempt];
  if (wait !== undefined) {
    const t = setTimeout(() => {
      if (live.has(username)) void revokeOne(username, attempt + 1);
    }, wait);
    t.unref?.();
  }
  return false;
}

// Mint budget per account (a modified client toggling voice can't make us hammer the TURN API).
const MINTS_PER_WINDOW = 10;
const MINT_WINDOW_MS = 10 * 60_000;
const mints = new Map<string, number[]>();

/** Accounts with mint history kept (tests). */
export function mintHistorySize(): number {
  return mints.size;
}

export const turnCredentials = {
  remember(userId: string, usernames: readonly string[], ttlS: number = VOICE.TURN_TTL_S, now = Date.now()): void {
    prune(now);
    for (const u of usernames) live.set(u, { userId, expiresAt: now + ttlS * 1000 });
  },

  /** A guest saved: their credentials now belong to the account. */
  rekey(fromUserId: string, toUserId: string): void {
    for (const c of live.values()) if (c.userId === fromUserId) c.userId = toUserId;
    const m = mints.get(fromUserId);
    if (m) {
      mints.delete(fromUserId);
      mints.set(toUserId, [...(mints.get(toUserId) ?? []), ...m]);
    }
  },

  /** Revoke credentials; failures stay registered and are retried with backoff. Returns how many were revoked. */
  async revoke(usernames: readonly string[]): Promise<number> {
    const ok = await Promise.all(usernames.map((u) => revokeOne(u)));
    return ok.filter(Boolean).length;
  },

  /** Revoke every live credential of an account (ban). Returns how many were revoked now. */
  async revokeUser(userId: string): Promise<number> {
    prune(Date.now());
    return this.revoke([...live].filter(([, c]) => c.userId === userId).map(([u]) => u));
  },

  /** May this account mint another credential now? (counts the attempt) */
  allowMint(userId: string, now = Date.now()): boolean {
    // Forget accounts with no mint in the window (F12 S10: the map must not grow forever).
    for (const [u, l] of mints) if (u !== userId && l.every((t) => now - t >= MINT_WINDOW_MS)) mints.delete(u);
    const list = (mints.get(userId) ?? []).filter((t) => now - t < MINT_WINDOW_MS);
    if (list.length >= MINTS_PER_WINDOW) {
      mints.set(userId, list);
      return false;
    }
    list.push(now);
    mints.set(userId, list);
    return true;
  },
};
