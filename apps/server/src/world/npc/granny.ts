// Granny Gust (#2): a roaming mini-boss on Hollowmere who outruns a sprinting player. She potters
// about the fen until someone comes within GRANNY.sight, then chases them at her runSpeed (faster than
// any sprint), says something cheeky, and dashes: the Gale Dash is a charge (the attack system runs it
// and shows its red line during the tell). After GRANNY.dashesBeforeRest dashes she sits down winded
// and takes GRANNY.windedDamage× damage; otherwise her shawl turns most of it (GRANNY.armour). Keep
// alive for GRANNY.surviveSeconds of one chase and she gives up on you (medal "Not Today, Nana");
// beat her for "Grounded". Her lines go out as `npcSay` subtitles near her.

import { GRANNY, GRANNY_LINES, NF, NPC_ANIM } from "@firstlight/shared/content/npcs";
import { actorPos, type PlayerActor } from "../actors.ts";
import { holdRegen } from "../combat.ts";
import { startAttack } from "./attacks.ts";
import { moveDir } from "./brain.ts";
import type { NpcSystem } from "./NpcSystem.ts";
import { MODE, type Npc } from "./npc.ts";
import { emitNpcEvent } from "./tuning.ts";
import { add, dist, dot, flatDist, rotateAboutUp, stableTangentAt, tangentDir } from "./vec.ts";

export const GRANNY_ID = "granny_gust";

type Phase = "roam" | "chase" | "winded";

interface GrannyState {
  phase: Phase;
  target: PlayerActor | null;
  chaseStart: number;
  /** When the target was last within reach (for giving up). */
  seenAt: number;
  dashes: number;
  /** A dash is under way (started by us): count it when the attack ends. */
  dashing: boolean;
  /** The target's HP when the dash started (did it land?). */
  hpAtDash: number;
  until: number;
  /** Account → until when she leaves them be (she gave up on them). */
  ignore: Map<string, number>;
  lastLine: number;
  lineNo: number;
  goal: [number, number, number] | null;
  nextLook: number;
}

const states = new WeakMap<Npc, GrannyState>();

function stateOf(n: Npc): GrannyState {
  let s = states.get(n);
  if (!s) {
    s = { phase: "roam", target: null, chaseStart: 0, seenAt: 0, dashes: 0, dashing: false, hpAtDash: 0, until: 0, ignore: new Map(), lastLine: 0, lineNo: 0, goal: null, nextLook: 0 };
    states.set(n, s);
  }
  return s;
}

/** The phase she is in (tests, the admin readout). */
export function grannyPhase(n: Npc): Phase {
  return stateOf(n).phase;
}

/** Damage she takes: most of it turned by her shawl, extra while she's winded. */
export function grannyArmour(n: Npc): number {
  return stateOf(n).phase === "winded" ? GRANNY.windedDamage : GRANNY.armour;
}

/** Say a line of hers near her (a subtitle for whoever is within 60 m). At most one every 2.5 s, unless `force`. */
export function grannySay(sys: NpcSystem, n: Npc, key: keyof typeof GRANNY_LINES, now: number, force = false) {
  const s = stateOf(n);
  if (!force && now - s.lastLine < 2500) return;
  s.lastLine = now;
  const lines = GRANNY_LINES[key];
  const line = lines[s.lineNo++ % lines.length]!;
  sys.world.host.broadcastNear("npcSay", { id: n.id, name: n.def.name, line }, n.pos, 60);
}

function valid(sys: NpcSystem, n: Npc, p: PlayerActor | null): p is PlayerActor {
  if (!p || p.dead || !sys.isLive(p) || !sys.mayEngage(n, p)) return false;
  const l = sys.live.find((x) => x.a === p);
  return !!l && !l.untouchable;
}

function engage(sys: NpcSystem, n: Npc, s: GrannyState, p: PlayerActor, now: number) {
  s.phase = "chase";
  s.target = p;
  s.chaseStart = now;
  s.seenAt = now;
  s.dashes = 0;
  n.target = p;
  n.state.target = p.id;
  n.state.flags |= NF.AGGRO;
  sys.setMode(n, MODE.CHASE, now);
  grannySay(sys, n, "spot", now, true);
}

function release(sys: NpcSystem, n: Npc, s: GrannyState, now: number) {
  s.phase = "roam";
  s.target = null;
  s.dashing = false;
  s.goal = null;
  n.target = null;
  n.state.target = "";
  n.state.flags &= ~(NF.AGGRO | NF.STUNNED | NF.WEAK_OPEN);
  sys.setMode(n, MODE.IDLE, now, now + 1500);
}

export function grannyThink(sys: NpcSystem, n: Npc, now: number, dt: number) {
  const s = stateOf(n);
  // A dash we started has ended (the attack system ran it): count it, and gloat if it landed.
  if (s.dashing && !n.attack) {
    s.dashing = false;
    s.dashes++;
    if (s.target && s.target.state.hp < s.hpAtDash) grannySay(sys, n, "hit", now);
    if (s.dashes >= GRANNY.dashesBeforeRest) {
      s.phase = "winded";
      s.until = now + GRANNY.windedSeconds * 1000;
      s.dashes = 0;
      n.state.flags |= NF.STUNNED | NF.WEAK_OPEN;
      sys.setAnim(n, NPC_ANIM.KNEEL);
      grannySay(sys, n, "winded", now, true);
      return;
    }
  }
  if (s.phase === "winded") {
    sys.setAnim(n, NPC_ANIM.KNEEL);
    if (s.target) holdRegen(s.target, "miniboss", now);
    if (now < s.until) return;
    n.state.flags &= ~(NF.STUNNED | NF.WEAK_OPEN);
    s.phase = valid(sys, n, s.target) ? "chase" : "roam";
    if (s.phase === "roam") release(sys, n, s, now);
    return;
  }
  if (s.phase === "roam") return roam(sys, n, s, now, dt);
  return chase(sys, n, s, now, dt);
}

function roam(sys: NpcSystem, n: Npc, s: GrannyState, now: number, dt: number) {
  // Struck while pottering about (onNpcHurt's aggro set n.target): she turns on whoever did it.
  if (n.target && n.target.kind === "player" && valid(sys, n, n.target as PlayerActor)) return engage(sys, n, s, n.target as PlayerActor, now);
  if (now >= s.nextLook) {
    s.nextLook = now + 300;
    let best: PlayerActor | null = null;
    let bd: number = GRANNY.sight;
    for (const l of sys.live) {
      if (l.untouchable || !sys.mayEngage(n, l.a)) continue;
      if ((s.ignore.get(l.a.identity.userId) ?? 0) > now) continue;
      const d = dist(n.pos, l.pos);
      if (d < bd) {
        bd = d;
        best = l.a;
      }
    }
    if (best) return engage(sys, n, s, best, now);
  }
  // Potter about her patch of fen, a little quicker than a walk.
  if (!s.goal || flatDist(n.pos, s.goal) < 1.5 || now > s.until) {
    const t = rotateAboutUp(n.home, stableTangentAt(n.home), Math.random() * 360);
    s.goal = add(n.home, t, Math.random() * n.roam);
    s.until = now + 20_000;
  }
  const dir = tangentDir(n.pos, s.goal);
  if (dot(dir, dir) > 0.5 && !moveDir(sys, n, dir, GRANNY.roamSpeed, dt, NPC_ANIM.WALK)) s.goal = null;
  else n.facing = dir;
}

function chase(sys: NpcSystem, n: Npc, s: GrannyState, now: number, dt: number) {
  const p = s.target;
  if (!p || p.dead) {
    if (p?.dead) grannySay(sys, n, "won", now, true);
    return release(sys, n, s, now);
  }
  const tp = actorPos(p);
  const d = dist(n.pos, tp);
  if (valid(sys, n, p) && d <= GRANNY.loseAt) s.seenAt = now;
  if (now - s.seenAt > GRANNY.loseSeconds * 1000) return release(sys, n, s, now);
  holdRegen(p, "miniboss", now);
  // Kept alive through a whole chase: she gives up on you (the medal) and leaves you be a while.
  if (now - s.chaseStart >= GRANNY.surviveSeconds * 1000) {
    grannySay(sys, n, "gaveUp", now, true);
    s.ignore.set(p.identity.userId, now + GRANNY.ignoreSeconds * 1000);
    emitNpcEvent({ kind: "granny", body: sys.world.body.id, outcome: "outran", sessionIds: [p.id], userIds: [p.identity.userId] });
    return release(sys, n, s, now);
  }
  if (!valid(sys, n, p)) {
    sys.setAnim(n, NPC_ANIM.IDLE); // on a pad's safe ring: she waits for you to step off
    return;
  }
  const dash = n.def.attacks[0]!, rap = n.def.attacks[1]!;
  if (d <= rap.range! + 0.3 && now >= n.cooldowns[1]!) {
    startAttack(sys, n, 1, p, now);
    return;
  }
  if (d >= (dash.minRange ?? 0) && d <= dash.range! && now >= n.cooldowns[0]!) {
    // The tell: a line, then the attack's own wind-up (the red line on the ground) before the dash.
    grannySay(sys, n, "tell", now);
    s.dashing = true;
    s.hpAtDash = p.state.hp;
    startAttack(sys, n, 0, p, now);
    return;
  }
  const dir = tangentDir(n.pos, tp);
  if (dot(dir, dir) < 0.5) return;
  n.facing = dir;
  moveDir(sys, n, dir, n.def.runSpeed, dt, NPC_ANIM.RUN);
}
