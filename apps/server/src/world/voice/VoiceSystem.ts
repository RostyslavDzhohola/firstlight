// Proximity voice signalling for one room copy (SPEC §5.7). The server never carries audio: it
// relays WebRTC offers/answers/candidates between two players only when the pair is allowed
// (both opted in, neither blocked either way, neither admin-muted, and within DROP metres or tuned to
// the same radio channel with a radio each), mints per-player TURN credentials, and owns the radio
// channel state (PlayerState.radioCh, PF.RADIO_TX).

import type { Client } from "@colyseus/core";
import { PF } from "@firstlight/shared/net/schema";
import { VOICE, VOICE_REPORT_REASONS, type IceServerConfig } from "@firstlight/shared/net/voice";
import { z } from "zod";
import { accountLinks } from "../../auth/links.ts";
import { env } from "../../env.ts";
import { actorPos, type PlayerActor } from "../actors.ts";
import type { BodyRoom } from "../BodyRoom.ts";
import { dist3 } from "../geometry.ts";
import type { RoomSystem } from "../systems.ts";
import { voiceMutes, voiceSafety } from "./safety.ts";
import { mintIceServers, turnConfigured, turnCredentials } from "./turn.ts";

// ---- validation ---------------------------------------------------------------------------

const sid = z.string().min(1).max(64);
const candidate = z.object({
  candidate: z.string().max(1024),
  sdpMid: z.string().max(64).nullable().optional(),
  sdpMLineIndex: z.number().int().min(0).max(64).nullable().optional(),
  usernameFragment: z.string().max(256).nullable().optional(),
});
export const voiceSchemas = {
  enable: z.object({ age16: z.boolean() }),
  signal: z.object({
    to: sid,
    sdp: z.object({ type: z.enum(["offer", "answer"]), sdp: z.string().max(12_000) }).optional(),
    candidate: candidate.nullable().optional(),
    candidates: z.array(candidate).max(24).optional(),
  }),
  tune: z.object({ ch: z.number().int().min(0).max(VOICE.CHANNELS) }),
  tx: z.object({ on: z.boolean() }),
  block: z.object({ target: sid }),
  report: z.object({ target: sid, reason: z.string().trim().min(1).max(200) }),
  mute: z.object({ target: sid, on: z.boolean() }),
};

// ---- rate limits --------------------------------------------------------------------------

/** Token bucket: `cap` burst, refilled at `perSec`. */
class Bucket {
  private tokens: number;
  private last: number;
  private readonly cap: number;
  private readonly perSec: number;
  constructor(cap: number, perSec: number, now: number) {
    this.cap = cap;
    this.perSec = perSec;
    this.tokens = cap;
    this.last = now;
  }
  take(now: number): boolean {
    this.tokens = Math.min(this.cap, this.tokens + ((now - this.last) / 1000) * this.perSec);
    this.last = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

const LIMITS = {
  /** Signals per second (the client batches candidates and stays under ~15/s). */
  SIGNAL_BURST: 40,
  SIGNAL_PER_S: 20,
  ACTION_BURST: 12,
  ACTION_PER_S: 2,
  REPORTS_PER_10_MIN: 5,
  REPORT_SAME_TARGET_MS: 60_000,
  UNREACHABLE_EVERY_MS: 5_000,
  TURN_RETRY_MS: 30_000,
};

interface VoiceSession {
  sid: string;
  /** Account id at join (identity may be re-keyed later; read the live one from the actor). */
  userId: string;
  enabled: boolean;
  signals: Bucket;
  actions: Bucket;
  /** Current TURN credentials (relay mode). */
  ice: IceServerConfig[] | null;
  iceUsernames: string[];
  mintedAt: number;
  minting: boolean;
  turnRetryAt: number;
  /** Seen banned in game.db: voice stays off for this session. */
  banned: boolean;
  txSince: number;
  mutedSeen: boolean;
  unreachableAt: Map<string, number>;
  reportTimes: number[];
  reportedAt: Map<string, number>;
}

export class VoiceSystem implements RoomSystem {
  readonly sessions = new Map<string, VoiceSession>();
  private readonly room: BodyRoom;
  private lastSlow = 0;
  private disposed = false;
  private readonly unsubscribeLinks: () => void;

  constructor(room: BodyRoom) {
    this.room = room;
    // A guest saved mid-session: the voice session follows the account id.
    this.unsubscribeLinks = accountLinks.on((ev) => {
      for (const s of this.sessions.values()) if (s.userId === ev.fromUserId) s.userId = ev.toUserId;
    });
    const on = (type: string, fn: (c: Client, m: unknown) => void) => room.onMessage(type, (c: Client, m: unknown) => fn(c, m));
    on("voice:enable", (c, m) => this.enable(c, m));
    on("voice:disable", (c) => this.disable(c));
    on("voice:signal", (c, m) => this.signal(c, m));
    on("radio:tune", (c, m) => this.tune(c, m));
    on("radio:tx", (c, m) => this.tx(c, m));
    on("voice:block", (c, m) => this.block(c, m));
    on("voice:report", (c, m) => this.report(c, m));
    on("voice:mute", (c, m) => this.adminMute(c, m));
  }

  // ---------------------------------------------------------------- lifecycle

  onPlayerJoin(sessionId: string): void {
    const a = this.room.actors.get(sessionId);
    if (!a) return;
    const now = Date.now();
    this.sessions.set(sessionId, {
      sid: sessionId,
      userId: a.identity.userId,
      enabled: false,
      signals: new Bucket(LIMITS.SIGNAL_BURST, LIMITS.SIGNAL_PER_S, now),
      actions: new Bucket(LIMITS.ACTION_BURST, LIMITS.ACTION_PER_S, now),
      ice: null,
      iceUsernames: [],
      mintedAt: 0,
      minting: false,
      turnRetryAt: 0,
      banned: false,
      txSince: 0,
      mutedSeen: false,
      unreachableAt: new Map(),
      reportTimes: [],
      reportedAt: new Map(),
    });
    a.state.flags &= ~(PF.VOICE | PF.RADIO_TX);
    a.state.radioCh = 0;
    if (voiceMutes.has(a.identity.userId)) a.state.flags |= PF.VOICE_MUTED;
  }

  onPlayerLeave(sessionId: string): void {
    const s = this.sessions.get(sessionId);
    this.sessions.delete(sessionId);
    // A lingering body stays in state: it no longer talks or holds a channel.
    const p = this.room.state.players.get(sessionId);
    if (p) {
      p.flags &= ~(PF.VOICE | PF.RADIO_TX);
      p.radioCh = 0;
    }
    for (const o of this.sessions.values()) o.unreachableAt.delete(sessionId);
    if (!s) return;
    if (s.enabled) this.dropEverywhere(sessionId);
    if (s.iceUsernames.length) void turnCredentials.revoke(s.iceUsernames);
  }

  dispose(): void {
    this.disposed = true;
    this.unsubscribeLinks();
    for (const s of this.sessions.values()) if (s.iceUsernames.length) void turnCredentials.revoke(s.iceUsernames);
    this.sessions.clear();
  }

  tick(_dtMs: number, now: number): void {
    if (now - this.lastSlow < 1000) return;
    this.lastSlow = now;
    for (const s of this.sessions.values()) {
      const a = this.room.actors.get(s.sid);
      if (!a) continue;
      const p = a.state;
      // Radio drops on death (the item goes to the pile) or when it leaves the inventory.
      if (p.radioCh !== 0 && !hasRadio(a)) {
        p.radioCh = 0;
        p.flags &= ~PF.RADIO_TX;
        a.client.send("radio:tuned", { ch: 0 });
      }
      if (p.flags & PF.RADIO_TX && now - s.txSince > VOICE.RADIO_TX_MAX_MS) {
        p.flags &= ~PF.RADIO_TX;
        a.client.send("voice:denied", { action: "radio:tx", reason: "timeout" });
      }
      // Admin mute applied elsewhere (player list, /admin): close the player's links once.
      const muted = !!(p.flags & PF.VOICE_MUTED);
      if (muted !== s.mutedSeen) {
        s.mutedSeen = muted;
        if (muted) {
          p.flags &= ~PF.RADIO_TX;
          if (s.enabled) this.dropEverywhere(s.sid);
        }
        a.client.send("voice:muted", { on: muted });
      }
      // Banned (by the admin tools, any room): voice ends now and relay credentials are revoked.
      if ((s.enabled || s.iceUsernames.length) && voiceSafety.isBanned(a.identity.userId, now)) {
        this.ban(a, s);
        continue;
      }
      if (s.enabled) {
        if (!(p.flags & PF.VOICE)) p.flags |= PF.VOICE;
        if (turnConfigured() && !s.minting) {
          const stale = s.ice && now - s.mintedAt >= VOICE.REMINT_MS;
          const retry = !s.ice && now >= s.turnRetryAt;
          if (stale || retry) void this.sendIce(a, s, true);
        }
      }
    }
  }

  // ---------------------------------------------------------------- opt in / out

  private enable(c: Client, m: unknown): void {
    const r = voiceSchemas.enable.safeParse(m);
    const { a, s } = this.who(c);
    if (!a || !s || !s.actions.take(Date.now())) return;
    if (!r.success) return this.deny(c, "voice:enable", "invalid");
    if (!r.data.age16) return this.deny(c, "voice:enable", "age");
    if (s.banned || voiceSafety.isBanned(a.identity.userId)) {
      this.ban(a, s);
      return this.deny(c, "voice:enable", "banned");
    }
    s.enabled = true;
    a.state.flags |= PF.VOICE;
    if (a.state.flags & PF.VOICE_MUTED) {
      s.mutedSeen = true;
      c.send("voice:muted", { on: true });
    }
    void this.sendIce(a, s, false);
  }

  private disable(c: Client): void {
    const { a, s } = this.who(c);
    if (!a || !s || !s.actions.take(Date.now())) return;
    this.turnOff(a, s);
  }

  /** Banned: voice off for good in this session, and every live credential of the account revoked. */
  private ban(a: PlayerActor, s: VoiceSession): void {
    s.banned = true;
    this.turnOff(a, s);
    void turnCredentials.revokeUser(a.identity.userId);
  }

  /** Voice off: hang up everywhere and revoke relay credentials. */
  private turnOff(a: PlayerActor, s: VoiceSession): void {
    const was = s.enabled;
    s.enabled = false;
    a.state.flags &= ~(PF.VOICE | PF.RADIO_TX);
    if (was) this.dropEverywhere(s.sid);
    if (s.iceUsernames.length) {
      void turnCredentials.revoke(s.iceUsernames);
      s.iceUsernames = [];
      s.ice = null;
      s.mintedAt = 0;
    }
  }

  /** Reply with ICE servers: fresh TURN credentials (relay), or direct mode in local dev. */
  private async sendIce(a: PlayerActor, s: VoiceSession, forceMint: boolean): Promise<void> {
    const ttl = VOICE.TURN_TTL_S;
    if (!turnConfigured()) {
      // No TURN key: local dev connects directly. Production refuses to expose addresses.
      a.client.send("voice:ice", { iceServers: [], relay: env.production, ttl, available: !env.production });
      return;
    }
    const now = Date.now();
    if (!forceMint && s.ice && now - s.mintedAt < VOICE.REMINT_MS) {
      a.client.send("voice:ice", { iceServers: s.ice, relay: true, ttl, available: true });
      return;
    }
    if (s.minting) return;
    // After a failure, and beyond the per-account budget, wait instead of calling the TURN API again.
    if (now < s.turnRetryAt || !turnCredentials.allowMint(s.userId, now)) {
      s.turnRetryAt = Math.max(s.turnRetryAt, now + LIMITS.TURN_RETRY_MS);
      if (!s.ice) a.client.send("voice:ice", { iceServers: [], relay: true, ttl, available: false });
      return;
    }
    s.minting = true;
    try {
      const minted = await mintIceServers(ttl);
      turnCredentials.remember(s.userId, minted.usernames, ttl);
      const live = this.sessions.get(s.sid) === s && s.enabled && !s.banned && !this.disposed && !voiceSafety.isBanned(a.identity.userId);
      if (!live) {
        void turnCredentials.revoke(minted.usernames);
        return;
      }
      const stale = s.iceUsernames.slice(0, -2); // keep the current and previous credential valid
      if (stale.length) void turnCredentials.revoke(stale);
      s.ice = minted.iceServers;
      s.iceUsernames = [...s.iceUsernames.slice(-2), ...minted.usernames];
      s.mintedAt = Date.now();
      a.client.send("voice:ice", { iceServers: minted.iceServers, relay: true, ttl, available: true });
    } catch (e) {
      console.warn(`voice: ${(e as Error).message}`);
      s.ice = null;
      s.turnRetryAt = Date.now() + LIMITS.TURN_RETRY_MS;
      if (this.sessions.get(s.sid) === s) a.client.send("voice:ice", { iceServers: [], relay: true, ttl, available: false });
    } finally {
      s.minting = false;
    }
  }

  // ---------------------------------------------------------------- signalling relay

  private signal(c: Client, m: unknown): void {
    const now = Date.now();
    const s = this.sessions.get(c.sessionId);
    if (!s || !s.signals.take(now)) return;
    const r = voiceSchemas.signal.safeParse(m);
    if (!r.success || r.data.to === c.sessionId) return;
    const to = r.data.to;
    if (!this.room.actors.has(to)) return; // unknown ids get no answer and leave no trace
    if (!this.allowed(c.sessionId, to)) {
      const last = s.unreachableAt.get(to) ?? 0;
      if (now - last >= LIMITS.UNREACHABLE_EVERY_MS) {
        s.unreachableAt.set(to, now);
        c.send("voice:unreachable", { peer: to });
      }
      return;
    }
    const target = this.room.actors.get(to)!;
    const out: Record<string, unknown> = { from: c.sessionId };
    if (r.data.sdp) out.sdp = r.data.sdp;
    if (r.data.candidate !== undefined) out.candidate = r.data.candidate;
    if (r.data.candidates?.length) out.candidates = r.data.candidates;
    target.client.send("voice:signal", out);
  }

  /** May `a` and `b` exchange signalling right now? Cheap checks first, the block lookup last. */
  allowed(aId: string, bId: string): boolean {
    const a = this.room.actors.get(aId);
    const b = this.room.actors.get(bId);
    if (!a || !b || aId === bId) return false;
    const sa = this.sessions.get(aId), sb = this.sessions.get(bId);
    if (!sa?.enabled || !sb?.enabled || sa.banned || sb.banned) return false;
    const fa = a.state.flags, fb = b.state.flags;
    if (!(fa & PF.VOICE) || !(fb & PF.VOICE)) return false;
    if (fa & PF.VOICE_MUTED || fb & PF.VOICE_MUTED) return false;
    if (voiceMutes.has(a.identity.userId) || voiceMutes.has(b.identity.userId)) return false;
    const near = dist3(actorPos(a), actorPos(b)) <= VOICE.DROP;
    if (!near && !sameRadioChannel(a, b)) return false;
    return !voiceSafety.blockedEitherWay(a.identity.userId, b.identity.userId);
  }

  // ---------------------------------------------------------------- radio

  private tune(c: Client, m: unknown): void {
    const { a, s } = this.who(c);
    if (!a || !s || !s.actions.take(Date.now())) return;
    const r = voiceSchemas.tune.safeParse(m);
    if (!r.success) return this.deny(c, "radio:tune", "invalid");
    const ch = r.data.ch;
    if (ch === 0) {
      a.state.radioCh = 0;
      a.state.flags &= ~PF.RADIO_TX;
      c.send("radio:tuned", { ch: 0 });
      return;
    }
    if (!hasRadio(a)) return this.deny(c, "radio:tune", "no radio");
    if (a.state.radioCh === ch) {
      c.send("radio:tuned", { ch });
      return;
    }
    let holders = 0;
    for (const o of this.room.actors.values()) if (o !== a && o.state.radioCh === ch) holders++;
    if (holders >= VOICE.RADIO_CAP) return this.deny(c, "radio:tune", "channel full");
    a.state.radioCh = ch;
    a.state.flags &= ~PF.RADIO_TX;
    c.send("radio:tuned", { ch });
  }

  private tx(c: Client, m: unknown): void {
    const { a, s } = this.who(c);
    if (!a || !s) return;
    const r = voiceSchemas.tx.safeParse(m);
    if (!r.success) return;
    if (!r.data.on) {
      a.state.flags &= ~PF.RADIO_TX;
      return;
    }
    if (!s.actions.take(Date.now())) return;
    const reason = !hasRadio(a) ? "no radio" : a.state.radioCh === 0 ? "not tuned" : !s.enabled ? "voice off" : a.state.flags & PF.VOICE_MUTED ? "muted" : "";
    if (reason) {
      a.state.flags &= ~PF.RADIO_TX;
      return this.deny(c, "radio:tx", reason);
    }
    a.state.flags |= PF.RADIO_TX;
    s.txSince = Date.now();
  }

  // ---------------------------------------------------------------- safety

  private block(c: Client, m: unknown): void {
    const { a, s } = this.who(c);
    if (!a || !s || !s.actions.take(Date.now())) return;
    const r = voiceSchemas.block.safeParse(m);
    if (!r.success) return this.deny(c, "voice:block", "invalid");
    const t = this.room.actors.get(r.data.target);
    if (!t || t === a) return this.deny(c, "voice:block", "no such player");
    const fresh = voiceSafety.block(a.identity.userId, t.identity.userId);
    // Both clients hang up now; the relay refuses the pair from here on (persisted, survives rejoin).
    c.send("voice:drop", { peer: t.id });
    t.client.send("voice:drop", { peer: a.id });
    c.send("voice:blocked", { target: t.id });
    c.send("social:blocked", { userIds: voiceSafety.blockedBy(a.identity.userId) }); // the Tab list's copy
    // Defence in depth against a modified client: cut the blocked player's relay allocations and give
    // them fresh credentials for everyone else.
    const ts = this.sessions.get(t.id);
    if (fresh && ts?.iceUsernames.length) {
      const old = ts.iceUsernames;
      ts.iceUsernames = [];
      ts.ice = null;
      void turnCredentials.revoke(old);
      if (ts.enabled) void this.sendIce(t, ts, true);
    }
  }

  private report(c: Client, m: unknown): void {
    const { a, s } = this.who(c);
    const now = Date.now();
    if (!a || !s || !s.actions.take(now)) return;
    const r = voiceSchemas.report.safeParse(m);
    if (!r.success) return this.deny(c, "voice:report", "invalid");
    const target = this.room.state.players.get(r.data.target);
    if (!target || r.data.target === c.sessionId || !target.userId) return this.deny(c, "voice:report", "no such player");
    s.reportTimes = s.reportTimes.filter((t) => now - t < 10 * 60_000);
    const lastSame = s.reportedAt.get(target.userId) ?? 0;
    if (s.reportTimes.length >= LIMITS.REPORTS_PER_10_MIN || now - lastSame < LIMITS.REPORT_SAME_TARGET_MS) {
      return this.deny(c, "voice:report", "too many reports");
    }
    s.reportTimes.push(now);
    s.reportedAt.set(target.userId, now);
    const known = (VOICE_REPORT_REASONS as readonly string[]).includes(r.data.reason);
    voiceSafety.report(
      {
        reporter: a.identity.userId,
        target: target.userId,
        body: this.room.bodyDef.id,
        pos: [target.x, target.y, target.z],
        reason: `voice: ${known ? r.data.reason : "Other"} (reported ${a.identity.name} → ${target.name})`,
      },
      now,
    );
    c.send("voice:reported", { target: r.data.target });
  }

  /** Admin: server-side voice mute. Persists for the account while this process runs. */
  private adminMute(c: Client, m: unknown): void {
    const { a } = this.who(c);
    if (!a || !a.identity.admin) return;
    const r = voiceSchemas.mute.safeParse(m);
    if (!r.success) return;
    const t = this.room.actors.get(r.data.target);
    if (!t) return this.deny(c, "voice:mute", "no such player");
    voiceMutes.set(t.identity.userId, r.data.on);
    const ts = this.sessions.get(t.id);
    if (r.data.on) {
      t.state.flags = (t.state.flags | PF.VOICE_MUTED) & ~PF.RADIO_TX;
      if (ts?.enabled) this.dropEverywhere(t.id);
    } else {
      t.state.flags &= ~PF.VOICE_MUTED;
    }
    if (ts) ts.mutedSeen = r.data.on;
    t.client.send("voice:muted", { on: r.data.on });
  }

  // ---------------------------------------------------------------- helpers

  private who(c: Client): { a: PlayerActor | undefined; s: VoiceSession | undefined } {
    return { a: this.room.actors.get(c.sessionId), s: this.sessions.get(c.sessionId) };
  }

  private deny(c: Client, action: string, reason: string): void {
    c.send("voice:denied", { action, reason });
  }

  /** Tell every other voice client to hang up on `peer` (its own client hangs up by itself). */
  private dropEverywhere(peer: string): void {
    for (const [id, s] of this.sessions) {
      if (id === peer || !s.enabled) continue;
      this.room.actors.get(id)?.client.send("voice:drop", { peer });
    }
  }
}

export function hasRadio(a: PlayerActor): boolean {
  for (const it of a.char.hotbar) if (it?.id === "radio") return true;
  for (const it of a.char.backpack) if (it?.id === "radio") return true;
  return false;
}

function sameRadioChannel(a: PlayerActor, b: PlayerActor): boolean {
  const ch = a.state.radioCh;
  return ch > 0 && ch === b.state.radioCh && hasRadio(a) && hasRadio(b);
}
