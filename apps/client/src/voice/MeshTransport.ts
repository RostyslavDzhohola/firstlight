// P2P mesh: one RTCPeerConnection per linked peer, signalled through the game server.
//
// - Perfect negotiation: the lower session id is polite. Only the higher id adds the (single,
//   sendrecv) audio transceiver and makes the first offer; the lower id "rings" with an empty signal
//   and waits to be called. That keeps the first negotiation glare-free; later renegotiations (ICE
//   restarts) use the standard polite/impolite collision rules.
// - Outgoing signals are batched (candidates ride with the SDP or each other) and paced under the
//   room's per-client message budget.
// - Senders are gated with replaceTrack (no renegotiation); Opus DTX and the bitrate cap come from
//   the remote description and RTCRtpSender.setParameters.

import { VOICE, type CandidateInit } from "@firstlight/shared/net/voice";
import { withOpusParams } from "./sdp.ts";
import type { IceSettings, SignalPayload, TransportHooks, VoiceTransport } from "./transport.ts";

const SIGNALS_PER_S = 12;
const SIGNAL_BURST = 12;
const MAX_CANDIDATES_PER_MSG = 20;
const RING_EVERY_MS = 3000;
const FAILED_GIVE_UP_MS = 8000;
/** A ring for a link younger than this crossed our own offer: ignore it. */
const RING_GRACE_MS = 4000;
const MAX_LINKS = VOICE.MAX_PEERS + VOICE.RADIO_CAP;

interface Link {
  peer: string;
  pc: RTCPeerConnection;
  polite: boolean;
  makingOffer: boolean;
  ignoreOffer: boolean;
  sending: MediaStreamTrack | null;
  bitrateSet: boolean;
  failedAt: number;
  createdAt: number;
  closed: boolean;
  /** Set when apply() rebuilt this link from a fresh offer of the same remote. */
  replacedBy?: Link;
}

const isRing = (p: SignalPayload) => !p.sdp && !p.candidate && !p.candidates?.length;

export class MeshTransport implements VoiceTransport {
  readonly kind = "mesh" as const;
  private readonly me: string;
  private readonly hooks: TransportHooks;
  private ice: IceSettings | null = null;
  private readonly links = new Map<string, Link>();
  private readonly ringAt = new Map<string, number>();
  /** Per peer: incoming signalling is applied in order (candidates wait for their description). */
  private readonly inbound = new Map<string, Promise<void>>();
  private outbox: { to: string; payload: SignalPayload }[] = [];
  private tokens = SIGNAL_BURST;
  private lastRefill = performance.now();
  private readonly timer: number;

  constructor(me: string, hooks: TransportHooks) {
    this.me = me;
    this.hooks = hooks;
    this.timer = window.setInterval(() => this.flush(), 50);
  }

  /** The higher session id calls; the lower one is polite. */
  private initiates(peer: string): boolean {
    return this.me > peer;
  }

  private config(): RTCConfiguration {
    return {
      iceServers: this.ice?.iceServers ?? [],
      iceTransportPolicy: this.ice?.relay ? "relay" : "all",
      bundlePolicy: "max-bundle",
    };
  }

  setIce(ice: IceSettings): void {
    const first = !this.ice;
    this.ice = ice;
    if (first) return;
    for (const l of this.links.values()) {
      try {
        l.pc.setConfiguration(this.config());
        l.pc.restartIce();
      } catch (e) {
        console.warn("voice: ICE refresh failed", e);
      }
    }
  }

  connect(peer: string): void {
    if (!this.ice || peer === this.me || this.links.has(peer) || this.links.size >= MAX_LINKS) return;
    if (this.initiates(peer)) {
      this.open(peer, true);
      return;
    }
    const now = performance.now();
    if (now - (this.ringAt.get(peer) ?? -Infinity) < RING_EVERY_MS) return;
    this.ringAt.set(peer, now);
    this.enqueue(peer, {});
  }

  has(peer: string): boolean {
    return this.links.has(peer);
  }

  peers(): string[] {
    return [...this.links.keys()];
  }

  handleSignal(from: string, payload: SignalPayload): void {
    if (!this.ice || from === this.me) return;
    let link = this.links.get(from);
    if (isRing(payload)) {
      // They have no link to us: call them. A young link means our offer is already on its way;
      // an older one is stale (they closed their side), so start over.
      if (!this.initiates(from) || !this.hooks.accept(from)) return;
      if (link && performance.now() - link.createdAt < RING_GRACE_MS) return;
      if (link) this.close(from);
      if (this.links.size < MAX_LINKS) this.open(from, true);
      return;
    }
    if (!link) {
      if (payload.sdp?.type !== "offer") return; // leftovers for a link we already closed
      if (!this.hooks.accept(from) || this.links.size >= MAX_LINKS) return;
      link = this.open(from, false);
    }
    // Bound to this link: if it is replaced before the work runs, the work is dropped (an answer or
    // candidates for the old connection must never reach a new one). A link rebuilt from a fresh
    // offer in apply() hands its queue on through `replacedBy`.
    const bound = link;
    const next = (this.inbound.get(from) ?? Promise.resolve())
      .then(() => {
        let l: Link | undefined = bound;
        while (l?.replacedBy) l = l.replacedBy;
        return l && this.links.get(from) === l ? this.apply(l, payload) : undefined;
      })
      .catch((e) => console.warn("voice: signalling failed", e));
    this.inbound.set(from, next);
    void next.then(() => {
      if (this.inbound.get(from) === next) this.inbound.delete(from);
    });
  }

  private async apply(link: Link, payload: SignalPayload, retried = false): Promise<void> {
    if (link.closed) return;
    const pc = link.pc;
    const d = payload.sdp;
    if (d) {
      if (d.type === "answer" && pc.signalingState !== "have-local-offer") return; // stale answer
      const collision = d.type === "offer" && (link.makingOffer || pc.signalingState !== "stable");
      link.ignoreOffer = !link.polite && collision;
      if (link.ignoreOffer) return;
      try {
        await pc.setRemoteDescription({ type: d.type, sdp: withOpusParams(d.sdp) });
      } catch (e) {
        // A fresh offer from a peer that rebuilt its side (new DTLS identity): start over from it.
        if (d.type === "offer" && !retried) {
          this.close(link.peer);
          if (!this.hooks.accept(link.peer)) return;
          const fresh = this.open(link.peer, false);
          link.replacedBy = fresh;
          return this.apply(fresh, payload, true);
        }
        throw e;
      }
      if (d.type === "offer") {
        for (const t of pc.getTransceivers()) if (t.receiver.track.kind === "audio" && t.direction !== "sendrecv") t.direction = "sendrecv";
        await pc.setLocalDescription();
        this.sendLocalDescription(link);
        const s = this.sender(link);
        if (s && s.track !== link.sending) await s.replaceTrack(link.sending).catch(() => {});
      }
    }
    const cands = [...(payload.candidate ? [payload.candidate] : []), ...(payload.candidates ?? [])];
    for (const c of cands) {
      try {
        await pc.addIceCandidate(c);
      } catch {
        // Candidates for an offer we ignored, or from a previous ICE generation.
      }
    }
  }

  setSending(peer: string, track: MediaStreamTrack | null): void {
    const l = this.links.get(peer);
    if (!l || l.sending === track) return;
    l.sending = track;
    const s = this.sender(l);
    if (s) void s.replaceTrack(track).catch(() => {});
  }

  close(peer: string): void {
    const l = this.links.get(peer);
    if (!l) return;
    l.closed = true;
    this.links.delete(peer);
    const pc = l.pc;
    pc.onnegotiationneeded = null;
    pc.onicecandidate = null;
    pc.ontrack = null;
    pc.onconnectionstatechange = null;
    pc.onsignalingstatechange = null;
    try {
      pc.close();
    } catch {}
    this.outbox = this.outbox.filter((m) => m.to !== peer);
    this.hooks.closed(peer);
  }

  dispose(): void {
    clearInterval(this.timer);
    for (const p of [...this.links.keys()]) this.close(p);
    this.outbox = [];
  }

  // ---------------------------------------------------------------- internals

  private open(peer: string, call: boolean): Link {
    const pc = new RTCPeerConnection(this.config());
    const link: Link = {
      peer,
      pc,
      polite: this.me < peer,
      makingOffer: false,
      ignoreOffer: false,
      sending: null,
      bitrateSet: false,
      failedAt: 0,
      createdAt: performance.now(),
      closed: false,
    };
    this.links.set(peer, link);
    this.ringAt.delete(peer);
    pc.onnegotiationneeded = async () => {
      try {
        link.makingOffer = true;
        await pc.setLocalDescription();
        this.sendLocalDescription(link);
      } catch (e) {
        console.warn("voice: offer failed", e);
      } finally {
        link.makingOffer = false;
      }
    };
    pc.onicecandidate = (e) => {
      if (e.candidate && e.candidate.candidate) this.enqueue(peer, { candidates: [e.candidate.toJSON() as CandidateInit] });
    };
    pc.ontrack = (e) => {
      if (e.track.kind === "audio") this.hooks.remoteStream(peer, e.streams[0] ?? new MediaStream([e.track]));
    };
    pc.onconnectionstatechange = () => this.onState(link);
    pc.onsignalingstatechange = () => {
      if (pc.signalingState === "stable") void this.applyBitrate(link);
    };
    if (call) pc.addTransceiver("audio", { direction: "sendrecv" });
    return link;
  }

  private sendLocalDescription(link: Link): void {
    const ld = link.pc.localDescription;
    if (!ld || link.closed || (ld.type !== "offer" && ld.type !== "answer")) return;
    this.enqueue(link.peer, { sdp: { type: ld.type, sdp: ld.sdp } });
  }

  private sender(link: Link): RTCRtpSender | undefined {
    return link.pc.getTransceivers().find((t) => t.receiver.track.kind === "audio")?.sender;
  }

  private async applyBitrate(link: Link): Promise<void> {
    if (link.bitrateSet || link.closed) return;
    const s = this.sender(link);
    if (!s) return;
    const p = s.getParameters();
    if (!p.encodings?.length) return; // not negotiated yet
    p.encodings[0]!.maxBitrate = VOICE.OPUS_MAX;
    try {
      await s.setParameters(p);
      link.bitrateSet = true;
    } catch {}
  }

  private onState(link: Link): void {
    const st = link.pc.connectionState;
    if (st === "failed") {
      if (!link.failedAt) {
        link.failedAt = performance.now();
        if (!link.polite) link.pc.restartIce();
      }
    } else if (st === "connected") {
      link.failedAt = 0;
      void this.applyBitrate(link);
    } else if (st === "closed") {
      this.close(link.peer);
    }
  }

  private enqueue(to: string, payload: SignalPayload): void {
    if (isRing(payload)) {
      if (!this.outbox.some((m) => m.to === to)) this.outbox.push({ to, payload: {} });
      return;
    }
    const add = payload.candidates;
    if (add?.length && !payload.sdp) {
      for (let i = this.outbox.length - 1; i >= 0; i--) {
        const m = this.outbox[i]!;
        if (m.to !== to || isRing(m.payload)) continue;
        const list = (m.payload.candidates ??= []);
        if (list.length + add.length <= MAX_CANDIDATES_PER_MSG) {
          list.push(...add);
          return;
        }
        break;
      }
    }
    this.outbox.push({ to, payload });
  }

  private flush(): void {
    const now = performance.now();
    this.tokens = Math.min(SIGNAL_BURST, this.tokens + ((now - this.lastRefill) / 1000) * SIGNALS_PER_S);
    this.lastRefill = now;
    while (this.outbox.length && this.tokens >= 1) {
      const m = this.outbox.shift()!;
      this.tokens -= 1;
      this.hooks.signal(m.to, m.payload);
    }
    for (const l of [...this.links.values()]) {
      if (l.failedAt && now - l.failedAt > FAILED_GIVE_UP_MS && l.pc.connectionState !== "connected") this.close(l.peer);
    }
  }
}
