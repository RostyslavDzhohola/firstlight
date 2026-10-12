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

// Process-wide registry of live credentials per account, so a ban (from any room or the admin page)
// can revoke them.
const liveByUser = new Map<string, Set<string>>();

export const turnCredentials = {
  remember(userId: string, usernames: readonly string[]): void {
    let s = liveByUser.get(userId);
    if (!s) liveByUser.set(userId, (s = new Set()));
    for (const u of usernames) s.add(u);
  },

  /** Revoke the given credentials (and forget them). */
  async revoke(userId: string, usernames: readonly string[]): Promise<void> {
    const s = liveByUser.get(userId);
    for (const u of usernames) s?.delete(u);
    if (s && !s.size) liveByUser.delete(userId);
    await Promise.all(usernames.map((u) => revokeCredential(u)));
  },

  /** Revoke every live credential of an account (ban). */
  async revokeUser(userId: string): Promise<number> {
    const s = liveByUser.get(userId);
    if (!s) return 0;
    liveByUser.delete(userId);
    const list = [...s];
    await Promise.all(list.map((u) => revokeCredential(u)));
    return list.length;
  },
};
