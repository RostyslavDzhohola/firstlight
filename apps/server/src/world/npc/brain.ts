// The state machine of regular enemies, critters, wildlife and beasts (SPEC §6.4):
// idle → wander → notice (cone + hearing + gunfire noise) → chase → telegraphed attack → recover,
// with leash/evade (40 m from the anchor or 20 s out of sight: invulnerable, run home, heal fully),
// Woolbacks fleeing, Dusk Wolves howling and hunting as a pack, neutral beasts fighting back,
// Cantors raising Bonewalkers, and the two egg NPCs (Golden Hopbit E3, Ticket #000 E9).

import { NF, NPC_ANIM, NPC_INDEX, NPC_RULES } from "@firstlight/shared/content/npcs";
import { PF } from "@firstlight/shared/net/schema";
import { actorPos, type PlayerActor } from "../actors.ts";
import type { V3 } from "../geometry.ts";
import { cancelAttack, canSee, chest, groundOnly, isMelee, meleeHeightTol, startAttack, updateAttack } from "./attacks.ts";
import type { NpcSystem } from "./NpcSystem.ts";
import { MODE, type Npc } from "./npc.ts";
import { feetHeight, nearSafeRing, npcBody, slideAngle, step } from "./steer.ts";
import { NPC_TUNING, emitNpcEvent } from "./tuning.ts";
import { add, cross, dist, dot, flatDist, len, normalize, rotateAboutUp, stableTangentAt, sub, tangentDir, tangentize, up } from "./vec.ts";

/** A wander walk ends after this long even short of its goal (a building in the way, D44). */
const WANDER_MS = 30_000;
/** A walk home (RETURN) that hasn't arrived after this long puts the NPC home (D44). */
const RETURN_MS = 30_000;

export function think(sys: NpcSystem, n: Npc, now: number, dt: number) {
  if (n.dead) return;
  if (n.mode === MODE.SPAWN) {
    if (now >= n.modeUntil) {
      n.state.flags &= ~(NF.SPAWNING | NF.INVULN);
      sys.setMode(n, MODE.IDLE, now, now + 500);
      sys.setAnim(n, NPC_ANIM.IDLE);
    }
    return;
  }
  if (n.attack) {
    updateAttack(sys, n, now, dt);
    return;
  }
  if (n.def.id === "golden_hopbit") return golden(sys, n, now, dt);
  if (n.def.id === "ticket_000") return ticket(sys, n, now, dt);
  switch (n.mode) {
    case MODE.STUN:
      if (now >= n.modeUntil) {
        n.state.flags &= ~NF.STUNNED;
        resume(sys, n, now);
      }
      return;
    case MODE.RECOVER:
      if (now >= n.modeUntil) resume(sys, n, now);
      return;
    case MODE.NOTICE:
    case MODE.HOWL:
      faceTarget(n);
      if (now >= n.modeUntil) {
        sys.setMode(n, MODE.CHASE, now);
        sys.setAnim(n, NPC_ANIM.RUN);
      }
      return;
    case MODE.CHANNEL:
      faceTarget(n);
      if (now >= n.modeUntil) raise(sys, n, now);
      return;
    case MODE.EVADE:
      return evade(sys, n, now, dt);
    case MODE.FLEE:
      return flee(sys, n, now, dt);
    case MODE.RETURN:
      return goHome(sys, n, now, dt);
    case MODE.CHASE:
      return chase(sys, n, now, dt);
    default:
      return calm(sys, n, now, dt);
  }
}

// ------------------------------------------------------------------------------------ calm

function calm(sys: NpcSystem, n: Npc, now: number, dt: number) {
  const def = n.def;
  if (def.temper === "hostile" && now >= n.nextThink) {
    n.nextThink = now + 220 + Math.random() * 160;
    const p = perceive(sys, n, now);
    if (p) {
      aggro(sys, n, p, now, true);
      return;
    }
  }
  if (n.mode === MODE.WANDER && n.goal) {
    sys.setAnim(n, NPC_ANIM.WALK);
    // A walk a building holds up ends after WANDER_MS (D44); elsewhere goals are reached well before.
    if (moveTo(sys, n, n.goal, def.speed, dt) || now - n.modeAt > WANDER_MS) {
      n.goal = null;
      sys.setMode(n, MODE.IDLE, now, now + 2000 + Math.random() * 4000);
    }
    return;
  }
  sys.setAnim(n, def.family === "woolback" || def.family === "beast" ? NPC_ANIM.GRAZE : NPC_ANIM.IDLE);
  if (now >= n.modeUntil) {
    if (n.roam > 0 && Math.random() < 0.6) {
      const ang = Math.random() * 360;
      const r = Math.random() * n.roam;
      const t = rotateAboutUp(n.home, stableTangentAt(n.home), ang);
      const goal = add(n.home, t, r);
      // Never a goal inside a building (D44): it idles a little longer instead.
      if (sys.ground.structures && !sys.ground.structures.isClear({ x: goal[0], y: goal[1], z: goal[2] }, npcBody(n.radius, n.height))) {
        n.modeUntil = now + 2000 + Math.random() * 3000;
        return;
      }
      n.goal = goal;
      sys.setMode(n, MODE.WANDER, now);
    } else n.modeUntil = now + 2000 + Math.random() * 3000;
  }
}

/** Nearest player this NPC can see (cone + line of sight), hear, or heard shooting. */
function perceive(sys: NpcSystem, n: Npc, now: number): PlayerActor | null {
  const def = n.def;
  const reach = Math.max(def.sight, def.hearing);
  if (n.nearD > Math.max(reach, NPC_RULES.noiseRadius)) return null;
  const cosHalf = Math.cos(((def.fov / 2) * Math.PI) / 180);
  let best: PlayerActor | null = null;
  let bestD = Infinity;
  for (const lp of sys.live) {
    if (lp.untouchable) continue;
    const d = dist(n.pos, lp.pos);
    if (d > reach || d >= bestD) continue;
    if (d <= def.hearing) {
      best = lp.a;
      bestD = d;
      continue;
    }
    if (def.fov < 360 && dot(tangentDir(n.pos, lp.pos), n.facing) < cosHalf) continue;
    if (!canSee(sys, chest(n.pos, Math.min(n.height * 0.8, 2)), chest(lp.pos, 1.4))) continue;
    best = lp.a;
    bestD = d;
  }
  if (best) return best;
  for (const noise of sys.noises) {
    if (dist(noise.pos, n.pos) > NPC_RULES.noiseRadius) continue;
    if (noise.explosion && def.scatter) {
      scatter(sys, n, noise.pos, now);
      return null;
    }
    const p = noise.by ? sys.world.playerById(noise.by) : undefined;
    if (p && !p.dead && !(p.state.flags & PF.SAFE) && p.protectedUntil <= now) return p;
  }
  return null;
}

/** Take a target; pack mates within 15 m share it. Wolves howl first (1.5 s). */
export function aggro(sys: NpcSystem, n: Npc, p: PlayerActor, now: number, share: boolean) {
  if (n.dead || n.mode === MODE.EVADE) return;
  // Woken again by the target it already gave up on, still out of reach: give up again at once
  // (no howl, no fresh window for a pad shooter; F12 final Opus SF9).
  if (n.unreachBy?.id === p.id && now - n.unreachBy.since >= NPC_TUNING.unreachableMs) {
    const tp = actorPos(p);
    if (outOfReach(sys, n, tp, flatDist(n.pos, tp))) {
      startEvade(sys, n, now);
      return;
    }
  }
  const calmBefore = n.mode === MODE.IDLE || n.mode === MODE.WANDER || n.mode === MODE.RETURN || n.mode === MODE.FLEE;
  n.target = p;
  n.lastSeenAt = now;
  n.lastLosAt = now;
  n.unreachSince = n.unreachBy?.id === p.id ? n.unreachBy.since : undefined;
  n.state.flags |= NF.AGGRO;
  if (calmBefore) {
    n.anchor = n.roam > 30 ? [n.pos[0], n.pos[1], n.pos[2]] : n.home;
    if (n.def.howl && !n.howled) {
      n.howled = true;
      sys.setMode(n, MODE.HOWL, now, now + n.def.howl * 1000);
      sys.setAnim(n, NPC_ANIM.HOWL);
    } else {
      sys.setMode(n, MODE.NOTICE, now, now + 350);
      sys.setAnim(n, NPC_ANIM.IDLE);
    }
    if (n.def.bark) sys.sendNear(n.pos, 60, "npcBark", { id: n.id, text: n.def.bark });
  }
  if (!share) return;
  for (const m of sys.mates(n)) {
    if (m.target || m.def.temper === "critter" || m.def.temper === "passive") continue;
    if (dist(m.pos, n.pos) <= NPC_RULES.shareTargetRadius) aggro(sys, m, p, now, false);
  }
}

// ------------------------------------------------------------------------------------ combat

function chase(sys: NpcSystem, n: Npc, now: number, dt: number) {
  const def = n.def;
  const t = n.target;
  if (!t || t.dead || t.state.hp <= 0 || (t.state.flags & PF.SAFE) !== 0 || !sys.isLive(t)) {
    drop(sys, n, now);
    return;
  }
  const tp = actorPos(t);
  if (dist(n.pos, n.anchor) > NPC_TUNING.leash) {
    startEvade(sys, n, now);
    return;
  }
  const d = flatDist(n.pos, tp);
  if (d <= def.hearing) n.lastSeenAt = now;
  else if (now - n.lastLosAt > 500) {
    n.lastLosAt = now;
    if (canSee(sys, chest(n.pos, Math.min(n.height * 0.8, 2)), chest(tp, 1.4))) n.lastSeenAt = now;
  }
  if (now - n.lastSeenAt > NPC_TUNING.lostSightMs) {
    startEvade(sys, n, now);
    return;
  }
  // Can't reach (F12): a combat-tagged player on a pad ring keeps shooting while melee NPCs may not
  // step in. After unreachableMs the NPC evades home and heals, as for leash (content §3.1).
  if (outOfReach(sys, n, tp, d)) {
    n.unreachSince ??= now;
    if (now - n.unreachSince >= NPC_TUNING.unreachableMs) {
      n.unreachBy = { id: t.id, since: n.unreachSince };
      startEvade(sys, n, now);
      return;
    }
  } else {
    n.unreachSince = undefined;
    n.unreachBy = undefined;
  }
  // A structure between it and a target in melee reach (a lantern post, a wall corner): its strikes
  // would only hit the structure (attacks.ts hitAll), so it doesn't swing; it steps round instead.
  const blockedStrike = strikeBlocked(sys, n, tp, d);
  // Walled off (D44): it steers round buildings, but one that keeps it from getting closer (or from
  // a clear strike) for unreachableMs sends it home to heal, as an unreachable target does. Never
  // stuck at a wall.
  if (walledOff(sys, n, tp, d, now, blockedStrike)) {
    startEvade(sys, n, now);
    return;
  }
  if (def.fleeBelow && n.state.hp < n.state.maxHp * def.fleeBelow && sys.mates(n).length < 2) {
    startFlee(sys, n, tp, now, 6000);
    n.target = null;
    n.state.flags &= ~NF.AGGRO;
    return;
  }
  if (def.raise && now >= n.raiseNext) {
    n.raiseNext = now + def.raise.every * 1000;
    if (n.raised.size < def.raise.max) {
      sys.setMode(n, MODE.CHANNEL, now, now + def.raise.channel * 1000);
      sys.setAnim(n, NPC_ANIM.CHANNEL);
      sys.sendNear(n.pos, 120, "npcAtk", { id: n.id, a: def.attacks.length, sh: 14, ms: def.raise.channel * 1000, x: n.pos[0], y: n.pos[1], z: n.pos[2], dx: n.facing[0], dy: n.facing[1], dz: n.facing[2], r: 3, w: 0, l: 0, ang: 0, c: 4 });
      return;
    }
  }
  for (let i = 0; i < def.attacks.length; i++) {
    const a = def.attacks[i]!;
    if (now < n.cooldowns[i]! || d > a.range || d < (a.minRange ?? 0)) continue;
    if (a.back && dot(tangentDir(n.pos, tp), n.facing) > -0.2) continue;
    if (!isMelee(a) && now - n.lastSeenAt > 600) continue;
    if (blockedStrike && isMelee(a)) continue;
    if (!sys.acquireToken(n, t.id, !isMelee(a))) continue;
    startAttack(sys, n, i, t, now);
    return;
  }
  // Movement.
  const toward = tangentDir(n.pos, tp);
  if (dot(toward, toward) > 0.5 && !def.gridMove) n.facing = toward;
  const away: V3 = [-toward[0], -toward[1], -toward[2]];
  if (def.preferRange) {
    const [lo, hi] = def.preferRange;
    if (def.relocateWithin && d < def.relocateWithin) moveDir(sys, n, away, def.runSpeed, dt, NPC_ANIM.RUN);
    else if (d > hi) moveDir(sys, n, toward, def.runSpeed, dt, NPC_ANIM.RUN);
    else if (d < lo) moveDir(sys, n, away, def.speed, dt, NPC_ANIM.WALK);
    else {
      if (Math.random() < dt / 3) n.strafeSign = -n.strafeSign;
      const side = cross(up(n.pos), toward);
      moveDir(sys, n, [side[0] * n.strafeSign, side[1] * n.strafeSign, side[2] * n.strafeSign], def.speed * 0.6, dt, NPC_ANIM.WALK);
    }
    if (!def.gridMove) n.facing = toward;
    return;
  }
  const reach = meleeReach(n);
  const allCooling = def.attacks.every((a, i) => now < n.cooldowns[i]!);
  if (def.howl && allCooling && d < 10) {
    // Dusk Wolves circle at 6–8 m while their bites recharge, then dart in.
    const side = cross(up(n.pos), toward);
    const radial = d < 6 ? -1 : d > 8 ? 1 : 0;
    moveDir(sys, n, normalize(add(scaleV(side, n.strafeSign), toward, radial * 0.8)), def.runSpeed * 0.7, dt, NPC_ANIM.RUN);
    n.facing = toward;
    return;
  }
  if (d > reach * 0.8) moveDir(sys, n, toward, def.runSpeed, dt, NPC_ANIM.RUN);
  else if (blockedStrike) {
    // Step round the structure in the way, to the side it keeps for rounding structures.
    const side = cross(up(n.pos), toward);
    const k = n.slideSide;
    if (!moveDir(sys, n, normalize(add(scaleV(side, k), toward, 0.35)), def.speed, dt, NPC_ANIM.WALK)) n.slideSide = -k;
  } else sys.setAnim(n, NPC_ANIM.IDLE);
  if (!def.gridMove || d <= reach * 0.8) n.facing = toward;
}

/**
 * The target stands where this NPC can't follow — inside a pad's safe ring (plus the NPC's margin),
 * outside its medium, or perched higher above anywhere it could stand under the target than its
 * melee reaches (a pillar or wall top, with no attack that flies; F12 confirmation Opus SF1) — and
 * no attack reaches it from here: ranged ones, melee that strikes from where the NPC stands (arc,
 * ring, line) within its height tolerance, ground circles under a target near the ground. Charges and
 * leaps would have to move into the no-go zone; when one of them does connect, hitPlayer clears the
 * timer (contact).
 */
function outOfReach(sys: NpcSystem, n: Npc, tp: V3, d: number): boolean {
  const l = len(tp);
  const tol = meleeHeightTol(n);
  const under = feetHeight(sys.ground, tp[0] / l, tp[1] / l, tp[2] / l, n.def.locomotion, n.def.hover ?? 0);
  const perch = under === null ? 0 : l - (sys.ground.R + under);
  for (const a of n.def.attacks) {
    if (d > a.range || a.shape === "charge" || a.shape === "leap") continue;
    if (isMelee(a) && Math.abs(l - len(n.pos)) > tol) continue; // swings under (or over) the target
    if (groundOnly(a) && !isMelee(a) && perch > tol) continue; // lands on the ground under it
    return false;
  }
  if (nearSafeRing(sys.ground, tp[0], tp[1], tp[2], NPC_RULES.safeMargin + n.radius)) return true;
  if (under === null) return true;
  return perch > tol && n.def.attacks.every(groundOnly);
}

/**
 * A target in melee reach (+0.5 m) with a structure on the strike's line (the NPC's chest to the
 * target's chest, the line attacks.ts hitAll checks): a swing would only hit the structure.
 */
function strikeBlocked(sys: NpcSystem, n: Npc, tp: V3, d: number): boolean {
  const s = sys.ground.structures;
  if (!s || d > meleeReach(n) + 0.5) return false;
  const a = chest(n.pos, Math.min(n.height * 0.8, 2)), b = chest(tp, 1.1);
  return s.blocks(a[0], a[1], a[2], b[0], b[1], b[2]);
}

/**
 * Walled off: a structure stands between the NPC and its target (a segment 0.6 m above both feet,
 * over the step band; within melee reach, the strike's line), or the NPC is wedged against one (its
 * last step was refused every way, say between a hangar and a pad's no-go ring), and it hasn't got
 * 1 m closer than its best since: after unreachableMs it gives up. Open ground, or a target in reach
 * with a clear strike, clears the clock, so this never acts away from structures.
 */
function walledOff(sys: NpcSystem, n: Npc, tp: V3, d: number, now: number, blockedStrike: boolean): boolean {
  const s = sys.ground.structures;
  if (!s || (d <= meleeReach(n) + 0.5 && !blockedStrike)) {
    n.walled = undefined;
    return false;
  }
  const a = chest(n.pos, 0.6), b = chest(tp, 0.6);
  const wedged = n.blockedMove === true && s.near(n.pos[0], n.pos[1], n.pos[2], n.radius + 3);
  if (!blockedStrike && !wedged && !s.blocks(a[0], a[1], a[2], b[0], b[1], b[2])) {
    n.walled = undefined;
    return false;
  }
  if (!n.walled || d < n.walled.best - 1) n.walled = { since: now, best: d };
  return now - n.walled.since >= NPC_TUNING.unreachableMs;
}

function meleeReach(n: Npc): number {
  let best = 0;
  for (const a of n.def.attacks) if (isMelee(a) && !a.minRange) best = Math.max(best, a.range);
  return best || 1.8;
}

function resume(sys: NpcSystem, n: Npc, now: number) {
  if (n.def.temper === "critter") {
    // Critters never chase: after a buck they run.
    const from = n.target ? actorPos(n.target) : n.pos;
    n.target = null;
    startFlee(sys, n, from, now, 5000);
    return;
  }
  if (n.target && !n.target.dead) {
    sys.setMode(n, MODE.CHASE, now);
    sys.setAnim(n, NPC_ANIM.RUN);
  } else drop(sys, n, now);
}

function drop(sys: NpcSystem, n: Npc, now: number) {
  n.target = null;
  sys.releaseToken(n);
  n.state.flags &= ~NF.AGGRO;
  if (dist(n.pos, n.home) > 3) sys.setMode(n, MODE.RETURN, now);
  else sys.setMode(n, MODE.IDLE, now, now + 1500);
}

export function startEvade(sys: NpcSystem, n: Npc, now: number) {
  cancelAttack(sys, n);
  n.target = null;
  n.unreachSince = undefined;
  n.walled = undefined;
  sys.releaseToken(n);
  n.damage.clear();
  n.state.flags = (n.state.flags | NF.EVADING | NF.INVULN) & ~(NF.AGGRO | NF.TELEGRAPH | NF.STUNNED);
  sys.setMode(n, MODE.EVADE, now);
  sys.setAnim(n, NPC_ANIM.EVADE);
}

function evade(sys: NpcSystem, n: Npc, now: number, dt: number) {
  const arrived = moveTo(sys, n, n.home, n.def.runSpeed * NPC_RULES.evadeSpeedMult, dt, 1.5);
  if (arrived || now - n.modeAt > 20_000) {
    if (!arrived) n.pos = [n.home[0], n.home[1], n.home[2]];
    n.state.hp = n.state.maxHp;
    n.shieldHp = n.shieldMax;
    if (n.shieldMax > 0) n.state.flags = (n.state.flags | NF.SHIELD) & ~NF.SHIELD_CRACKED;
    n.state.flags &= ~(NF.EVADING | NF.INVULN);
    n.howled = false;
    n.anchor = n.home;
    sys.setMode(n, MODE.IDLE, now, now + 1500);
    sys.setAnim(n, NPC_ANIM.IDLE);
  }
}

function goHome(sys: NpcSystem, n: Npc, now: number, dt: number) {
  if (n.def.temper === "hostile" && now >= n.nextThink) {
    n.nextThink = now + 300;
    const p = perceive(sys, n, now);
    if (p) return aggro(sys, n, p, now, true);
  }
  sys.setAnim(n, NPC_ANIM.WALK);
  const arrived = moveTo(sys, n, n.home, n.def.speed * 1.3, dt, 1.5);
  // Held up (by a building, D44) for RETURN_MS: put home, as evade does after 20 s.
  if (arrived || now - n.modeAt > RETURN_MS) {
    if (!arrived) n.pos = [n.home[0], n.home[1], n.home[2]];
    n.howled = false;
    sys.setMode(n, MODE.IDLE, now, now + 1500);
  }
}

// ------------------------------------------------------------------------------------ fleeing

export function startFlee(sys: NpcSystem, n: Npc, from: V3, now: number, ms: number) {
  cancelAttack(sys, n);
  sys.releaseToken(n);
  n.fleeFrom = [from[0], from[1], from[2]];
  n.regroupAt = now + 20_000;
  n.state.flags |= NF.FLEEING;
  sys.setMode(n, MODE.FLEE, now, now + ms);
  sys.setAnim(n, NPC_ANIM.FLEE);
}

function scatter(sys: NpcSystem, n: Npc, from: V3, now: number) {
  startFlee(sys, n, from, now, (n.def.scatter ?? 5) * 1000);
  n.regroupAt = now + (n.def.scatter ?? 5) * 1000;
}

function flee(sys: NpcSystem, n: Npc, now: number, dt: number) {
  const def = n.def;
  if (now < n.modeUntil && n.fleeFrom) {
    let away = tangentDir(n.fleeFrom, n.pos);
    if (dot(away, away) < 0.5) away = n.facing;
    n.facing = away;
    if (!moveDir(sys, n, away, def.fleeSpeed ?? def.runSpeed, dt, NPC_ANIM.FLEE)) n.facing = rotateAboutUp(n.pos, away, 90);
    return;
  }
  n.state.flags &= ~NF.FLEEING;
  if (now < n.regroupAt) {
    sys.setAnim(n, NPC_ANIM.IDLE);
    return;
  }
  n.fleeFrom = null;
  if (n.target && !n.target.dead) {
    sys.setMode(n, MODE.CHASE, now);
    return;
  }
  sys.setMode(n, MODE.RETURN, now);
}

// ------------------------------------------------------------------------------------ reactions

/** Called when the NPC takes damage (after HP is reduced). */
export function onNpcHurt(sys: NpcSystem, n: Npc, p: PlayerActor | null, now: number) {
  if (n.dead) return;
  const def = n.def;
  if (def.id === "golden_hopbit") {
    // Damaging it pops it for 25 coins (egg E3 is lost).
    if (p) {
      p.char.coins += def.coinsFixed ?? 25;
      p.youDirty = true;
      sys.world.send(p, "npcKill", { id: n.id, kind: n.defIndex, xp: 0, coins: def.coinsFixed ?? 25 });
    }
    n.state.hp = 0;
    sys.retire(n);
    return;
  }
  if (def.id === "ticket_000") {
    n.state.hp = n.state.maxHp;
    sys.retire(n); // vanishes for 10 minutes
    return;
  }
  if (n.mode === MODE.CHANNEL) {
    sys.setMode(n, MODE.RECOVER, now, now + 600);
    sys.setAnim(n, NPC_ANIM.HIT);
    sys.sendNear(n.pos, 120, "npcAtk", { id: n.id, a: -1, sh: -1, ms: 0, x: 0, y: 0, z: 0, dx: 0, dy: 0, dz: 0, r: 0, w: 0, l: 0, ang: 0, c: 0 });
  }
  if (n.mode === MODE.EVADE || n.mode === MODE.SPAWN || !p) return;
  const pp = actorPos(p);
  if (def.temper === "critter") {
    if (n.mode === MODE.FLEE) return;
    const buck = def.attacks[0];
    if (buck && def.retaliateChance && Math.random() < def.retaliateChance && dist(n.pos, pp) <= buck.range + 0.5 && !n.attack) {
      n.target = p;
      startAttack(sys, n, 0, p, now);
      n.regroupAt = now + 20_000;
      return;
    }
    startFlee(sys, n, pp, now, 5000);
    for (const m of sys.mates(n)) if (m.def.temper === "critter" && m.mode !== MODE.FLEE && dist(m.pos, n.pos) < 20 && !m.attack) startFlee(sys, m, pp, now, 5000);
    return;
  }
  if (def.temper === "passive") return;
  if (!n.target || n.target.dead) {
    aggro(sys, n, p, now, true);
    if (def.temper === "neutral") {
      // A roaming beast leashes from where the fight started.
      n.anchor = [n.pos[0], n.pos[1], n.pos[2]];
    }
  } else if (n.target !== p && dist(n.pos, pp) + 4 < dist(n.pos, actorPos(n.target))) n.target = p;
}

function raise(sys: NpcSystem, n: Npc, now: number) {
  const r = n.def.raise!;
  const idx = NPC_INDEX.get(r.def)!;
  const side = rotateAboutUp(n.pos, n.facing, Math.random() < 0.5 ? 70 : -70);
  const at = add(n.pos, side, 3);
  const m = sys.createNpc(idx, n.level, at, now, { roam: 6, summoner: n.id });
  n.raised.add(m.id);
  if (n.target) aggro(sys, m, n.target, now, false);
  sys.setMode(n, MODE.RECOVER, now, now + 500);
  sys.setAnim(n, NPC_ANIM.RECOVER);
}

// ------------------------------------------------------------------------------------ eggs

/** Golden Hopbit (E3): flees players, never attacks; stay within 15 m for 60 s and it opens the burrow. */
function golden(sys: NpcSystem, n: Npc, now: number, dt: number) {
  let nearest: { a: PlayerActor; pos: V3 } | null = null;
  let nd = Infinity;
  for (const lp of sys.live) {
    const d = dist(lp.pos, n.pos);
    if (d < nd) {
      nd = d;
      nearest = lp;
    }
  }
  n.egg ??= { follower: null, since: 0 };
  if (nearest && nd <= 15) {
    if (n.egg.follower !== nearest.a.id) {
      n.egg.follower = nearest.a.id;
      n.egg.since = now;
    } else if (now - n.egg.since >= 60_000) {
      emitNpcEvent({ kind: "egg", body: sys.world.body.id, egg: "E3", sessionId: nearest.a.id, userId: nearest.a.identity.userId });
      sys.sendNear(n.pos, 60, "npcEgg", { id: n.id, egg: "E3", by: nearest.a.id });
      sys.retire(n);
      return;
    }
  } else n.egg.follower = null;
  if (nearest && nd < 8) {
    const away = tangentDir(nearest.pos, n.pos);
    n.facing = away;
    moveDir(sys, n, away, n.def.fleeSpeed ?? 4.5, dt, NPC_ANIM.FLEE);
    return;
  }
  calm(sys, n, now, dt);
}

/** Ticket #000 (E9): faces the wall; "Truce?" within 5 m makes it walk 120 m to the freight lift. */
function ticket(sys: NpcSystem, n: Npc, now: number, dt: number) {
  const e = n.egg;
  if (n.mode !== MODE.SCRIPT || !e?.walker || !e.walkFrom || !e.walkDir) {
    sys.setAnim(n, NPC_ANIM.IDLE);
    return;
  }
  const moved = moveDir(sys, n, tangentize(n.pos, e.walkDir), n.def.speed, dt, NPC_ANIM.WALK);
  if (!moved) e.walkDir = rotateAboutUp(n.pos, e.walkDir, 30);
  else n.facing = tangentize(n.pos, e.walkDir);
  if (dist(n.pos, e.walkFrom) >= 120 || now - n.modeAt > 90_000) {
    const p = sys.world.playerById(e.walker);
    if (p) emitNpcEvent({ kind: "egg", body: sys.world.body.id, egg: "E9", sessionId: p.id, userId: p.identity.userId });
    sys.sendNear(n.pos, 60, "npcEgg", { id: n.id, egg: "E9", by: e.walker });
    sys.retire(n);
  }
}

// ------------------------------------------------------------------------------------ movement

function faceTarget(n: Npc) {
  if (!n.target) return;
  const d = tangentDir(n.pos, actorPos(n.target));
  if (dot(d, d) > 0.5) n.facing = d;
}

function scaleV(v: V3, k: number): V3 {
  return [v[0] * k, v[1] * k, v[2] * k];
}

/** Brightbits move in hard 90° steps: snap to the nearest local axis, with hysteresis. */
function quantize(n: Npc, d: V3): V3 {
  const e1 = stableTangentAt(n.pos);
  const e2 = cross(up(n.pos), e1);
  const axes: V3[] = [e1, e2, [-e1[0], -e1[1], -e1[2]], [-e2[0], -e2[1], -e2[2]]];
  let best = 0;
  let bestDot = -2;
  for (let i = 0; i < 4; i++) {
    const k = dot(axes[i]!, d) + (i === n.gridAxis ? 0.2 : 0);
    if (k > bestDot) {
      bestDot = k;
      best = i;
    }
  }
  n.gridAxis = best;
  return axes[best]!;
}

/** Move along a tangent direction with separation from neighbours. Returns false if blocked. */
export function moveDir(sys: NpcSystem, n: Npc, dir: V3, speed: number, dt: number, anim: number, avoidSafe = true): boolean {
  if (dot(dir, dir) < 0.5 || speed <= 0) return false;
  let d = dir;
  const nb = sys.neighbours(n, n.radius + 1.4);
  if (nb.length) {
    let push: V3 = [0, 0, 0];
    for (const m of nb) {
      const away = sub(n.pos, m.pos);
      const l = Math.hypot(away[0], away[1], away[2]) || 0.01;
      const k = (n.radius + m.radius + 0.4 - l) / l;
      if (k > 0) push = add(push, away, k);
    }
    if (push[0] || push[1] || push[2]) d = normalize(add(d, tangentize(n.pos, push), 1.2));
  }
  if (n.def.gridMove) {
    d = quantize(n, d);
    n.facing = d;
  }
  const out: V3 = [0, 0, 0];
  const used = step(sys.ground, n.pos, d, speed * dt, n.def.locomotion, n.def.hover ?? 0, n.radius, out, avoidSafe, n.slideSide, n.height);
  sys.setAnim(n, anim);
  n.blockedMove = used < 0;
  if (used < 0) return false;
  // Round a structure: keep turning to the side that worked (straight on or straight back keeps it).
  const ang = slideAngle(sys.ground, used, n.slideSide);
  if (ang !== 0 && Math.abs(ang) !== 180) n.slideSide = Math.sign(ang);
  n.pos = out;
  return true;
}

/** Walk toward a point; true when within `within` metres (or stuck right next to it). */
function moveTo(sys: NpcSystem, n: Npc, goal: V3, speed: number, dt: number, within = 1, avoidSafe = true): boolean {
  const d = flatDist(n.pos, goal);
  if (d <= within) return true;
  const dir = tangentDir(n.pos, goal);
  if (dot(dir, dir) < 0.5) return true;
  if (!n.def.gridMove) n.facing = dir;
  const ok = moveDir(sys, n, dir, Math.min(speed, d / Math.max(dt, 1e-3)), dt, speed > n.def.speed * 1.2 ? NPC_ANIM.RUN : NPC_ANIM.WALK, avoidSafe);
  return !ok && d < 3;
}
