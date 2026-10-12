// Server-authoritative combat: hitscan with lag compensation, pellets, chain lightning, melee arcs,
// simulated projectiles with splash, damage rules (safe zones, protection, friendly fire on),
// blocking, burn, healing. The room calls these from message handlers and the tick.

import { damageMult, falloff, maxHp, splashFalloff } from "@firstlight/shared/content/progression";
import { WEAPONS, WEAPON_INDEX, type TierStats, type WeaponDef } from "@firstlight/shared/content/weapons";
import type { Terrain } from "@firstlight/shared";
import { PF } from "@firstlight/shared/net/schema";
import { actorPos, positionAgo, type Actor, type NpcActor, type PlayerActor } from "./actors.ts";
import { dist3, HEAD_FROM, inMeleeArc, PLAYER_HEIGHT, PLAYER_RADIUS, rayCapsule, rayTerrain, type V3 } from "./geometry.ts";

export const REWIND_MS = 150;
export const COMBAT_TAG_MS = 10_000;
export const ORIGIN_SLACK = 7; // metres the shot origin may be from the shooter's head (camera offset)

export interface CombatHost {
  terrain: Terrain;
  now(): number;
  players(): Iterable<PlayerActor>;
  npcs(): Iterable<NpcActor>;
  broadcast(type: string, msg: unknown, except?: PlayerActor): void;
  /** Send only to clients within `radius` metres of `at` (plus the `always` session ids). */
  broadcastNear(type: string, msg: unknown, at: V3, radius: number, always?: string[]): void;
  /** Called after damage is applied; handles deaths. */
  onDamage(target: Actor, amount: number, attacker: PlayerActor | NpcActor | null, weak: boolean): void;
  /** Report a hit on a destructible prop (destruction system). */
  onPropHit?(point: V3, power: "light" | "heavy", amount: number): void;
}

export interface Projectile {
  id: number;
  owner: PlayerActor | NpcActor;
  weapon: WeaponDef;
  tier: TierStats;
  damage: number;
  pos: V3;
  vel: V3;
  gravity: number;
  travelled: number;
  maxDist: number;
  pierceLeft: number;
  hit: Set<string>;
  fuseAt: number | null; // grenades
  stuck: boolean;
}

let projectileSeq = 1;

export function selectedWeapon(p: PlayerActor): { def: WeaponDef; tier: TierStats; tierIndex: number; slot: number } {
  const item = p.char.hotbar[p.char.selected];
  const id = item?.id ?? "fists";
  const def = WEAPONS[WEAPON_INDEX.get(id) ?? 0]!;
  const tierIndex = Math.max(0, Math.min(2, (item?.tier ?? 1) - 1));
  return { def, tier: def.tiers[tierIndex]!, tierIndex, slot: p.char.selected };
}

/** Can `a` hurt `b` right now? Safe zones protect both ways; protection after login/respawn. */
export function canHurt(a: Actor | null, b: Actor, now: number): boolean {
  if (b.kind === "player") {
    if (b.dead) return false;
    if (b.state.flags & PF.SAFE) return false;
    if (b.protectedUntil > now) return false;
  } else if (b.state.hp <= 0) return false;
  if (a && a.kind === "player") {
    if (a.dead) return false;
    if (a.state.flags & PF.SAFE) return false;
    if (a.protectedUntil > now) return false;
  }
  return true;
}

function headPos(p: PlayerActor): V3 {
  const [x, y, z] = actorPos(p);
  const l = Math.hypot(x, y, z);
  return [x + (x / l) * 1.6, y + (y / l) * 1.6, z + (z / l) * 1.6];
}

function upOf(v: V3): V3 {
  const l = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / l, v[1] / l, v[2] / l];
}

interface RayTargetHit {
  actor: Actor;
  t: number;
  weak: boolean;
}

/** Nearest actor hit by a ray, using rewound positions, ignoring `ignore`. */
function raycastActors(host: CombatHost, o: V3, d: V3, maxT: number, ignore: Set<string>, rewindMs: number): RayTargetHit | null {
  let best: RayTargetHit | null = null;
  const now = host.now();
  const test = (a: Actor, r: number, h: number) => {
    if (ignore.has(a.id) || !canHurt(null, a, now)) return;
    const feet = positionAgo(a, now, rewindMs);
    const hit = rayCapsule(o, d, maxT, feet, r, h);
    if (hit && (!best || hit.t < best.t)) best = { actor: a, t: hit.t, weak: a.kind === "player" ? hit.heightAboveFeet >= HEAD_FROM : hit.heightAboveFeet >= h * 0.8 };
  };
  for (const p of host.players()) if (!p.dead) test(p, PLAYER_RADIUS, PLAYER_HEIGHT);
  for (const n of host.npcs()) if (n.state.hp > 0) test(n, n.radius, n.height);
  return best;
}

export interface FireInput {
  ox: number;
  oy: number;
  oz: number;
  dx: number;
  dy: number;
  dz: number;
  charge?: number;
}

export type FireResult = { ok: true } | { ok: false; reason: string };

/** Rate limit, gates, magazine/heat. Mutates actor state when the attack is allowed. */
export function consumeAttack(p: PlayerActor, def: WeaponDef, tier: TierStats, now: number, rateScale = 1): FireResult {
  if (p.dead || p.superseded) return { ok: false, reason: "dead" };
  if (p.state.flags & PF.SAFE) return { ok: false, reason: "safe zone" };
  if (p.protectedUntil > now) return { ok: false, reason: "protected" };
  if (p.state.flags & PF.SWIMMING) return { ok: false, reason: "swimming" };
  if (tier.level > p.char.level) return { ok: false, reason: "level gate" };
  if (now - p.lastAttackAt < tier.rate * 1000 * 0.85 * rateScale) return { ok: false, reason: "rate" };
  if (now < p.reloadEndsAt) return { ok: false, reason: "reloading" };
  if (now < p.overheatUntil) return { ok: false, reason: "overheated" };
  const item = p.char.hotbar[p.char.selected];
  if (tier.mag !== undefined && item) {
    const mag = item.mag ?? tier.mag;
    if (mag <= 0) {
      p.reloadEndsAt = now + (tier.reload ?? 1.5) * 1000;
      item.mag = tier.mag;
      p.youDirty = true;
      return { ok: false, reason: "empty" };
    }
    item.mag = mag - 1;
    if (item.mag <= 0) {
      p.reloadEndsAt = now + (tier.reload ?? 1.5) * 1000;
      item.mag = tier.mag;
    }
    p.youDirty = true;
  }
  if (tier.heat !== undefined) {
    // Heat cools at one shot per second of not firing.
    p.heat = Math.max(0, p.heat - (now - p.lastAttackAt) / 1000);
    p.heat += 1;
    if (p.heat >= tier.heat) {
      p.overheatUntil = now + 1500;
      p.heat = 0;
    }
  }
  p.lastAttackAt = now;
  p.combatUntil = now + COMBAT_TAG_MS;
  p.logoutEndsAt = null; // attacking cancels a logout countdown
  if (p.blocking) {
    p.blocking = false; // no blocking while attacking
    p.state.flags &= ~PF.BLOCKING;
  }
  return { ok: true };
}

export function fire(host: CombatHost, p: PlayerActor, msg: FireInput): FireResult {
  const now = host.now();
  const { def, tier } = selectedWeapon(p);
  if (def.delivery === "melee" || def.delivery === "none" || def.delivery === "heal" || def.delivery === "bubble") return { ok: false, reason: "not a ranged weapon" };
  const head = headPos(p);
  const o: V3 = [msg.ox, msg.oy, msg.oz];
  if (dist3(o, head) > ORIGIN_SLACK) return { ok: false, reason: "origin" };
  const dl = Math.hypot(msg.dx, msg.dy, msg.dz);
  if (!(dl > 0.5 && dl < 1.5)) return { ok: false, reason: "dir" };
  const d: V3 = [msg.dx / dl, msg.dy / dl, msg.dz / dl];
  // Bow draw is timed on the server from the `charge` start message; the client value is ignored.
  let charge = 1;
  if (def.delivery === "arrow") {
    const drawMs = (tier.draw ?? 1) * 1000;
    charge = p.chargeStartedAt > 0 ? Math.max(0, Math.min(1, (now - p.chargeStartedAt) / drawMs)) : 0;
    p.chargeStartedAt = 0;
  }
  const res = consumeAttack(p, def, tier, now, 1);
  if (!res.ok) return res;
  const lvl = damageMult(p.char.level);

  switch (def.delivery) {
    case "hitscan":
    case "pellets": {
      // The camera ray only chooses the aim point; damage is traced from the authoritative muzzle,
      // so a camera behind cover can't shoot through it.
      const maxR = def.falloffTo ?? def.range;
      const aimT = Math.min(maxR, rayTerrain(host.terrain, o, d, maxR, 1.5), aimActorT(host, p, o, d, maxR));
      const aim: V3 = [o[0] + d[0] * aimT, o[1] + d[1] * aimT, o[2] + d[2] * aimT];
      const muzzle = head;
      let base: V3 = [aim[0] - muzzle[0], aim[1] - muzzle[1], aim[2] - muzzle[2]];
      const bl = Math.hypot(base[0], base[1], base[2]) || 1;
      base = [base[0] / bl, base[1] / bl, base[2] / bl];
      const spreadDeg = p.state.flags & PF.SCOPED ? (def.adsSpread ?? 0) : (def.spread ?? 0);
      const rand = Math.random;
      const shots = def.delivery === "pellets" ? (tier.pellets ?? 6) : 1;
      let firstHit: number | null = null;
      let firstDir = base;
      for (let i = 0; i < shots; i++) {
        const dir = jitter(base, spreadDeg, rand);
        const t = hitscan(host, p, muzzle, dir, maxR, tier.damage * lvl, def, tier);
        if (i === 0) {
          firstHit = t;
          firstDir = dir;
        }
      }
      host.broadcastNear("shot", { by: p.id, weapon: WEAPON_INDEX.get(def.id), ox: muzzle[0], oy: muzzle[1], oz: muzzle[2], dx: firstDir[0], dy: firstDir[1], dz: firstDir[2], hit: firstHit === null ? undefined : [muzzle[0] + firstDir[0] * firstHit, muzzle[1] + firstDir[1] * firstHit, muzzle[2] + firstDir[2] * firstHit] }, muzzle, 160);
      return { ok: true };
    }
    case "chain": {
      chain(host, p, o, d, def, tier, lvl);
      return { ok: true };
    }
    case "projectile":
    case "arrow":
    case "thrown": {
      const speed = def.delivery === "arrow" ? 25 + 30 * charge : (def.speed ?? 30);
      const dmg = def.delivery === "arrow" ? ((tier.tap ?? tier.damage) + (tier.damage - (tier.tap ?? tier.damage)) * charge) * lvl : tier.damage * lvl;
      // Spawn from the shooter's hand, aimed at where the camera ray points.
      const aimT = Math.min(def.range, rayTerrain(host.terrain, o, d, def.range, 2));
      const aim: V3 = [o[0] + d[0] * aimT, o[1] + d[1] * aimT, o[2] + d[2] * aimT];
      const hand: V3 = [head[0], head[1], head[2]];
      let dir: V3 = [aim[0] - hand[0], aim[1] - hand[1], aim[2] - hand[2]];
      const l = Math.hypot(dir[0], dir[1], dir[2]) || 1;
      dir = [dir[0] / l, dir[1] / l, dir[2] / l];
      if (def.delivery === "thrown") {
        const up = upOf(head);
        dir = [dir[0] + up[0] * 0.35, dir[1] + up[1] * 0.35, dir[2] + up[2] * 0.35];
        const l2 = Math.hypot(dir[0], dir[1], dir[2]);
        dir = [dir[0] / l2, dir[1] / l2, dir[2] / l2];
      }
      const pr: Projectile = {
        id: projectileSeq++,
        owner: p,
        weapon: def,
        tier,
        damage: dmg,
        pos: hand,
        vel: [dir[0] * speed, dir[1] * speed, dir[2] * speed],
        gravity: def.gravity ?? 0,
        travelled: 0,
        maxDist: def.range * 1.2,
        pierceLeft: tier.pierce ?? 0,
        hit: new Set([p.id]),
        fuseAt: def.delivery === "thrown" ? now + (def.fuse ?? 1.6) * 1000 : null,
        stuck: false,
      };
      projectiles(host).push(pr);
      host.broadcastNear("projectile", { id: pr.id, by: p.id, weapon: WEAPON_INDEX.get(def.id), x: hand[0], y: hand[1], z: hand[2], vx: pr.vel[0], vy: pr.vel[1], vz: pr.vel[2], g: pr.gravity }, hand, 200);
      if (def.delivery === "thrown") consumeStack(p);
      return { ok: true };
    }
    default:
      return { ok: false, reason: "unsupported" };
  }
}

function consumeStack(p: PlayerActor) {
  const item = p.char.hotbar[p.char.selected];
  if (!item) return;
  item.qty -= 1;
  if (item.qty <= 0) p.char.hotbar[p.char.selected] = null;
  p.youDirty = true;
}

function jitter(d: V3, deg: number, rand: () => number): V3 {
  if (deg <= 0) return d;
  const a = ((deg * Math.PI) / 180) * Math.sqrt(rand());
  const phi = rand() * Math.PI * 2;
  // Build an orthonormal basis around d.
  const ref: V3 = Math.abs(d[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  let ux = d[1] * ref[2] - d[2] * ref[1], uy = d[2] * ref[0] - d[0] * ref[2], uz = d[0] * ref[1] - d[1] * ref[0];
  const ul = Math.hypot(ux, uy, uz);
  ux /= ul; uy /= ul; uz /= ul;
  const vx = d[1] * uz - d[2] * uy, vy = d[2] * ux - d[0] * uz, vz = d[0] * uy - d[1] * ux;
  const s = Math.sin(a), c = Math.cos(a);
  const cp = Math.cos(phi) * s, sp = Math.sin(phi) * s;
  return [d[0] * c + ux * cp + vx * sp, d[1] * c + uy * cp + vy * sp, d[2] * c + uz * cp + vz * sp];
}

/** Distance along the camera ray to the first actor (aim assist for choosing the aim point). */
function aimActorT(host: CombatHost, p: PlayerActor, o: V3, d: V3, maxT: number): number {
  const hit = raycastActors(host, o, d, maxT, new Set([p.id]), REWIND_MS);
  return hit ? hit.t : Infinity;
}

function hitscan(host: CombatHost, p: PlayerActor, o: V3, d: V3, maxRange: number, baseDamage: number, def: WeaponDef, tier: TierStats): number | null {
  const terrainT = rayTerrain(host.terrain, o, d, maxRange, 1.5);
  const hit = raycastActors(host, o, d, Math.min(maxRange, terrainT), new Set([p.id]), REWIND_MS);
  if (!hit) {
    if (terrainT < maxRange) host.onPropHit?.([o[0] + d[0] * terrainT, o[1] + d[1] * terrainT, o[2] + d[2] * terrainT], def.destroys === "heavy" ? "heavy" : "light", baseDamage);
    return terrainT === Infinity ? null : terrainT;
  }
  const f = falloff(hit.t, def.range, def.falloffTo, def.falloffMin);
  const mult = hit.weak ? (tier.headMult ?? 1.5) : 1;
  dealDamage(host, p, hit.actor, baseDamage * f * mult, hit.weak, actorFacingFrom(o, hit.actor));
  return hit.t;
}

function actorFacingFrom(from: V3, target: Actor): V3 {
  const t = actorPos(target);
  return [from[0] - t[0], from[1] - t[1], from[2] - t[2]];
}

function chain(host: CombatHost, p: PlayerActor, o: V3, d: V3, def: WeaponDef, tier: TierStats, lvl: number) {
  const now = host.now();
  const terrainT = rayTerrain(host.terrain, o, d, def.range, 1.5);
  // Generous aim: look for the actor closest to the ray within 1.2 m.
  let first: Actor | null = null;
  let bestT = Infinity;
  for (const a of allActors(host)) {
    if (a.id === p.id || !canHurt(p, a, now)) continue;
    const r = a.kind === "player" ? PLAYER_RADIUS + 0.7 : a.radius + 0.7;
    const h = a.kind === "player" ? PLAYER_HEIGHT : a.height;
    const hit = rayCapsule(o, d, Math.min(def.range, terrainT), positionAgo(a, now, REWIND_MS), r, h);
    if (hit && hit.t < bestT) {
      bestT = hit.t;
      first = a;
    }
  }
  const points: V3[] = [];
  if (first) {
    const hitSet = new Set<string>([p.id]);
    let cur: Actor | null = first;
    let dmg = tier.damage * lvl;
    for (let j = 0; cur && j <= (tier.jumps ?? 2); j++) {
      hitSet.add(cur.id);
      points.push(actorPos(cur));
      dealDamage(host, p, cur, dmg, false, actorFacingFrom(o, cur));
      dmg *= 0.7;
      let next: Actor | null = null;
      let nd = 6;
      for (const a of allActors(host)) {
        if (hitSet.has(a.id) || !canHurt(p, a, now)) continue;
        const dd = dist3(actorPos(a), actorPos(cur));
        if (dd <= nd) {
          nd = dd;
          next = a;
        }
      }
      cur = next;
    }
  }
  const end: V3 = first ? actorPos(first) : [o[0] + d[0] * Math.min(def.range, terrainT), o[1] + d[1] * Math.min(def.range, terrainT), o[2] + d[2] * Math.min(def.range, terrainT)];
  host.broadcastNear("shot", { by: p.id, weapon: WEAPON_INDEX.get(def.id), ox: o[0], oy: o[1], oz: o[2], dx: d[0], dy: d[1], dz: d[2], hit: end, chain: points }, o, 160);
}

function* allActors(host: CombatHost): Iterable<Actor> {
  yield* host.players();
  yield* host.npcs();
}

export function melee(host: CombatHost, p: PlayerActor, heavy: boolean): FireResult {
  const now = host.now();
  const { def, tier } = selectedWeapon(p);
  const meleeDef = def.delivery === "melee" ? def : WEAPONS[0]!;
  const meleeTier = def.delivery === "melee" ? tier : WEAPONS[0]!.tiers[0]!;
  // Heavy attacks need a server-timed charge (the `charge` start message) and respect cooldowns.
  let useHeavy = heavy && meleeTier.heavy !== undefined && p.chargeStartedAt > 0 && now - p.chargeStartedAt >= (meleeTier.heavyTime ?? 1) * 1000 * 0.9;
  if (useHeavy && meleeTier.cooldown && now < p.specialReadyAt) useHeavy = false;
  p.chargeStartedAt = 0;
  if (heavy && !useHeavy) return { ok: false, reason: "not charged" };
  const res = consumeAttack(p, meleeDef, meleeTier, now, 1);
  if (!res.ok) return res;
  if (useHeavy && meleeTier.cooldown) p.specialReadyAt = now + meleeTier.cooldown * 1000;
  const lvl = damageMult(p.char.level);
  const pos = actorPos(p);
  const facing: V3 = [p.state.fx, p.state.fy, p.state.fz];
  const dmg = (useHeavy ? meleeTier.heavy! : meleeTier.damage) * lvl;
  const targets: { a: Actor; d: number }[] = [];
  for (const a of allActors(host)) {
    if (a.id === p.id) continue;
    if (!canHurt(p, a, now)) continue;
    const ap = positionAgo(a, now, REWIND_MS);
    if (inMeleeArc(pos, facing, ap, meleeDef.range, meleeDef.arc ?? 90)) targets.push({ a, d: dist3(pos, ap) });
  }
  targets.sort((x, y) => x.d - y.d);
  const slam = useHeavy && !!meleeTier.radius;
  if (!slam) for (const t of targets.slice(0, meleeDef.maxTargets ?? 1)) dealDamage(host, p, t.a, dmg, false, actorFacingFrom(pos, t.a), meleeTier.knockback);
  // Hammer slam replaces the arc: radius damage around the attacker.
  if (slam && meleeTier.radius) {
    for (const a of allActors(host)) {
      if (a.id === p.id) continue;
      const d = dist3(pos, actorPos(a));
      if (d <= meleeTier.radius) dealDamage(host, p, a, dmg * (d <= meleeTier.radius / 2 ? 1 : 0.5), false, actorFacingFrom(pos, a));
    }
  }
  const reach: V3 = [pos[0] + facing[0] * meleeDef.range, pos[1] + facing[1] * meleeDef.range, pos[2] + facing[2] * meleeDef.range];
  host.onPropHit?.(reach, useHeavy || meleeDef.destroys === "heavy" ? "heavy" : "light", dmg);
  host.broadcastNear("swing", { by: p.id, weapon: WEAPON_INDEX.get(meleeDef.id), heavy: useHeavy, hits: targets.length }, pos, 120);
  return { ok: true };
}

/** Apply damage with block, armour and the safe-zone/protection rules. */
export function dealDamage(host: CombatHost, attacker: PlayerActor | NpcActor | null, target: Actor, amount: number, weak: boolean, fromDir?: V3, knockback?: number): boolean {
  const now = host.now();
  if (!canHurt(attacker, target, now)) return false;
  let dmg = amount;
  if (target.kind === "player") {
    if (target.blocking && fromDir) {
      const { tier, def } = selectedWeapon(target);
      if (def.delivery === "melee" && tier.block && tier.level <= target.char.level) {
        const f: V3 = [target.state.fx, target.state.fy, target.state.fz];
        const l = Math.hypot(fromDir[0], fromDir[1], fromDir[2]) || 1;
        const cos = (f[0] * fromDir[0] + f[1] * fromDir[1] + f[2] * fromDir[2]) / l;
        if (cos >= Math.cos((60 * Math.PI) / 180)) dmg *= 1 - tier.block;
      }
    }
    target.combatUntil = now + COMBAT_TAG_MS;
    target.logoutEndsAt = null; // damage cancels logout
    if (attacker) target.lastDamagedBy = attacker.id;
  } else {
    dmg = target.mitigate ? target.mitigate(dmg, weak, fromDir) : dmg * (target.armour ?? 1);
    if (dmg <= 0) return;
  }
  dmg = Math.max(1, Math.round(dmg));
  target.state.hp = Math.max(0, target.state.hp - dmg);
  if (target.kind === "npc") target.onDamaged?.(dmg, attacker?.id ?? "");
  const tp = actorPos(target);
  host.broadcastNear("hit", { attacker: attacker?.id ?? "", target: target.id, amount: dmg, weak, kind: target.kind, x: tp[0], y: tp[1], z: tp[2], kb: knockback ?? 0 }, tp, 120, [target.id, attacker?.id ?? ""]);
  host.onDamage(target, dmg, attacker, weak);
  return true;
}

/** Splash damage around a point (friendly fire on; the owner takes half). */
export function explode(host: CombatHost, owner: PlayerActor | NpcActor, at: V3, radius: number, damage: number, weaponIndex: number, exclude?: string) {
  for (const a of allActors(host)) {
    if (a.id === exclude) continue;
    const d = dist3(at, actorPos(a));
    if (d > radius + 0.5) continue;
    let dmg = damage * splashFalloff(Math.max(0, d - 0.5), radius);
    if (a.id === owner.id) dmg *= 0.5;
    if (dmg > 0) dealDamage(host, owner, a, dmg, false, [at[0] - actorPos(a)[0], at[1] - actorPos(a)[1], at[2] - actorPos(a)[2]], 4);
  }
  host.onPropHit?.(at, "heavy", damage);
  host.broadcastNear("explode", { id: 0, x: at[0], y: at[1], z: at[2], radius, weapon: weaponIndex }, at, 200);
}

const projectileLists = new WeakMap<CombatHost, Projectile[]>();
export function projectiles(host: CombatHost): Projectile[] {
  let l = projectileLists.get(host);
  if (!l) {
    l = [];
    projectileLists.set(host, l);
  }
  return l;
}

/** Advance projectiles by dt seconds; resolve hits, splash, fuses. */
export function stepProjectiles(host: CombatHost, dt: number) {
  const list = projectiles(host);
  const now = host.now();
  for (let i = list.length - 1; i >= 0; i--) {
    const p = list[i]!;
    if (p.fuseAt !== null && now >= p.fuseAt) {
      explode(host, p.owner, p.pos, p.tier.radius ?? 4, p.damage, WEAPON_INDEX.get(p.weapon.id) ?? 0);
      list.splice(i, 1);
      continue;
    }
    if (p.stuck) continue;
    const up = upOf(p.pos);
    p.vel[0] -= up[0] * p.gravity * dt;
    p.vel[1] -= up[1] * p.gravity * dt;
    p.vel[2] -= up[2] * p.gravity * dt;
    const step = Math.hypot(p.vel[0], p.vel[1], p.vel[2]) * dt;
    const d: V3 = [p.vel[0] * dt / step, p.vel[1] * dt / step, p.vel[2] * dt / step];
    const terrainT = rayTerrain(host.terrain, p.pos, d, step, 0.75);
    const hit = raycastActors(host, p.pos, d, Math.min(step, terrainT), p.hit, 0);
    if (hit) {
      p.hit.add(hit.actor.id);
      const mult = hit.weak ? (p.tier.headMult ?? 1.5) : 1;
      const at: V3 = [p.pos[0] + d[0] * hit.t, p.pos[1] + d[1] * hit.t, p.pos[2] + d[2] * hit.t];
      if (p.fuseAt === null) {
        const applied = dealDamage(host, p.owner, hit.actor, p.damage * mult, hit.weak, [p.pos[0] - at[0], p.pos[1] - at[1], p.pos[2] - at[2]]);
        if (applied && p.tier.burn && hit.actor.kind === "player") hit.actor.burn = { perSec: p.tier.burn, until: now + 3000, by: p.owner.id };
        // The direct-hit number already includes the blast for the victim (content.md §2.3).
        if (p.tier.splash && p.tier.radius) explode(host, p.owner, at, p.tier.radius, p.tier.splash, WEAPON_INDEX.get(p.weapon.id) ?? 0, hit.actor.id);
        if (p.pierceLeft > 0) {
          p.pierceLeft--;
        } else {
          host.broadcastNear("explode", { id: p.id, x: at[0], y: at[1], z: at[2], radius: 0, weapon: WEAPON_INDEX.get(p.weapon.id) }, at, 200);
          list.splice(i, 1);
          continue;
        }
      }
    }
    if (terrainT < step) {
      const at: V3 = [p.pos[0] + d[0] * terrainT, p.pos[1] + d[1] * terrainT, p.pos[2] + d[2] * terrainT];
      if (p.fuseAt !== null) {
        p.pos = at;
        p.stuck = true;
        continue;
      }
      if (p.tier.splash && p.tier.radius) explode(host, p.owner, at, p.tier.radius, p.tier.splash, WEAPON_INDEX.get(p.weapon.id) ?? 0);
      else {
        host.onPropHit?.(at, p.weapon.destroys === "heavy" ? "heavy" : "light", p.damage);
        host.broadcastNear("explode", { id: p.id, x: at[0], y: at[1], z: at[2], radius: 0, weapon: WEAPON_INDEX.get(p.weapon.id) }, at, 200);
      }
      list.splice(i, 1);
      continue;
    }
    p.pos = [p.pos[0] + d[0] * step, p.pos[1] + d[1] * step, p.pos[2] + d[2] * step];
    p.travelled += step;
    if (p.travelled > p.maxDist) list.splice(i, 1);
  }
}

const burnAcc = new WeakMap<PlayerActor, number>();

/** Per-tick effects on players: burn, heals over time. */
export function stepEffects(host: CombatHost, dt: number) {
  const now = host.now();
  for (const p of host.players()) {
    if (p.dead) continue;
    if (p.burn) {
      if (now > p.burn.until) p.burn = null;
      else {
        // Accumulate fractional burn so a 4/s burn deals 4/s, not 1 per tick.
        const acc = (burnAcc.get(p) ?? 0) + p.burn.perSec * dt;
        if (acc >= 1) {
          const by = [...host.players()].find((x) => x.id === p.burn!.by) ?? null;
          dealDamage(host, by, p, Math.floor(acc), false);
          burnAcc.set(p, acc - Math.floor(acc));
        } else burnAcc.set(p, acc);
      }
    }
    if (p.heals.length) {
      const mh = maxHp(p.char.level);
      let add = 0;
      p.heals = p.heals.filter((h) => {
        if (now > h.until) return false;
        add += h.perSec * dt;
        return true;
      });
      // Accumulate fractional healing so a 40 HP tonic heals 40, independent of tick length.
      p.healAcc += add;
      const whole = Math.floor(p.healAcc);
      if (whole > 0) {
        p.healAcc -= whole;
        if (p.state.hp < mh) p.state.hp = Math.min(mh, p.state.hp + whole);
      }
    }
  }
}
