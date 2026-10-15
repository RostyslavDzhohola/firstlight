// Onboarding on Portus (SPEC §6.12, content.md §1.1, shared/content/onboarding.ts): offered once per
// account to a brand-new character (level 1, never died). The client teaches move, look, jump,
// sprint and dodge on its own (nothing is paid for those); the server counts hits on the three
// training dummies from `train` messages (Portus town is a safe zone, so real attacks are refused there),
// pays 10 XP per dummy and, when all three are down, 20 XP and the Spark medal. Skipping ends it with
// nothing more paid. Progress lives in account stats, so it survives reconnects and never repeats.
// Every payout (the dummy's flag, the completion flag, the character's XP, the medal) commits in one
// transaction (D26); the player hears about it only after the commit.

import type { Client } from "@colyseus/core";
import { dummyPos, dummyStat, ONBOARDING, TRAINING_DUMMIES } from "@firstlight/shared/content/onboarding";
import type { YouState } from "@firstlight/shared/net/protocol";
import { z } from "zod";
import { actorPos, type PlayerActor } from "./actors.ts";
import type { BodyRoom } from "./BodyRoom.ts";
import { aimOrigin, ORIGIN_SLACK, selectedWeapon } from "./combat.ts";
import { emitGameEvent } from "./events.ts";
import { dist3, inMeleeArc, rayCapsule, type V3 } from "./geometry.ts";
import { QuestSystem } from "./quests/QuestSystem.ts";
import { progressStore } from "./quests/store.ts";
import type { RoomSystem } from "./systems.ts";

export const ONBOARDING_RULES = {
  /** Extra reach for training swings (the dummy's own radius plus a little forgiveness). */
  MELEE_SLACK_M: 0.8,
  /** Extra degrees on each side of the weapon's melee arc. */
  MELEE_ARC_SLACK: 30,
  /** Ranged: the camera sits behind the head, so the ray may be this much longer than the weapon's range. */
  RAY_SLACK_M: 8,
  /** Never count hits faster than this, whatever the weapon. */
  MIN_GAP_MS: 200,
  /** Drop trainees whose session is gone (leave hooks may not run, e.g. on a takeover). */
  PRUNE_MS: 1000,
};

const SPARK = "spark";

const vec = z.number().finite();
const trainSchema = z.object({ ox: vec, oy: vec, oz: vec, dx: vec, dy: vec, dz: vec });

export interface Trainee {
  /** The session training now (a takeover from another window replaces it). */
  sessionId: string;
  hits: number[];
  lastAt: number;
}

export class OnboardingSystem implements RoomSystem {
  private readonly room: BodyRoom;
  private readonly dummies: V3[];
  /** By account (user id), so a second window replaces the entry instead of adding one. */
  readonly trainees = new Map<string, Trainee>();
  private lastPrune = 0;

  constructor(room: BodyRoom) {
    this.room = room;
    const t = room.terrain;
    this.dummies = TRAINING_DUMMIES.map((_, i) => dummyPos(i, (x, y, z) => t.groundHeight(x, y, z)));
    room.onMessage("train", trainSchema, (c, m) => this.train(c, m));
    room.onMessage("onboarding", z.object({ action: z.literal("skip") }), (c) => this.skip(c));
  }

  /** Idempotent cleanup: forget trainees whose session no longer has a live actor here. */
  tick(_dtMs: number, now: number) {
    if (now - this.lastPrune < ONBOARDING_RULES.PRUNE_MS) return;
    this.lastPrune = now;
    for (const [uid, t] of this.trainees) if (!this.room.actors.has(t.sessionId)) this.trainees.delete(uid);
  }

  onPlayerJoin(sessionId: string) {
    const a = this.room.playerById(sessionId);
    if (!a) return;
    const uid = a.identity.userId;
    this.trainees.delete(uid);
    if (!this.eligible(a)) return;
    const hits = this.dummies.map((_, i) => (progressStore.current.stat(uid, dummyStat(i)) > 0 ? ONBOARDING.HITS_PER_DUMMY : 0));
    const t: Trainee = { sessionId, hits, lastAt: 0 };
    this.trainees.set(uid, t);
    if (this.allDown(t)) this.complete(a, t); // paid every dummy, then the process stopped before the end
    a.youDirty = true;
  }

  /** Safe to call more than once, and late: only the entry of that very session goes. */
  onPlayerLeave(sessionId: string) {
    for (const [uid, t] of this.trainees) if (t.sessionId === sessionId) this.trainees.delete(uid);
  }

  /** The trainee entry of this live actor (not of an older window of the same account). */
  private trainee(a: PlayerActor): Trainee | undefined {
    const t = this.trainees.get(a.identity.userId);
    return t && t.sessionId === a.id ? t : undefined;
  }

  decorateYou(a: PlayerActor, you: YouState) {
    const t = this.trainee(a);
    if (t) you.onboarding = { hits: [...t.hits] };
  }

  /** A brand-new character on an account that hasn't finished (or skipped) onboarding. */
  private eligible(a: PlayerActor): boolean {
    if (a.identity.loadtest || a.dead || a.char.level !== 1 || a.char.deaths > 0) return false;
    return progressStore.current.stat(a.identity.userId, ONBOARDING.STAT) === 0;
  }

  private allDown(t: Trainee): boolean {
    return t.hits.every((h) => h >= ONBOARDING.HITS_PER_DUMMY);
  }

  private paid(t: Trainee, done: boolean): number {
    return t.hits.filter((h) => h >= ONBOARDING.HITS_PER_DUMMY).length * ONBOARDING.DUMMY_XP + (done ? ONBOARDING.DONE_XP : 0);
  }

  /** A training attack: which dummy (if any) does the held weapon reach from where we stand? */
  train(c: Client, m: z.infer<typeof trainSchema>) {
    const a = this.room.playerById(c.sessionId);
    const t = a ? this.trainee(a) : undefined;
    if (!a || !t || a.dead || a.superseded) return;
    const { def, tier } = selectedWeapon(a);
    if (def.delivery === "heal" || def.delivery === "bubble" || def.delivery === "none" || tier.level > a.char.level) return;
    const now = Date.now();
    if (now - t.lastAt < Math.max(ONBOARDING_RULES.MIN_GAP_MS, tier.rate * 1000 * 0.85)) return;
    // Knocked-down dummies take no more hits while one still stands (a swing or a shot at a standing
    // dummy used to land on a nearer or nearer-along-the-ray down one, e2e); with all down they do,
    // so a failed completion can be retried.
    const all = this.allDown(t);
    const open = (i: number) => all || t.hits[i]! < ONBOARDING.HITS_PER_DUMMY;
    const i = def.delivery === "melee" ? this.meleeTarget(a, m, def.range, def.arc ?? 90, open) : this.rayTarget(a, m, def.falloffTo ?? def.range, open);
    if (i < 0) return;
    t.lastAt = now;
    const was = t.hits[i]!;
    t.hits[i] = Math.min(ONBOARDING.HITS_PER_DUMMY, was + 1);
    a.youDirty = true;
    if (t.hits[i]! < ONBOARDING.HITS_PER_DUMMY || was >= ONBOARDING.HITS_PER_DUMMY) {
      c.send("train", { dummy: i, hits: t.hits[i], down: t.hits[i]! >= ONBOARDING.HITS_PER_DUMMY });
      if (was >= ONBOARDING.HITS_PER_DUMMY && this.allDown(t)) this.complete(a, t); // retry a failed completion
      return;
    }
    // This hit knocks the dummy down: pay it (and the completion, if it was the last) or undo the hit.
    const done = this.allDown(t);
    const r = this.payout(a, i, done);
    if (!r) {
      t.hits[i] = was;
      c.send("train", { dummy: i, hits: was, down: false });
      return;
    }
    // Committed. A finished trainee is retired before anything that could still go wrong.
    if (done) this.retire(a, t);
    r.show();
    c.send("train", { dummy: i, hits: t.hits[i], down: true });
    if (r.dummyXp) c.send("toast", { text: `Training dummy down · +${r.dummyXp} XP`, kind: "xp" });
    if (done) this.ended(a, t, "done");
  }

  /**
   * Pay a knocked-down dummy and/or the completion. Each pays on its first durable transition only
   * (its flag goes from 0 to 1 inside the transaction), so a retry after a committed payout pays
   * nothing (F12 final B2). The flags, the character's XP and level, and the Spark medal commit in
   * one transaction; nothing here saves again. Returns null when the transaction fails (nothing
   * persisted, nothing sent), else the amounts and `show`, which runs after the commit: level-up
   * effects and the medal's messages.
   */
  private payout(a: PlayerActor, dummy: number | null, done: boolean): { dummyXp: number; doneXp: number; show: () => void } | null {
    const uid = a.identity.userId;
    const store = progressStore.current;
    const quests = this.room.systems.find((s): s is QuestSystem => s instanceof QuestSystem);
    const notify: (() => void)[] = [];
    let dummyXp = 0;
    let doneXp = 0;
    try {
      this.room.persist([a], () => {
        if (dummy !== null && store.addStat(uid, dummyStat(dummy), 1) === 1) dummyXp = ONBOARDING.DUMMY_XP;
        if (done && store.stat(uid, ONBOARDING.STAT) === 0) {
          store.addStat(uid, ONBOARDING.STAT, 1);
          doneXp = ONBOARDING.DONE_XP;
          if (quests) quests.award(a, SPARK, notify);
          else store.awardMedal(uid, SPARK);
        }
        notify.unshift(this.room.addXp(a, dummyXp + doneXp));
        this.room.saveActor(a);
      });
    } catch (err) {
      console.error(`[onboarding] payout for ${uid} rolled back:`, err);
      return null;
    }
    return {
      dummyXp,
      doneXp,
      show: () => {
        for (const f of notify) f();
      },
    };
  }

  /** Every dummy is down: pay the completion (from a join after an interrupted finish, or a retry). */
  private complete(a: PlayerActor, t: Trainee) {
    const r = this.payout(a, null, true);
    if (!r) return;
    this.retire(a, t);
    r.show();
    this.ended(a, t, "done");
  }

  /** Forget a trainee (only if it is still this one). */
  private retire(a: PlayerActor, t: Trainee) {
    if (this.trainees.get(a.identity.userId) === t) this.trainees.delete(a.identity.userId);
  }

  /** Nearest open dummy inside the melee reach, judged by the body's facing or the camera's aim. */
  private meleeTarget(a: PlayerActor, m: z.infer<typeof trainSchema>, range: number, arcDeg: number, open: (i: number) => boolean): number {
    const pos = actorPos(a);
    const facing: V3 = [a.state.fx, a.state.fy, a.state.fz];
    // The camera ray flattened onto the ground plane (players aim with the mouse).
    const l = Math.hypot(pos[0], pos[1], pos[2]) || 1;
    const up: V3 = [pos[0] / l, pos[1] / l, pos[2] / l];
    const k = m.dx * up[0] + m.dy * up[1] + m.dz * up[2];
    const aim: V3 = [m.dx - k * up[0], m.dy - k * up[1], m.dz - k * up[2]];
    const reach = range + ONBOARDING_RULES.MELEE_SLACK_M;
    const arc = arcDeg + ONBOARDING_RULES.MELEE_ARC_SLACK * 2;
    let best = -1;
    let bestD = Infinity;
    const aimOk = Math.hypot(aim[0], aim[1], aim[2]) > 0.1;
    this.dummies.forEach((f, i) => {
      const d = dist3(pos, f);
      if (d >= bestD || !open(i)) return;
      if (inMeleeArc(pos, facing, f, reach, arc) || (aimOk && inMeleeArc(pos, aim, f, reach, arc))) {
        best = i;
        bestD = d;
      }
    });
    return best;
  }

  /** First open dummy along the aim ray, which must start near our head (like a real shot). */
  private rayTarget(a: PlayerActor, m: z.infer<typeof trainSchema>, range: number, open: (i: number) => boolean): number {
    const pos = actorPos(a);
    const l = Math.hypot(pos[0], pos[1], pos[2]) || 1;
    const head: V3 = [pos[0] + (pos[0] / l) * 1.6, pos[1] + (pos[1] / l) * 1.6, pos[2] + (pos[2] / l) * 1.6];
    const dl = Math.hypot(m.dx, m.dy, m.dz);
    if (!(dl > 0.5 && dl < 1.5)) return -1;
    const d: V3 = [m.dx / dl, m.dy / dl, m.dz / dl];
    const o = aimOrigin([m.ox, m.oy, m.oz], d, head); // a zoomed-out camera counts from the head too
    if (!(dist3(o, head) <= ORIGIN_SLACK)) return -1;
    let best = -1;
    let bestT = Infinity;
    this.dummies.forEach((f, i) => {
      if (!open(i)) return; // a down dummy lies flat: shots pass over it
      const hit = rayCapsule(o, d, range + ONBOARDING_RULES.RAY_SLACK_M, f, ONBOARDING.DUMMY_RADIUS, ONBOARDING.DUMMY_HEIGHT);
      if (hit && hit.t < bestT) {
        best = i;
        bestT = hit.t;
      }
    });
    return best;
  }

  /** Skip: finished for good; what the dummies already paid stays, nothing more. */
  skip(c: Client) {
    const a = this.room.playerById(c.sessionId);
    const t = a ? this.trainee(a) : undefined;
    if (!a || !t) return;
    progressStore.current.addStat(a.identity.userId, ONBOARDING.STAT, 1);
    this.ended(a, t, "skipped");
  }

  /** After the commit: forget the trainee and tell the player (and the bus, on completion). */
  private ended(a: PlayerActor, t: Trainee, state: "done" | "skipped") {
    this.retire(a, t);
    a.youDirty = true;
    // The quests system already holds the medal (no second award); other listeners still hear it.
    if (state === "done") emitGameEvent(this.room, { type: "onboardingDone", playerId: a.id });
    a.client.send("onboarding", { state, xp: this.paid(t, state === "done") });
  }
}

export function createOnboardingSystem(room: BodyRoom): RoomSystem | null {
  return room.bodyDef.id === ONBOARDING.BODY ? new OnboardingSystem(room) : null;
}
