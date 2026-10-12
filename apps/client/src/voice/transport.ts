// How voice reaches other players. The game talks to this interface only; the P2P mesh
// (MeshTransport) is the default, and a LiveKit adapter can replace it (LiveKitTransport, stub).

import type { CandidateInit, SessionDescription } from "@firstlight/shared/net/voice";

/** A signalling payload. Empty (no sdp, no candidates) means "please call me". */
export interface SignalPayload {
  sdp?: SessionDescription;
  candidate?: CandidateInit | null;
  candidates?: CandidateInit[];
}

export interface IceSettings {
  iceServers: RTCIceServer[];
  /** iceTransportPolicy "relay" (production: players never see each other's addresses). */
  relay: boolean;
}

export interface TransportHooks {
  /** Send signalling to `to` through the game server. */
  signal(to: string, payload: SignalPayload): void;
  /** Remote audio for a peer arrived (or was replaced). */
  remoteStream(peer: string, stream: MediaStream): void;
  /** The link to a peer is gone (closed here, failed, or refused). */
  closed(peer: string): void;
  /** May this peer open a link to us? (incoming offers and rings) */
  accept(peer: string): boolean;
}

export interface VoiceTransport {
  readonly kind: "mesh" | "livekit";
  /** Apply (or refresh) ICE servers; existing links restart ICE with them. */
  setIce(ice: IceSettings): void;
  /** Ask for a link to `peer` (idempotent; called every planning tick while wanted). */
  connect(peer: string): void;
  close(peer: string): void;
  /** Peers with a live or connecting link. */
  peers(): string[];
  has(peer: string): boolean;
  /** Signalling from the server. */
  handleSignal(from: string, payload: SignalPayload): void;
  /** Gate the outgoing audio for one peer (null = send nothing). */
  setSending(peer: string, track: MediaStreamTrack | null): void;
  dispose(): void;
}
