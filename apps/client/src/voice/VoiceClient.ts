// Proximity voice on the client (SPEC §5.7).
//
// VoiceClient is one per page: opt-in, microphone, AudioContext, local mutes/blocks, "mute strangers",
// panic. It survives travel between bodies. VoiceRoom is the per-room client system: it binds the
// room's voice messages, owns the transport (one link per nearby peer), plans links at 4 Hz, updates
// spatial audio and sender gating at 20 Hz, and feeds the HUD every frame.

import * as THREE from "three/webgpu";
import type { Room } from "@colyseus/sdk";
import { PF } from "@firstlight/shared/net/schema";
import { filterIceServers, type VoiceServerMessages } from "@firstlight/shared/net/voice";
import type { Game } from "../game/Game.ts";
import type { ClientSystem } from "../game/systems.ts";
import { isBlocked, isMuted, isMutedLocally, onSocialChange, setMuted } from "../social/store.ts";
import { VoiceAudio } from "./audio.ts";
import { MeshTransport } from "./MeshTransport.ts";
import { acceptsIncoming, onMyChannel, planLinks, shouldSend, type Me, type PeerView } from "./planner.ts";
import type { IceSettings, SignalPayload, VoiceTransport } from "./transport.ts";
import { VoiceUi } from "./ui.ts";

export type MicState = "off" | "live" | "denied" | "unsupported";

const LS = { optIn: "fl.voice.optin", strangers: "fl.voice.strangers" };
const BACKOFF_MS = 10_000;

const micSupported = () => typeof navigator.mediaDevices?.getUserMedia === "function";

/** A player in the current room as the voice UI sees them. */
export interface VoicePeerInfo {
  id: string;
  userId: string;
  name: string;
  dist: number;
  voice: boolean;
  linked: boolean;
  speaking: number;
  muted: boolean;
  blocked: boolean;
  adminMuted: boolean;
  radioCh: number;
  radioTx: boolean;
  party: boolean;
}

export class VoiceClient {
  readonly game: Game;
  readonly ui: VoiceUi;
  enabled = false;
  optedIn = localStorage.getItem(LS.optIn) === "1";
  ctx: AudioContext | null = null;
  audio: VoiceAudio | null = null;
  mic: MediaStream | null = null;
  micState: MicState = "off";
  muteStrangers = localStorage.getItem(LS.strangers) === "1";
  panic = false;
  adminMuted = false;
  /** Relay unavailable (TURN down or not configured in production). */
  relayDown = false;
  ice: IceSettings | null = null;
  room: VoiceRoom | null = null;
  /** Speaking level (0..1) per session id, for the HUD and the player list. */
  readonly speaking = new Map<string, number>();
  ptt = false;
  radioTx = false;
  micTest = false;
  private enabling: Promise<void> | null = null;

  constructor(game: Game) {
    this.game = game;
    this.ui = new VoiceUi(this);
    // Mutes and blocks are shared with the Tab player list (social store).
    onSocialChange(() => this.ui.refresh());
    // Shift+Esc: panic mute-all. Browsers may swallow Esc while pointer-locked or fullscreen, so also
    // treat "pointer lock lost while Shift is held" as the same gesture.
    let shift = false;
    window.addEventListener("keydown", (e) => {
      if (e.key === "Shift") shift = true;
      if (e.key === "Escape" && e.shiftKey && this.enabled) this.setPanic(true);
      if (this.ctx?.state === "suspended") void this.ctx.resume().catch(() => {});
    }, true);
    window.addEventListener("keyup", (e) => {
      if (e.key === "Shift") shift = false;
    }, true);
    window.addEventListener("blur", () => (shift = false));
    document.addEventListener("pointerlockchange", () => {
      if (!document.pointerLockElement && shift && this.enabled) this.setPanic(true);
    });
    window.addEventListener("pointerdown", () => {
      if (this.ctx?.state === "suspended") void this.ctx.resume().catch(() => {});
    }, true);
  }

  // ---------------------------------------------------------------- opt in

  /**
   * Turn voice on. Call from inside a click or key handler: the AudioContext is created and resumed
   * and the microphone requested in the same gesture (Safari). A denied mic means listen-only.
   */
  enableFromGesture(): Promise<void> {
    if (this.enabling) return this.enabling;
    const ctx = (this.ctx ??= new AudioContext({ latencyHint: "interactive" }));
    const resumed = ctx.resume().catch(() => {});
    const gum = this.mic && this.mic.getAudioTracks().some((t) => t.readyState === "live") ? Promise.resolve(this.mic) : this.requestMic();
    this.enabling = Promise.all([resumed, gum.then((s) => this.setMic(s), () => this.setMic(null))])
      .then(() => this.turnOn())
      .finally(() => (this.enabling = null));
    return this.enabling;
  }

  private requestMic(): Promise<MediaStream> {
    if (!micSupported()) return Promise.reject(new Error("unsupported"));
    return navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    });
  }

  private setMic(stream: MediaStream | null) {
    if (this.mic && this.mic !== stream) for (const t of this.mic.getTracks()) t.stop();
    this.mic = stream;
    this.micState = stream ? "live" : micSupported() ? "denied" : "unsupported";
    for (const t of stream?.getAudioTracks() ?? []) t.enabled = false; // only while a talk key is held
    this.audio ??= new VoiceAudio(this.ctx!);
    this.audio.setMic(stream);
  }

  /** Retry the microphone after a denial (from a click in the panel). */
  retryMic(): void {
    void this.ctx?.resume().catch(() => {});
    this.requestMic().then(
      (s) => {
        this.setMic(s);
        this.game.hud.toast("Microphone ready — hold V to talk", "info");
        this.ui.refresh();
      },
      () => {
        this.setMic(null);
        this.ui.refresh();
      },
    );
  }

  private turnOn() {
    this.enabled = true;
    this.optedIn = true;
    localStorage.setItem(LS.optIn, "1");
    this.room?.sendEnable();
    this.game.hud.toast(this.micState === "live" ? "Voice on — hold V to talk" : "Voice on — listening only (no microphone)", "info");
    this.ui.refresh();
  }

  disable(): void {
    if (!this.enabled) return;
    this.enabled = false;
    this.room?.voiceOff();
    if (this.mic) for (const t of this.mic.getTracks()) t.stop(); // releases the device (indicator off)
    this.mic = null;
    this.micState = "off";
    this.audio?.setMic(null);
    this.ptt = this.radioTx = false;
    this.game.hud.toast("Voice off", "info");
    this.ui.refresh();
  }

  // ---------------------------------------------------------------- safety controls

  setPanic(on: boolean): void {
    if (this.panic === on) return;
    this.panic = on;
    this.audio?.setMaster(on ? 0 : 1);
    if (on) {
      this.ptt = false;
      this.room?.stopRadioTx();
      if (this.enabled) this.game.hud.toast("Everyone muted (Shift+Esc). Unmute from Esc → Voice & radio.", "warn");
    }
    this.ui.refresh();
  }

  setMuteStrangers(on: boolean): void {
    this.muteStrangers = on;
    localStorage.setItem(LS.strangers, on ? "1" : "0");
    this.ui.refresh();
  }

  /** Local mute (only you stop hearing them), remembered by account (shared with the player list). */
  setMuted(sessionId: string, on: boolean): void {
    setMuted(sessionId, on);
    this.ui.refresh();
  }

  /** Block: persisted on the server (both directions); neither of you will hear the other again. */
  block(sessionId: string): void {
    const userId = this.userIdOf(sessionId);
    if (!userId || !this.room) return;
    this.room.send("voice:block", { target: sessionId }); // the server replies with social:blocked
    this.room.transport.close(sessionId);
    this.ui.refresh();
  }

  report(sessionId: string, reason: string): void {
    this.room?.send("voice:report", { target: sessionId, reason });
  }

  /** Admins: server-side voice mute. */
  adminMute(sessionId: string, on: boolean): void {
    this.room?.send("voice:mute", { target: sessionId, on });
  }

  tune(ch: number): void {
    this.room?.send("radio:tune", { ch });
  }

  hasRadio(): boolean {
    const you = this.game.hud.you;
    if (!you) return false;
    return [...you.hotbar, ...you.backpack].some((it) => it?.id === "radio");
  }

  private userIdOf(sessionId: string): string | null {
    const p = (this.game.net.room?.state as any)?.players?.get(sessionId);
    return p?.userId || null;
  }

  /** Everyone else in this room copy, nearest first. */
  peers(): VoicePeerInfo[] {
    const room = this.game.net.room;
    const state = room?.state as any;
    if (!room || !state?.players) return [];
    const me = state.players.get(room.sessionId);
    const pos = this.game.player.pos;
    const out: VoicePeerInfo[] = [];
    state.players.forEach((p: any, id: string) => {
      if (id === room.sessionId) return;
      out.push({
        id,
        userId: p.userId,
        name: p.name,
        dist: Math.hypot(p.x - pos.x, p.y - pos.y, p.z - pos.z),
        voice: !!(p.flags & PF.VOICE),
        linked: !!this.room?.transport.has(id),
        speaking: this.speaking.get(id) ?? 0,
        muted: isMutedLocally(id),
        blocked: isBlocked(p.userId),
        adminMuted: !!(p.flags & PF.VOICE_MUTED),
        radioCh: p.radioCh,
        radioTx: !!(p.flags & PF.RADIO_TX),
        party: !!me?.party && p.party === me.party,
      });
    });
    return out.sort((a, b) => a.dist - b.dist);
  }

  /** Is our own player an admin? */
  isAdmin(): boolean {
    const room = this.game.net.room;
    const me = (room?.state as any)?.players?.get(room?.sessionId ?? "");
    return !!(me && me.flags & PF.ADMIN);
  }

  myRadioCh(): number {
    const room = this.game.net.room;
    return (room?.state as any)?.players?.get(room?.sessionId ?? "")?.radioCh ?? 0;
  }
}

// ---------------------------------------------------------------------------------------------

const _q = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _me = new THREE.Vector3();
const _up = new THREE.Vector3();

/** The voice side of one room: messages, links, audio positions and gating. */
export class VoiceRoom implements ClientSystem {
  readonly room: Room;
  readonly transport: VoiceTransport;
  private readonly vc: VoiceClient;
  private readonly game: Game;
  private readonly unsub: (() => void)[] = [];
  private readonly farSince = new Map<string, number>();
  private readonly backoff = new Map<string, number>();
  private lastPlan = 0;
  private lastAudio = 0;
  private bHeld = false;
  private txDenied = false;
  private disposed = false;

  constructor(vc: VoiceClient, game: Game, room: Room) {
    this.vc = vc;
    this.game = game;
    this.room = room;
    this.transport = new MeshTransport(room.sessionId, {
      signal: (to, payload) => this.send("voice:signal", { to, ...payload }),
      remoteStream: (peer, stream) => vc.audio?.attach(peer, stream),
      closed: (peer) => {
        vc.audio?.detach(peer);
        vc.speaking.delete(peer);
        this.farSince.delete(peer);
      },
      accept: (peer) => this.accepts(peer),
    });
    const on = <K extends keyof VoiceServerMessages>(type: K, fn: (m: VoiceServerMessages[K]) => void) => {
      this.unsub.push(room.onMessage(type, fn as (m: unknown) => void));
    };
    on("voice:ice", (m) => this.onIce(m));
    on("voice:signal", (m) => {
      const { from, ...payload } = m;
      if (vc.enabled) this.transport.handleSignal(from, payload as SignalPayload);
    });
    on("voice:drop", (m) => {
      this.transport.close(m.peer);
      this.backoff.set(m.peer, performance.now() + BACKOFF_MS);
    });
    on("voice:unreachable", (m) => {
      this.backoff.set(m.peer, performance.now() + BACKOFF_MS);
    });
    on("voice:denied", (m) => this.onDenied(m));
    on("radio:tuned", (m) => {
      this.game.hud.toast(m.ch ? `Radio tuned to channel ${m.ch} — hold B to talk` : "Radio off", "info");
      vc.ui.refresh();
    });
    on("voice:reported", () => this.game.hud.toast("Report sent. A moderator will review it — thank you.", "info"));
    on("voice:blocked", () => this.game.hud.toast("Blocked. You won't hear each other again.", "info"));
    on("voice:muted", (m) => {
      vc.adminMuted = m.on;
      if (m.on) {
        for (const p of this.transport.peers()) this.transport.close(p);
        this.game.hud.toast("A moderator muted your voice", "warn");
      } else this.game.hud.toast("A moderator unmuted your voice", "info");
      vc.ui.refresh();
    });
    vc.room = this;
    vc.adminMuted = false;
    if (vc.enabled) this.sendEnable();
  }

  send(type: string, msg: unknown): void {
    if (!this.disposed && this.game.net.room === this.room) this.room.send(type, msg);
  }

  sendEnable(): void {
    this.send("voice:enable", { age16: true });
  }

  voiceOff(): void {
    this.stopRadioTx();
    this.send("voice:disable", {});
    for (const p of this.transport.peers()) this.transport.close(p);
    this.vc.ice = null;
  }

  stopRadioTx(): void {
    if (this.vc.radioTx || this.bHeld) this.send("radio:tx", { on: false });
    this.vc.radioTx = false;
  }

  private onIce(m: VoiceServerMessages["voice:ice"]): void {
    const vc = this.vc;
    vc.relayDown = !m.available;
    if (!m.available) {
      for (const p of this.transport.peers()) this.transport.close(p);
      vc.ice = null;
      vc.ui.refresh();
      return;
    }
    vc.ice = { iceServers: filterIceServers(m.iceServers, m.relay) as RTCIceServer[], relay: m.relay };
    this.transport.setIce(vc.ice);
    vc.ui.refresh();
  }

  private onDenied(m: { action: string; reason: string }): void {
    const hud = this.game.hud;
    const text: Record<string, string> = {
      "radio:tune/no radio": "You need a radio to tune in (Portus, 100 coins)",
      "radio:tune/channel full": "That channel is full (8 radios max)",
      "radio:tx/no radio": "You need a radio to talk on B (Portus, 100 coins)",
      "radio:tx/not tuned": "Pick a radio channel first (Esc → Voice & radio)",
      "radio:tx/voice off": "Turn voice on first (press V)",
      "radio:tx/muted": "A moderator muted your voice",
      "radio:tx/timeout": "Radio released after 60 s — press B again",
      "voice:enable/age": "Voice needs the 16+ confirmation",
      "voice:enable/banned": "Voice isn't available on this account",
      "voice:report/too many reports": "You reported this player recently",
      "voice:block/no such player": "That player has left",
      "voice:report/no such player": "That player has left",
    };
    const t = text[`${m.action}/${m.reason}`];
    if (t) hud.toast(t, "warn");
    if (m.action === "radio:tx") {
      this.txDenied = true;
      this.vc.radioTx = false;
    }
  }

  /** May `peer` link to us? (incoming offers and rings) */
  private accepts(peer: string): boolean {
    const vc = this.vc;
    if (!vc.enabled || vc.adminMuted || !vc.ice) return false;
    const state = this.room.state as any;
    const p = state?.players?.get(peer);
    const me = state?.players?.get(this.room.sessionId);
    if (!p || !me || !(p.flags & PF.VOICE) || p.flags & PF.VOICE_MUTED || isBlocked(p.userId)) return false;
    // Only links the planner would keep: a radio mate, or one of the nearest MAX_PEERS within DROP.
    const d = (q: any) => Math.hypot(q.x - me.x, q.y - me.y, q.z - me.z);
    const my = this.myInfo(me);
    const linked = this.transport.peers().filter((id) => id !== peer).map((id) => state.players.get(id)).filter(Boolean);
    return acceptsIncoming(my, { radioCh: p.radioCh, dist: d(p) }, linked.map((q: any) => ({ radioCh: q.radioCh, dist: d(q) })));
  }

  // ---------------------------------------------------------------- per frame

  update(_dt: number, now: number): void {
    if (this.disposed || this.game.net.room !== this.room) return;
    const state = this.room.state as any;
    const me = state?.players?.get(this.room.sessionId);
    if (!me) return;
    const vc = this.vc;
    this.keys(me);
    if (now - this.lastPlan >= 250) {
      this.lastPlan = now;
      this.plan(state, me, now);
    }
    if (now - this.lastAudio >= 50) {
      this.lastAudio = now;
      this.audioTick(state, me);
    }
    vc.ui.frame(this.game, state, this.room.sessionId);
  }

  private typing(): boolean {
    const a = document.activeElement;
    return !!a && (a.tagName === "INPUT" || a.tagName === "TEXTAREA" || a.tagName === "SELECT" || (a as HTMLElement).isContentEditable);
  }

  private keys(me: any): void {
    const vc = this.vc;
    const input = this.game.input;
    // Typing in a field counts as both talk keys released (never stay on air).
    const typing = this.typing();
    const vPressed = !typing && input.pressed.has("KeyV");
    if (vPressed && !vc.enabled) {
      if (vc.optedIn) void vc.enableFromGesture();
      else vc.ui.openPanel();
    }
    const canTalk = vc.enabled && !vc.panic && !vc.adminMuted && vc.micState === "live";
    if (vPressed && vc.enabled && vc.micState !== "live") this.game.hud.toast("No microphone — listening only (Esc → Voice & radio to retry)", "warn");
    const wasPtt = vc.ptt;
    const wasRadio = vc.radioTx;
    vc.ptt = canTalk && !typing && input.down("KeyV");

    const b = !typing && input.down("KeyB");
    if (b && !this.bHeld) {
      this.txDenied = false;
      if (!vc.enabled) this.game.hud.toast("Turn voice on first (press V)", "warn");
      else if (!vc.hasRadio()) this.game.hud.toast("You need a radio to talk on B (Portus, 100 coins)", "warn");
      else if (!me.radioCh) this.game.hud.toast("Pick a radio channel first (Esc → Voice & radio)", "warn");
      else if (canTalk) {
        this.send("radio:tx", { on: true });
        vc.audio?.squelch();
      }
    } else if (!b && this.bHeld) {
      if (vc.radioTx) vc.audio?.squelch();
      this.stopRadioTx();
    }
    this.bHeld = b;
    vc.radioTx = canTalk && b && !this.txDenied && me.radioCh > 0 && vc.hasRadio();
    const talking = vc.ptt || vc.radioTx || (vc.micTest && vc.micState === "live");
    for (const t of vc.mic?.getAudioTracks() ?? []) if (t.enabled !== talking) t.enabled = talking;
    if (vc.ptt !== wasPtt || vc.radioTx !== wasRadio) this.gate(this.room.state as any, me);
  }

  private myInfo(me: any): Me {
    return { radioCh: me.radioCh, hasRadio: this.vc.hasRadio(), adminMuted: this.vc.adminMuted || !!(me.flags & PF.VOICE_MUTED) };
  }

  private plan(state: any, me: any, now: number): void {
    const vc = this.vc;
    if (!vc.enabled || !vc.ice) {
      for (const p of this.transport.peers()) this.transport.close(p);
      return;
    }
    const peers: PeerView[] = [];
    state.players.forEach((p: any, id: string) => {
      if (id === this.room.sessionId) return;
      peers.push({
        id,
        dist: Math.hypot(p.x - me.x, p.y - me.y, p.z - me.z),
        voice: !!(p.flags & PF.VOICE),
        adminMuted: !!(p.flags & PF.VOICE_MUTED),
        radioCh: p.radioCh,
        blocked: isBlocked(p.userId) || (this.backoff.get(id) ?? 0) > now,
      });
    });
    const plan = planLinks({ me: this.myInfo(me), peers, linked: new Set(this.transport.peers()), farSince: this.farSince, now });
    for (const id of plan.close) this.transport.close(id);
    // Stagger new links: a few per tick keeps signalling under the room's message budget.
    const dist = new Map(peers.map((p) => [p.id, p.dist]));
    plan.open.sort((a, b) => dist.get(a)! - dist.get(b)!);
    for (const id of plan.open.slice(0, 3)) this.transport.connect(id);
  }

  /** Who gets my microphone right now. */
  private gate(state: any, me: any): void {
    const vc = this.vc;
    const mic = vc.micState === "live" && !vc.panic && !vc.adminMuted ? (vc.mic?.getAudioTracks()[0] ?? null) : null;
    const my = this.myInfo(me);
    for (const id of this.transport.peers()) {
      const p = state.players.get(id);
      const send = !!mic && !!p && shouldSend(Math.hypot(p.x - me.x, p.y - me.y, p.z - me.z), vc.ptt, vc.radioTx, onMyChannel(my, p));
      this.transport.setSending(id, send ? mic : null);
    }
  }

  private audioTick(state: any, me: any): void {
    const vc = this.vc;
    const audio = vc.audio;
    this.gate(state, me);
    if (!audio) return;
    const cam = this.game.ctx.camera;
    cam.getWorldQuaternion(_q).invert();
    const pos = this.game.player.pos;
    _up.copy(pos).normalize();
    _me.copy(pos).addScaledVector(_up, 1.6);
    const my = this.myInfo(me);
    const myParty: string = me.party ?? "";
    for (const id of this.transport.peers()) {
      const p = state.players.get(id);
      if (!p) continue;
      const av = this.game.avatars.get(id);
      if (av) _v.copy(av.root.position);
      else _v.set(p.x, p.y, p.z);
      const l = _v.length() || 1;
      _v.addScaledVector(_up.set(_v.x / l, _v.y / l, _v.z / l), 1.6).sub(_me).applyQuaternion(_q);
      audio.setPosition(id, _v.x, _v.y, _v.z);
      const stranger = !myParty || p.party !== myParty;
      const silent = isMuted(id) || (vc.muteStrangers && stranger);
      audio.setPeerGain(id, silent ? 0 : 1);
      // Same-channel transmitter: through the radio chain at fixed gain (squelch on each edge).
      audio.setRadio(id, !!(p.flags & PF.RADIO_TX) && onMyChannel(my, p), !silent && !vc.panic);
    }
    audio.levels(vc.speaking);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const u of this.unsub) u();
    this.transport.dispose();
    this.vc.speaking.clear();
    if (this.vc.room === this) this.vc.room = null;
    this.vc.ui.clearRings();
  }
}
