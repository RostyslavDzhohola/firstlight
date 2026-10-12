// Connection to the game server: /api/play → seat reservation → room. Sends inputs at 20 Hz and
// keeps per-player snapshot buffers for 100 ms interpolation (SPEC §5.3).

import { Client, type Room } from "@colyseus/sdk";
import type { BodyId } from "@firstlight/shared";
import { NET, type InputMsg, type PlayResponse } from "@firstlight/shared/net/protocol";
import { config } from "../config.ts";
import { getPlayToken, invalidatePlayToken } from "./auth.ts";

export interface Snapshot {
  t: number; // local receive time (ms)
  x: number;
  y: number;
  z: number;
  fx: number;
  fy: number;
  fz: number;
  anim: number;
}

export interface RemotePlayerView {
  id: string;
  buf: Snapshot[];
}

/** The server sent us to the body our character is actually on (no travel ticket for the one asked). */
export class TravelRedirect extends Error {
  constructor(readonly body: BodyId) {
    super(`travel: character is on ${body}`);
  }
}

/** App close codes (shared with the server). */
export { CLOSE } from "@firstlight/shared/net/social";

export class Net {
  room: Room | null = null;
  readonly client = new Client(config.apiUrl);
  readonly remotes = new Map<string, RemotePlayerView>();
  private seq = 0;
  private lastSend = 0;
  serverOffset = 0; // serverTime - localTime
  rtt = 0;
  onCorrect: ((x: number, y: number, z: number) => void) | null = null;
  onLeaveRoom: ((code: number) => void) | null = null;
  /** Queue position while /api/play says the world is full (null once in, or on failure). */
  onQueue: ((q: { position: number; etaSeconds: number } | null) => void) | null = null;
  /** /api/play refused this account ("banned", or "kicked" for a short cooldown). */
  onRefused: ((reason: string) => void) | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;

  async join(body: BodyId, opts: { partyLeaderRoomId?: string; starter?: number; palette?: number } = {}): Promise<Room> {
    let retried401 = false;
    for (;;) {
      // Per attempt: queues can outlast the 15-minute JWT (getPlayToken caches and refreshes it).
      const token = await getPlayToken();
      const res = await fetch(`${config.apiUrl}/api/play`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ body, ...opts }),
      });
      if (res.status === 401 && !retried401) {
        // Stale token (e.g. the guest just saved and got a new id): fetch a fresh one once.
        retried401 = true;
        invalidatePlayToken();
        continue;
      }
      if (res.status === 429) {
        await new Promise((ok) => setTimeout(ok, 2500));
        continue;
      }
      const r = (await res.json()) as PlayResponse;
      if (r.ok) {
        this.onQueue?.(null);
        const room = await this.client.consumeSeatReservation(r.reservation as never);
        this.attach(room);
        return room;
      }
      if ("queue" in r) {
        this.onQueue?.(r.queue);
        await new Promise((ok) => setTimeout(ok, 5000));
        continue;
      }
      this.onQueue?.(null);
      if (r.error === "travel" && r.body) throw new TravelRedirect(r.body);
      if (r.error === "banned" || r.error === "kicked") this.onRefused?.(r.error);
      throw new Error(r.error);
    }
  }

  private attach(room: Room) {
    this.room = room;
    this.remotes.clear();
    this.seq = 0;
    room.onStateChange((state: any) => {
      const now = performance.now();
      const seen = new Set<string>();
      state.players?.forEach((p: any, id: string) => {
        seen.add(id);
        if (id === room.sessionId) return;
        let v = this.remotes.get(id);
        if (!v) {
          v = { id, buf: [] };
          this.remotes.set(id, v);
        }
        const last = v.buf[v.buf.length - 1];
        if (!last || last.x !== p.x || last.y !== p.y || last.z !== p.z || last.anim !== p.anim || now - last.t > 200) {
          v.buf.push({ t: now, x: p.x, y: p.y, z: p.z, fx: p.fx, fy: p.fy, fz: p.fz, anim: p.anim });
          if (v.buf.length > 30) v.buf.shift();
        }
      });
      for (const id of this.remotes.keys()) if (!seen.has(id)) this.remotes.delete(id);
    });
    room.onMessage("correct", (m: { x: number; y: number; z: number }) => this.onCorrect?.(m.x, m.y, m.z));
    room.onMessage("pong", (m: { t: number; serverTime: number }) => {
      const now = performance.now();
      this.rtt = now - m.t;
      this.serverOffset = m.serverTime - (Date.now() - this.rtt / 2);
    });
    room.onLeave((code: number) => {
      if (this.room === room) {
        this.room = null;
        this.stopPing();
      }
      this.onLeaveRoom?.(code);
    });
    this.stopPing();
    this.pingTimer = setInterval(() => this.room === room && room.send("ping", { t: performance.now() }), 2000);
  }

  private stopPing() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  /** Ask the server to authorise travel through the portal we're standing in. */
  requestTravel(to: BodyId, timeoutMs = 3000): Promise<boolean> {
    const room = this.room;
    if (!room) return Promise.resolve(false);
    return new Promise((resolve) => {
      let done = false;
      const finish = (ok: boolean) => {
        if (done) return;
        done = true;
        offOk();
        offDenied();
        clearTimeout(timer);
        resolve(ok);
      };
      const offOk = room.onMessage("travelOk", (m: { to: BodyId }) => m.to === to && finish(true));
      const offDenied = room.onMessage("denied", (m: { action: string }) => m.action === "travel" && finish(false));
      const timer = setTimeout(() => finish(false), timeoutMs);
      room.send("travel", { to });
    });
  }

  sendInput(now: number, m: Omit<InputMsg, "seq" | "t">) {
    if (!this.room || now - this.lastSend < 1000 / NET.INPUT_HZ) return;
    this.lastSend = now;
    this.room.send("input", { ...m, seq: ++this.seq, t: Date.now() });
  }

  /** Interpolated snapshot `delay` ms in the past. */
  sample(view: RemotePlayerView, now: number, delay = NET.INTERP_DELAY_MS): Snapshot | null {
    const b = view.buf;
    if (b.length === 0) return null;
    const t = now - delay;
    if (t <= b[0]!.t) return b[0]!;
    for (let i = b.length - 1; i > 0; i--) {
      const a = b[i - 1]!, c = b[i]!;
      if (t >= a.t) {
        const k = Math.min(1, (t - a.t) / Math.max(1, c.t - a.t));
        return {
          t,
          x: a.x + (c.x - a.x) * k,
          y: a.y + (c.y - a.y) * k,
          z: a.z + (c.z - a.z) * k,
          fx: a.fx + (c.fx - a.fx) * k,
          fy: a.fy + (c.fy - a.fy) * k,
          fz: a.fz + (c.fz - a.fz) * k,
          anim: k < 0.5 ? a.anim : c.anim,
        };
      }
    }
    return b[b.length - 1]!;
  }

  async leave() {
    const r = this.room;
    this.room = null;
    this.stopPing();
    await r?.leave().catch(() => {});
  }
}
