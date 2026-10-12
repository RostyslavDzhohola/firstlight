// Proximity voice and radio: numbers and the message contract shared by server and client
// (SPEC §5.7, r2-13 §10). Audio never touches the server; it only relays WebRTC signalling.

export const VOICE = {
  /** Linear rolloff reaches silence here (PannerNode maxDistance). */
  HEAR: 35,
  /** Peers inside this distance are linked (nearest MAX_PEERS). */
  CONNECT: 45,
  /** Links beyond this are closed once held for DROP_HOLD_MS; the server refuses signals beyond it. */
  DROP: 60,
  DROP_HOLD_MS: 3000,
  MAX_PEERS: 12,
  /** Radio holders per channel per room copy. */
  RADIO_CAP: 8,
  CHANNELS: 9,
  OPUS_MAX: 24000,
  /** PannerNode reference distance (full volume inside it). */
  REF: 2,
  /** TURN credential lifetime and refresh period. */
  TURN_TTL_S: 43200,
  REMINT_MS: 6 * 60 * 60 * 1000,
  /** Radio transmit is released by the server after this long (stuck key). */
  RADIO_TX_MAX_MS: 60_000,
} as const;

/** WebRTC ICE server entry (mirrors RTCIceServer without needing DOM types). */
export interface IceServerConfig {
  urls: string | string[];
  username?: string;
  credential?: string;
}

/** Mirrors RTCIceCandidateInit. */
export interface CandidateInit {
  candidate: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
  usernameFragment?: string | null;
}

export interface SessionDescription {
  type: "offer" | "answer";
  sdp: string;
}

/** Reasons offered in the report dialog (free text is not collected). */
export const VOICE_REPORT_REASONS = ["Harassment or bullying", "Hate speech", "Sexual content", "Threats or violence", "Spam or noise", "Other"] as const;

// ---- Client → server ---------------------------------------------------------------------

export type VoiceClientMessages = {
  "voice:enable": { age16: boolean };
  "voice:disable": Record<string, never>;
  /** Relayed to `to` only when the server allows the pair. No sdp and no candidates = "please call me". */
  "voice:signal": { to: string; sdp?: SessionDescription; candidate?: CandidateInit | null; candidates?: CandidateInit[] };
  "radio:tune": { ch: number };
  "radio:tx": { on: boolean };
  "voice:block": { target: string };
  "voice:report": { target: string; reason: string };
  /** Admin only: server-side voice mute (PF.VOICE_MUTED). */
  "voice:mute": { target: string; on: boolean };
};

// ---- Server → client ---------------------------------------------------------------------

export type VoiceServerMessages = {
  /** `relay` true: use iceTransportPolicy "relay". Empty list with relay false = local dev (direct). */
  "voice:ice": { iceServers: IceServerConfig[]; relay: boolean; ttl: number; available: boolean };
  "voice:signal": { from: string; sdp?: SessionDescription; candidate?: CandidateInit | null; candidates?: CandidateInit[] };
  /** Close the link to `peer` now (block, mute, voice off). */
  "voice:drop": { peer: string };
  /** A signal to `peer` was not relayed (reason not disclosed); back off before ringing again. */
  "voice:unreachable": { peer: string };
  "voice:denied": { action: string; reason: string };
  "radio:tuned": { ch: number };
  "voice:reported": { target: string };
  "voice:blocked": { target: string };
  /** An admin muted (or unmuted) your voice. */
  "voice:muted": { on: boolean };
};

/** True for ICE URLs a relay-only client should drop: STUN entries and port 53 (blocked by browsers). */
export function isUnwantedIceUrl(url: string, relayOnly: boolean): boolean {
  if (/:53(?:[/?]|$)/.test(url)) return true;
  return relayOnly && /^stuns?:/i.test(url);
}

/** Drop STUN (under relay-only) and :53 URLs; drop servers left with no URLs. */
export function filterIceServers(list: readonly IceServerConfig[], relayOnly: boolean): IceServerConfig[] {
  const out: IceServerConfig[] = [];
  for (const s of list) {
    const urls = (Array.isArray(s.urls) ? s.urls : [s.urls]).filter((u) => typeof u === "string" && !isUnwantedIceUrl(u, relayOnly));
    if (urls.length) out.push({ ...s, urls });
  }
  return out;
}
