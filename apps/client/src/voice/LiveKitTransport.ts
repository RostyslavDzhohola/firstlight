// Fallback transport (r2-13 §10): LiveKit Cloud behind the same VoiceTransport interface. Not wired
// and not deployed; the mesh is the default. To switch:
//   1. the server mints a LiveKit access token in voice:enable (room = body copy id, identity =
//      sessionId, canPublish only while not admin-muted) instead of TURN credentials;
//   2. connect() becomes `participant.audioTrackPublications[0].setSubscribed(true)` and close()
//      `setSubscribed(false)`, driven by the same planner (proximity + radio channel);
//   3. setSending() maps to publishing the mic track muted/unmuted (an SFU can't gate per listener,
//      so per-listener proximity gating moves to subscription permissions on the server);
//   4. remoteStream() fires from `TrackSubscribed` with `new MediaStream([track.mediaStreamTrack])`.
// handleSignal() is unused (LiveKit signals over its own socket).

import type { IceSettings, SignalPayload, TransportHooks, VoiceTransport } from "./transport.ts";

export class LiveKitTransport implements VoiceTransport {
  readonly kind = "livekit" as const;
  private readonly hooks: TransportHooks;

  constructor(_url: string, _token: string, hooks: TransportHooks) {
    this.hooks = hooks;
    throw new Error("LiveKitTransport is a stub: the P2P mesh is the deployed transport");
  }

  setIce(_ice: IceSettings): void {}
  connect(_peer: string): void {}
  close(peer: string): void {
    this.hooks.closed(peer);
  }
  peers(): string[] {
    return [];
  }
  has(_peer: string): boolean {
    return false;
  }
  handleSignal(_from: string, _payload: SignalPayload): void {}
  setSending(_peer: string, _track: MediaStreamTrack | null): void {}
  dispose(): void {}
}
