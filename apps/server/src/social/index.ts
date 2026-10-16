// Social and operations (SPEC §6.10–6.11, M8). Importing this module registers the social room
// system. Public API for other lanes:
//
//   partyOf(userId)              member account ids (self included) — shared boss credit
//   blockedEitherWay(a, b)       either player blocked the other — voice relay, invites
//   isVoiceMuted(userId)         admin voice-mute — voice relay must not forward this player
//   announceAll(text)            banner to every copy
//   endAllSessions()             graceful shutdown: close open analytics sessions

import { accountLinks } from "../auth/links.ts";
import { SYSTEM_FACTORIES } from "../world/systems.ts";
import { rekeyAnalytics } from "./analytics.ts";
import { rekeyModeration } from "./moderation.ts";
import { rekeyLimits } from "./limits.ts";
import { parties } from "./parties.ts";
import { presenceOf, rekeyPresence, sendTo } from "./presence.ts";
import { onTestMarked } from "../db/testAccounts.ts";
import { createSocialSystem, enforceBlocksAfterMerge, rekeyOfflineTimer, rekeySessions, syncParty } from "./system.ts";

SYSTEM_FACTORIES.push(createSocialSystem);

// One of our tools flagged a player who's already in the world (D-home-6): out of public counts now,
// not only from their next join.
onTestMarked((userId) => {
  const p = presenceOf(userId);
  const a = p?.room.actors.get(p.sessionId);
  if (a) a.identity.test = true;
});

// A guest saved their character and got a new account id: party, presence, sessions follow.
accountLinks.on((ev) => {
  const { affected, reissued } = parties.rekey(ev.fromUserId, ev.toUserId);
  rekeyPresence(ev.fromUserId, ev.toUserId);
  rekeySessions(ev.fromUserId, ev.toUserId);
  rekeyOfflineTimer(ev.fromUserId, ev.toUserId);
  rekeyAnalytics(ev.fromUserId, ev.toUserId);
  rekeyModeration(ev.fromUserId, ev.toUserId);
  rekeyLimits(ev.fromUserId, ev.toUserId); // report, block and invite limits carry over
  // The merged blocks (game.db moved them before this event) apply to the merged party and invites.
  enforceBlocksAfterMerge(ev.toUserId);
  syncParty([...affected, ev.toUserId, ...(parties.of(ev.toUserId)?.members ?? [])]);
  // Invite cards the guest sent: swap them for ones from the saved account (unless withdrawn above).
  for (const inv of reissued) {
    sendTo(inv.to, "party:invite-closed", { from: ev.fromUserId, to: inv.to, reason: "cancelled" });
    if (!parties.pendingFor(inv.to).some((i) => i.from === inv.from)) continue;
    sendTo(inv.to, "party:invite", { from: inv.from, fromName: ev.name || inv.fromName, partyId: parties.of(inv.from)?.id ?? null, expiresAt: inv.expiresAt });
  }
});

export { endAllSessions, ANALYTICS } from "./analytics.ts";
export { announceAll, banAccount, isVoiceMuted, kickUser, playRefusal, setVoiceMuted } from "./moderation.ts";
export { parties, partyOf } from "./parties.ts";
export { liveRooms, presenceOf } from "./presence.ts";
export { blockedEitherWay } from "./store.ts";
export { partyRoomFor, SOCIAL_RULES } from "./system.ts";
