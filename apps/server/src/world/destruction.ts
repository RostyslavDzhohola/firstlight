// Destruction (SPEC §6.9, content.md §2.2): per-copy HP and broken set for the body's breakable
// props (shared placement in @firstlight/shared planet/breakables). Combat asks this system whether
// a shot is stopped by an intact prop and reports damage to it (CombatHost.props). A prop that runs
// out of HP breaks: `broke {id, archetype, variant, ix, iy, iz}` goes to clients near it (the
// server picks the pre-fractured variant so every client shatters it the same way), the id goes
// into BodyState.broken (id → rebuild time, synced to everyone, so late joiners see it broken),
// and after the archetype's rebuild time it comes back with `rebuilt {id}`.

import { BreakableGrid, bodyBreakables, canBreak, distanceToBreakable, hash4, rayBreakable, segmentNearBreakable, type Breakable, type BreakClass } from "@firstlight/shared";
import { splashFalloff } from "@firstlight/shared/content/progression";
import type { BodyRoom } from "./BodyRoom.ts";
import { emitGameEvent } from "./events.ts";
import type { BreakableHost } from "./combat.ts";
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

  constructor(room: Room, now: () => number = Date.now) {
    this.room = room;
    this.now = now;
    this.list = bodyBreakables(room.terrain);
    this.grid = new BreakableGrid(this.list);
    this.hp = new Float32Array(this.list.length);
    this.brokenUntil = new Float64Array(this.list.length);
    for (const b of this.list) this.hp[b.index] = b.hp;
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
    if (!canBreak(b.size, cls)) return false;
    this.hp[index] = this.hp[index]! - amount * (DESTRUCTION.propMult[weaponId] ?? 1);
    if (this.hp[index]! <= 0) this.breakProp(b, dir, force, by);
    return true;
  }

  splash(at: V3, radius: number, amount: number, cls: BreakClass, weaponId: string, by: string | null = null, exclude = -1): void {
    if (!(radius > 0) || cls === "none") return;
    const n = this.grid.collect(at[0], at[1], at[2], 0, 0, 0, 0, radius, this.candidates);
    for (let k = 0; k < n; k++) {
      const i = this.candidates[k]!;
      if (i === exclude || this.brokenUntil[i]! > 0) continue;
      const b = this.list[i]!;
      const dist = distanceToBreakable(b, at[0], at[1], at[2]);
      if (dist >= radius) continue;
      const dir: V3 = [b.cx - at[0], b.cy - at[1], b.cz - at[2]];
      this.damage(i, amount * splashFalloff(dist, radius), cls, weaponId, dir, by, 2.2);
    }
  }

  arc(pos: V3, facing: V3, range: number, arcDeg: number, amount: number, cls: BreakClass, weaponId: string, by: string | null = null): void {
    if (cls === "none") return;
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
    this.room.state.broken.set(b.id, until);
    // The server picks the shatter variant (deterministic per prop and break count).
    const variant = hash4(b.index, ++this.breaks, 0xb4ea) % DESTRUCTION.variants;
    const dl = Math.hypot(dir[0], dir[1], dir[2]) || 1;
    this.room.broadcastNear("broke", { id: b.id, archetype: b.archetype, variant, ix: dir[0] / dl, iy: dir[1] / dl, iz: dir[2] / dl, f: force }, [b.cx, b.cy, b.cz], DESTRUCTION.broadcastRadius);
    // Quests: the Demolition Crew medal counts props a player breaks.
    emitGameEvent(this.room, { type: "propBroken", playerId: by, propId: b.id });
  }

  rebuild(index: number) {
    const b = this.list[index];
    if (!b || this.brokenUntil[index] === 0) return;
    this.brokenUntil[index] = 0;
    this.hp[index] = b.hp;
    this.broken.delete(index);
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
    if (this.broken.size === 0) return;
    for (const i of this.broken) if (now >= this.brokenUntil[i]!) this.rebuild(i);
  }

  dispose() {
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
