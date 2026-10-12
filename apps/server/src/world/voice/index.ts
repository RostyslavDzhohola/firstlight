// Voice lane entry: the room system factory and the hooks other lanes call (admin ban).

import type { SystemFactory } from "../systems.ts";
import { turnCredentials } from "./turn.ts";
import { VoiceSystem } from "./VoiceSystem.ts";

export const createVoiceSystem: SystemFactory = (room) => new VoiceSystem(room);

/** Call when an account is banned: revokes its live TURN credentials (kick the session separately). */
export function revokeVoiceForUser(userId: string): Promise<number> {
  return turnCredentials.revokeUser(userId);
}

export { VoiceSystem } from "./VoiceSystem.ts";
export { voiceMutes, voiceSafety } from "./safety.ts";
