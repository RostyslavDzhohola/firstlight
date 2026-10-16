// Party frames (top-left of the HUD) from the social lane's party state, the room's player states and
// the voice lane's speaking levels. Slot = the member's place in the party (1–4); the frame colour
// and the compass marker use the same slot colour, always next to the slot number.

import type { PartyMemberInfo } from "@firstlight/shared/net/social";
import type { PartyMember } from "./hud.ts";

export const PARTY_SLOT_COLOURS = ["#fff3dc", "#7fe3b0", "#b9a6ff", "#7cc6ff"] as const;

interface RoomPlayer {
  userId?: string;
  name?: string;
  level?: number;
  starter?: number;
  look?: number;
  hp?: number;
  maxHp?: number;
  x: number;
  y: number;
  z: number;
}

/**
 * Build the frames for everyone in the party except us. Members in our room copy get live HP and
 * distance; members elsewhere show their level and "elsewhere".
 */
export function partyFrames(
  members: readonly PartyMemberInfo[],
  me: { userId?: string; x: number; y: number; z: number } | null,
  players: ReadonlyMap<string, RoomPlayer> | null,
  body: string,
  speaking?: (sessionId: string) => { speaking: boolean; radio: boolean; muted: boolean } | null,
): PartyMember[] {
  const out: PartyMember[] = [];
  members.forEach((m, i) => {
    if (!me || m.userId === me.userId) return;
    const here = m.sessionId ? players?.get(m.sessionId) : undefined;
    const sameBody = m.online && m.body === body;
    const at = here ?? (sameBody && (m.x || m.y || m.z) ? m : null);
    const v = here && m.sessionId ? speaking?.(m.sessionId) : null;
    out.push({
      slot: Math.min(4, i + 1) as 1 | 2 | 3 | 4,
      name: m.name,
      level: here?.level ?? m.level,
      starter: here?.starter ?? 0,
      look: here?.look ?? 0,
      hp: here?.hp ?? (m.online ? 1 : 0),
      maxHp: here?.maxHp ?? 1,
      speaking: !!v?.speaking,
      radio: !!v?.radio,
      muted: !!v?.muted,
      distance: !m.online ? null : at ? Math.round(Math.hypot(at.x - me.x, at.y - me.y, at.z - me.z)) : null,
      title: m.online ? undefined : "Offline",
    });
  });
  return out;
}
