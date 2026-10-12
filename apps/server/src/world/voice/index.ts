// Voice lane entry: the room system factory and the hooks other lanes call (admin ban).

import { accountLinks } from "../../auth/links.ts";
import type { SystemFactory } from "../systems.ts";
import { voiceMutes } from "./safety.ts";
import { turnCredentials } from "./turn.ts";
import { VoiceSystem } from "./VoiceSystem.ts";

// A guest saved their character: process-wide voice records follow the account.
accountLinks.on((ev) => {
  turnCredentials.rekey(ev.fromUserId, ev.toUserId);
  voiceMutes.rekey(ev.fromUserId, ev.toUserId);
});

export const createVoiceSystem: SystemFactory = (room) => new VoiceSystem(room);

/**
 * Revoke an account's live TURN credentials now. Rooms also notice bans in game.db within a second
 * and do this themselves; call it directly for an immediate cut (kick the session separately).
 */
export function revokeVoiceForUser(userId: string): Promise<number> {
  return turnCredentials.revokeUser(userId);
}

export { VoiceSystem } from "./VoiceSystem.ts";
export { voiceMutes, voiceSafety } from "./safety.ts";
