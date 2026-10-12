// Onboarding on Portus (SPEC §6.12, content.md §1.1, shared/content/onboarding.ts): offered once per
// account to a brand-new character (level 1, never died). The client teaches move, look, jump,
// sprint and dodge on its own (nothing is paid for those); the server counts hits on the three
// training dummies from `train` messages (Portus is a safe zone, so real attacks are refused there),
// pays 10 XP per dummy and, when all three are down, 20 XP and the Spark medal (via the
// `onboardingDone` game event that the quests system turns into the medal). Skipping ends it with
// nothing more paid. Progress lives in account stats, so it survives reconnects and never repeats.

import type { Client } from "@colyseus/core";
import { dummyPos, dummyStat, ONBOARDING, TRAINING_DUMMIES } from "@firstlight/shared/content/onboarding";
import type { YouState } from "@firstlight/shared/net/protocol";
import { z } from "zod";
import { actorPos, type PlayerActor } from "./actors.ts";
import type { BodyRoom } from "./BodyRoom.ts";
import { ORIGIN_SLACK, selectedWeapon } from "./combat.ts";
import { emitGameEvent } from "./events.ts";
import { dist3, inMeleeArc, rayCapsule, type V3 } from "./geometry.ts";
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
};

const vec = z.number().finite();
const trainSchema = z.object({ ox: vec, oy: vec, oz: vec, dx: vec, dy: vec, dz: vec });

interface Trainee {
  hits: number[];
  lastAt: number;
}

export class OnboardingSystem implements RoomSystem {
  private readonly room: BodyRoom;
  private readonly dummies: V3[];
  private readonly trainees = new Map<string, Trainee>();

  constructor(room: BodyRoom) {
    this.room = room;
    const t = room.terrain;
    this.dummies = TRAINING_DUMMIES.map((_, i) => dummyPos(i, (x, y, z) => t.groundHeight(x, y, z)));
    room.onMessage("train", trainSchema, (c, m) => this.train(c, m));
    room.onMessage("onboarding", z.object({ action: z.literal("skip") }), (c) => this.skip(c));
  }

  tick() {}

  onPlayerJoin(sessionId: string) {
    const a = this.room.playerById(sessionId);
    if (!a || !this.eligible(a)) return;
    const uid = a.identity.userId;
    const hits = this.dummies.map((_, i) => (progressStore.current.stat(uid, dummyStat(i)) > 0 ? ONBOARDING.HITS_PER_DUMMY : 0));
    const t: Trainee = { hits, lastAt: 0 };
    this.trainees.set(sessionId, t);
    if (this.allDown(t)) this.finish(a, t);
    a.youDirty = true;
  }

  onPlayerLeave(sessionId: string) {
    this.trainees.delete(sessionId);
  }

  decorateYou(a: PlayerActor, you: YouState) {
    const t = this.trainees.get(a.id);
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
    const t = this.trainees.get(c.sessionId);
    if (!a || !t || a.dead) return;
    const { def, tier } = selectedWeapon(a);
    if (def.delivery === "heal" || def.delivery === "bubble" || def.delivery === "none" || tier.level > a.char.level) return;
    const now = Date.now();
    if (now - t.lastAt < Math.max(ONBOARDING_RULES.MIN_GAP_MS, tier.rate * 1000 * 0.85)) return;
    const i = def.delivery === "melee" ? this.meleeTarget(a, m, def.range, def.arc ?? 90) : this.rayTarget(a, m, def.falloffTo ?? def.range);
    if (i < 0) return;
    t.lastAt = now;
    const was = t.hits[i]!;
    t.hits[i] = Math.min(ONBOARDING.HITS_PER_DUMMY, was + 1);
    const down = t.hits[i]! >= ONBOARDING.HITS_PER_DUMMY;
    c.send("train", { dummy: i, hits: t.hits[i], down });
    a.youDirty = true;
    if (!down || was >= ONBOARDING.HITS_PER_DUMMY) return;
    if (progressStore.current.addStat(a.identity.userId, dummyStat(i), 1) === 1) {
      this.room.grantXp(a, ONBOARDING.DUMMY_XP);
      c.send("toast", { text: `Training dummy down · +${ONBOARDING.DUMMY_XP} XP`, kind: "xp" });
    }
    if (this.allDown(t)) this.finish(a, t);
    else this.room.saveActor(a);
  }

  /** Nearest dummy inside the melee reach, judged by the body's facing or the camera's aim. */
  private meleeTarget(a: PlayerActor, m: z.infer<typeof trainSchema>, range: number, arcDeg: number): number {
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
      if (d >= bestD) return;
      if (inMeleeArc(pos, facing, f, reach, arc) || (aimOk && inMeleeArc(pos, aim, f, reach, arc))) {
        best = i;
        bestD = d;
      }
    });
    return best;
  }

  /** First dummy along the aim ray, which must start near our head (like a real shot). */
  private rayTarget(a: PlayerActor, m: z.infer<typeof trainSchema>, range: number): number {
    const pos = actorPos(a);
    const l = Math.hypot(pos[0], pos[1], pos[2]) || 1;
    const head: V3 = [pos[0] + (pos[0] / l) * 1.6, pos[1] + (pos[1] / l) * 1.6, pos[2] + (pos[2] / l) * 1.6];
    const o: V3 = [m.ox, m.oy, m.oz];
    if (dist3(o, head) > ORIGIN_SLACK) return -1;
    const dl = Math.hypot(m.dx, m.dy, m.dz);
    if (!(dl > 0.5 && dl < 1.5)) return -1;
    const d: V3 = [m.dx / dl, m.dy / dl, m.dz / dl];
    let best = -1;
    let bestT = Infinity;
    this.dummies.forEach((f, i) => {
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
    const t = this.trainees.get(c.sessionId);
    if (!a || !t) return;
    this.trainees.delete(c.sessionId);
    progressStore.current.addStat(a.identity.userId, ONBOARDING.STAT, 1);
    a.youDirty = true;
    c.send("onboarding", { state: "skipped", xp: this.paid(t, false) });
  }

  private finish(a: PlayerActor, t: Trainee) {
    this.trainees.delete(a.id);
    progressStore.current.addStat(a.identity.userId, ONBOARDING.STAT, 1);
    this.room.grantXp(a, ONBOARDING.DONE_XP);
    this.room.saveActor(a);
    emitGameEvent(this.room, { type: "onboardingDone", playerId: a.id });
    a.youDirty = true;
    a.client.send("onboarding", { state: "done", xp: this.paid(t, true) });
  }
}

export function createOnboardingSystem(room: BodyRoom): RoomSystem | null {
  return room.bodyDef.id === ONBOARDING.BODY ? new OnboardingSystem(room) : null;
}
