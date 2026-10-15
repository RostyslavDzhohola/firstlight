// Server-authoritative combat: hitscan with lag compensation, pellets, chain lightning, melee arcs,
// simulated projectiles with splash, damage rules (safe zones, protection, friendly fire on),
// blocking, burn, healing. The room calls these from message handlers and the tick.

import { damageMult, falloff, maxHp, splashFalloff } from "@firstlight/shared/content/progression";
import { WEAPONS, WEAPON_INDEX, type Destroys, type TierStats, type WeaponDef } from "@firstlight/shared/content/weapons";
import type { Terrain } from "@firstlight/shared";
import { NET } from "@firstlight/shared/net/protocol";
import { PF } from "@firstlight/shared/net/schema";
import { actorPos, mountedAt, positionAgo, type Actor, type NpcActor, type PlayerActor } from "./actors.ts";
import { noteKnockback } from "./movement.ts";
import { dist3, HEAD_FROM, inMeleeArc, PLAYER_HEIGHT, PLAYER_RADIUS, rayCapsule, rayTerrain, type V3 } from "./geometry.ts";
import { splashShield, type BubbleHost } from "./support.ts";
import { HORSE } from "@firstlight/shared/content/horse";

/** Lag compensation window: the one shared constant (SPEC §5.3: history ≤ 200 ms). */
export const REWIND_MS = NET.REWIND_MS;
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
  /** Report where an attack landed (the NPC lane's boss-arena cover listens; npc/boss.ts). */
  onPropHit?(point: V3, power: "light" | "heavy", amount: number): void;
  /** Breakable props (set by destruction.ts): intact ones stop shots and take damage. */
  props?: BreakableHost;
  /**
   * Indestructible structures (planet/sites.ts: Portus' town, the planets' pad outposts; set by
   * BodyRoom, D43): they stop shots, projectiles, chain bolts, line of sight, NPC sight and bolts,
   * and shelter whoever stands behind them from blasts. Never damaged.
   */
  walls?: WallHost;
  /** Prism Bubbles (set by support.ts): shots, projectiles and splash crossing a shell stop at it. */
  bubbles?: BubbleHost;
}

/**
 * Breakable props as seen by combat (implemented by world/destruction.ts). `cls` is the attack's
 * destruction class (the weapon's `destroys`, or "heavy" for heavy attacks); the system decides
 * whether that class can break the prop and applies weapon prop multipliers.
 */
export interface BreakableHost {
  /** First intact prop along a segment (the returned object is reused), or null. Props containing `o` are ignored. */
  raycast(o: V3, d: V3, maxT: number): { index: number; t: number } | null;
  /** Is the point inside intact prop `index`? (Stand-ins without it: never.) */
  contains?(index: number, p: V3): boolean;
  /** Movement footing at the feet: highest intact prop top under them (radius, 0 = none), and whether they're inside a prop. */
  footing?(x: number, y: number, z: number, step: number): { top: number; inside: boolean };
  /** Do feet moving straight from a to b pass through an intact prop (props the start is inside don't count)? */
  crosses?(ax: number, ay: number, az: number, bx: number, by: number, bz: number): boolean;
  /** `by`: the attacking player's session id (credit for the Demolition Crew medal), or null. */
  damage(index: number, amount: number, cls: Destroys, weaponId: string, dir: V3, by: string | null): void;
  /** `blocked(point)`: a Prism Bubble shell lies between the blast and that prop centre (skip it). */
  splash(at: V3, radius: number, amount: number, cls: Destroys, weaponId: string, by: string | null, exclude?: number, blocked?: (point: V3) => boolean): void;
  arc(pos: V3, facing: V3, range: number, arcDeg: number, amount: number, cls: Destroys, weaponId: string, by: string | null): void;
}

/** Indestructible structures as seen by combat (planet/sites.ts StructureCollider). */
export interface WallHost {
  /** Distance along a ray (unit d) to the first structure within maxT (solids the ray starts inside are ignored), or Infinity. */
  raycast(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxT: number): number;
  /** Does the segment a → b pass through a structure? */
  blocks(ax: number, ay: number, az: number, bx: number, by: number, bz: number): boolean;
}

const playerId = (a: PlayerActor | NpcActor | null): string | null => (a && a.kind === "player" ? a.id : null);

/** propOnRay's index for an indestructible structure (never damaged, nobody stands inside one). */
export const WALL_HIT = -2;

/** Does a structure lie between two points (blast lines: who a wall shelters)? */
export function wallBetween(host: CombatHost, a: V3, b: V3): boolean {
  return !!host.walls?.blocks(a[0], a[1], a[2], b[0], b[1], b[2]);
}

const propHit = { index: -1, t: Infinity };
/**
 * First intact breakable or structure along a ray, ignoring the first `skip` metres (camera rays
 * start behind the shooter's head: props there must not catch the aim). A structure returns the
 * index WALL_HIT. Returns a reused object or null.
 */
function propOnRay(host: CombatHost, o: V3, d: V3, maxT: number, skip = 0): { index: number; t: number } | null {
  if ((!host.props && !host.walls) || !(maxT > skip)) return null;
  const s: V3 = [o[0] + d[0] * skip, o[1] + d[1] * skip, o[2] + d[2] * skip];
  const h = host.props?.raycast(s, d, maxT - skip) ?? null;
  const propT = h ? h.t : Infinity;
  const wallT = host.walls ? host.walls.raycast(s[0], s[1], s[2], d[0], d[1], d[2], Math.min(maxT - skip, propT)) : Infinity;
  if (wallT < propT) {
    propHit.index = WALL_HIT;
    propHit.t = wallT + skip;
    return propHit;
  }
  if (!h) return null;
  propHit.index = h.index;
  propHit.t = h.t + skip;
  return propHit;
}

/** Distance along a camera ray to the shooter's head (where aiming starts to count). */
function behind(o: V3, d: V3, head: V3): number {
  return Math.max(0, (head[0] - o[0]) * d[0] + (head[1] - o[1]) * d[1] + (head[2] - o[2]) * d[2]);
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

/** Feet of an actor's hit capsule `ms` ago: a mounted rider's sit HORSE.riderLift up, in the saddle. */
function capsuleFeet(a: Actor, now: number, ms: number): V3 {
  const f = positionAgo(a, now, ms);
  if (a.kind !== "player" || !mountedAt(a, now - ms)) return f;
  const l = Math.hypot(f[0], f[1], f[2]);
  const k = 1 + HORSE.riderLift / l;
  return [f[0] * k, f[1] * k, f[2] * k];
}

function headPos(p: PlayerActor): V3 {
  const [x, y, z] = actorPos(p);
  const l = Math.hypot(x, y, z);
  return [x + (x / l) * 1.6, y + (y / l) * 1.6, z + (z / l) * 1.6];
}

/** Chest of an actor (splash and line-of-sight tests): 1 m above a player's feet, mid-height for NPCs. */
function chestOf(a: Actor): V3 {
  const [x, y, z] = actorPos(a);
  const l = Math.hypot(x, y, z) || 1;
  const h = a.kind === "player" ? 1.0 : Math.min(a.height * 0.5, 3);
  return [x + (x / l) * h, y + (y / l) * h, z + (z / l) * h];
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

/** Weak-point multiplier: the NPC's own (bosses) or the weapon's headshot multiplier. */
function weakMult(hit: RayTargetHit, tier: TierStats): number {
  if (!hit.weak) return 1;
  if (hit.actor.kind === "npc" && hit.actor.weakMult !== undefined) return hit.actor.weakMult;
  return tier.headMult ?? 1.5;
}

/** Nearest actor hit by a ray, using rewound positions, ignoring `ignore`. */
function raycastActors(host: CombatHost, o: V3, d: V3, maxT: number, ignore: Set<string>, rewindMs: number): RayTargetHit | null {
  let best: RayTargetHit | null = null;
  const now = host.now();
  const test = (a: Actor, r: number, h: number) => {
    if (ignore.has(a.id) || !canHurt(null, a, now)) return;
    const hit = rayCapsule(o, d, maxT, capsuleFeet(a, now, rewindMs), r, h);
    if (hit && (!best || hit.t < best.t)) {
      // NPCs with weak-point volumes (bosses) decide for themselves where the weak spot is.
      const weak = a.kind === "player" ? hit.heightAboveFeet >= HEAD_FROM : a.weakPoint ? a.weakPoint(o, d, hit.t) : hit.heightAboveFeet >= h * 0.8;
      best = { actor: a, t: hit.t, weak };
    }
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
      p.youDirty = true;
    } else p.youLazy = true; // the ammo readout catches up within ~0.4 s, not one full 'you' per shot
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
      const aimT = Math.min(maxR, rayTerrain(host.terrain, o, d, maxR, 1.5), aimActorT(host, p, o, d, maxR), propOnRay(host, o, d, maxR, behind(o, d, head))?.t ?? Infinity);
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
      const aimT = Math.min(def.range, rayTerrain(host.terrain, o, d, def.range, 2), propOnRay(host, o, d, def.range, behind(o, d, head))?.t ?? Infinity);
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
        fuseAt: def.delivery === "thrown" ? now + (tier.fuse ?? def.fuse ?? 1.6) * 1000 : null,
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

/**
 * An actor the ray reaches inside the prop that stopped it (at `propIdx`): standing in a prop is no
 * shield (F12). Null when nobody is hit there.
 */
function actorInsideProp(host: CombatHost, propIdx: number, o: V3, d: V3, maxT: number, ignore: Set<string>, rewindMs: number): RayTargetHit | null {
  if (propIdx < 0 || !host.props) return null;
  const hit = raycastActors(host, o, d, maxT, ignore, rewindMs);
  if (!hit) return null;
  return host.props.contains?.(propIdx, [o[0] + d[0] * hit.t, o[1] + d[1] * hit.t, o[2] + d[2] * hit.t]) ? hit : null;
}

function hitscan(host: CombatHost, p: PlayerActor, o: V3, d: V3, maxRange: number, baseDamage: number, def: WeaponDef, tier: TierStats): number | null {
  const terrainT = rayTerrain(host.terrain, o, d, maxRange, 1.5);
  // An intact breakable in the way stops the shot and takes it instead (destruction.ts).
  const prop = propOnRay(host, o, d, Math.min(maxRange, terrainT));
  const propT = prop ? prop.t : Infinity, propIdx = prop ? prop.index : -1;
  // A Prism Bubble shell in the way (either side) takes the shot.
  const shell = host.bubbles?.cross(o, d, Math.min(maxRange, terrainT, propT)) ?? null;
  const shellT = shell ? shell.t : Infinity;
  const ignore = new Set([p.id]);
  // Someone standing inside the prop that stops the shot is still hit (F12: props are no shield).
  const hit = raycastActors(host, o, d, Math.min(maxRange, terrainT, propT, shellT), ignore, REWIND_MS) ?? (shellT < propT ? null : actorInsideProp(host, propIdx, o, d, Math.min(maxRange, terrainT), ignore, REWIND_MS));
  if (!hit && shell) {
    host.bubbles!.absorb(shell.bubble, baseDamage * falloff(shellT, def.range, def.falloffTo, def.falloffMin));
    return shellT;
  }
  if (!hit) {
    if (propIdx >= 0) host.props!.damage(propIdx, baseDamage * falloff(propT, def.range, def.falloffTo, def.falloffMin), def.destroys, def.id, d, p.id);
    const endT = prop ? propT : terrainT;
    if (endT < maxRange) host.onPropHit?.([o[0] + d[0] * endT, o[1] + d[1] * endT, o[2] + d[2] * endT], def.destroys === "heavy" ? "heavy" : "light", baseDamage);
    return endT === Infinity ? null : endT;
  }
  const f = falloff(hit.t, def.range, def.falloffTo, def.falloffMin);
  const mult = weakMult(hit, tier);
  dealDamage(host, p, hit.actor, baseDamage * f * mult, hit.weak, actorFacingFrom(o, hit.actor));
  return hit.t;
}

function actorFacingFrom(from: V3, target: Actor): V3 {
  const t = actorPos(target);
  return [from[0] - t[0], from[1] - t[1], from[2] - t[2]];
}

/** Line of sight between two points: no terrain, intact breakable or structure in the way (shells aside). */
export function lineOfSight(host: CombatHost, a: V3, b: V3): boolean {
  const v: V3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const l = Math.hypot(v[0], v[1], v[2]);
  if (l < 1e-6) return true;
  const d: V3 = [v[0] / l, v[1] / l, v[2] / l];
  return rayTerrain(host.terrain, a, d, l, 1) >= l && !propOnRay(host, a, d, l);
}

/** The first Prism Bubble shell between two points, and where along the line it is. */
function shellBetween(host: CombatHost, a: V3, b: V3): { bubble: NonNullable<ReturnType<BubbleHost["between"]>>; at: V3 } | null {
  if (!host.bubbles) return null;
  const v: V3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const l = Math.hypot(v[0], v[1], v[2]);
  if (l < 1e-6) return null;
  const d: V3 = [v[0] / l, v[1] / l, v[2] / l];
  const hit = host.bubbles.cross(a, d, l);
  return hit ? { bubble: hit.bubble, at: [a[0] + d[0] * hit.t, a[1] + d[1] * hit.t, a[2] + d[2] * hit.t] } : null;
}

/**
 * Stormcoil (content §2.3): the camera ray only picks the first target (generous aim, 0.7 m extra);
 * the bolt is traced from the caster's head on the server and needs a clear line to it, and every
 * jump (to the nearest damageable entity within 6 m that it can see, allies included, never twice)
 * needs a clear line from the previous target (F12 review: it used to trace from the client's origin,
 * up to 7 m from the head, and jumped through cover). A Prism Bubble shell on the chosen line takes
 * that bolt or jump and ends the chain.
 */
function chain(host: CombatHost, p: PlayerActor, o: V3, d: V3, def: WeaponDef, tier: TierStats, lvl: number) {
  const now = host.now();
  const head = headPos(p);
  const skip = behind(o, d, head);
  const terrainT = rayTerrain(host.terrain, o, d, skip + def.range, 1.5);
  const prop = propOnRay(host, o, d, Math.min(skip + def.range, terrainT), skip);
  const aimEnd = Math.min(skip + def.range, terrainT, prop ? prop.t : Infinity);
  let dmg = tier.damage * lvl;
  // First target: closest to the camera ray, in front of the head, within range of the head.
  let first: Actor | null = null;
  let bestT = Infinity;
  for (const a of allActors(host)) {
    if (a.id === p.id || !canHurt(p, a, now)) continue;
    const r = a.kind === "player" ? PLAYER_RADIUS + 0.7 : a.radius + 0.7;
    const h = a.kind === "player" ? PLAYER_HEIGHT : a.height;
    const hit = rayCapsule(o, d, aimEnd, capsuleFeet(a, now, REWIND_MS), r, h);
    if (!hit || hit.t < skip || hit.t >= bestT) continue;
    if (dist3(head, chestOf(a)) > def.range + 1) continue;
    bestT = hit.t;
    first = a;
  }
  const points: V3[] = [];
  let end: V3;
  if (first && lineOfSight(host, head, chestOf(first))) {
    const shell = shellBetween(host, head, chestOf(first));
    if (shell) {
      host.bubbles!.absorb(shell.bubble, dmg);
      end = shell.at;
    } else {
      const hitSet = new Set<string>([p.id]);
      let cur: Actor | null = first;
      for (let j = 0; cur && j <= (tier.jumps ?? 2); j++) {
        hitSet.add(cur.id);
        points.push(actorPos(cur));
        dealDamage(host, p, cur, dmg, false, actorFacingFrom(j === 0 ? head : points[j - 1]!, cur));
        dmg *= 0.7;
        const from = chestOf(cur);
        let next: Actor | null = null;
        let nd = 6;
        for (const a of allActors(host)) {
          if (hitSet.has(a.id) || !canHurt(p, a, now)) continue;
          const dd = dist3(actorPos(a), actorPos(cur));
          if (dd <= nd && lineOfSight(host, from, chestOf(a))) {
            nd = dd;
            next = a;
          }
        }
        // The jump goes to the nearest visible target; a shell on that line takes it and ends the chain.
        const shellJ = next ? shellBetween(host, from, chestOf(next)) : null;
        if (shellJ) {
          host.bubbles!.absorb(shellJ.bubble, dmg);
          next = null;
        }
        cur = next;
      }
      end = actorPos(first);
    }
  } else {
    // No target (or the first is behind cover): the bolt flies from the head toward the aim point
    // and stops at the first thing in the way; an intact breakable or a bubble shell there takes it.
    const aim: V3 = first ? chestOf(first) : [o[0] + d[0] * aimEnd, o[1] + d[1] * aimEnd, o[2] + d[2] * aimEnd];
    const v: V3 = [aim[0] - head[0], aim[1] - head[1], aim[2] - head[2]];
    const l = Math.hypot(v[0], v[1], v[2]) || 1;
    const hd: V3 = [v[0] / l, v[1] / l, v[2] / l];
    const tT = rayTerrain(host.terrain, head, hd, l, 1);
    const pr = propOnRay(host, head, hd, Math.min(l, tT));
    const shell = host.bubbles?.cross(head, hd, Math.min(l, tT, pr ? pr.t : Infinity)) ?? null;
    let t = Math.min(l, tT);
    if (shell) {
      t = shell.t;
      host.bubbles!.absorb(shell.bubble, dmg);
    } else if (pr) {
      t = pr.t;
      if (pr.index >= 0) host.props!.damage(pr.index, dmg, def.destroys, def.id, hd, p.id);
    }
    end = [head[0] + hd[0] * t, head[1] + hd[1] * t, head[2] + hd[2] * t];
    // Where the bolt ends on something, report it like hitscan does (boss-arena cover listens).
    const onSomething = t < l - 1e-3 || (!first && aimEnd < skip + def.range);
    if (!shell && onSomething) host.onPropHit?.(end, def.destroys === "heavy" ? "heavy" : "light", dmg);
  }
  host.broadcastNear("shot", { by: p.id, weapon: WEAPON_INDEX.get(def.id), ox: head[0], oy: head[1], oz: head[2], dx: d[0], dy: d[1], dz: d[2], hit: end, chain: points }, head, 160);
}

function* allActors(host: CombatHost): Iterable<Actor> {
  yield* host.players();
  yield* host.npcs();
}

/** Riverstaff swings that hit, in a row (a miss or a pause longer than this resets the count). */
const STAFF_COMBO_MS = 1500;
const staffHits = new WeakMap<PlayerActor, { n: number; at: number }>();

/** Riverstaff knockback (content §2.3): only every 3rd hit in a row knocks back. */
function staffCombo(p: PlayerActor, hit: boolean, now: number): number | undefined {
  const prev = staffHits.get(p);
  const n = hit ? (prev && now - prev.at <= STAFF_COMBO_MS ? prev.n : 0) + 1 : 0;
  staffHits.set(p, { n: n % 3, at: now });
  return n === 3 ? selectedWeapon(p).tier.knockback : undefined;
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
  const kb = meleeDef.id === "riverstaff" ? staffCombo(p, targets.length > 0, now) : meleeTier.knockback;
  if (!slam) for (const t of targets.slice(0, meleeDef.maxTargets ?? 1)) dealDamage(host, p, t.a, dmg, false, actorFacingFrom(pos, t.a), kb);
  // Hammer slam replaces the arc: radius damage around the attacker.
  if (slam && meleeTier.radius) {
    for (const a of allActors(host)) {
      if (a.id === p.id) continue;
      const d = dist3(pos, actorPos(a));
      if (d <= meleeTier.radius) dealDamage(host, p, a, dmg * (d <= meleeTier.radius / 2 ? 1 : 0.5), false, actorFacingFrom(pos, a));
    }
  }
  // Breakable props in the arc (or the slam ring) take the hit too; heavy attacks are heavy class
  // (the axe's charged chop), fists break nothing (destruction.ts).
  const propCls: Destroys = useHeavy ? "heavy" : meleeDef.destroys;
  if (slam) host.props?.splash(pos, meleeTier.radius!, dmg, propCls, meleeDef.id, p.id);
  else host.props?.arc(pos, facing, meleeDef.range, meleeDef.arc ?? 90, dmg, propCls, meleeDef.id, p.id);
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
    dmg = target.mitigate ? target.mitigate(dmg, weak, fromDir, attacker) : dmg * (target.armour ?? 1);
    if (dmg <= 0) return false;
  }
  dmg = Math.max(1, Math.round(dmg));
  const hpBefore = target.state.hp;
  target.state.hp = Math.max(0, hpBefore - dmg);
  // NPC credit counts HP actually removed (an overkill hit can't outrank earlier damage).
  if (target.kind === "npc") target.onDamaged?.(hpBefore - target.state.hp, attacker?.id ?? "");
  const tp = actorPos(target);
  // Knockback: the shove direction (away from the attacker) rides on the hit; the victim's client
  // applies it, and the server widens that player's movement budget so the shove isn't "corrected".
  let kx = 0, ky = 0, kz = 0;
  if (knockback && fromDir) {
    const l = Math.hypot(fromDir[0], fromDir[1], fromDir[2]) || 1;
    kx = +(-fromDir[0] / l).toFixed(3);
    ky = +(-fromDir[1] / l).toFixed(3);
    kz = +(-fromDir[2] / l).toFixed(3);
    if (target.kind === "player") noteKnockback(target, knockback, now);
  }
  host.broadcastNear("hit", { attacker: attacker?.id ?? "", target: target.id, amount: dmg, weak, kind: target.kind, x: tp[0], y: tp[1], z: tp[2], kb: knockback ?? 0, kx, ky, kz }, tp, 120, [target.id, attacker?.id ?? ""]);
  host.onDamage(target, dmg, attacker, weak);
  return true;
}

/** Splash damage around a point (friendly fire on; the owner takes half). */
export function explode(host: CombatHost, owner: PlayerActor | NpcActor, at: V3, radius: number, damage: number, weaponIndex: number, exclude?: string, excludeProp?: number) {
  // Prism Bubble shells: decide who (and which props) they shelter before charging any of them.
  const shield = splashShield(host.bubbles, at);
  const hits: { a: Actor; d: number }[] = [];
  for (const a of allActors(host)) {
    if (a.id === exclude) continue;
    const d = dist3(at, actorPos(a));
    if (d > radius + 0.5) continue;
    if (shield.blocks(chestOf(a))) continue;
    // A structure between the blast and the victim shelters it (D43; breakables don't).
    if (wallBetween(host, at, chestOf(a))) continue;
    hits.push({ a, d });
  }
  for (const { a, d } of hits) {
    let dmg = damage * splashFalloff(Math.max(0, d - 0.5), radius);
    if (a.id === owner.id) dmg *= 0.5;
    if (dmg > 0) dealDamage(host, owner, a, dmg, false, [at[0] - actorPos(a)[0], at[1] - actorPos(a)[1], at[2] - actorPos(a)[2]], 4);
  }
  host.onPropHit?.(at, "heavy", damage);
  // Breakable props in the blast (NPC blasts count as heavy too); not through a shell.
  const w = WEAPONS[weaponIndex];
  host.props?.splash(at, radius, damage, owner.kind === "npc" ? "heavy" : (w?.destroys ?? "heavy"), w?.id ?? "", playerId(owner), excludeProp, (c) => shield.blocks(c) || wallBetween(host, at, c));
  shield.charge((b) => damage * splashFalloff(Math.max(0, dist3(at, b.c) - b.r), radius));
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
    if (!advance(host, p, d, step, now)) list.splice(i, 1);
    else if (!p.stuck && p.travelled > p.maxDist) list.splice(i, 1);
  }
}

/**
 * Move a projectile `step` metres along `d`, resolving collisions nearest first: an actor, a Prism
 * Bubble shell, an intact breakable, then terrain. A piercing bolt carries on through the rest of the
 * segment after each actor it pierces (F12 review: it used to jump the whole step, skipping a shell
 * just behind the first victim). Returns false when the projectile is gone; grenades stop (stuck)
 * against shells, props and terrain and wait for their fuse.
 */
function advance(host: CombatHost, p: Projectile, d: V3, step: number, now: number): boolean {
  const wi = WEAPON_INDEX.get(p.weapon.id) ?? 0;
  const splash = p.tier.splash && p.tier.radius ? p.tier.splash : 0;
  const burst = (at: V3) => host.broadcastNear("explode", { id: p.id, x: at[0], y: at[1], z: at[2], radius: 0, weapon: wi }, at, 200);
  const moveTo = (t: number) => {
    p.pos = [p.pos[0] + d[0] * t, p.pos[1] + d[1] * t, p.pos[2] + d[2] * t];
    p.travelled += t;
  };
  let left = step;
  for (let guard = 0; guard < 8 && left > 1e-6; guard++) {
    const o = p.pos;
    const terrainT = rayTerrain(host.terrain, o, d, left, 0.75);
    // Intact breakables stop projectiles like terrain does (destruction.ts).
    const prop = propOnRay(host, o, d, Math.min(left, terrainT));
    const propT = prop ? prop.t : Infinity, propIdx = prop ? prop.index : -1;
    // A Prism Bubble shell stops the projectile where it crosses (rockets burst against it).
    const shell = host.bubbles?.cross(o, d, Math.min(left, terrainT, propT)) ?? null;
    const shellT = shell ? shell.t : Infinity;
    const sh = shell ? shell.bubble : null;
    const hit = raycastActors(host, o, d, Math.min(left, terrainT, propT, shellT), p.hit, 0) ?? (propT < left && propT < shellT ? actorInsideProp(host, propIdx, o, d, Math.min(left, terrainT), p.hit, 0) : null);
    if (hit) {
      p.hit.add(hit.actor.id);
      const at: V3 = [o[0] + d[0] * hit.t, o[1] + d[1] * hit.t, o[2] + d[2] * hit.t];
      if (p.fuseAt === null) {
        const mult = weakMult(hit, p.tier);
        const applied = dealDamage(host, p.owner, hit.actor, p.damage * mult, hit.weak, [o[0] - at[0], o[1] - at[1], o[2] - at[2]]);
        // Burn refreshes, never stacks; NPCs burn too (F12 review).
        if (applied && p.tier.burn) {
          if (hit.actor.kind === "player") hit.actor.burn = { perSec: p.tier.burn, until: now + 3000, by: p.owner.id };
          else npcBurns(host).set(hit.actor, { perSec: p.tier.burn, until: now + 3000, by: p.owner.id, acc: 0 });
        }
        // The direct-hit number already includes the blast for the victim (content.md §2.3).
        if (splash) explode(host, p.owner, at, p.tier.radius!, splash, wi, hit.actor.id);
        if (p.pierceLeft <= 0) {
          burst(at);
          return false;
        }
        p.pierceLeft--;
      }
      // Pierced (or a grenade rolling past someone): carry on from just beyond the hit.
      const t = Math.min(left, hit.t + 0.01);
      moveTo(t);
      left -= t;
      continue;
    }
    if (sh) {
      const at: V3 = [o[0] + d[0] * shellT, o[1] + d[1] * shellT, o[2] + d[2] * shellT];
      if (p.fuseAt !== null) {
        // Grenades stop against the shell and wait for the fuse on the side they came from.
        moveTo(Math.max(0, shellT - 0.2));
        p.stuck = true;
        return true;
      }
      // The direct number includes the blast (content §2.3): the shell takes the rest from the splash.
      host.bubbles!.absorb(sh, p.damage - splash);
      const back: V3 = [at[0] - d[0] * 0.05, at[1] - d[1] * 0.05, at[2] - d[2] * 0.05];
      if (splash) explode(host, p.owner, back, p.tier.radius!, splash, wi);
      else burst(at);
      return false;
    }
    if (prop && propT < left && propT <= terrainT) {
      // A structure: the burst stays on the near side of the wall (blast lines start outside it).
      const back = propIdx === WALL_HIT ? 0.05 : 0;
      const at: V3 = [o[0] + d[0] * (propT - back), o[1] + d[1] * (propT - back), o[2] + d[2] * (propT - back)];
      if (p.fuseAt !== null) {
        // Grenades stop against the prop (or wall) and wait for the fuse.
        moveTo(Math.max(0, propT - 0.2));
        p.stuck = true;
        return true;
      }
      if (propIdx >= 0) host.props!.damage(propIdx, p.damage, p.weapon.destroys, p.weapon.id, d, playerId(p.owner));
      if (splash) explode(host, p.owner, at, p.tier.radius!, splash, wi, undefined, propIdx >= 0 ? propIdx : undefined);
      else host.onPropHit?.(at, p.weapon.destroys === "heavy" ? "heavy" : "light", p.damage);
      burst(at);
      return false;
    }
    if (terrainT < left) {
      const at: V3 = [o[0] + d[0] * terrainT, o[1] + d[1] * terrainT, o[2] + d[2] * terrainT];
      if (p.fuseAt !== null) {
        moveTo(terrainT);
        p.stuck = true;
        return true;
      }
      if (splash) explode(host, p.owner, at, p.tier.radius!, splash, wi);
      else {
        host.onPropHit?.(at, p.weapon.destroys === "heavy" ? "heavy" : "light", p.damage);
        burst(at);
      }
      return false;
    }
    moveTo(left);
    left = 0;
  }
  return true;
}

const burnAcc = new WeakMap<PlayerActor, number>();

/** Burning NPCs per room (Emberglass): the attacker's session id gets the credit. */
const npcBurnLists = new WeakMap<CombatHost, Map<NpcActor, { perSec: number; until: number; by: string; acc: number }>>();
function npcBurns(host: CombatHost) {
  let m = npcBurnLists.get(host);
  if (!m) npcBurnLists.set(host, (m = new Map()));
  return m;
}

/** Per-tick effects: burn (players and NPCs), heals over time. */
export function stepEffects(host: CombatHost, dt: number) {
  const now = host.now();
  const burning = npcBurnLists.get(host);
  if (burning?.size) {
    for (const [n, b] of burning) {
      if (n.state.hp <= 0 || now > b.until) {
        burning.delete(n);
        continue;
      }
      b.acc += b.perSec * dt;
      if (b.acc + 1e-6 >= 1) {
        const whole = Math.floor(b.acc + 1e-6);
        b.acc -= whole;
        let by: PlayerActor | null = null;
        for (const x of host.players()) if (x.id === b.by) by = x;
        dealDamage(host, by, n, whole, false);
      }
    }
  }
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
        if (h.left === undefined) {
          if (now > h.until) return false;
          add += h.perSec * dt;
          return true;
        }
        // Heals that know their total pay exactly that, however the ticks fall.
        const amt = Math.min(h.left, h.perSec * dt);
        h.left -= amt;
        add += amt;
        return h.left > 1e-6 && now <= h.until + 1000;
      });
      // Accumulate fractional healing so a 40 HP tonic heals 40, independent of tick length.
      p.healAcc += add;
      const whole = Math.floor(p.healAcc + 1e-6); // 40 × 0.75 must come to 30, not 29.999…
      if (whole > 0) {
        p.healAcc -= whole;
        if (p.state.hp < mh) p.state.hp = Math.min(mh, p.state.hp + whole);
      }
    }
  }
}
