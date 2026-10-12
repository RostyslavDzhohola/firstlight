// Boss lairs: a deterministic layout computed from the shared terrain, so the server (mechanics)
// and the client (plates, cover, decals) agree without sending positions.
//
// Placement (documented for the world lane, which should build the lair props on these points):
// - Tidewrath: Glasswater Lake. Scan 36 bearings from the lake centre, find where the shore leaves
//   the water, score a 70 × 25 m strip inland, take the best. Tide Stones sit 8 m inland, 30 m apart
//   along the shore; Tidewrath's home is 15 m out in the shallows; 6 Coral Pillars stagger the strip.
// - The Hollow King: the Hollow Nave, 30% of the way from pad 10 (Tolling Tower) to pad 8; the
//   flattest dry 50 × 30 m site within 100 m; the long axis points at the tower; 8 pillars in two rows,
//   4 bone piles at the corners, the King's home at the apse end.
// - The Receiver: Foreclosure Yard 70% of the way from pad 13 to pad 17 (2.3 km from the main pad);
//   the flattest dry 70 × 50 m site within 180 m (Meridian is rugged; most pad midpoints are wet or steep); Override Consoles 32 m apart across the yard;
//   8 Freight Containers and 4 Crane Legs.

import { BODIES, type BodyDef } from "../planet/bodies.ts";
import { anchorDir, padDirs, type Dir } from "../planet/pads.ts";
import type { Terrain } from "../planet/terrain.ts";
import type { PlanetId } from "./npcs.ts";

export type Vec3 = [number, number, number];

export interface ArenaCover {
  id: number;
  kind: "coral" | "pillar" | "container" | "crane";
  pos: Vec3;
  radius: number;
  height: number;
  hp: number;
  heavyOnly: boolean;
}

export interface ArenaLayout {
  boss: string;
  body: PlanetId;
  /** Ground point at the arena centre, its up vector and the engagement radius (m). */
  centre: Vec3;
  up: Vec3;
  radius: number;
  /** Unit tangents at the centre: the long axis (inland for Tidewrath) and the side axis. */
  axis: Vec3;
  side: Vec3;
  /** Boss spawn point and its resting facing. */
  home: Vec3;
  homeFacing: Vec3;
  /** Plates (Tide Stones / Override Consoles); empty for the Hollow King. */
  plates: Vec3[];
  plateRadius: number;
  cover: ArenaCover[];
  /** Summon points (bone piles, drone bays). */
  summons: Vec3[];
  /** Tidewrath: lake centre on the water surface and the shore distance along the arena bearing. */
  lake?: { centre: Vec3; dir: Vec3; shore: number };
  /** Max distance the boss may roam from home. */
  roam: number;
}

function norm(v: readonly number[]): Vec3 {
  const l = Math.hypot(v[0]!, v[1]!, v[2]!);
  return [v[0]! / l, v[1]! / l, v[2]! / l];
}

function cross(a: readonly number[], b: readonly number[]): Vec3 {
  return [a[1]! * b[2]! - a[2]! * b[1]!, a[2]! * b[0]! - a[0]! * b[2]!, a[0]! * b[1]! - a[1]! * b[0]!];
}

/** Unit tangent at `up` pointing toward `to` (great-circle direction). */
export function tangentToward(up: readonly number[], to: readonly number[]): Vec3 {
  const d = to[0]! * up[0]! + to[1]! * up[1]! + to[2]! * up[2]!;
  const t = [to[0]! - d * up[0]!, to[1]! - d * up[1]!, to[2]! - d * up[2]!];
  const l = Math.hypot(t[0]!, t[1]!, t[2]!);
  if (l < 1e-9) return stableTangent(up);
  return [t[0]! / l, t[1]! / l, t[2]! / l];
}

export function stableTangent(up: readonly number[]): Vec3 {
  const ref = Math.abs(up[2]!) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  return tangentToward(up, ref);
}

/** Direction reached by walking `a` metres along t1 and `b` metres along t2 from `dir`. */
export function walk(dir: readonly number[], t1: readonly number[], a: number, t2: readonly number[], b: number, R: number): Vec3 {
  return norm([dir[0]! + (t1[0]! * a + t2[0]! * b) / R, dir[1]! + (t1[1]! * a + t2[1]! * b) / R, dir[2]! + (t1[2]! * a + t2[2]! * b) / R]);
}

function ground(terrain: Terrain, d: readonly number[]): Vec3 {
  const R = terrain.body.radius;
  const r = R + terrain.groundHeight(d[0]!, d[1]!, d[2]!);
  return [d[0]! * r, d[1]! * r, d[2]! * r];
}

function resolveDir(body: BodyDef, at: { lerp: [Parameters<typeof anchorDir>[1], Parameters<typeof anchorDir>[1], number] } | Parameters<typeof anchorDir>[1]): Vec3 {
  if ("lerp" in at) {
    const a = anchorDir(body, at.lerp[0]);
    const b = anchorDir(body, at.lerp[1]);
    return slerpDir(a, b, at.lerp[2]);
  }
  const d = anchorDir(body, at);
  return [d[0], d[1], d[2]];
}

/** Spherical interpolation between two unit directions. */
export function slerpDir(a: Dir, b: Dir, t: number): Vec3 {
  const dot = Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]));
  const om = Math.acos(dot);
  if (om < 1e-6) return [a[0], a[1], a[2]];
  const s = Math.sin(om);
  const ka = Math.sin((1 - t) * om) / s;
  const kb = Math.sin(t * om) / s;
  return norm([a[0] * ka + b[0] * kb, a[1] * ka + b[1] * kb, a[2] * ka + b[2] * kb]);
}

export { resolveDir as resolveAreaDir };

function minPadDistance(body: BodyDef, d: readonly number[]): number {
  let best = Infinity;
  for (const p of padDirs(body)) {
    const c = Math.hypot(p[0] - d[0]!, p[1] - d[1]!, p[2] - d[2]!) * body.radius;
    if (c < best) best = c;
  }
  return best;
}

/**
 * Flattest dry site for a rectangle (±halfLen along the axis, ±halfWid across) within `maxRange` m of
 * `nominal`. The axis points at `toward`, rotated in 45° steps only when that is clearly flatter.
 */
function findFlatSite(terrain: Terrain, nominal: Vec3, toward: Vec3, halfLen: number, halfWid: number, maxRange: number): { dir: Vec3; axis: Vec3; side: Vec3 } {
  const body = terrain.body;
  const R = body.radius;
  const t0 = stableTangent(nominal);
  const t1 = cross(nominal, t0);
  type Site = { dir: Vec3; axis: Vec3; side: Vec3; score: number };
  const found: { best: Site | null } = { best: null };
  for (let ring = 0; ring <= maxRange; ring += 15) {
    const bearings = ring === 0 ? 1 : 16;
    for (let k = 0; k < bearings; k++) {
      const ang = (k / bearings) * Math.PI * 2;
      const dir = walk(nominal, t0, Math.cos(ang) * ring, t1, Math.sin(ang) * ring, R);
      if (minPadDistance(body, dir) < Math.max(halfLen, halfWid) + 40) continue;
      const axis0 = tangentToward(dir, toward);
      const side0 = cross(dir, axis0);
      for (let rot = 0; rot < 4; rot++) {
        const c = Math.cos((rot * Math.PI) / 4), s = Math.sin((rot * Math.PI) / 4);
        const axis = norm([axis0[0] * c + side0[0] * s, axis0[1] * c + side0[1] * s, axis0[2] * c + side0[2] * s]);
        const side = cross(dir, axis);
        let lo = Infinity, hi = -Infinity;
        for (let a = -halfLen; a <= halfLen + 1e-6; a += halfLen / 3) {
          for (let b = -halfWid; b <= halfWid + 1e-6; b += halfWid / 2) {
            const d = walk(dir, axis, a, side, b, R);
            const h = terrain.groundHeight(d[0], d[1], d[2]);
            if (h < lo) lo = h;
            if (h > hi) hi = h;
          }
        }
        const score = hi - lo + (lo < body.waterLevel + 0.8 ? 100 : 0) + ring * 0.01 + rot * 0.5;
        if (!found.best || score < found.best.score) found.best = { dir, axis, side, score };
      }
    }
    if (found.best && found.best.score < 2.5 + ring * 0.01) break;
  }
  return found.best!;
}

function tidewrath(terrain: Terrain): ArenaLayout {
  const body = BODIES.arcadia;
  const R = body.radius;
  const water = body.waterLevel;
  const lakeDef = body.lakes.find((l) => l.name === "Glasswater Lake")!;
  const L = anchorDir(body, lakeDef.at);
  const Ld: Vec3 = [L[0], L[1], L[2]];
  const t0 = stableTangent(Ld);
  const t1 = cross(Ld, t0);
  let best: { out: Vec3; shore: number; score: number } | null = null;
  for (let k = 0; k < 36; k++) {
    const ang = (k / 36) * Math.PI * 2;
    const out = norm([t0[0] * Math.cos(ang) + t1[0] * Math.sin(ang), t0[1] * Math.cos(ang) + t1[1] * Math.sin(ang), t0[2] * Math.cos(ang) + t1[2] * Math.sin(ang)]);
    let shore = -1;
    for (let s = lakeDef.radius * 0.7; s < lakeDef.radius * 1.8; s += 1) {
      const d = walk(Ld, out, s, t1, 0, R);
      if (terrain.groundHeight(d[0], d[1], d[2]) >= water + 0.4) {
        shore = s;
        break;
      }
    }
    if (shore < 0) continue;
    // Score the 70 × 25 m strip inland: land, gentle, not too high; and water 10–25 m out.
    let good = 0;
    const S = walk(Ld, out, shore, t1, 0, R);
    const along = cross(S, tangentToward(S, walk(Ld, out, shore + 10, t1, 0, R)));
    const inland = tangentToward(S, walk(Ld, out, shore + 10, t1, 0, R));
    for (let a = 4; a <= 24; a += 5) {
      for (let b = -35; b <= 35; b += 7) {
        const d = walk(S, inland, a, along, b, R);
        const h = terrain.groundHeight(d[0], d[1], d[2]);
        if (h >= water + 0.3 && h <= water + 7) good++;
      }
    }
    for (let a = 10; a <= 25; a += 5) {
      const d = walk(S, inland, -a, along, 0, R);
      if (terrain.groundHeight(d[0], d[1], d[2]) < water - 1.5) good += 2;
    }
    if (minPadDistance(body, S) < 80) good -= 100;
    const score = good - k * 1e-3;
    if (!best || score > best.score) best = { out, shore, score };
  }
  const { out, shore } = best!;
  const S = walk(Ld, out, shore, t1, 0, R);
  const inland = tangentToward(S, walk(Ld, out, shore + 10, t1, 0, R));
  const along = cross(S, inland);
  const centreDir = walk(S, inland, 4, along, 0, R);
  // Tide Stones: on the shore arc 8 m inland, exactly 30 m apart (chord).
  const rStones = shore + 8;
  const theta = Math.asin(15 / rStones);
  const plates: Vec3[] = [-1, 1].map((sgn) => {
    const dir = norm([out[0] * Math.cos(theta) + cross(Ld, out)[0] * Math.sin(theta) * sgn, out[1] * Math.cos(theta) + cross(Ld, out)[1] * Math.sin(theta) * sgn, out[2] * Math.cos(theta) + cross(Ld, out)[2] * Math.sin(theta) * sgn]);
    return ground(terrain, walk(Ld, dir, rStones, t1, 0, R));
  });
  const homeDir = walk(S, inland, -15, along, 0, R);
  const hh = Math.max(terrain.groundHeight(homeDir[0], homeDir[1], homeDir[2]), water - 2.5);
  const home: Vec3 = [homeDir[0] * (R + hh), homeDir[1] * (R + hh), homeDir[2] * (R + hh)];
  const cover: ArenaCover[] = [-25, -15, -5, 5, 15, 25].map((b, i) => ({
    id: i,
    kind: "coral",
    pos: ground(terrain, walk(S, inland, i % 2 ? 16 : 12, along, b, R)),
    radius: 1.2,
    height: 4,
    hp: 400,
    heavyOnly: true,
  }));
  const lr = R + water;
  return {
    boss: "tidewrath",
    body: "arcadia",
    centre: ground(terrain, centreDir),
    up: centreDir,
    radius: 42,
    axis: tangentToward(centreDir, walk(centreDir, inland, 10, along, 0, R)),
    side: cross(centreDir, tangentToward(centreDir, walk(centreDir, inland, 10, along, 0, R))),
    home,
    homeFacing: inland,
    plates,
    plateRadius: 1.0,
    cover,
    summons: [],
    lake: { centre: [Ld[0] * lr, Ld[1] * lr, Ld[2] * lr], dir: Ld, shore },
    roam: 12,
  };
}

function hollowKing(terrain: Terrain): ArenaLayout {
  const body = BODIES.hollowmere;
  const R = body.radius;
  const pads = padDirs(body);
  const tower = pads[10]!;
  const nominal = slerpDir(tower, pads[8]!, 0.3);
  const site = findFlatSite(terrain, nominal, [tower[0], tower[1], tower[2]], 25, 15, 100);
  const { dir, axis, side } = site;
  const at = (a: number, b: number) => ground(terrain, walk(dir, axis, a, side, b, R));
  const cover: ArenaCover[] = [];
  let id = 0;
  for (const a of [-18, -6, 6, 18]) for (const b of [-8, 8]) cover.push({ id: id++, kind: "pillar", pos: at(a, b), radius: 1.0, height: 9, hp: 600, heavyOnly: true });
  return {
    boss: "hollow_king",
    body: "hollowmere",
    centre: ground(terrain, dir),
    up: dir,
    radius: 30,
    axis,
    side,
    home: at(15, 0),
    homeFacing: [-axis[0], -axis[1], -axis[2]],
    plates: [],
    plateRadius: 0,
    cover,
    summons: [at(-22, -12), at(-22, 12), at(22, -12), at(22, 12)],
    roam: 24,
  };
}

function receiver(terrain: Terrain): ArenaLayout {
  const body = BODIES.meridian;
  const R = body.radius;
  const pads = padDirs(body);
  const nominal = slerpDir(pads[13]!, pads[17]!, 0.7);
  const toward = pads[17]!;
  const site = findFlatSite(terrain, nominal, [toward[0], toward[1], toward[2]], 35, 25, 180);
  const { dir, axis, side } = site;
  const at = (a: number, b: number) => ground(terrain, walk(dir, axis, a, side, b, R));
  const cover: ArenaCover[] = [];
  let id = 0;
  for (const [a, b] of [[-24, -10], [-12, 14], [-4, -18], [8, 12], [16, -12], [26, 6], [-28, 16], [20, 20]] as const) {
    cover.push({ id: id++, kind: "container", pos: at(a, b), radius: 2.2, height: 2.6, hp: 900, heavyOnly: true });
  }
  for (const [a, b] of [[-30, -22], [-30, 22], [30, -22], [30, 22]] as const) {
    cover.push({ id: id++, kind: "crane", pos: at(a, b), radius: 0.9, height: 18, hp: 1500, heavyOnly: true });
  }
  return {
    boss: "the_receiver",
    body: "meridian",
    centre: ground(terrain, dir),
    up: dir,
    radius: 40,
    axis,
    side,
    home: at(0, 0),
    homeFacing: axis,
    plates: [at(0, -16), at(0, 16)],
    plateRadius: 1.2,
    cover,
    summons: [at(-32, 0), at(32, 0)],
    roam: 20,
  };
}

const cache = new WeakMap<Terrain, ArenaLayout | null>();

/** The boss arena on this terrain's body, or null (Portus). Cached per terrain. */
export function bossArena(terrain: Terrain): ArenaLayout | null {
  if (cache.has(terrain)) return cache.get(terrain)!;
  const id = terrain.body.id;
  const a = id === "arcadia" ? tidewrath(terrain) : id === "hollowmere" ? hollowKing(terrain) : id === "meridian" ? receiver(terrain) : null;
  cache.set(terrain, a);
  return a;
}
