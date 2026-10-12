// Time of day and weather for one body copy (SPEC §6.14 #3/#4). The schedule is the shared,
// deterministic one (@firstlight/shared sky.ts); this system makes the server authoritative:
//   - "skySync" (client → server, sent right after its handler is registered) → "sky" to that client;
//   - "sky" broadcast to the copy whenever the weather slot changes or an admin overrides it;
//   - admin `sky` command: { weather?, intensity?, dayT?, hold?, minutes?, clear? } (staging for
//     photos/videos). Both the weather override and the time of day (a shifted clock, or with
//     `hold` a frozen one) last `minutes` (default 15, max 240); `clear` drops both at once.
// Clients extrapolate the clock and weather fades between messages.

import type { Client } from "@colyseus/core";
import { isWeather, skyState, SKY_PROFILES, dayT as dayAt, type SkyOverride, type SkyState } from "@firstlight/shared";
import { z } from "zod";
import type { PlayerActor } from "./actors.ts";
import type { BodyRoom } from "./BodyRoom.ts";
import type { RoomSystem, SystemFactory } from "./systems.ts";

/** One skySync answer per client per second (clients ask on join and every SKY_SYNC_MS). */
const SYNC_MIN_MS = 1000;

/** A finite number from an admin argument, else undefined. */
const finite = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

export class SkySystem implements RoomSystem {
  private readonly room: BodyRoom;
  private override: SkyOverride | null = null;
  /** Admin time shift (fraction of a day added to the clock), or a held (frozen) time of day. */
  private dayOffset = 0;
  private dayHold: number | null = null;
  /** When the admin time of day ends (0 = none set). */
  private dayUntil = 0;
  private lastKey = "";
  private readonly lastSync = new Map<string, number>();
  /** Injectable clock (tests). */
  now: () => number = () => Date.now();

  constructor(room: BodyRoom) {
    this.room = room;
    room.onMessage("skySync", z.object({}).passthrough().optional(), (c: Client) => this.sync(c));
    this.lastKey = this.key(this.state());
  }

  /** Answer a client's re-sync. Extra requests inside a second are dropped: the reply is idempotent
   * and the client keeps extrapolating, so there is nothing to refuse. */
  private sync(c: Client) {
    const now = this.now();
    if (now - (this.lastSync.get(c.sessionId) ?? -Infinity) < SYNC_MIN_MS) return;
    this.lastSync.set(c.sessionId, now);
    c.send("sky", this.state(now));
  }

  onPlayerLeave(sessionId: string) {
    this.lastSync.delete(sessionId);
  }

  get body() {
    return this.room.bodyDef.id;
  }

  get copy() {
    return this.room.state.copy;
  }

  state(now = this.now()): SkyState {
    return skyState(this.body, this.copy, now, this.dayOffset, this.override, this.dayHold);
  }

  /** What clients extrapolate from; a broadcast goes out only when it changes (an override's state is fixed). */
  private key(s: SkyState): string {
    return `${s.weather}:${s.intensity.toFixed(3)}:${s.slotStart}:${s.nextChangeAt}:${s.override}:${this.dayOffset}:${this.dayHold}`;
  }

  tick(_dtMs: number, now: number) {
    if (this.override && this.override.until <= now) this.override = null;
    if (this.dayUntil && this.dayUntil <= now) this.resetDay();
    const s = this.state(now);
    const k = this.key(s);
    if (k !== this.lastKey) {
      this.lastKey = k;
      this.room.broadcast("sky" as never, s as never);
    }
  }

  onAdmin(_actor: PlayerActor, cmd: string, args: Record<string, unknown>): boolean {
    if (cmd !== "sky") return false;
    const now = this.now();
    if (args.clear === true) {
      this.override = null;
      this.resetDay();
    }
    const until = now + Math.max(0.1, Math.min(240, finite(args.minutes) ?? 15)) * 60_000;
    if (isWeather(args.weather)) {
      const intensity = Math.max(0, Math.min(1, finite(args.intensity) ?? 0.9));
      this.override = { weather: args.weather, intensity, since: now, until };
    }
    const t = finite(args.dayT);
    if (t !== undefined) {
      const want = t - Math.floor(t);
      // Hold: freeze the time of day. Otherwise shift the clock so the copy is at that time now.
      this.dayHold = args.hold === true ? want : null;
      this.dayOffset = args.hold === true ? 0 : want - dayAt(this.body, now);
      this.dayUntil = until;
    }
    const s = this.state(now);
    this.lastKey = this.key(s);
    this.room.broadcast("sky" as never, s as never);
    return true;
  }

  private resetDay() {
    this.dayOffset = 0;
    this.dayHold = null;
    this.dayUntil = 0;
  }
}

export const createSkySystem: SystemFactory = (room) => (SKY_PROFILES[room.bodyDef.id] ? new SkySystem(room) : null);
