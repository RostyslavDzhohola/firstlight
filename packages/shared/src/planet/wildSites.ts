// Where the wild sites stand (content/wildSites.ts; lane world, 2026-11-13). Deterministic and shared:
// the server's movement validator, shots and NPC steering block the same walls the client draws, and
// the NPC spawns, the chest and the discovery trigger all read the same spots.
//
// Each site starts from its content anchor and takes the first spot, on rings round it, that is clear:
// dry ground under its whole footprint, gentle enough (the height spread under the footprint is
// bounded), and far enough from every pad, the boss arena, the named NPC camps, the breakable sites,
// the world objects (eggs, missions) and the sites already placed. The prefab stands on the median
// ground height of its inner footprint; its walls and skirts reach down under the ground (the Blender
// build sinks them 1–3 m), so a slope shows no gap.
//
// Solids join the structure collider (sites.ts structureCollider) after the outpost's, with `item`
// WILD_SITE_ITEM_BASE + site index, so nothing that walks the outpost layout by item meets them.

import { bossArena, resolveAreaDir } from "../content/arenas.ts";
import { NPC_AREAS } from "../content/npcs.ts";
import { offsetDir } from "../content/places.ts";
import { objectDir, objectsOn } from "../content/world.ts";
import { WILD_SITE_PREFAB_BY_NAME, WILD_SITE_PREFABS, type WildSitePrefab } from "../content/wildSitePrefabs.ts";
import { wildSitesOn, type WildSiteDef } from "../content/wildSites.ts";
import { bodyBreakables } from "./breakables.ts";
import { chordMetres, padDirs, type Dir } from "./pads.ts";
import { placeSiteItem, placeSolids, type StructureSolid } from "./sites.ts";
import type { Terrain } from "./terrain.ts";
import { siteAnchor, siteDir, type SiteAnchor, type TownPlacement } from "./townFrame.ts";

type V3 = [number, number, number];

/** `item` of a wild site's solids: this plus the site's index on its body. */
export const WILD_SITE_ITEM_BASE = 1000;

/** Placement rules (metres). */
export const WILD_SITE_RULES = {
  /** From every pad's centre to the footprint's edge (hostile camps keep 45 m + their spread off a pad). */
  padClear: 100,
  /** From the boss arena's edge, a named camp's area edge, another site's footprint. */
  arenaClear: 30,
  campClear: 25,
  siteClear: 30,
  /** From a breakable (its own footprint) and from a world object (egg, mission spot). */
  breakableClear: 3,
  objectClear: 15,
  /** The lowest ground under the footprint stands this far above the water. */
  dry: 1.0,
  /** Height spread allowed under the footprint: base + per metre of footprint radius. */
  spread: 2.0,
  spreadPerM: 0.08,
  /** Search rings round the anchor: spacing and how far out. */
  ring: 6,
  rings: 30,
} as const;

export interface WildSitePlacement {
  site: WildSiteDef;
  /** Index among the body's wild sites (wildSitesOn order) and into WILD_SITE_PREFABS. */
  index: number;
  prefabIndex: number;
  prefab: WildSitePrefab;
  /** Unit direction of the site's origin, its frame, and its base height above the radius. */
  dir: V3;
  anchor: SiteAnchor;
  base: number;
  /** The prefab's frame on the body (base at R + base). */
  frame: TownPlacement;
  /** Ground directions of the chest and the guard spots, and the lookout's position. */
  chestDir: V3;
  guardDirs: V3[];
  lookout: V3;
  /** How far the search moved the site from its content anchor (m). */
  moved: number;
}

const cache = new WeakMap<Terrain, readonly WildSitePlacement[]>();

/** Planet-space point of prefab point (x right, z front, y up) under frame `p`. */
export function prefabPoint(p: TownPlacement, x: number, z: number, y: number, out: V3 = [0, 0, 0]): V3 {
  out[0] = p.px + p.rx * x + p.fx * z + p.ux * y;
  out[1] = p.py + p.ry * x + p.fy * z + p.uy * y;
  out[2] = p.pz + p.rz * x + p.fz * z + p.uz * y;
  return out;
}

function unit(v: V3): V3 {
  const l = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / l, v[1] / l, v[2] / l];
}

/** Ground heights under a footprint of radius `foot` round `d`: centre and two rings of 12. */
function footprintHeights(terrain: Terrain, d: Dir, foot: number): { inner: number[]; all: number[] } {
  const R = terrain.body.radius;
  const a = siteAnchor([d[0], d[1], d[2]]);
  const inner: number[] = [terrain.groundHeight(d[0], d[1], d[2])];
  const all = [...inner];
  const q: V3 = [0, 0, 0];
  for (const [f, list] of [[0.5, inner], [1, all]] as const) {
    for (let k = 0; k < 12; k++) {
      const ang = (k / 12) * Math.PI * 2;
      siteDir(a, Math.cos(ang) * foot * f, Math.sin(ang) * foot * f, R, q);
      const h = terrain.groundHeight(q[0], q[1], q[2]);
      list.push(h);
      if (list !== all) all.push(h);
    }
  }
  return { inner, all };
}

function median(xs: number[]): number {
  const s = [...xs].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** Every wild site on `terrain`'s body, placed (wildSitesOn order). Deterministic; cached per terrain. */
export function wildSitePlacements(terrain: Terrain): readonly WildSitePlacement[] {
  let list = cache.get(terrain);
  if (list) return list;
  const body = terrain.body;
  const R = body.radius;
  const sites = wildSitesOn(body.id);
  const out: WildSitePlacement[] = [];
  if (sites.length === 0) {
    cache.set(terrain, out);
    return out;
  }
  const W = WILD_SITE_RULES;
  const pads = padDirs(body);
  const arena = bossArena(terrain);
  const camps = NPC_AREAS.filter((a) => a.planet === body.id && a.camp).map((a) => ({ dir: resolveAreaDir(body, a.at), radius: a.radius }));
  const breakables = bodyBreakables(terrain);
  const objects = objectsOn(body.id).map((o) => objectDir(o));
  const chord = (a: Dir, b: Dir) => chordMetres(a, b[0], b[1], b[2], R);
  const fits = (d: Dir, foot: number): number | null => {
    if (pads.some((p) => chord(p, d) < W.padClear + foot)) return null;
    if (arena && chord(arena.up, d) < arena.radius + W.arenaClear + foot) return null;
    if (camps.some((c) => chord(c.dir, d) < c.radius + W.campClear + foot)) return null;
    if (out.some((s) => chord(s.dir, d) < s.prefab.foot + W.siteClear + foot)) return null;
    if (objects.some((o) => chord(o, d) < W.objectClear + foot)) return null;
    for (const b of breakables) if (chordMetres([b.ux, b.uy, b.uz], d[0], d[1], d[2], R) < foot + b.foot + W.breakableClear) return null;
    const { inner, all } = footprintHeights(terrain, d, foot);
    let lo = Infinity, hi = -Infinity;
    for (const h of all) {
      if (h < lo) lo = h;
      if (h > hi) hi = h;
    }
    if (lo < body.waterLevel + W.dry) return null;
    if (hi - lo > W.spread + W.spreadPerM * foot) return null;
    return median(inner);
  };
  for (let i = 0; i < sites.length; i++) {
    const site = sites[i]!;
    const prefab = WILD_SITE_PREFAB_BY_NAME.get(site.prefab);
    if (!prefab) throw new Error(`wild site ${site.id}: no prefab ${site.prefab}`);
    const start = offsetDir(resolveAreaDir(body, site.at), site.east ?? 0, site.north ?? 0, R);
    const a0 = siteAnchor([start[0], start[1], start[2]]);
    let found: { d: V3; base: number; moved: number } | null = null;
    for (let ring = 0; ring <= W.rings && !found; ring++) {
      const n = ring === 0 ? 1 : 8 + ring * 2;
      for (let k = 0; k < n; k++) {
        const ang = (k / n) * Math.PI * 2 + ring * 0.37;
        const d = siteDir(a0, Math.cos(ang) * ring * W.ring, Math.sin(ang) * ring * W.ring, R) as V3;
        const base = fits(d, prefab.foot);
        if (base === null) continue;
        found = { d: [d[0], d[1], d[2]], base, moved: ring * W.ring };
        break;
      }
    }
    if (!found) throw new Error(`wild site ${site.id}: no clear spot within ${W.ring * W.rings} m of its anchor`);
    const anchor = siteAnchor(found.d);
    const prefabIndex = WILD_SITE_PREFABS.indexOf(prefab);
    const frame = placeSiteItem(anchor, 0, 0, site.yaw, R, R + found.base, {
      item: WILD_SITE_ITEM_BASE + i, prefab: prefabIndex, scale: 1,
      px: 0, py: 0, pz: 0, rx: 0, ry: 0, rz: 0, ux: 0, uy: 0, uz: 0, fx: 0, fy: 0, fz: 0,
    });
    const chestDir = unit(prefabPoint(frame, prefab.chest[0], prefab.chest[1], 0));
    const guardDirs = prefab.guards.map(([x, z]) => unit(prefabPoint(frame, x, z, 0)));
    const lookout = prefabPoint(frame, prefab.lookout[0], prefab.lookout[1], prefab.lookout[2]);
    out.push({ site, index: i, prefabIndex, prefab, dir: found.d, anchor, base: found.base, frame, chestDir, guardDirs, lookout, moved: found.moved });
  }
  list = out;
  cache.set(terrain, list);
  return list;
}

/** The wild sites' collider solids on `terrain`, numbered from `start` (their index in the collider). */
export function wildSiteSolids(terrain: Terrain, start = 0): StructureSolid[] {
  const out: StructureSolid[] = [];
  for (const p of wildSitePlacements(terrain)) placeSolids(p.frame, p.prefab.solids, out);
  for (const s of out) s.index += start;
  return out;
}

/** The wild site whose discovery ring holds planet point (x, y, z), or null. */
export function wildSiteAt(terrain: Terrain, x: number, y: number, z: number, margin: number): WildSitePlacement | null {
  const l = Math.hypot(x, y, z);
  for (const p of wildSitePlacements(terrain)) {
    if (chordMetres(p.dir, x / l, y / l, z / l, terrain.body.radius) <= p.prefab.foot + margin) return p;
  }
  return null;
}

/** Natural-prop clearings round the sites (props.ts): the footprint plus a few metres. */
export function wildSiteClearings(terrain: Terrain): { dir: Dir; radius: number }[] {
  return wildSitePlacements(terrain).map((p) => ({ dir: p.dir, radius: p.prefab.foot + 4 }));
}
