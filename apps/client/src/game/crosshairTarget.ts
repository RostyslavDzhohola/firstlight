// What the crosshair is on (one query, D-controls-5 and the spellbook): the creature or player nearest
// the camera ray, unless the ground or something solid comes first. Spells aim with it
// (SpellClient.crosshairPoint) and the gamepad's aim slowdown reads its kind: only a creature that is
// the nearest unobstructed thing under the crosshair slows the look (review #9), so a creep behind a
// wall or behind another player gives no help.

import * as THREE from "three/webgpu";
import { PF } from "@firstlight/shared/net/schema";
import type { Game } from "./Game.ts";

export interface Posed {
  x: number;
  y: number;
  z: number;
  flags?: number;
  hp?: number;
}

type Solid = { raycast?(o: THREE.Vector3, d: THREE.Vector3, maxT: number): number };
type Each<T> = { forEach(cb: (v: T, id: string) => void): void };

/** The scene the query reads (Game builds it with crosshairQueryOf; tests pass plain objects). */
export interface CrosshairQuery {
  /** Camera position and unit view direction. */
  o: THREE.Vector3;
  d: THREE.Vector3;
  /** Our feet (aiming starts at the head, in front of the camera). */
  me: THREE.Vector3;
  /** Planet radius and the ground's height over it along a unit direction. */
  radius: number;
  terrain: { groundHeight(nx: number, ny: number, nz: number): number };
  /** Solids with a ray test (props, structures): distance to the first hit, Infinity when none. */
  solids: readonly (Solid | null | undefined)[];
  npcs?: Each<Posed> | null;
  players?: Each<Posed> | null;
  selfId?: string | null;
}

export interface CrosshairHit {
  kind: "npc" | "player" | null;
  /** Distance along the ray from the camera. */
  t: number;
  /** The creature's or player's feet; else where the ray stops (ground, solid, or range). */
  point: THREE.Vector3;
}

const _v = new THREE.Vector3();
const _w = new THREE.Vector3();
const _s = new THREE.Vector3();

/** The nearest thing under the crosshair within `range` metres of us (see the file header). */
export function crosshairTarget(q: CrosshairQuery, range: number, out = new THREE.Vector3()): CrosshairHit {
  const { o, d, me } = q;
  const head = _v.copy(me).addScaledVector(_w.copy(me).normalize(), 1.6);
  // The camera sits behind the head: aiming starts there.
  const skip = Math.max(0, head.sub(o).dot(d));
  const max = skip + range;
  let t = max;
  for (let k = skip; k <= max; k += 1) {
    _v.copy(o).addScaledVector(d, k);
    const l = _v.length();
    if (l < q.radius + q.terrain.groundHeight(_v.x / l, _v.y / l, _v.z / l)) {
      t = k;
      break;
    }
  }
  _s.copy(o).addScaledVector(d, skip);
  for (const c of q.solids) {
    const hit = c?.raycast?.(_s, d, max - skip) ?? Infinity;
    if (skip + hit < t) t = skip + hit;
  }
  let best: Posed | null = null;
  let kind: CrosshairHit["kind"] = null;
  let bestT = t;
  const test = (p: Posed, h: number, r: number, k: "npc" | "player") => {
    _v.set(p.x, p.y, p.z);
    _v.addScaledVector(_w.copy(_v).normalize(), h).sub(o);
    const along = _v.dot(d);
    if (along < skip || along > bestT + r) return;
    if (_v.addScaledVector(d, -along).length() > r) return;
    best = p;
    kind = k;
    bestT = along;
  };
  q.npcs?.forEach((n) => {
    if ((n.hp ?? 1) > 0) test(n, 0.8, 1.3, "npc");
  });
  q.players?.forEach((p, id) => {
    if (id !== q.selfId && !((p.flags ?? 0) & PF.DEAD)) test(p, 1.0, 1.1, "player");
  });
  const hit = best as Posed | null;
  if (hit) return { kind, t: bestT, point: out.set(hit.x, hit.y, hit.z) };
  return { kind: null, t, point: out.copy(o).addScaledVector(d, t) };
}

const _o = new THREE.Vector3();
const _d = new THREE.Vector3();
const solids: (Solid | null)[] = [null, null];
const query: CrosshairQuery = { o: _o, d: _d, me: _o, radius: 1, terrain: { groundHeight: () => 0 }, solids, npcs: null, players: null, selfId: null };

/** The running game's crosshair scene (one shared object, refilled per call: no allocation). */
export function crosshairQueryOf(g: Game): CrosshairQuery {
  const cam = g.ctx.camera;
  const terrain = g.planet.terrain;
  const room = g.net.room;
  const st = room?.state as { npcs?: Each<Posed>; players?: Each<Posed> } | undefined;
  solids[0] = g.player.getColliders();
  solids[1] = g.player.getStructures();
  query.o = cam.getWorldPosition(_o);
  query.d = cam.getWorldDirection(_d);
  query.me = g.player.pos;
  query.radius = terrain.body.radius;
  query.terrain = terrain;
  query.npcs = st?.npcs ?? null;
  query.players = st?.players ?? null;
  query.selfId = room?.sessionId ?? null;
  return query;
}
