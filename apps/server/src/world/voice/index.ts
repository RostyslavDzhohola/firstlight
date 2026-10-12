// Voice lane entry: the room system factory and the hooks other lanes call (admin ban).

import { accountLinks } from "../../auth/links.ts";
import type { SystemFactory } from "../systems.ts";
import { turnCredentials } from "./turn.ts";
import { VoiceSystem } from "./VoiceSystem.ts";

// A guest saved their character: relay credentials follow the account (admin voice mutes are
// re-keyed by the moderation module).
accountLinks.on((ev) => turnCredentials.rekey(ev.fromUserId, ev.toUserId));

export const createVoiceSystem: SystemFactory = (room) => new VoiceSystem(room);

/**
 * Revoke an account's live TURN credentials now (moderation's banAccount calls this). Rooms also
 * notice bans within a second and end the player's voice themselves.
 */
export function revokeVoiceForUser(userId: string): Promise<number> {
  return turnCredentials.revokeUser(userId);
}

export { VOICE_LIMITS, VoiceSystem } from "./VoiceSystem.ts";
export { voiceMutes, voiceSafety } from "./safety.ts";
