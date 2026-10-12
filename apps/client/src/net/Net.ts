// Connection to the game server: /api/play → seat reservation → room. Sends inputs at 20 Hz and
// keeps per-player snapshot buffers for 100 ms interpolation (SPEC §5.3).

import { Client, type Room } from "@colyseus/sdk";
import type { BodyId } from "@firstlight/shared";
import { NET, PROTOCOL_VERSION, type InputMsg, type PlayResponse } from "@firstlight/shared/net/protocol";
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

/**
 * The server speaks another protocol version (a deploy happened while this tab was open): reload
 * once to pick up the new client. Only once per server version, so a stale cached page can't loop.
 */
function reloadForVersion(version: number | undefined): void {
  const key = "fl.reloadedForVersion";
  if (sessionStorage.getItem(key) === String(version)) return;
  sessionStorage.setItem(key, String(version));
  location.reload();
}

/** App close codes (shared with the server). */
export { CLOSE } from "@firstlight/shared/net/social";

/** The room handshake (WebSocket join of a seat reservation) must finish within this (ms). */
export const JOIN_TIMEOUT_MS = 15_000;

/** The WebSocket connected (or not) but the room handshake never finished. */
export class JoinTimeout extends Error {
  constructor() {
    super(`room handshake timed out after ${JOIN_TIMEOUT_MS} ms`);
    this.name = "JoinTimeout";
  }
}

/** Starts the WebSocket join of a seat reservation; `abort` closes that socket while it handshakes. */
export interface SeatJoiner {
  consume(reservation: unknown): { joined: Promise<Room>; abort(): void };
}

/** The SDK client, keeping hold of the room it is connecting so a stalled handshake can be closed. */
class SeatClient extends Client implements SeatJoiner {
  private connecting: Room | null = null;

  protected override createRoom<T>(roomName: string, rootSchema?: any): Room<any, T> {
    const room = super.createRoom<T>(roomName, rootSchema);
    this.connecting = room;
    return room;
  }

  consume(reservation: unknown): { joined: Promise<Room>; abort(): void } {
    // consumeSeatReservation creates the room and starts connecting before its first await.
    const joined = this.consumeSeatReservation(reservation as never);
    const room = this.connecting;
    this.connecting = null;
    return {
      joined,
      abort: () => {
        try {
          room?.connection?.close();
        } catch {
          /* the socket may never have opened */
        }
      },
    };
  }
}

export class Net {
  room: Room | null = null;
  /** Bumped by every join and leave: a join that finishes after a newer one (or a leave) is dropped. */
  private joinGen = 0;
  readonly remotes = new Map<string, RemotePlayerView>();
  private seq = 0;
  private lastSend = 0;
  serverOffset = 0; // serverTime - localTime
  rtt = 0;
  onCorrect: ((x: number, y: number, z: number) => void) | null = null;
  /** The current room closed without us leaving it (rooms we left or replaced don't report). */
  onLeaveRoom: ((code: number) => void) | null = null;
  /** Queue position while /api/play says the world is full (null once in, or on failure). */
  onQueue: ((q: { position: number; etaSeconds: number } | null) => void) | null = null;
  /** /api/play refused this account ("banned", or "kicked" for a short cooldown). */
  onRefused: ((reason: string) => void) | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly joiner: SeatJoiner = new SeatClient(config.apiUrl)) {}

  async join(body: BodyId, opts: { partyLeaderRoomId?: string; starter?: number; palette?: number } = {}): Promise<Room> {
    let retried401 = false;
    for (;;) {
      // Per attempt: queues can outlast the 15-minute JWT (getPlayToken caches and refreshes it).
      const token = await getPlayToken();
      const res = await fetch(`${config.apiUrl}/api/play`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ body, v: PROTOCOL_VERSION, ...opts }),
        signal: AbortSignal.timeout(20_000), // a server that never answers fails the arrival (retry/reconnect), not a spinner
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
        const gen = ++this.joinGen;
        const room = await this.consumeWithDeadline(r.reservation);
        if (gen !== this.joinGen) {
          void room.leave().catch(() => {}); // a leave() or a newer join came first: never attach this one
          throw new Error("join superseded");
        }
        this.attach(room);
        return room;
      }
      if ("queue" in r) {
        this.onQueue?.(r.queue);
        await new Promise((ok) => setTimeout(ok, 5000));
        continue;
      }
      this.onQueue?.(null);
      if (r.error === "version") reloadForVersion(r.version);
      if (r.error === "travel" && r.body) throw new TravelRedirect(r.body);
      if (r.error === "banned" || r.error === "kicked") this.onRefused?.(r.error);
      throw new Error(r.error);
    }
  }

  /**
   * The WebSocket half of a join, bounded: a socket that never finishes the room handshake is closed
   * and the join fails (JoinTimeout); a room that joins after that is left, never attached.
   */
  private consumeWithDeadline(reservation: unknown): Promise<Room> {
    const { joined, abort } = this.joiner.consume(reservation);
    return new Promise<Room>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        abort();
        reject(new JoinTimeout());
      }, JOIN_TIMEOUT_MS);
      joined.then(
        (room) => {
          if (settled) return void room.leave().catch(() => {});
          settled = true;
          clearTimeout(timer);
          resolve(room);
        },
        (e: unknown) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(e);
        },
      );
    });
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
      if (this.room !== room) return; // we left it (leave() clears this.room first) or joined another
      this.room = null;
      this.stopPing();
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

  /** Interpolated snapshot `delay` ms in the past (written into `out` when given: no allocation). */
  sample(view: RemotePlayerView, now: number, delay = NET.INTERP_DELAY_MS, out?: Snapshot): Snapshot | null {
    const b = view.buf;
    if (b.length === 0) return null;
    const t = now - delay;
    if (t <= b[0]!.t) return b[0]!;
    for (let i = b.length - 1; i > 0; i--) {
      const a = b[i - 1]!, c = b[i]!;
      if (t >= a.t) {
        const k = Math.min(1, (t - a.t) / Math.max(1, c.t - a.t));
        const s = out ?? { t: 0, x: 0, y: 0, z: 0, fx: 0, fy: 0, fz: 0, anim: 0 };
        s.t = t;
        s.x = a.x + (c.x - a.x) * k;
        s.y = a.y + (c.y - a.y) * k;
        s.z = a.z + (c.z - a.z) * k;
        s.fx = a.fx + (c.fx - a.fx) * k;
        s.fy = a.fy + (c.fy - a.fy) * k;
        s.fz = a.fz + (c.fz - a.fz) * k;
        s.anim = k < 0.5 ? a.anim : c.anim;
        return s;
      }
    }
    return b[b.length - 1]!;
  }

  async leave() {
    this.joinGen++; // a join still in flight must not attach after this
    const r = this.room;
    this.room = null;
    this.stopPing();
    await r?.leave().catch(() => {});
  }
}
