// Telegraphed attacks: start (lock the shape, tell nearby clients), wind up, resolve (damage only
// lands if the player is still inside the shape when the telegraph ends), active phases (charges,
// bursts, damage ticks, double sweeps) and NPC projectiles.

import { NF, NPC_ANIM, SHAPE_CODE, attackDamage, type AttackDef, type NpcAttackMsg, type StatusEffect } from "@firstlight/shared/content/npcs";
import { actorPos, positionAgo, type PlayerActor } from "../actors.ts";
import { wallBetween } from "../combat.ts";
import { PLAYER_RADIUS, rayTerrain, type V3 } from "../geometry.ts";
import type { LivePlayer, NpcSystem } from "./NpcSystem.ts";
import { MODE, type ActiveAttack, type Npc } from "./npc.ts";
import { blockedByStructure, CHASE_MARGIN, feetHeight, nearSafeRing, npcBody, standsClear, step } from "./steer.ts";
import { add, cross, dist, dot, flatDist, len, normalize, rotateAboutUp, scale, sub, tangentDir, up } from "./vec.ts";

export interface NpcProjectile {
  owner: Npc;
  pos: V3;
  vel: V3;
  g: number;
  until: number;
  radius: number;
  damage: number;
  effect?: StatusEffect;
}

/** Clients within this distance of an attack hear about its telegraph. */
export const TELEGRAPH_RADIUS = 130;
/** Vertical tolerance for ground shapes (m). */
const HEIGHT_TOL = 3;

export function isMelee(a: AttackDef): boolean {
  return a.shape === "arc" || a.shape === "ring" || a.shape === "leap" || a.shape === "charge" || a.shape === "line";
}

/** Vertical tolerance of this NPC's melee shapes (bosses reach higher). */
export function meleeHeightTol(n: Npc): number {
  return n.boss ? 5 : HEIGHT_TOL;
}

/**
 * Does this attack only hit players near the ground: melee shapes (within the NPC's height
 * tolerance), and lobbed circles and fields (on the ground under the target, HEIGHT_TOL)? Bolts,
 * rounds, zaps, tags and boss specials reach a player standing on a pillar or wall top.
 */
export function groundOnly(a: AttackDef): boolean {
  return isMelee(a) || a.shape === "circle" || a.shape === "field";
}

/** Telegraph language (content §3.1): 0 red = dodge, 1 amber = ranged lock, 2 teal = step out, 3 white = launch, 4 violet = curse. */
export function colourOf(a: AttackDef): number {
  switch (a.shape) {
    case "burst":
    case "zap":
    case "tag":
      return 1;
    case "ring":
    case "pull":
    case "band":
    case "field":
      return 2;
    case "bolt":
      return 3;
    case "split":
    case "raise":
      return 4;
    case "circle":
      return a.track ? 1 : 0;
    default:
      return 0;
  }
}

export function chest(p: V3, h = 0.9): V3 {
  const u = up(p);
  return [p[0] + u[0] * h, p[1] + u[1] * h, p[2] + u[2] * h];
}

/** Line of sight from one point to another: terrain, intact breakable props, arena cover and the sites' structures block it. */
export function canSee(sys: NpcSystem, from: V3, to: V3): boolean {
  const d = sub(to, from);
  const l = len(d);
  if (l < 1) return true;
  const dir: V3 = [d[0] / l, d[1] / l, d[2] / l];
  if (rayTerrain(sys.world.terrain, from, dir, l, 2.5) < l - 0.75) return false;
  // Cover works both ways (F12): the walls that stop players' shots hide them from NPCs too, and so
  // do the structures: the Portus town's walls, an outpost's buildings (D-zones-3, D43).
  const walls = sys.world.host.walls;
  if (walls && walls.raycast(from[0], from[1], from[2], dir[0], dir[1], dir[2], l - 0.75) < l - 0.75) return false;
  return !sys.world.host.props?.raycast(from, dir, l - 0.75);
}

function vertOk(a: V3, b: V3, tol = HEIGHT_TOL): boolean {
  return Math.abs(len(a) - len(b)) <= tol;
}

// ------------------------------------------------------------------------------------ shape queries

export function playersInArc(sys: NpcSystem, origin: V3, dir: V3, radius: number, angleDeg: number, tol = HEIGHT_TOL): LivePlayer[] {
  const cosHalf = Math.cos(((angleDeg / 2) * Math.PI) / 180);
  const out: LivePlayer[] = [];
  for (const lp of sys.live) {
    if (lp.untouchable) continue;
    const d = flatDist(origin, lp.pos);
    if (d > radius + PLAYER_RADIUS || !vertOk(origin, lp.pos, tol)) continue;
    if (d < 0.6) {
      out.push(lp);
      continue;
    }
    const t = tangentDir(origin, lp.pos);
    if (angleDeg >= 360 || dot(t, dir) >= cosHalf) out.push(lp);
  }
  return out;
}

export function playersInCircle(sys: NpcSystem, c: V3, radius: number, inner = 0, tol = HEIGHT_TOL): LivePlayer[] {
  const out: LivePlayer[] = [];
  for (const lp of sys.live) {
    if (lp.untouchable) continue;
    const d = flatDist(c, lp.pos);
    if (d <= radius + PLAYER_RADIUS * 0.5 && d >= inner && vertOk(c, lp.pos, tol)) out.push(lp);
  }
  return out;
}

export function playersInLine(sys: NpcSystem, origin: V3, dir: V3, length: number, width: number, tol = HEIGHT_TOL): LivePlayer[] {
  const out: LivePlayer[] = [];
  const u = up(origin);
  for (const lp of sys.live) {
    if (lp.untouchable) continue;
    const d = sub(lp.pos, origin);
    const along = dot(d, dir);
    if (along < -PLAYER_RADIUS || along > length + PLAYER_RADIUS) continue;
    const side = cross(u, dir);
    const lat = Math.abs(dot(d, side));
    if (lat <= width / 2 + PLAYER_RADIUS && vertOk(origin, lp.pos, tol + along * 0.15)) out.push(lp);
  }
  return out;
}

// ------------------------------------------------------------------------------------ start

/** Begin a telegraphed attack on `target` (may be null for self-centred shapes). */
export function startAttack(sys: NpcSystem, n: Npc, index: number, target: PlayerActor | null, now: number) {
  const a = n.def.attacks[index]!;
  const bossScale = n.boss && sys.boss ? sys.boss.cooldownScale() : 1;
  n.cooldowns[index] = now + a.cooldown * 1000 * bossScale;
  const tp = target ? actorPos(target) : null;
  let dir = tp ? tangentDir(n.pos, tp) : n.facing;
  if (dot(dir, dir) < 0.5) dir = n.facing;
  if (a.back) dir = [-n.facing[0], -n.facing[1], -n.facing[2]];
  else n.facing = dir;
  let origin: V3 = [n.pos[0], n.pos[1], n.pos[2]];
  const points: V3[] = [];
  const tracked: string[] = [];
  const ground = sys.ground;
  if (a.shape === "line" && n.boss && tp) {
    // Boss lines land on the shore around the target (Tail Slam: 15 × 6 m).
    const back = Math.min(10, flatDist(n.pos, tp));
    origin = groundAt(sys, add(tp, dir, -back));
  }
  if (a.shape === "ring" && a.footOffset) {
    const side = cross(up(n.pos), dir);
    origin = groundAt(sys, add(n.pos, side, a.footOffset * (Math.random() < 0.5 ? -1 : 1)));
  }
  if ((a.shape === "circle" || a.shape === "field") && tp) {
    const count = a.count ?? 1;
    const victims: PlayerActor[] = [target!];
    if (count > 1 && (n.boss || a.track)) {
      for (const lp of sys.live) {
        if (victims.length >= count) break;
        if (lp.untouchable || victims.includes(lp.a)) continue;
        if (flatDist(n.pos, lp.pos) <= a.range) victims.push(lp.a);
      }
    }
    for (let i = 0; i < count; i++) {
      const v = victims[i];
      if (v) {
        points.push(groundAt(sys, actorPos(v)));
        if (a.track) tracked.push(v.id);
      } else {
        // Spare circles land around the main target.
        const ang = Math.random() * 360;
        const r = 2.5 + Math.random() * 2.5;
        points.push(groundAt(sys, add(tp, rotateAboutUp(tp, tangentDir(tp, n.pos).every((x) => x === 0) ? n.facing : tangentDir(tp, n.pos), ang), r)));
      }
    }
  }
  if (a.shape === "leap" && tp) points.push(leapLanding(sys, n, tp, a));
  if (a.shape === "pull" && tp) points.push(groundAt(sys, add(n.pos, dir, Math.min(10, flatDist(n.pos, tp) * 0.6))));
  if ((a.shape === "bolt" || a.shape === "burst" || a.shape === "zap" || a.shape === "tag") && target) tracked.push(target.id);
  const telegraphMs = a.telegraph * 1000;
  const at: ActiveAttack = {
    def: a,
    index,
    start: now,
    resolveAt: now + telegraphMs,
    origin,
    dir,
    points,
    tracked,
    lockAt: a.track ? now + telegraphMs - (a.lockLead ?? 0.5) * 1000 : now + telegraphMs,
    locked: !a.track,
    targetId: target?.id ?? null,
    resolved: false,
    activeUntil: 0,
    travelled: 0,
    hitIds: new Set(),
    nextTickAt: 0,
    ticksLeft: 0,
    repeatAt: 0,
    repeatDir: null,
    aim: tp,
  };
  if (a.repeatAfter && n.boss && sys.boss && (a.repeatPhases ?? []).includes(sys.boss.phase)) {
    at.repeatAt = at.resolveAt + a.repeatAfter * 1000;
    at.repeatDir = [-dir[0], -dir[1], -dir[2]];
  }
  n.attack = at;
  sys.setMode(n, MODE.WINDUP, now, at.resolveAt);
  sys.setAnim(n, NPC_ANIM.WINDUP);
  n.state.flags |= NF.TELEGRAPH;
  n.state.target = target?.id ?? "";
  if (!n.boss) n.state.phase = index + 1;
  sys.sendNear(origin, n.boss ? 200 : TELEGRAPH_RADIUS, "npcAtk", telegraphMsg(n, at, telegraphMs));
  if (at.repeatDir) sys.sendNear(origin, 200, "npcAtk", { ...telegraphMsg(n, at, telegraphMs + a.repeatAfter! * 1000), dx: at.repeatDir[0], dy: at.repeatDir[1], dz: at.repeatDir[2] });
}

export function telegraphMsg(n: Npc, at: ActiveAttack, ms: number): NpcAttackMsg {
  const a = at.def;
  const m: NpcAttackMsg = {
    id: n.id,
    a: at.index,
    sh: SHAPE_CODE[a.shape],
    ms: Math.round(ms),
    x: at.origin[0],
    y: at.origin[1],
    z: at.origin[2],
    dx: at.dir[0],
    dy: at.dir[1],
    dz: at.dir[2],
    r: a.radius ?? (a.shape === "charge" || a.shape === "line" ? (a.width ?? 1.5) / 2 : a.range),
    w: a.width ?? a.inner ?? 0,
    l: a.length ?? 0,
    ang: a.angle ?? 0,
    c: colourOf(a),
  };
  if (at.points.length) m.pts = at.points.flatMap((p) => [p[0], p[1], p[2]]);
  if (at.tracked.length && !at.locked) m.tg = at.tracked;
  return m;
}

/** Where `n`'s leap `a` at a target standing at `tp` lands: toward it, at most the leap's range. */
export function leapLanding(sys: NpcSystem, n: Npc, tp: V3, a: AttackDef): V3 {
  let dir = tangentDir(n.pos, tp);
  if (dot(dir, dir) < 0.5) dir = n.facing;
  return groundAt(sys, add(n.pos, dir, Math.min(flatDist(n.pos, tp), a.range)));
}

/**
 * Would a leap to `to` be stopped where it started (resolveAttack): a structure or, for the NPCs that
 * walk round them, a tree trunk, boulder or spire on its way or at its landing.
 */
export function leapStopped(sys: NpcSystem, n: Npc, to: V3): boolean {
  const body = npcBody(n.radius, n.height);
  return blockedByStructure(sys.ground, n.pos, to, body) || !standsClear(sys.ground, to, body);
}

function groundAt(sys: NpcSystem, p: V3): V3 {
  const l = len(p);
  const ux = p[0] / l, uy = p[1] / l, uz = p[2] / l;
  const r = sys.ground.R + Math.max(sys.ground.terrain.groundHeight(ux, uy, uz), sys.ground.water - 0.3);
  return [ux * r, uy * r, uz * r];
}

// ------------------------------------------------------------------------------------ wind-up, resolve, active

/** Advance the NPC's current attack. Returns true while the attack still owns the NPC. */
export function updateAttack(sys: NpcSystem, n: Npc, now: number, dt: number): boolean {
  const at = n.attack;
  if (!at) return false;
  const a = at.def;
  if (!at.resolved) {
    if (!at.locked) {
      for (let i = 0; i < at.tracked.length; i++) {
        const p = sys.world.playerById(at.tracked[i]!);
        if (p && !p.dead && at.points[i]) at.points[i] = groundAt(sys, actorPos(p));
      }
      if (now >= at.lockAt) {
        at.locked = true;
        sys.sendNear(at.origin, 200, "npcAtk", telegraphMsg(n, at, at.resolveAt - now));
      }
    }
    if (a.shape === "bolt" || a.shape === "burst" || a.shape === "zap" || a.shape === "tag") {
      const t = at.targetId ? sys.world.playerById(at.targetId) : undefined;
      if (t && !t.dead) {
        const d = tangentDir(n.pos, actorPos(t));
        if (dot(d, d) > 0.5) n.facing = d;
      }
    }
    if (now >= at.resolveAt) resolve(sys, n, at, now);
    return true;
  }
  if (now < at.activeUntil || at.repeatAt > 0) {
    runActive(sys, n, at, now, dt);
    if (n.attack !== at) return true;
    if (now < at.activeUntil || at.repeatAt > 0) return true;
  }
  finish(sys, n, now);
  return true;
}

function dmgOf(n: Npc, a: AttackDef): number {
  return attackDamage(a, n.level);
}

function fromDirOf(n: Npc, p: V3): V3 {
  return sub(n.pos, p);
}

/**
 * `src`: where splash comes from (lobbed circles), so a Prism Bubble between it and a player stops it.
 * A structure (the town's, an outpost's) between the strike's source (the splash, else the NPC's
 * chest) and the player's chest stops it too (D-zones-3, D43); breakable props keep their old rule
 * (they don't).
 */
function hitAll(sys: NpcSystem, n: Npc, list: LivePlayer[], a: AttackDef, at: ActiveAttack, from?: V3, src?: V3) {
  const o = sys.world.host.walls ? (src ?? chest(n.pos, Math.min(n.height * 0.8, 2))) : null;
  for (const lp of list) {
    if (n.boss && sys.boss && sys.boss.blocked(n.pos, lp.pos, a)) continue;
    if (o && wallBetween(sys.world.host, o, chest(lp.pos, 1.1))) continue;
    sys.hitPlayer(n, lp.a, dmgOf(n, a), { fromDir: from ? sub(from, lp.pos) : fromDirOf(n, lp.pos), knockback: a.knockback, effect: a.effect, ...(src ? { src } : {}) });
    at.hitIds.add(lp.a.id);
  }
}

function resolve(sys: NpcSystem, n: Npc, at: ActiveAttack, now: number) {
  const a = at.def;
  at.resolved = true;
  n.state.flags &= ~NF.TELEGRAPH;
  sys.setAnim(n, NPC_ANIM.STRIKE);
  switch (a.shape) {
    case "arc": {
      hitAll(sys, n, playersInArc(sys, n.pos, at.dir, a.radius ?? 2, a.angle ?? 90, meleeHeightTol(n)), a, at);
      if (a.ticks && a.ticks > 1) {
        at.ticksLeft = a.ticks - 1;
        at.nextTickAt = now + (a.interval ?? 0.5) * 1000;
        at.activeUntil = now + (a.ticks - 1) * (a.interval ?? 0.5) * 1000 + 10;
      }
      break;
    }
    case "ring":
      hitAll(sys, n, playersInCircle(sys, at.origin, a.radius ?? 3, a.inner ?? 0, meleeHeightTol(n)), a, at, at.origin);
      break;
    case "circle":
      for (const c of at.points) hitAll(sys, n, playersInCircle(sys, c, a.radius ?? 3), a, at, n.pos, chest(c, 0.3));
      break;
    case "field":
      for (const c of at.points) for (const lp of playersInCircle(sys, c, a.radius ?? 4)) if (a.effect) sys.applyEffect(lp.a, a.effect, n);
      break;
    case "line":
      hitAll(sys, n, playersInLine(sys, at.origin, at.dir, a.length ?? 6, a.width ?? 2, meleeHeightTol(n)), a, at);
      break;
    case "leap": {
      const land = at.points[0];
      if (land) {
        const l = len(land);
        const ux = land[0] / l, uy = land[1] / l, uz = land[2] / l;
        const fh = feetHeight(sys.ground, ux, uy, uz, n.def.locomotion, n.def.hover ?? 0, true);
        // Lands anywhere outside the zones' least margin (D-evade-1): a player just outside a ring can be leapt at.
        if (fh !== null && !nearSafeRing(sys.ground, land[0], land[1], land[2], CHASE_MARGIN + n.radius)) {
          const r = sys.ground.R + fh;
          const to: V3 = [ux * r, uy * r, uz * r];
          // Never through or into a building (D44): the leap stops where it started.
          const body = npcBody(n.radius, n.height);
          if (!blockedByStructure(sys.ground, n.pos, to, body) && standsClear(sys.ground, to, body)) n.pos = to;
        }
      }
      hitAll(sys, n, playersInCircle(sys, n.pos, a.radius ?? 1.5), a, at);
      break;
    }
    case "charge":
      at.travelled = 0;
      at.activeUntil = now + ((a.length ?? 8) / (a.speed ?? 10)) * 1000 + 30;
      sys.setAnim(n, NPC_ANIM.DASH);
      break;
    case "bolt": {
      const t = at.targetId ? sys.world.playerById(at.targetId) : undefined;
      const aim = t && !t.dead ? actorPos(t) : at.aim;
      if (!aim) break;
      const from = chest(n.pos, Math.min(n.height * 0.6, 3));
      const count = a.count ?? 1;
      const spread = a.angle ?? (count > 1 ? 16 : 0);
      for (let i = 0; i < count; i++) {
        const off = count > 1 ? -spread / 2 + (spread * i) / (count - 1) : 0;
        const dirTo = tangentDir(n.pos, aim);
        const D = flatDist(n.pos, aim);
        const aimed = off === 0 || dot(dirTo, dirTo) < 0.5 ? chest(aim, 0.9) : chest(add(n.pos, rotateAboutUp(n.pos, dirTo, off), D), 0.9);
        spawnBolt(sys, n, from, aimed, a, dmgOf(n, a), now);
      }
      break;
    }
    case "burst":
      at.ticksLeft = a.count ?? 1;
      at.nextTickAt = now;
      at.activeUntil = now + (a.count ?? 1) * (a.interval ?? 0.12) * 1000 + 20;
      break;
    case "zap": {
      const t = at.targetId ? sys.world.playerById(at.targetId) : undefined;
      if (t && !t.dead) {
        const tp = actorPos(t);
        if (dist(n.pos, tp) <= a.range + 1.5 && canSee(sys, chest(n.pos, 0.3), chest(tp))) sys.hitPlayer(n, t, dmgOf(n, a), { fromDir: fromDirOf(n, tp), src: chest(n.pos, 0.3) });
        sys.sendNear(n.pos, TELEGRAPH_RADIUS, "npcShot", { id: n.id, x: n.pos[0], y: n.pos[1], z: n.pos[2], vx: tp[0], vy: tp[1], vz: tp[2], g: -1, ms: 150, k: n.defIndex });
      }
      break;
    }
    case "tag": {
      const t = at.targetId ? sys.world.playerById(at.targetId) : undefined;
      if (t && !t.dead && a.effect) {
        const tp = actorPos(t);
        const inCone = dot(tangentDir(n.pos, tp), n.facing) >= Math.cos((((a.angle ?? 30) / 2) * Math.PI) / 180);
        if (inCone && dist(n.pos, tp) <= a.range && canSee(sys, n.pos, chest(tp))) sys.applyEffect(t, a.effect, n);
      }
      break;
    }
    case "raise":
    case "split":
    case "band":
    case "beam":
    case "pull":
      sys.boss?.resolveSpecial(n, at, now);
      break;
  }
  if (now >= at.activeUntil && at.repeatAt === 0) finish(sys, n, now);
}

function runActive(sys: NpcSystem, n: Npc, at: ActiveAttack, now: number, dt: number) {
  const a = at.def;
  switch (a.shape) {
    case "charge": {
      const speed = a.speed ?? 10;
      const out: V3 = [0, 0, 0];
      const d = Math.min(speed * dt, (a.length ?? 8) - at.travelled);
      const used = d > 0 ? step(sys.ground, n.pos, at.dir, d, n.def.locomotion, n.def.hover ?? 0, n.radius, out, "close", 1, n.height) : -1;
      if (used !== 0) {
        // Hit an obstacle (cliff, water, safe ring): the Pixel Lancer is stunned (punish window).
        at.activeUntil = now;
        if (a.stunOnObstacle && d > 0) stun(sys, n, now, a.stun ?? 1.5);
      } else {
        n.pos = out;
        at.travelled += d;
      }
      for (const lp of playersInCircle(sys, n.pos, (a.width ?? 1.5) / 2 + n.radius * 0.5)) {
        if (at.hitIds.has(lp.a.id)) continue;
        at.hitIds.add(lp.a.id);
        sys.hitPlayer(n, lp.a, dmgOf(n, a), { fromDir: sub(n.pos, lp.pos), knockback: a.knockback, effect: a.effect });
      }
      if (at.travelled >= (a.length ?? 8) - 1e-3) at.activeUntil = now;
      if (now >= at.activeUntil && a.stun && !a.stunOnObstacle) stun(sys, n, now, a.stun);
      break;
    }
    case "burst": {
      const t = at.targetId ? sys.world.playerById(at.targetId) : undefined;
      while (at.ticksLeft > 0 && now >= at.nextTickAt) {
        at.ticksLeft--;
        at.nextTickAt += (a.interval ?? 0.12) * 1000;
        if (!t || t.dead) continue;
        const tp = actorPos(t);
        // Rounds go where the target was 150 ms ago: moving across the lock makes them miss.
        const aim = positionAgo(t, now, 150);
        const from = chest(n.pos, Math.min(1.5, n.height * 0.75));
        if (at.aim === null || at.ticksLeft === (a.count ?? 1) - 1) at.aim = canSee(sys, from, chest(tp)) ? tp : null;
        sys.sendNear(n.pos, TELEGRAPH_RADIUS, "npcShot", { id: n.id, x: from[0], y: from[1], z: from[2], vx: aim[0], vy: aim[1], vz: aim[2], g: -1, ms: 90, k: n.defIndex });
        if (at.aim && dist(aim, tp) <= 1.1 && dist(n.pos, tp) <= a.range + 3) sys.hitPlayer(n, t, dmgOf(n, a), { fromDir: fromDirOf(n, tp), src: from });
      }
      break;
    }
    case "arc": {
      if (at.ticksLeft > 0 && now >= at.nextTickAt) {
        at.ticksLeft--;
        at.nextTickAt += (a.interval ?? 0.5) * 1000;
        hitAll(sys, n, playersInArc(sys, n.pos, at.dir, a.radius ?? 2, a.angle ?? 90, meleeHeightTol(n)), a, at);
      }
      if (at.repeatAt > 0 && now >= at.repeatAt && at.repeatDir) {
        at.repeatAt = 0;
        sys.setAnim(n, NPC_ANIM.STRIKE);
        hitAll(sys, n, playersInArc(sys, n.pos, at.repeatDir, a.radius ?? 2, a.angle ?? 90, 5), a, at);
      }
      break;
    }
    default:
      sys.boss?.runActive(n, at, now, dt);
  }
}

function stun(sys: NpcSystem, n: Npc, now: number, seconds: number) {
  n.attack = null;
  n.stunUntil = now + seconds * 1000;
  sys.setMode(n, MODE.STUN, now, n.stunUntil);
  sys.setAnim(n, NPC_ANIM.STUN);
  n.state.flags |= NF.STUNNED;
  n.state.phase = 0;
}

/** End the attack: recovery (or keep a stun that the attack caused). */
export function finish(sys: NpcSystem, n: Npc, now: number) {
  const at = n.attack;
  n.attack = null;
  n.state.flags &= ~NF.TELEGRAPH;
  if (!n.boss) n.state.phase = 0;
  if (n.mode === MODE.STUN || n.dead) return;
  const rec = (at?.def.recovery ?? 0.4) * 1000;
  sys.setMode(n, MODE.RECOVER, now, now + rec);
  sys.setAnim(n, NPC_ANIM.RECOVER);
}

/** Cancel a wind-up (the NPC was interrupted, evaded or the boss was Moored). */
export function cancelAttack(sys: NpcSystem, n: Npc) {
  if (!n.attack) return;
  n.attack = null;
  n.state.flags &= ~NF.TELEGRAPH;
  if (!n.boss) n.state.phase = 0;
  sys.sendNear(n.pos, 200, "npcAtk", { id: n.id, a: -1, sh: -1, ms: 0, x: 0, y: 0, z: 0, dx: 0, dy: 0, dz: 0, r: 0, w: 0, l: 0, ang: 0, c: 0 } satisfies NpcAttackMsg);
}

// ------------------------------------------------------------------------------------ projectiles

export function spawnBolt(sys: NpcSystem, n: Npc, from: V3, aim: V3, a: AttackDef, damage: number, now: number) {
  const speed = a.speed ?? 15;
  const g = a.gravity ?? 0;
  const d = sub(aim, from);
  const D = len(d);
  const T = Math.max(0.15, D / speed);
  const u = up(from);
  const vel: V3 = [d[0] / T + u[0] * 0.5 * g * T, d[1] / T + u[1] * 0.5 * g * T, d[2] / T + u[2] * 0.5 * g * T];
  const until = now + T * 1600 + 250;
  sys.projectiles.push({ owner: n, pos: [...from] as V3, vel, g, until, radius: a.radius ?? 0.5, damage, effect: a.effect });
  sys.sendNear(from, TELEGRAPH_RADIUS, "npcShot", { id: n.id, x: from[0], y: from[1], z: from[2], vx: vel[0], vy: vel[1], vz: vel[2], g, ms: Math.round(until - now), k: n.defIndex });
}

function segPointDist(a: V3, b: V3, p: V3): number {
  const ab = sub(b, a);
  const l2 = dot(ab, ab);
  const t = l2 > 0 ? Math.max(0, Math.min(1, dot(sub(p, a), ab) / l2)) : 0;
  return dist(add(a, ab, t), p);
}

export function stepNpcProjectiles(sys: NpcSystem, now: number, dt: number) {
  const list = sys.projectiles;
  const R = sys.ground.R;
  for (let i = list.length - 1; i >= 0; i--) {
    const pr = list[i]!;
    if (now >= pr.until) {
      list.splice(i, 1);
      continue;
    }
    const u = up(pr.pos);
    pr.vel = add(pr.vel, u, -pr.g * dt);
    let next = add(pr.pos, pr.vel, dt);
    // An intact prop (or arena cover) on this step stops the bolt where it touches it, as it stops
    // players' shots; only players in front of it can still be hit.
    const step0 = sub(next, pr.pos);
    const sl = len(step0);
    const dir0 = sl > 0 ? scale(step0, 1 / sl) : step0;
    const propT = sl > 0 ? (sys.world.host.props?.raycast(pr.pos, dir0, sl)?.t ?? Infinity) : Infinity;
    // …and so does a structure (D-zones-3, D43).
    const walls = sys.world.host.walls;
    const wallT = sl > 0 && walls ? walls.raycast(pr.pos[0], pr.pos[1], pr.pos[2], dir0[0], dir0[1], dir0[2], Math.min(sl, propT)) : Infinity;
    const wall = Math.min(propT, wallT) < Infinity ? { t: Math.min(propT, wallT) } : null;
    if (wall) next = add(pr.pos, step0, Math.max(0, wall.t - pr.radius) / sl);
    let gone = !!wall;
    // Nearest first along what's left of this step: the first player the bolt reaches, or a Prism
    // Bubble shell (which then takes the hit). A player in front of a shell is hit; one behind is not.
    const seg = sub(next, pr.pos);
    const segLen = len(seg);
    let victim: LivePlayer | null = null;
    let victimT = Infinity;
    for (const lp of sys.live) {
      if (lp.untouchable) continue;
      const c = chest(lp.pos);
      if (segPointDist(pr.pos, next, c) > pr.radius + 0.55) continue;
      const t = segLen > 0 ? Math.max(0, Math.min(segLen, dot(sub(c, pr.pos), seg) / segLen)) : 0;
      if (t < victimT) {
        victimT = t;
        victim = lp;
      }
    }
    const shell = segLen > 0 ? (sys.world.host.bubbles?.cross(pr.pos, scale(seg, 1 / segLen), segLen) ?? null) : null;
    if (shell && shell.t < victimT) {
      sys.world.host.bubbles!.absorb(shell.bubble, pr.damage);
      list.splice(i, 1);
      continue;
    }
    if (victim) {
      sys.hitPlayer(pr.owner, victim.a, pr.damage, { fromDir: scale(normalize(pr.vel), -1), effect: pr.effect });
      gone = true;
    }
    if (!gone) {
      const l = len(next);
      if (l < R + sys.ground.terrain.groundHeight(next[0] / l, next[1] / l, next[2] / l)) gone = true;
    }
    if (gone) list.splice(i, 1);
    else pr.pos = next;
  }
}
