// Destruction (SPEC §6.9, content.md §2.2): per-copy HP and broken set for the body's breakable
// props (shared placement in @firstlight/shared planet/breakables). Combat asks this system whether
// a shot is stopped by an intact prop and reports damage to it (CombatHost.props). A prop that runs
// out of HP breaks: `broke {id, archetype, variant, ix, iy, iz}` goes to clients near it (the
// server picks the pre-fractured variant so every client shatters it the same way), the id goes
// into BodyState.broken (id → rebuild time, synced to everyone, so late joiners see it broken),
// and after the archetype's rebuild time it comes back with `rebuilt {id}`.

import { BreakableGrid, bodyBreakables, canBreak, distanceToBreakable, FUEL_DRUM_BLAST, hash4, rayBreakable, segmentNearBreakable, type Breakable, type BreakClass } from "@firstlight/shared";
import { splashFalloff } from "@firstlight/shared/content/progression";
import { WEAPON_INDEX } from "@firstlight/shared/content/weapons";
import { actorPos, type Actor } from "./actors.ts";
import type { BodyRoom } from "./BodyRoom.ts";
import { loadCopy, roomCopyKey, saveCopy } from "./copyState.ts";
import { emitGameEvent } from "./events.ts";
import { dealDamage, type BreakableHost } from "./combat.ts";
import { splashShield } from "./support.ts";
import type { V3 } from "./geometry.ts";
import type { RoomSystem } from "./systems.ts";

export const DESTRUCTION = {
  /** Rebuild delay for every prop (ms), overriding content.md's per-archetype times. Tests set it. */
  rebuildMsOverride: null as number | null,
  /** Damage multiplier vs props per weapon id (content.md §2.3: explosives ×2). */
  propMult: { comet: 2, grenade: 2 } as Record<string, number>,
  /** Pre-fractured variants per archetype on the client (fracture.worker.ts). */
  variants: 3,
  /** `broke` / `rebuilt` go to clients within this distance (m); the synced broken map covers the rest. */
  broadcastRadius: 260,
};

/** The room surface this system needs. */
type Room = BodyRoom;

/** Broken props kept across room instances of one copy (copyState.ts, F12 B2): [prop id, rebuild time]. */
interface DestructionCopyState {
  v: 1;
  broken: [string, number][];
}

export class DestructionSystem implements RoomSystem, BreakableHost {
  readonly list: readonly Breakable[];
  readonly grid: BreakableGrid;
  /** Current HP per breakable (index = Breakable.index). */
  readonly hp: Float32Array;
  /** Rebuild time per breakable (ms since epoch); 0 = intact. */
  readonly brokenUntil: Float64Array;
  private readonly broken = new Set<number>();
  private readonly room: Room;
  private readonly now: () => number;
  private readonly candidates: number[] = [];
  private readonly rayHit = { index: -1, t: 0 };
  private readonly tmp: V3 = [0, 0, 0];
  private breaks = 0;
  /** Broken set changed since the last copy-state save (flushed at most once a second, and on dispose). */
  private copyDirty = false;
  private lastCopySave = 0;

  constructor(room: Room, now: () => number = Date.now) {
    this.room = room;
    this.now = now;
    this.list = bodyBreakables(room.terrain);
    this.grid = new BreakableGrid(this.list);
    this.hp = new Float32Array(this.list.length);
    this.brokenUntil = new Float64Array(this.list.length);
    for (const b of this.list) this.hp[b.index] = b.hp;
    this.restoreCopy();
  }

  /** A fresh room on an emptied or restarted copy keeps the props that were broken (SPEC §5.1). */
  private restoreCopy() {
    const s = loadCopy<DestructionCopyState>(roomCopyKey(this.room), "destruction");
    if (!s || s.v !== 1 || !Array.isArray(s.broken)) return;
    const now = this.now();
    const byId = new Map(this.list.map((b) => [b.id, b]));
    for (const [id, until] of s.broken) {
      const b = byId.get(id);
      if (!b || !(until > now)) continue;
      this.brokenUntil[b.index] = until;
      this.hp[b.index] = 0;
      this.broken.add(b.index);
      this.room.state.broken.set(b.id, until);
    }
  }

  private saveCopy() {
    this.copyDirty = false;
    this.lastCopySave = this.now();
    const broken: [string, number][] = [];
    for (const i of this.broken) broken.push([this.list[i]!.id, this.brokenUntil[i]!]);
    saveCopy(roomCopyKey(this.room), "destruction", broken.length ? ({ v: 1, broken } satisfies DestructionCopyState) : null);
  }

  isBroken(index: number): boolean {
    return this.brokenUntil[index]! > 0;
  }

  byId(id: string): Breakable | undefined {
    const site = Number(id.split(".")[0]);
    for (const b of this.list) if (b.site === site && b.id === id) return b;
    return undefined;
  }

  // ------------------------------------------------------------------ BreakableHost (combat.ts)

  raycast(o: V3, d: V3, maxT: number): { index: number; t: number } | null {
    if (!(maxT > 0) || this.list.length === 0) return null;
    const lim = Math.min(maxT, 400);
    const n = this.grid.collect(o[0], o[1], o[2], d[0], d[1], d[2], lim, 0, this.candidates);
    let best = Infinity, bestIdx = -1;
    for (let k = 0; k < n; k++) {
      const i = this.candidates[k]!;
      if (this.brokenUntil[i]! > 0) continue;
      const b = this.list[i]!;
      if (!segmentNearBreakable(b, o[0], o[1], o[2], d[0], d[1], d[2], lim)) continue;
      const t = rayBreakable(b, o[0], o[1], o[2], d[0], d[1], d[2], Math.min(lim, best));
      if (t < best) {
        best = t;
        bestIdx = i;
      }
    }
    if (bestIdx < 0) return null;
    this.rayHit.index = bestIdx;
    this.rayHit.t = best;
    return this.rayHit;
  }

  damage(index: number, amount: number, cls: BreakClass, weaponId: string, dir: V3, by: string | null = null, force = 1): boolean {
    const b = this.list[index];
    if (!b || this.brokenUntil[index]! > 0 || !(amount > 0)) return false;
    // Fuel drums take any hit, fists included (content.md §2.2).
    if (b.kind !== "fueldrum" && !canBreak(b.size, cls)) return false;
    this.hp[index] = this.hp[index]! - amount * (DESTRUCTION.propMult[weaponId] ?? 1);
    if (this.hp[index]! <= 0) this.breakProp(b, dir, force, by);
    return true;
  }

  splash(at: V3, radius: number, amount: number, cls: BreakClass, weaponId: string, by: string | null = null, exclude = -1, blocked?: (point: V3) => boolean): void {
    if (!(radius > 0) || cls === "none") return;
    const n = this.grid.collect(at[0], at[1], at[2], 0, 0, 0, 0, radius, this.candidates);
    // Decide every target first (a drum that goes up mid-loop can't change who else is hit).
    const hits: { i: number; dist: number }[] = [];
    for (let k = 0; k < n; k++) {
      const i = this.candidates[k]!;
      if (i === exclude || this.brokenUntil[i]! > 0) continue;
      const b = this.list[i]!;
      const dist = distanceToBreakable(b, at[0], at[1], at[2]);
      if (dist >= radius) continue;
      if (blocked?.([b.cx, b.cy, b.cz])) continue; // a Prism Bubble shell is in the way
      hits.push({ i, dist });
    }
    for (const { i, dist } of hits) {
      const b = this.list[i]!;
      const dir: V3 = [b.cx - at[0], b.cy - at[1], b.cz - at[2]];
      this.damage(i, amount * splashFalloff(dist, radius), cls, weaponId, dir, by, 2.2);
    }
  }

  arc(pos: V3, facing: V3, range: number, arcDeg: number, amount: number, cls: BreakClass, weaponId: string, by: string | null = null): void {
    // Chest height: melee swings at about 1 m above the feet.
    const l = Math.hypot(pos[0], pos[1], pos[2]);
    const ux = pos[0] / l, uy = pos[1] / l, uz = pos[2] / l;
    const cx = pos[0] + ux, cy = pos[1] + uy, cz = pos[2] + uz;
    const fl = Math.hypot(facing[0], facing[1], facing[2]) || 1;
    const cosHalf = Math.cos(((arcDeg / 2) * Math.PI) / 180);
    const n = this.grid.collect(cx, cy, cz, 0, 0, 0, 0, range + 0.5, this.candidates);
    let best = -1, bestD = Infinity;
    for (let k = 0; k < n; k++) {
      const i = this.candidates[k]!;
      if (this.brokenUntil[i]! > 0) continue;
      const b = this.list[i]!;
      const dist = distanceToBreakable(b, cx, cy, cz, this.tmp);
      if (dist > range + 0.3 || dist >= bestD) continue;
      // Angle in the tangent plane between the facing and the closest point of the prop.
      let vx = this.tmp[0] - cx, vy = this.tmp[1] - cy, vz = this.tmp[2] - cz;
      const vu = vx * ux + vy * uy + vz * uz;
      vx -= ux * vu; vy -= uy * vu; vz -= uz * vu;
      const vl = Math.hypot(vx, vy, vz);
      if (vl > 0.35 && (vx * facing[0] + vy * facing[1] + vz * facing[2]) / (vl * fl) < cosHalf) continue;
      best = i;
      bestD = dist;
    }
    if (best >= 0) this.damage(best, amount, cls, weaponId, [facing[0] / fl, facing[1] / fl, facing[2] / fl], by, 1.3);
  }

  // ------------------------------------------------------------------ breaking and rebuilding

  private breakProp(b: Breakable, dir: V3, force: number, by: string | null) {
    const now = this.now();
    const until = now + (DESTRUCTION.rebuildMsOverride ?? b.rebuildMs);
    this.brokenUntil[b.index] = until;
    this.hp[b.index] = 0;
    this.broken.add(b.index);
    this.copyDirty = true;
    this.room.state.broken.set(b.id, until);
    // The server picks the shatter variant (deterministic per prop and break count).
    const variant = hash4(b.index, ++this.breaks, 0xb4ea) % DESTRUCTION.variants;
    const dl = Math.hypot(dir[0], dir[1], dir[2]) || 1;
    this.room.broadcastNear("broke", { id: b.id, archetype: b.archetype, variant, ix: dir[0] / dl, iy: dir[1] / dl, iz: dir[2] / dl, f: force }, [b.cx, b.cy, b.cz], DESTRUCTION.broadcastRadius);
    // Quests: the Demolition Crew medal counts props a player breaks.
    emitGameEvent(this.room, { type: "propBroken", playerId: by, propId: b.id });
    if (b.kind === "fueldrum") this.blast(b, by);
  }

  /**
   * A fuel drum goes up (content.md §2.2): everyone within 3.5 m of it takes 25% of their max HP at
   * the centre falling to 8% at the edge, credited to whoever broke it (friendly fire on, like any
   * explosion; Prism Bubble shells stop it); nearby props take a heavy blast, so drums chain.
   */
  private blast(b: Breakable, by: string | null) {
    const host = this.room.host;
    const at: V3 = [b.cx, b.cy, b.cz];
    const R = FUEL_DRUM_BLAST.radius;
    const attacker = by ? (this.room.actors.get(by) ?? null) : null;
    // Shells: decided for every victim and prop first, then each intercepting shell is charged once.
    const shield = splashShield(host.bubbles, at);
    const hits: { a: Actor; d: number; p: V3 }[] = [];
    for (const a of [...host.players(), ...host.npcs()] as Actor[]) {
      if (a.kind === "npc" && a.boss) continue;
      const p = actorPos(a);
      const l = Math.hypot(p[0], p[1], p[2]) || 1;
      const chest: V3 = [p[0] + p[0] / l, p[1] + p[1] / l, p[2] + p[2] / l];
      const d = Math.min(Math.hypot(chest[0] - at[0], chest[1] - at[1], chest[2] - at[2]), Math.hypot(p[0] - at[0], p[1] - at[1], p[2] - at[2]));
      if (d > R || a.state.hp <= 0) continue;
      if (shield.blocks(chest)) continue;
      hits.push({ a, d, p });
    }
    for (const { a, d, p } of hits) {
      const share = FUEL_DRUM_BLAST.centre + (FUEL_DRUM_BLAST.edge - FUEL_DRUM_BLAST.centre) * (d / R);
      dealDamage(host, attacker, a, share * a.state.maxHp, false, [at[0] - p[0], at[1] - p[1], at[2] - p[2]], 2);
    }
    this.splash(at, R, FUEL_DRUM_BLAST.props, "heavy", "fueldrum", by, b.index, (c) => shield.blocks(c));
    shield.charge((s) => FUEL_DRUM_BLAST.props * splashFalloff(Math.max(0, Math.hypot(s.c[0] - at[0], s.c[1] - at[1], s.c[2] - at[2]) - s.r), R));
    this.room.broadcastNear("explode", { id: 0, x: at[0], y: at[1], z: at[2], radius: R, weapon: WEAPON_INDEX.get("grenade") ?? 0 }, at, 200);
  }

  rebuild(index: number) {
    const b = this.list[index];
    if (!b || this.brokenUntil[index] === 0) return;
    this.brokenUntil[index] = 0;
    this.hp[index] = b.hp;
    this.broken.delete(index);
    this.copyDirty = true;
    this.room.state.broken.delete(b.id);
    this.room.broadcastNear("rebuilt", { id: b.id }, [b.cx, b.cy, b.cz], DESTRUCTION.broadcastRadius);
  }

  /** Rebuild every broken prop within `radius` of a point (e.g. a boss arena reset). */
  rebuildNear(at: V3, radius: number) {
    for (const i of [...this.broken]) {
      const b = this.list[i]!;
      if (Math.hypot(b.cx - at[0], b.cy - at[1], b.cz - at[2]) <= radius) this.rebuild(i);
    }
  }

  tick(_dtMs: number, now: number) {
    for (const i of this.broken) if (now >= this.brokenUntil[i]!) this.rebuild(i);
    // Checkpoint breaks and rebuilds so a crash doesn't bring broken props back early (SPEC §5.1).
    if (this.copyDirty && now - this.lastCopySave >= 1000) this.saveCopy();
  }

  dispose() {
    this.saveCopy();
    if (this.room.host?.props === this) this.room.host.props = undefined;
  }
}

/** SYSTEM_FACTORIES entry: one destruction system per room copy, hooked into combat. */
export function createDestructionSystem(room: BodyRoom): RoomSystem | null {
  if (room.bodyDef.terrain.kind === "hub") return null; // Portus never breaks
  const sys = new DestructionSystem(room);
  room.host.props = sys;
  return sys;
}
