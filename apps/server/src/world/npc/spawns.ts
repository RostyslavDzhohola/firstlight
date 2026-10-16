// Deterministic spawn points for a body: per terrain chunk, hashed candidates become pack/herd homes
// (named areas raise the density and pick their own tables), plus fixed camps at named POIs and
// fixed singles (beasts, sentinels, egg NPCs). Same body → same points in every room copy.

import { CHUNK_QUADS, gridDir, hash01, hash4, nearSafeZone, padDirs, tangentFrame, type Face, type Terrain } from "@firstlight/shared";
import { siteCoords, siteDir, townDir } from "@firstlight/shared/planet/townFrame";
import { outpostAnchor } from "@firstlight/shared/planet/sites";
import { OUTPOST_GROUND_HALF, outpostGroundDistance } from "@firstlight/shared/planet/outpostGround";
import { resolveAreaDir, stableTangent, walk, type ArenaLayout } from "@firstlight/shared/content/arenas";
import {
  ARRIVAL_GROUPS, NPC_AREAS, NPC_DEFS, NPC_INDEX, NPC_RULES, PLANET_WILDS, PORTUS_WILDS, defLevels, npcDef,
  type CampChest, type FixedMember, type NpcArea, type PlanetId, type SpawnGroupDef,
} from "@firstlight/shared/content/npcs";
import type { V3 } from "../geometry.ts";
import { cross } from "./vec.ts";

export interface SpawnMember {
  def: number;
  level: number;
  /** Offset from the point in metres along t1 / t2. */
  a: number;
  b: number;
  golden?: boolean;
}

export interface SpawnPoint {
  id: number;
  kind: "pack" | "camp" | "single";
  area: string | null;
  dir: V3;
  pos: V3;
  t1: V3;
  t2: V3;
  members: SpawnMember[];
  respawnSec: number;
  roam: number;
  chest?: CampChest;
  /** Member index whose death opens the chest. */
  chestKey?: number;
}

const MIN_PAD_DIST = 40;
/** Hostile homes include room for member offsets and wandering toward the arrival pad. */
const MIN_HOSTILE_PAD_DIST = 45;
const MIN_POINT_DIST = 28;
/** Fixed groups (Portus, arrival groups): members stand this far from the home at most. */
const FIXED_SPREAD = 4;
/**
 * A group starts on open ground beside a pad outpost, not in its barn (D44): every member stands at
 * least this far (m, plus its radius) from the outpost's paving, paths and buildings.
 */
const SITE_CLEAR = 1.5;
/** Named areas get one group per this many square metres × density. */
const AREA_M2_PER_GROUP = 6000;

interface ResolvedArea {
  area: NpcArea;
  dir: V3;
}

function classify(terrain: Terrain, dir: V3): { land: boolean; meadow: boolean; ridge: boolean; shore: boolean; h: number } {
  const body = terrain.body;
  const R = body.radius;
  const w = body.waterLevel;
  const h = terrain.groundHeight(dir[0], dir[1], dir[2]);
  const t1 = stableTangent(dir);
  const t2 = cross(dir, t1);
  let slope = 0;
  let wetNear = false;
  for (const [a, b] of [[4, 0], [-4, 0], [0, 4], [0, -4]] as const) {
    const d = walk(dir, t1, a, t2, b, R);
    slope = Math.max(slope, Math.abs(terrain.groundHeight(d[0], d[1], d[2]) - h));
  }
  for (const [a, b] of [[18, 0], [-18, 0], [0, 18], [0, -18]] as const) {
    const d = walk(dir, t1, a, t2, b, R);
    if (terrain.groundHeight(d[0], d[1], d[2]) < w) wetNear = true;
  }
  const land = h >= w + 0.5 && slope < 3.5;
  return { land, meadow: land && h < w + 14 && slope < 1.5, ridge: land && (h >= w + 12 || slope >= 2), shore: land && wetNear, h };
}

function groundOk(g: SpawnGroupDef, c: ReturnType<typeof classify>): boolean {
  if (!c.land) return false;
  switch (g.ground ?? "any") {
    case "meadow":
      return c.meadow;
    case "ridge":
      return c.ridge;
    case "shore":
      return c.shore;
    default:
      return true;
  }
}

function levelFits(g: SpawnGroupDef, planet: PlanetId, lo: number, hi: number): boolean {
  return g.members.every((m) => {
    const [a, b] = defLevels(npcDef(m.kind), planet);
    return a <= hi && b >= lo;
  });
}

function clampLevel(kind: string, planet: PlanetId, level: number): number {
  const [a, b] = defLevels(npcDef(kind), planet);
  return Math.max(a, Math.min(b, level));
}

/** Pick a weighted group by a hash in [0, 1). */
function pickGroup(groups: SpawnGroupDef[], r: number): SpawnGroupDef | null {
  const total = groups.reduce((s, g) => s + g.weight, 0);
  if (total <= 0) return null;
  let x = r * total;
  for (const g of groups) {
    x -= g.weight;
    if (x < 0) return g;
  }
  return groups[groups.length - 1]!;
}

/** Members of a fixed group around its home: the first in the middle, the rest on a small ring. */
function fixedMembers(list: readonly FixedMember[]): SpawnMember[] {
  const total = list.reduce((s, m) => s + m.count, 0);
  const out: SpawnMember[] = [];
  for (const m of list) {
    for (let k = 0; k < m.count; k++) {
      const i = out.length;
      const ang = (i / total) * Math.PI * 2 + 0.4;
      const rad = i === 0 ? 0 : 2.5 + (i % 2) * 1.5;
      out.push({ def: NPC_INDEX.get(m.kind)!, level: m.level, a: Math.cos(ang) * rad, b: Math.sin(ang) * rad });
    }
  }
  return out;
}

const roamOf = (members: readonly SpawnMember[]) => (members.some((m) => NPC_DEFS[m.def]!.family === "woolback") ? 14 : 10);

/**
 * Portus outside the town walls (D-zones-1): the fixed PORTUS_WILDS groups. A hostile group whose
 * members could wander to within the NPC margin of the town is left out (npc-spawns.test.ts keeps
 * the list clean).
 */
function portusPoints(terrain: Terrain): SpawnPoint[] {
  const body = terrain.body;
  const R = body.radius;
  const points: SpawnPoint[] = [];
  for (const g of PORTUS_WILDS) {
    const members = fixedMembers(g.members);
    const roam = roamOf(members);
    const d = townDir(g.east, g.north, R);
    const dir: V3 = [d[0], d[1], d[2]];
    // Hostiles keep their whole wander room clear of the town (like the 45 m pad rule); grazers only
    // need their spread: steering keeps every NPC out of the town either way.
    const hostile = members.some((m) => NPC_DEFS[m.def]!.temper === "hostile");
    const keep = NPC_RULES.safeMargin + FIXED_SPREAD + (hostile ? roam : 0) + Math.max(...members.map((m) => NPC_DEFS[m.def]!.radius));
    const r0 = R + terrain.groundHeight(dir[0], dir[1], dir[2]);
    if (nearSafeZone(body, dir[0] * r0, dir[1] * r0, dir[2] * r0, keep)) continue;
    const t1 = stableTangent(dir);
    const t2 = cross(dir, t1);
    points.push({ id: points.length, kind: "pack", area: null, dir, pos: [dir[0] * r0, dir[1] * r0, dir[2] * r0], t1, t2, members, respawnSec: NPC_RULES.respawnPack, roam });
  }
  return points;
}

export function buildSpawnPoints(terrain: Terrain, arena: ArenaLayout | null): SpawnPoint[] {
  const body = terrain.body;
  if (body.terrain.kind === "hub") return portusPoints(terrain);
  const planet = body.id as PlanetId;
  const R = body.radius;
  const seed = body.seed;
  const pads = padDirs(body);
  const main = pads[0]!;
  const maxArc = Math.PI * R * 0.85;
  const wilds = PLANET_WILDS[planet];
  const areas: ResolvedArea[] = NPC_AREAS.filter((a) => a.planet === planet).map((a) => ({ area: a, dir: resolveAreaDir(body, a.at) }));
  const points: SpawnPoint[] = [];
  /** Packs that may carry the Golden Hopbit (egg E3), with their roll. */
  const goldenCandidates: { point: SpawnPoint; roll: number }[] = [];
  const chord = (a: readonly number[], b: readonly number[]) => Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!) * R;
  const farFromPads = (d: V3, min = MIN_PAD_DIST) => pads.every((p) => chord(p, d) >= min);
  const farFromArena = (d: V3, extra: number) => !arena || chord(arena.up, d) >= arena.radius + extra;
  const farFromPoints = (d: V3, min = MIN_POINT_DIST) => points.every((p) => chord(p.dir, d) >= min);
  const groundPos = (d: V3): V3 => {
    const r = R + terrain.groundHeight(d[0], d[1], d[2]);
    return [d[0] * r, d[1] * r, d[2] * r];
  };
  const respawnFor = (kind: SpawnPoint["kind"], defIds: number[]) => {
    if (kind === "camp") return NPC_RULES.respawnCamp;
    const defs = defIds.map((i) => npcDef(npcIdOf(i)));
    if (defs.some((d) => d.respawn === "beast")) return NPC_RULES.respawnBeast;
    if (defs.some((d) => d.respawn === "egg")) return 600;
    return NPC_RULES.respawnPack;
  };
  // A group on or beside pad 0's outpost moves to the nearest dry home (rings of 1 m round it) where
  // every member stands SITE_CLEAR off the outpost.
  const anchor = outpostAnchor(terrain);
  const siteAt: [number, number] = [0, 0];
  const membersClear = (d: V3, members: readonly SpawnMember[]) => {
    const t1 = stableTangent(d);
    const t2 = cross(d, t1);
    return members.every((m) => {
      const q = walk(d, t1, m.a, t2, m.b, R);
      const [e, n] = siteCoords(anchor, q[0], q[1], q[2], R, siteAt);
      return outpostGroundDistance(body.id, e, n) >= SITE_CLEAR + NPC_DEFS[m.def]!.radius;
    });
  };
  const clearOfSite = (d: V3, members: readonly SpawnMember[]): V3 => {
    if (chord(main, d) > OUTPOST_GROUND_HALF * 2 || membersClear(d, members)) return d;
    const [e0, n0] = siteCoords(anchor, d[0], d[1], d[2], R, [0, 0]);
    for (let ring = 1; ring <= 30; ring++) {
      for (let k = 0; k < 24; k++) {
        const a = (k / 24) * Math.PI * 2;
        const c = siteDir(anchor, e0 + Math.cos(a) * ring, n0 + Math.sin(a) * ring, R) as V3;
        if (membersClear(c, members) && classify(terrain, c).land) return c;
      }
    }
    return d;
  };
  const add = (p: Omit<SpawnPoint, "id" | "t1" | "t2" | "pos" | "respawnSec"> & { respawnSec?: number }) => {
    p = { ...p, dir: clearOfSite(p.dir, p.members) };
    const t1 = stableTangent(p.dir);
    const t2 = cross(p.dir, t1);
    for (const m of p.members) {
      if (NPC_DEFS[m.def]!.temper !== "hostile") continue;
      if (!farFromPads(p.dir, MIN_HOSTILE_PAD_DIST) || !farFromPads(walk(p.dir, t1, m.a, t2, m.b, R), MIN_HOSTILE_PAD_DIST + p.roam)) return false;
    }
    points.push({ ...p, id: points.length, pos: groundPos(p.dir), t1, t2, respawnSec: p.respawnSec ?? respawnFor(p.kind, p.members.map((m) => m.def)) });
    return true;
  };
  /** Nearest dry spot within 40 m of `d` (rings of 8 m), or null. */
  const findLand = (d: V3, padDist = MIN_PAD_DIST): V3 | null => {
    const t1 = stableTangent(d);
    const t2 = cross(d, t1);
    for (let ring = 0; ring <= 40; ring += 8) {
      const n = ring === 0 ? 1 : 8;
      for (let k = 0; k < n; k++) {
        const ang = (k / n) * Math.PI * 2;
        const c = walk(d, t1, Math.cos(ang) * ring, t2, Math.sin(ang) * ring, R);
        if (classify(terrain, c).land && farFromPads(c, padDist) && farFromArena(c, 15)) return c;
      }
    }
    return null;
  };

  // 0. Arrival groups (D-zones-2): in front of the arrival camera at the main pad, on dry ground
  // with room to graze (no water within 8 m), the hostile pack just outside the 45 m rule.
  {
    const { fwd, right } = tangentFrame([main[0], main[1], main[2]]);
    const dryAround = (d: V3) => {
      if (!classify(terrain, d).land) return false;
      const t1 = stableTangent(d);
      const t2 = cross(d, t1);
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * Math.PI * 2;
        const q = walk(d, t1, Math.cos(a) * 8, t2, Math.sin(a) * 8, R);
        if (terrain.groundHeight(q[0], q[1], q[2]) < body.waterLevel + 0.5) return false;
      }
      return true;
    };
    for (const g of ARRIVAL_GROUPS[planet]) {
      const members = fixedMembers(g.members);
      const roam = roamOf(members);
      let placed = false;
      for (let k = 0; k <= 36 && !placed; k++) {
        const off = (k % 2 ? 1 : -1) * Math.ceil(k / 2) * 10; // 0, +10, -10, +20, …
        const a = ((g.bearing + off) * Math.PI) / 180;
        for (const m of [g.metres, g.metres + 8, g.metres + 16]) {
          const d = walk(main, fwd, Math.cos(a) * m, right, Math.sin(a) * m, R);
          if (!dryAround(d) || !farFromArena(d, 25) || !farFromPoints(d)) continue;
          if (add({ kind: "pack", area: g.area ?? null, dir: d, members, roam })) {
            placed = true;
            break;
          }
        }
      }
    }
  }

  // 1. Camps at named POIs (one fixed group each).
  for (const { area, dir } of areas) {
    if (!area.camp) continue;
    // Camp members spread up to 11 m and wander 8 m from their individual homes.
    const hostile = area.camp.members.some((m) => npcDef(m.kind).temper === "hostile");
    const d = findLand(dir, hostile ? MIN_HOSTILE_PAD_DIST + 11 + 8 : MIN_PAD_DIST);
    if (!d) continue;
    const members: SpawnMember[] = [];
    let i = 0;
    let chestKey: number | undefined;
    for (const m of area.camp.members) {
      for (let k = 0; k < m.count; k++, i++) {
        const lv = m.level ?? area.levels[0] + Math.floor(hash01(seed, hashStr(area.id), i, 7) * (area.levels[1] - area.levels[0] + 1));
        const ang = (i / Math.max(1, countAll(area))) * Math.PI * 2;
        const rad = i === 0 ? 0 : 5 + (i % 3) * 3;
        if (chestKey === undefined && (npcDef(m.kind).tier === "elite")) chestKey = members.length;
        members.push({ def: NPC_INDEX.get(m.kind)!, level: clampLevel(m.kind, planet, lv), a: Math.cos(ang) * rad, b: Math.sin(ang) * rad });
      }
    }
    add({ kind: "camp", area: area.id, dir: d, members, roam: 8, chest: area.camp.chest, chestKey });
  }

  // 2. Fixed singles (beasts roam their area; sentinels and egg NPCs stand still).
  for (const { area, dir } of areas) {
    for (const [si, s] of (area.singles ?? []).entries()) {
      const t1 = stableTangent(dir);
      const off = s.offset ?? 0;
      const ang = hash01(seed, hashStr(area.id), si, 11) * Math.PI * 2;
      const t2 = cross(dir, t1);
      const def = npcDef(s.kind);
      let d = walk(dir, t1, Math.cos(ang) * off, t2, Math.sin(ang) * off, R);
      if (def.locomotion !== "wade") d = findLand(d, def.temper === "hostile" ? MIN_HOSTILE_PAD_DIST + (s.roam ?? 0) : MIN_PAD_DIST) ?? d;
      const lv = s.level ?? clampLevel(s.kind, planet, area.levels[1]);
      add({ kind: "single", area: area.id, dir: d, members: [{ def: NPC_INDEX.get(s.kind)!, level: lv, a: 0, b: 0 }], roam: s.roam ?? 0 });
    }
  }

  // Shared: turn a candidate into a pack/herd point, or null if nothing fits there.
  const tryPack = (d: V3, key: number, inArea: ResolvedArea | null): boolean => {
    if (!farFromPads(d) || !farFromArena(d, 25) || !farFromPoints(d)) return false;
    // Named camps keep their surroundings clear.
    if (areas.some((ra) => ra.area.camp && chord(ra.dir, d) < ra.area.radius + 20)) return false;
    const cls = classify(terrain, d);
    if (!cls.land) return false;
    let lo: number, hi: number;
    if (inArea) [lo, hi] = inArea.area.levels;
    else {
      const arc = Math.acos(Math.max(-1, Math.min(1, d[0] * main[0] + d[1] * main[1] + d[2] * main[2]))) * R;
      const f = Math.min(1, arc / maxArc);
      const L = Math.round(body.levels[0] + (body.levels[1] - body.levels[0]) * f);
      lo = Math.max(body.levels[0], L - 1);
      hi = Math.min(body.levels[1], L + 1);
    }
    const table = (inArea ? inArea.area.groups : wilds.groups).filter((g) => {
      if (!groundOk(g, cls) || !levelFits(g, planet, lo, hi)) return false;
      if (!g.members.some((m) => npcDef(m.kind).temper === "hostile")) return true;
      const roam = g.members.some((m) => npcDef(m.kind).family === "woolback") ? 14 : 10;
      return farFromPads(d, MIN_HOSTILE_PAD_DIST + 6 + roam);
    });
    const g = pickGroup(table, hash01(key, 4));
    if (!g) return false;
    const level = lo + Math.floor(hash01(key, 5) * (hi - lo + 1));
    const members: SpawnMember[] = [];
    let i = 0;
    for (const m of g.members) {
      const count = m.count[0] + Math.floor(hash01(key, 6, i) * (m.count[1] - m.count[0] + 1));
      for (let k = 0; k < count; k++, i++) {
        const ang = hash01(key, 8, i) * Math.PI * 2;
        const rad = 1.5 + hash01(key, 9, i) * 4.5;
        members.push({ def: NPC_INDEX.get(m.kind)!, level: clampLevel(m.kind, planet, level), a: Math.cos(ang) * rad, b: Math.sin(ang) * rad });
      }
    }
    const roll = g.goldenOneIn ? hash01(key, 10) : 1;
    if (g.goldenOneIn && roll < 1 / g.goldenOneIn) {
      members.push({ def: NPC_INDEX.get("golden_hopbit")!, level: 1, a: 3, b: 3, golden: true });
    }
    const roam = members.some((m) => npcDef(npcIdOf(m.def)).family === "woolback") ? 14 : 10;
    if (!add({ kind: "pack", area: inArea?.area.id ?? null, dir: d, members, roam })) return false;
    if (g.goldenOneIn) goldenCandidates.push({ point: points[points.length - 1]!, roll });
    return true;
  };

  // 3. Named areas: a fixed number of hashed points by area and density.
  for (const ra of areas) {
    const { area, dir } = ra;
    if (area.groups.length === 0) continue;
    const want = Math.max(1, Math.round(((area.density ?? 0.6) * Math.PI * area.radius * area.radius) / AREA_M2_PER_GROUP));
    const t1 = stableTangent(dir);
    const t2 = cross(dir, t1);
    let got = 0;
    for (let k = 0; k < want * 6 && got < want; k++) {
      const key = hash4(seed, hashStr(area.id), k, 77);
      const ang = hash01(key, 1) * Math.PI * 2;
      const rad = area.radius * Math.sqrt(hash01(key, 2));
      const d = walk(dir, t1, Math.cos(ang) * rad, t2, Math.sin(ang) * rad, R);
      if (tryPack(d, key, ra)) got++;
    }
  }

  // 4. Wilds: hashed candidates per terrain chunk, outside the named areas.
  const n = terrain.n;
  const cpf = body.chunksPerFace;
  const tmp: [number, number, number] = [0, 0, 0];
  for (let face = 0; face < 6; face++) {
    for (let cy = 0; cy < cpf; cy++) {
      for (let cx = 0; cx < cpf; cx++) {
        for (let c = 0; c < 2; c++) {
          const key = hash4(seed, face * 4096 + cx, cy, c);
          if (hash01(key, 3) >= wilds.density / 2) continue;
          const ox = (hash01(key, 1) - 0.5) * 0.8 * CHUNK_QUADS;
          const oy = (hash01(key, 2) - 0.5) * 0.8 * CHUNK_QUADS;
          gridDir(face as Face, cx * CHUNK_QUADS + CHUNK_QUADS / 2 + ox, cy * CHUNK_QUADS + CHUNK_QUADS / 2 + oy, n, tmp);
          const d: V3 = [tmp[0], tmp[1], tmp[2]];
          if (areas.some((ra) => chord(ra.dir, d) <= ra.area.radius)) continue;
          tryPack(d, key, null);
        }
      }
    }
  }
  // Egg E3 needs at least one Golden Hopbit: if no pack's 1-in-N roll came up (every planet missed
  // with the shipped seeds), the pack with the lowest roll carries it.
  if (goldenCandidates.length && !points.some((p) => p.members.some((m) => m.golden))) {
    const best = goldenCandidates.reduce((x, y) => (y.roll < x.roll ? y : x));
    best.point.members.push({ def: NPC_INDEX.get("golden_hopbit")!, level: 1, a: 3, b: 3, golden: true });
  }
  // Dawnpad's first fight is a small pack. Keep any special non-hostile member when reducing it.
  if (planet === "arcadia") {
    const packs = points.filter((p) => p.kind === "pack" && p.members.some((m) => NPC_DEFS[m.def]!.temper === "hostile"));
    const first = packs.reduce<SpawnPoint | null>((best, p) => !best || chord(p.dir, main) < chord(best.dir, main) ? p : best, null);
    if (first && first.members.length > 3) {
      const golden = first.members.filter((m) => m.golden);
      first.members = [...first.members.filter((m) => !m.golden).slice(0, 3 - golden.length), ...golden];
    }
  }
  return points;
}

const IDS: string[] = [];
function npcIdOf(index: number): string {
  if (IDS.length === 0) for (const [id, i] of NPC_INDEX) IDS[i] = id;
  return IDS[index]!;
}

function countAll(area: NpcArea): number {
  return (area.camp?.members ?? []).reduce((s, m) => s + m.count, 0);
}

function hashStr(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
