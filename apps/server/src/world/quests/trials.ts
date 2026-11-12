// Timed and tracked mission objectives (2026-11-12): race (rings in order against a clock), defend
// (light a beacon, hold its ring while waves arrive) and collect (walk over every piece, optionally
// against a clock). One attempt per player at a time, server-side only; the client hears each state
// change as a `trial` message (protocol.ts TrialMsg) and counts the clock down itself.
//
// What persists: the mission entry (accepted, done, and for collect the pieces taken in `counts`).
// The attempt itself (clock, next ring, waves) lives in this session only: a dropped socket, a
// reconnect, a death, a timeout or leaving a beacon's ring ends it, and the mission stays accepted for another try.
// Defend waves come from the NPC system's public createNpc/dissolve, marked `spawned: "trial"`, so
// they pay nothing (rewards.ts) and dissolve when the attempt ends.

import { MISSION_BY_ID, missionGoal, type MissionDef } from "@firstlight/shared/content/missions";
import { NPC_DEFS, NPC_INDEX } from "@firstlight/shared/content/npcs";
import { inReach } from "@firstlight/shared/content/world";
import type { TrialMsg } from "@firstlight/shared/net/protocol";
import { PF } from "@firstlight/shared/net/schema";
import { actorPos, type PlayerActor } from "../actors.ts";
import type { V3 } from "../geometry.ts";
import { npcSystemOf } from "../npc/index.ts";
import type { QuestSystem } from "./QuestSystem.ts";

export const TRIAL_RULES = {
  /** Scales every trial clock (limits, holds, wave times, grace). Tests shrink it; 1 in play. */
  timeScale: 1,
  /** Ring centres stand this far above the ground (the client draws them there too). */
  RING_LIFT: 1.6,
  /** Trial waves alive at once in one room, all players together. */
  MAX_WAVE_NPCS: 18,
  /** Waves rise this far from the defender, spread around them. */
  WAVE_DIST_M: 10,
  /** Unspent waves dissolve this long after their attempt would have ended anyway. */
  WAVE_TTL_EXTRA_MS: 60_000,
};

type Kind = TrialMsg["kind"];

interface Run {
  id: string;
  kind: Kind;
  startedAt: number;
  /** race / timed collect: when the clock runs out (ms epoch). */
  deadline: number;
  /** race: index of the ring to pass next. */
  next: number;
  /** defend: ms held inside the ring so far, when outside began (or 0), waves raised so far. */
  heldMs: number;
  outsideSince: number;
  waves: number;
  npcIds: string[];
  lastAt: number;
  paused: boolean;
}

type Mission = PlayerActor["char"]["missions"][number];

export class TrialLogic {
  private readonly q: QuestSystem;
  /** Session id → the running attempt. */
  private readonly runs = new Map<string, Run>();
  /** Session id → feet position at the previous tick (race rings are passed along that segment). */
  private readonly lastPos = new Map<string, V3>();
  /** Session id → the mission whose attempt a dropped socket ended (told on reconnect). */
  private readonly dropped = new Map<string, string>();

  constructor(q: QuestSystem) {
    this.q = q;
  }

  private scaled(s: number): number {
    return Math.max(1, Math.round(s * 1000 * TRIAL_RULES.timeScale));
  }

  /** The running attempt of a player (tests, the e2e hook through `trial` messages). */
  run(a: PlayerActor): Readonly<Run> | undefined {
    return this.runs.get(a.id);
  }

  // ---------------------------------------------------------------- messages

  private send(a: PlayerActor, def: MissionDef, m: Mission | undefined, state: TrialMsg["state"], reason?: string) {
    const run = this.runs.get(a.id);
    const kind: Kind = def.race ? "race" : def.defend ? "defend" : "collect";
    const now = Date.now();
    let leftMs = 0;
    let limitMs = 0;
    let next: string | null = null;
    if (def.race) {
      limitMs = this.scaled(def.race.limitS);
      leftMs = run ? Math.max(0, run.deadline - now) : limitMs;
      next = def.race.rings[run ? run.next : 0] ?? null;
    } else if (def.defend) {
      limitMs = this.scaled(def.defend.holdS);
      leftMs = run ? Math.max(0, limitMs - run.heldMs) : limitMs;
      next = def.defend.beacon;
    } else if (def.collect?.limitS) {
      limitMs = this.scaled(def.collect.limitS);
      leftMs = run ? Math.max(0, run.deadline - now) : limitMs;
    }
    const msg: TrialMsg = { id: def.id, kind, state, progress: m?.progress ?? 0, goal: missionGoal(def), leftMs, limitMs, next, ...(reason ? { reason } : {}) };
    a.client.send("trial", msg);
  }

  // ---------------------------------------------------------------- lifecycle hooks

  /** On join: an attempt that a disconnect cut short is gone (its clock can't be trusted). */
  onJoin(a: PlayerActor) {
    for (const m of a.char.missions) {
      const def = MISSION_BY_ID.get(m.id);
      if (!def || m.done) continue;
      if (def.race || def.defend) m.progress = 0;
      // A timed collect restarts too (else leaving would stop its clock); untimed pieces are kept.
      if (def.collect?.limitS && m.progress > 0) {
        m.progress = 0;
        m.counts = def.collect.pieces.map(() => 0);
      }
    }
  }

  onLeave(sessionId: string) {
    const run = this.runs.get(sessionId);
    if (run) this.dissolveWaves(run);
    this.runs.delete(sessionId);
    this.lastPos.delete(sessionId);
    this.dropped.delete(sessionId);
  }

  /**
   * The socket dropped: the body waits out the reconnection window, but the attempt ends now (its
   * clock can't run for someone who isn't there, D-hunt-3): waves dissolve, progress resets as on a
   * failure, and the reconnect hears `idle` (reason "dropped"). Nothing ticks while the body lingers.
   */
  onDrop(a: PlayerActor) {
    this.lastPos.delete(a.id);
    const run = this.runs.get(a.id);
    if (!run) return;
    this.reset(a, run);
    this.dropped.set(a.id, run.id);
  }

  /** Back on the same body: say the attempt the drop ended is gone (the HUD clears its clock). */
  onReconnect(a: PlayerActor) {
    const id = this.dropped.get(a.id);
    this.dropped.delete(a.id);
    const def = id ? MISSION_BY_ID.get(id) : undefined;
    if (def) this.send(a, def, a.char.missions.find((x) => x.id === id && !x.done), "idle", "dropped");
  }

  /** Death ends any attempt (the mission stays accepted until the rebirth clears it). */
  onDeath(a: PlayerActor) {
    this.fail(a, "died");
  }

  /** Abandoning the mission ends its attempt quietly. */
  onAbandon(a: PlayerActor, id: string) {
    const run = this.runs.get(a.id);
    if (!run || run.id !== id) return;
    this.end(a, run);
    const def = MISSION_BY_ID.get(id);
    if (def) this.send(a, def, undefined, "idle", "abandoned");
  }

  dispose() {
    for (const run of this.runs.values()) this.dissolveWaves(run);
    this.runs.clear();
  }

  // ---------------------------------------------------------------- tick

  tickPlayer(a: PlayerActor, now: number) {
    // A dropped or lingering body runs no trial: it can't start a race standing in ring 1 or take a shard.
    if (a.state.flags & PF.LINGER) return;
    const p = actorPos(a);
    const prev = this.lastPos.get(a.id) ?? p;
    this.lastPos.set(a.id, [p[0], p[1], p[2]]);
    for (const { m, def } of this.q.activeMissions(a)) {
      if (def.race) this.tickRace(a, m, def, prev, p, now);
      else if (def.collect) this.tickCollect(a, m, def, p, now);
      else if (def.defend) this.tickDefend(a, m, def, p, now);
      if (a.dead) return;
    }
  }

  private ringAt(id: string): V3 {
    const g = this.q.pos(id);
    const l = Math.hypot(g[0], g[1], g[2]);
    const k = (l + TRIAL_RULES.RING_LIFT) / l;
    return [g[0] * k, g[1] * k, g[2] * k];
  }

  /** Did the feet move through (or stand in) the ring at `c` between `a` and `b`? */
  private passes(c: V3, a: V3, b: V3, radius: number): boolean {
    // Feet are about RING_LIFT below the ring's centre when running through it: compare at chest height.
    const lift = (v: V3): V3 => {
      const l = Math.hypot(v[0], v[1], v[2]) || 1;
      const k = (l + TRIAL_RULES.RING_LIFT) / l;
      return [v[0] * k, v[1] * k, v[2] * k];
    };
    const A = lift(a);
    const B = lift(b);
    const d: V3 = [B[0] - A[0], B[1] - A[1], B[2] - A[2]];
    const dd = d[0] * d[0] + d[1] * d[1] + d[2] * d[2];
    let t = dd > 1e-9 ? ((c[0] - A[0]) * d[0] + (c[1] - A[1]) * d[1] + (c[2] - A[2]) * d[2]) / dd : 0;
    t = Math.max(0, Math.min(1, t));
    const x = A[0] + d[0] * t - c[0];
    const y = A[1] + d[1] * t - c[1];
    const z = A[2] + d[2] * t - c[2];
    return Math.hypot(x, y, z) <= radius;
  }

  private tickRace(a: PlayerActor, m: Mission, def: MissionDef, prev: V3, p: V3, now: number) {
    const race = def.race!;
    let run = this.runs.get(a.id);
    if (run && run.id !== def.id) return; // one attempt at a time
    if (run && now > run.deadline) {
      this.fail(a, "time");
      run = undefined;
    }
    if (!run) {
      // Passing the first ring starts the clock (again, after a failure).
      if (!this.passes(this.ringAt(race.rings[0]!), prev, p, race.radius)) return;
      if (this.runs.has(a.id)) return;
      run = this.newRun(def, "race", now);
      run.deadline = now + this.scaled(race.limitS);
      run.next = 1;
      this.runs.set(a.id, run);
      m.progress = 1;
      a.youDirty = true;
      this.q.toast(a, `${def.name}: the clock is running — ${race.rings.length - 1} rings to go`, "info");
      this.send(a, def, m, "running");
      return;
    }
    // Several rings can fall in one tick at a gallop; each needs its own pass.
    let moved = false;
    while (run.next < race.rings.length && this.passes(this.ringAt(race.rings[run.next]!), prev, p, race.radius)) {
      run.next++;
      moved = true;
    }
    if (!moved) return;
    m.progress = run.next;
    a.youDirty = true;
    if (run.next >= race.rings.length) {
      this.end(a, run);
      this.send(a, def, m, "done");
      this.q.completeMission(a, m, def);
      return;
    }
    this.send(a, def, m, "running");
  }

  private tickCollect(a: PlayerActor, m: Mission, def: MissionDef, p: V3, now: number) {
    const c = def.collect!;
    let run = this.runs.get(a.id);
    if (run && run.id !== def.id) {
      if (c.limitS) return; // a timed collect waits for the other attempt to end
      run = undefined;
    }
    if (run && c.limitS && now > run.deadline) {
      this.fail(a, "time");
      return; // a shard underfoot starts the next attempt on a later tick
    }
    const counts = (m.counts ??= c.pieces.map(() => 0));
    let got = 0;
    for (let i = 0; i < c.pieces.length; i++) {
      if (counts[i]) continue;
      if (!inReach(this.q.pos(c.pieces[i]!), p, c.radius, 0.5)) continue;
      if (c.limitS && !run && this.runs.has(a.id)) continue; // another attempt holds the clock
      counts[i] = 1;
      got++;
    }
    if (!got) return;
    m.progress = counts.reduce((s, v) => s + (v ? 1 : 0), 0);
    a.youDirty = true;
    if (c.limitS && !run) {
      run = this.newRun(def, "collect", now);
      run.deadline = now + this.scaled(c.limitS);
      this.runs.set(a.id, run);
      this.q.toast(a, `${def.name}: the clock is running — ${m.progress} of ${c.pieces.length} ${c.itemName}`, "info");
    }
    if (m.progress >= c.pieces.length) {
      if (run) this.end(a, run);
      this.send(a, def, m, "done");
      this.q.completeMission(a, m, def);
      return;
    }
    if (!c.limitS) this.q.toast(a, `${def.name}: ${m.progress} of ${c.pieces.length} ${c.itemName}`, "info");
    this.send(a, def, m, "running");
  }

  // ---------------------------------------------------------------- defend

  /** E on a beacon: light it and start holding (one attempt at a time; the mission must be open). */
  interact(a: PlayerActor, objectId: string): boolean {
    for (const { m, def } of this.q.activeMissions(a)) {
      if (def.defend?.beacon !== objectId) continue;
      const run = this.runs.get(a.id);
      if (run?.id === def.id) {
        this.q.toast(a, "The beacon is already lit. Stay in its ring!", "info");
        return true;
      }
      if (run) {
        this.q.toast(a, "Finish the trial you're on first", "warn");
        return true;
      }
      const now = Date.now();
      const r = this.newRun(def, "defend", now);
      this.runs.set(a.id, r);
      m.progress = 0;
      a.youDirty = true;
      this.q.toast(a, `${def.name}: the beacon is lit — hold its ring for ${def.defend.holdS} s`, "info");
      this.send(a, def, m, "running");
      return true;
    }
    return false;
  }

  private tickDefend(a: PlayerActor, m: Mission, def: MissionDef, p: V3, now: number) {
    const d = def.defend!;
    const run = this.runs.get(a.id);
    if (!run || run.id !== def.id) return;
    const dt = Math.max(0, now - run.lastAt);
    run.lastAt = now;
    const inside = inReach(this.q.pos(d.beacon), p, d.radius, 0);
    if (!inside) {
      if (!run.outsideSince) {
        run.outsideSince = now;
        run.paused = true;
        this.q.toast(a, `Back to the beacon! The clock waits ${Math.round(this.scaled(d.graceS) / 1000)} s`, "warn");
        this.send(a, def, m, "paused");
      } else if (now - run.outsideSince > this.scaled(d.graceS)) {
        this.fail(a, "left");
      }
      return;
    }
    if (run.outsideSince) {
      run.outsideSince = 0;
      run.paused = false;
      this.send(a, def, m, "running");
    }
    run.heldMs += dt;
    while (run.waves < d.waves.length && run.heldMs >= this.scaled(d.waves[run.waves]!.atS)) this.raiseWave(a, run, d.waves[run.waves++]!, d.level, now);
    const held = Math.min(d.holdS, Math.floor(run.heldMs / Math.max(1, this.scaled(1))));
    if (held !== m.progress) {
      m.progress = held;
      a.youDirty = true;
    }
    if (run.heldMs >= this.scaled(d.holdS)) {
      m.progress = d.holdS;
      this.end(a, run);
      this.send(a, def, m, "done");
      this.q.completeMission(a, m, def);
    }
  }

  private raiseWave(a: PlayerActor, run: Run, w: { npcKind: string; count: number }, level: number, now: number) {
    const npcs = npcSystemOf(this.q.room);
    const idx = NPC_INDEX.get(w.npcKind);
    if (!npcs || idx === undefined || !NPC_DEFS[idx]) return;
    const room = Math.max(0, TRIAL_RULES.MAX_WAVE_NPCS - npcs.spawnedCount("trial"));
    const count = Math.min(w.count, room);
    const p = actorPos(a);
    const def = MISSION_BY_ID.get(run.id)!;
    const ttlMs = this.scaled(def.defend!.holdS) + this.scaled(def.defend!.graceS) + TRIAL_RULES.WAVE_TTL_EXTRA_MS;
    const phase = (run.waves * 1.7) % (Math.PI * 2);
    for (let i = 0; i < count; i++) {
      const ang = phase + (i / Math.max(1, count)) * Math.PI * 2;
      const at = this.q.room.snapToGround(this.q.around(p, Math.cos(ang) * TRIAL_RULES.WAVE_DIST_M, Math.sin(ang) * TRIAL_RULES.WAVE_DIST_M));
      const n = npcs.createNpc(idx, level, at, now, { roam: 12, spawned: { reason: "trial", key: run.id, userId: a.identity.userId }, ttlMs });
      run.npcIds.push(n.id);
    }
  }

  // ---------------------------------------------------------------- endings

  private newRun(def: MissionDef, kind: Kind, now: number): Run {
    return { id: def.id, kind, startedAt: now, deadline: 0, next: 0, heldMs: 0, outsideSince: 0, waves: 0, npcIds: [], lastAt: now, paused: false };
  }

  private dissolveWaves(run: Run) {
    const npcs = npcSystemOf(this.q.room);
    if (!npcs) return;
    const now = Date.now();
    for (const id of run.npcIds) {
      const n = npcs.npcs.get(id);
      if (n) npcs.dissolve(n, now);
    }
    run.npcIds.length = 0;
  }

  private end(a: PlayerActor, run: Run) {
    this.dissolveWaves(run);
    if (this.runs.get(a.id) === run) this.runs.delete(a.id);
  }

  /** End an attempt without a word: waves dissolve, progress back to 0 (timed collects drop their pieces). */
  private reset(a: PlayerActor, run: Run): { def: MissionDef | undefined; m: Mission | undefined } {
    this.end(a, run);
    const def = MISSION_BY_ID.get(run.id);
    const m = a.char.missions.find((x) => x.id === run.id && !x.done);
    if (def && m) {
      m.progress = 0;
      if (def.collect) m.counts = def.collect.pieces.map(() => 0);
      a.youDirty = true;
    }
    return { def, m };
  }

  /** End the player's attempt as failed: progress back to 0 (timed collects drop their pieces). */
  fail(a: PlayerActor, reason: "time" | "died" | "left") {
    const run = this.runs.get(a.id);
    if (!run) return;
    const { def, m } = this.reset(a, run);
    if (!def) return;
    const again = def.race ? "pass the first ring to try again" : def.defend ? "light the beacon to try again" : "gather the first shard to start again";
    const why = reason === "time" ? "out of time" : reason === "died" ? "you fell" : "you left the beacon's ring";
    if (reason !== "died") this.q.toast(a, `${def.name} failed: ${why} — ${again}`, "warn");
    this.send(a, def, m, "failed", reason);
  }
}
