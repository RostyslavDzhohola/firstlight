// Voice lane entry: the room system factory and the hooks other lanes call (admin ban).

import type { VoiceClientMessages } from "@firstlight/shared/net/voice";
import { accountLinks } from "../../auth/links.ts";
import { env } from "../../env.ts";
import type { SystemFactory } from "../systems.ts";
import { turnCredentials } from "./turn.ts";
import { VoiceSystem } from "./VoiceSystem.ts";

// A guest saved their character: relay credentials follow the account (admin voice mutes are
// re-keyed by the moderation module).
accountLinks.on((ev) => turnCredentials.rekey(ev.fromUserId, ev.toUserId));

/** Every voice/radio message type: each stays registered with voice off (see createVoiceSystem). */
const VOICE_MESSAGES: readonly (keyof VoiceClientMessages)[] = ["voice:enable", "voice:disable", "voice:signal", "radio:tune", "radio:tx", "voice:block", "voice:report", "voice:mute"];

/**
 * SYSTEM_FACTORIES entry. With the flag off (env.voice; FEATURE_VOICE unset in this build) there is no
 * voice system: nothing is relayed and no TURN credential is ever minted. The message types stay
 * registered because in production Colyseus drops a client that sends an unregistered type, and a
 * tab from an older build may still try; requests are refused with reason "off", signals ignored.
 */
export const createVoiceSystem: SystemFactory = (room) => {
  // An admin sandbox (D-admin-3) has no voice: nobody else is there, and voice moderation, mutes and
  // TURN credentials are process-wide state a sandbox must not touch. Its messages are refused as "off".
  if (env.voice && !room.sandbox) return new VoiceSystem(room);
  for (const type of VOICE_MESSAGES) {
    room.onMessage(type, (c) => {
      if (type !== "voice:signal" && type !== "voice:disable") c.send("voice:denied", { action: type, reason: "off" });
    });
  }
  return null;
};

/** The radio is a voice item: while voice is off it isn't sold and never lands in a pile (D-controls-1). */
export function voiceItemHidden(itemId: string): boolean {
  return !env.voice && itemId === "radio";
}

/**
 * Revoke an account's live TURN credentials now (moderation's banAccount calls this). Rooms also
 * notice bans within a second and end the player's voice themselves.
 */
export function revokeVoiceForUser(userId: string): Promise<number> {
  return turnCredentials.revokeUser(userId);
}

export { VOICE_LIMITS, VoiceSystem } from "./VoiceSystem.ts";
export { voiceMutes, voiceSafety } from "./safety.ts";
