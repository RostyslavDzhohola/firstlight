// Social and moderation message contract (SPEC §6.10, §6.11): parties, blocks, reports, admin
// actions, analytics hello. The server validates every client message with zod; these types are the
// shape both sides agree on.

/**
 * App WebSocket close codes (Colyseus reserves 4000–4010). The server uses them when it removes a
 * player on purpose; the client picks its screen by code.
 */
export const CLOSE = {
  /** The same character joined from another tab or browser. */
  ELSEWHERE: 4100,
  /** Account merged after saving or signing in: rejoin with a fresh token. */
  MERGED: 4101,
  /** Banned by an admin. */
  BANNED: 4102,
  /** Logout finished. */
  LOGGED_OUT: 4103,
  /** Kicked by an admin (may come back after a short cooldown). */
  KICKED: 4104,
  /** Saving failed (e.g. a death couldn't be recorded): rejoin later, from the last good save. */
  STORAGE: 4105,
} as const;

export const SOCIAL = {
  PARTY_MAX: 4,
  /** Invites only reach players this close, in the same copy. */
  INVITE_RANGE_M: 30,
  INVITE_TTL_MS: 60_000,
  /** How long an admin kick keeps a player out. */
  KICK_COOLDOWN_MS: 120_000,
} as const;

export const REPORT_REASONS = ["cheating", "harassment", "offensive name", "griefing", "other"] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];

export type PartyAction = "invite" | "accept" | "decline" | "leave" | "kick";
export type ModAction = "kick" | "ban" | "voicemute" | "goto" | "bring" | "announce";

// ---- Client → server -------------------------------------------------------------------------

export type SocialClientMessages = {
  /** `target`: invite → a player in this copy (sessionId or userId); accept/decline → the inviter's userId; kick → a member's userId. */
  party: { action: PartyAction; target?: string };
  /** Block (on: true, default) or unblock a player (sessionId in this copy, or userId). Persisted; symmetric for voice. */
  "social:block": { target: string; on?: boolean };
  /** Report a player in this copy (sessionId or userId). */
  report: { target: string; reason: ReportReason; note?: string };
  /** Sent once after every join: renderer backend and quality tier (analytics). The server replies with the social snapshot. */
  "client:info": { backend: string; tier: string };
  /** Admins only. `target`: sessionId in this copy, or userId. */
  mod: { action: ModAction; target?: string; reason?: string; on?: boolean; text?: string };
};

// ---- Server → client -------------------------------------------------------------------------

export interface PartyMemberInfo {
  userId: string;
  name: string;
  level: number;
  online: boolean;
  /** Where the member is (for compass markers and travelling into the same copy). */
  body: string | null;
  roomId: string | null;
  sessionId: string | null;
  x: number;
  y: number;
  z: number;
}

export interface PartyStateMsg {
  /** null: not in a party. */
  id: string | null;
  leader: string | null;
  members: PartyMemberInfo[];
}

export interface PartyInviteMsg {
  from: string; // inviter userId
  fromName: string;
  partyId: string | null;
  expiresAt: number;
}

export type SocialServerMessages = {
  "party:state": PartyStateMsg;
  "party:invite": PartyInviteMsg;
  /** An invite you sent or received was withdrawn/declined/expired. */
  "party:invite-closed": { from: string; to: string; reason: "declined" | "expired" | "accepted" | "cancelled" };
  "social:blocked": { userIds: string[] };
  /** Sent right before an admin removes the player (close code CLOSE.KICKED/BANNED follows). */
  kicked: { reason: string; code: number };
};
