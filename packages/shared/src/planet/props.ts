// Deterministic per-chunk prop placement (trees, rocks, reeds, spires...). Pure function of the body
// and the chunk: every client sees the same forest, and the server can rebuild the same colliders.
//
// Candidates live on a global per-face grid (not per chunk), so results never depend on how the
// face is split into chunks. Each candidate is jittered inside its cell, placed exactly on the
// rendered triangle under it (same split as the chunk mesh), and kept only if it passes the rule:
// above water, not on steep rock, outside pad clearings and the Portus plaza.

import { bossArena } from "../content/arenas.ts";
import { objectsOn, objectDir } from "../content/world.ts";
import { bodyBreakables } from "./breakables.ts";
import { portalSpots } from "./portals.ts";
import { createNoise3, type Noise3 } from "../noise.ts";
import { hash01, hash4 } from "../rng.ts";
import type { BodyDef, BodyId } from "./bodies.ts";
import { CHUNK_QUADS, gridDir, type Face } from "./cubesphere.ts";
import { chordMetres, padDirs } from "./pads.ts";
import type { Terrain } from "./terrain.ts";
import { siteAnchor, siteCoords, townCoords, type SiteAnchor } from "./townFrame.ts";
import { townPropClear } from "./townGround.ts";
import { OUTPOST_GROUND_HALF, outpostPropClear } from "./outpostGround.ts";

const townAt: [number, number] = [0, 0];
const outpostAt: [number, number] = [0, 0];

/**
 * Bump whenever placement output changes (rules, their order, jitter, filters): clients and the
 * This versions visual vegetation only; authoritative breakable placement uses props-v2-frozen.
 * v2: jitter kept inside [0.15, 0.85] of each cell and a
 * margin at each face's far edge, so same-rule props are ≥ 0.3 cells apart even across seams.
 * v3: forest undergrowth, arena/interaction clearings and fitted-breakable exclusions.
 * v4: the Portus castle town (D38): its flat floor, a 52 m clearing inside the walls, and its roads,
 * paving, structures and trees kept clear (townGround.ts).
 * v5: the planets' pad-0 outposts (D42): their apron, paths, structures and trees kept clear
 * (outpostGround.ts).
 */
export const PROPS_VERSION = 5;

/** Jitter range inside a candidate cell (fraction of the cell), and the face-edge margin. */
export const PROP_JITTER_MIN = 0.15;

export const PROP_KINDS = ["oak", "pine", "bush", "rock", "boulder", "deadtree", "reed", "scrub", "spire", "blossom", "fern", "flower", "mushroom"] as const;
export type PropKind = (typeof PROP_KINDS)[number];

export interface PropDef {
  /** Collider radius (m) at scale 1. */
  radius: number;
  /** Collider height (m) at scale 1. */
  height: number;
  collider: "capsule" | "sphere" | "none";
}

/** Collider sizes (scale with PropInstance.scale): the solid ones block movement (propSolid). */
export const PROP_DEFS: Record<PropKind, PropDef> = {
  oak: { radius: 0.35, height: 6.5, collider: "capsule" },
  pine: { radius: 0.3, height: 8.5, collider: "capsule" },
  bush: { radius: 0.8, height: 1.1, collider: "none" },
  rock: { radius: 0.7, height: 0.9, collider: "sphere" },
  boulder: { radius: 1.7, height: 2.3, collider: "sphere" },
  deadtree: { radius: 0.3, height: 6, collider: "capsule" },
  reed: { radius: 0.4, height: 1.7, collider: "none" },
  scrub: { radius: 0.6, height: 0.9, collider: "none" },
  spire: { radius: 1.8, height: 15, collider: "capsule" },
  blossom: { radius: 0.35, height: 5.5, collider: "capsule" },
  fern: { radius: 0.5, height: 0.8, collider: "none" },
  flower: { radius: 0.4, height: 0.65, collider: "none" },
  mushroom: { radius: 0.3, height: 0.45, collider: "none" },
};

/**
 * Natural props that block movement (D-solid-1): tree trunks, boulders, spires and the bigger rocks,
 * each an upright cylinder on its surface point. `fit` shrinks the round ones a little (a cylinder
 * is wider than a rock's rounded base); rocks under `minScale` stay walk-through (no snagging on
 * pebbles). Grass, flowers, bushes, ferns, reeds, scrub and mushrooms stay walk-through.
 */
export const SOLID_PROPS: Partial<Record<PropKind, { fit: number; minScale?: number }>> = {
  oak: { fit: 1 },
  pine: { fit: 1 },
  deadtree: { fit: 1 },
  blossom: { fit: 1 },
  rock: { fit: 0.85, minScale: 0.85 },
  boulder: { fit: 0.85 },
  spire: { fit: 0.85 },
};

export const SOLID_KINDS: ReadonlySet<PropKind> = new Set(Object.keys(SOLID_PROPS) as PropKind[]);

/** The collider cylinder of a natural prop (radius, height in metres), or null when it is walk-through. */
export function propSolid(kind: PropKind, scale: number): { radius: number; height: number } | null {
  const s = SOLID_PROPS[kind];
  if (!s || scale < (s.minScale ?? 0)) return null;
  const d = PROP_DEFS[kind];
  return { radius: d.radius * scale * s.fit, height: d.height * scale };
}

export interface PropRule {
  kind: PropKind;
  /** Candidate spacing in grid quads (~3 m on planets, ~1.8 m on Portus). */
  every: number;
  /** Probability that a candidate that passes the terrain tests becomes a prop. */
  chance: number;
  /** Optional cluster mask (forests): low-frequency noise in metres; keep where noise > maskMin. */
  maskScale?: number;
  maskMin?: number;
  /** Share a forest mask with another rule so undergrowth follows its clumps. */
  maskSeed?: number;
  /** Minimum flatness = dot(surface normal, radial up). */
  minFlat: number;
  /** Height range above the water level (m). */
  minH: number;
  maxH: number;
  scale: [number, number];
}

/** No prop is ever placed on slopes steeper than this (dot(n, up) < 0.75 ≈ 41°). */
export const PROP_MIN_FLATNESS = 0.75;
/** Clearing around every fast-travel pad (m). Pads have a 12 m safe ring. */
export const PROP_PAD_CLEARANCE = 14;
/** Minimum height above the water surface for any prop (m). */
export const PROP_MIN_ABOVE_WATER = 0.05;
/**
 * No natural props inside the Portus town walls (chord metres from +Y; the walls and towers end
 * at about 49 m). Beyond, the town's roads, structures and trees keep them away (townGround.ts).
 */
export const PORTUS_PLAZA_CLEAR = 52;

export const PROP_STYLES: Record<BodyId, PropRule[]> = {
  portus: [
    { kind: "blossom", every: 4, chance: 0.22, minFlat: 0.85, minH: 0.5, maxH: 999, scale: [0.85, 1.25] },
    { kind: "rock", every: 5, chance: 0.08, minFlat: 0.78, minH: 0.3, maxH: 999, scale: [0.7, 1.3] },
    { kind: "bush", every: 4, chance: 0.12, minFlat: 0.85, minH: 0.5, maxH: 999, scale: [0.7, 1.1] },
    { kind: "flower", every: 3, chance: 0.15, minFlat: 0.85, minH: 0.5, maxH: 999, scale: [0.8, 1.2] },
  ],
  arcadia: [
    { kind: "oak", every: 2, chance: 0.6, maskScale: 140, maskMin: 0.08, minFlat: 0.84, minH: 1.0, maxH: 55, scale: [0.8, 1.35] },
    { kind: "pine", every: 2, chance: 0.5, maskScale: 110, maskMin: 0.18, minFlat: 0.8, minH: 6, maxH: 95, scale: [0.75, 1.3] },
    { kind: "bush", every: 2, chance: 0.22, maskScale: 140, maskMin: 0.08, maskSeed: 0, minFlat: 0.82, minH: 0.6, maxH: 60, scale: [0.7, 1.3] },
    { kind: "rock", every: 3, chance: 0.07, minFlat: 0.76, minH: 0.2, maxH: 999, scale: [0.6, 1.4] },
    { kind: "boulder", every: 7, chance: 0.08, minFlat: 0.78, minH: 0.5, maxH: 999, scale: [0.7, 1.3] },
    { kind: "fern", every: 2, chance: 0.18, maskScale: 140, maskMin: 0.08, maskSeed: 0, minFlat: 0.82, minH: 0.6, maxH: 60, scale: [0.7, 1.3] },
    { kind: "flower", every: 3, chance: 0.10, maskScale: 140, maskMin: 0.08, maskSeed: 0, minFlat: 0.82, minH: 0.6, maxH: 60, scale: [0.7, 1.2] },
    { kind: "mushroom", every: 3, chance: 0.12, maskScale: 140, maskMin: 0.08, maskSeed: 0, minFlat: 0.82, minH: 0.6, maxH: 50, scale: [0.7, 1.2] },
  ],
  hollowmere: [
    { kind: "deadtree", every: 2, chance: 0.3, maskScale: 120, maskMin: 0.02, minFlat: 0.8, minH: 0.8, maxH: 70, scale: [0.8, 1.45] },
    { kind: "reed", every: 1, chance: 0.6, minFlat: 0.86, minH: 0.05, maxH: 0.9, scale: [0.8, 1.3] },
    { kind: "rock", every: 3, chance: 0.07, minFlat: 0.76, minH: 0.2, maxH: 999, scale: [0.6, 1.4] },
    { kind: "boulder", every: 7, chance: 0.06, minFlat: 0.78, minH: 0.5, maxH: 999, scale: [0.7, 1.4] },
    { kind: "oak", every: 3, chance: 0.28, maskScale: 120, maskMin: 0.02, maskSeed: 0, minFlat: 0.8, minH: 1, maxH: 70, scale: [0.8, 1.3] },
    { kind: "fern", every: 2, chance: 0.12, maskScale: 120, maskMin: 0.02, maskSeed: 0, minFlat: 0.82, minH: 0.6, maxH: 40, scale: [0.7, 1.2] },
    { kind: "mushroom", every: 3, chance: 0.14, maskScale: 120, maskMin: 0.02, maskSeed: 0, minFlat: 0.82, minH: 0.6, maxH: 40, scale: [0.7, 1.2] },
  ],
  meridian: [
    { kind: "scrub", every: 2, chance: 0.13, minFlat: 0.8, minH: 0.5, maxH: 90, scale: [0.7, 1.4] },
    { kind: "spire", every: 8, chance: 0.35, maskScale: 220, maskMin: 0.0, minFlat: 0.8, minH: 2, maxH: 999, scale: [0.7, 1.6] },
    { kind: "rock", every: 3, chance: 0.08, minFlat: 0.76, minH: 0.2, maxH: 999, scale: [0.6, 1.5] },
    { kind: "boulder", every: 5, chance: 0.09, minFlat: 0.78, minH: 0.5, maxH: 999, scale: [0.7, 1.5] },
  ],
};

export interface PropInstance {
  kind: PropKind;
  /** Index into PROP_KINDS. */
  kindIndex: number;
  /** Planet-space position on the rendered surface. */
  x: number;
  y: number;
  z: number;
  scale: number;
  /** Rotation about local up (radians). */
  yaw: number;
}

export interface SurfacePoint {
  x: number;
  y: number;
  z: number;
  /** Height above the radius (m). */
  h: number;
  /** dot(triangle normal, radial up). */
  flatness: number;
}

/**
 * The point of the rendered terrain mesh at continuous face-grid coordinates (gx, gy), with the
 * flatness of its triangle. Uses the same triangle split as buildChunk / groundHeight.
 */
export function surfaceAtGrid(terrain: Terrain, face: Face, gx: number, gy: number, out: SurfacePoint): SurfacePoint {
  const n = terrain.n;
  const R = terrain.body.radius;
  const i = Math.min(n - 1, Math.max(0, Math.floor(gx)));
  const j = Math.min(n - 1, Math.max(0, Math.floor(gy)));
  const fx = gx - i;
  const fy = gy - j;
  let bi: number, bj: number, ci: number, cj: number, wb: number, wc: number;
  if (fx >= fy) {
    // (i,j)(i+1,j)(i+1,j+1): p = a + fx·(b - a)... in barycentric form
    bi = i + 1; bj = j; ci = i + 1; cj = j + 1;
    wb = fx - fy;
    wc = fy;
  } else {
    bi = i + 1; bj = j + 1; ci = i; cj = j + 1;
    wb = fx;
    wc = fy - fx;
  }
  const wa = 1 - wb - wc;
  const da: [number, number, number] = [0, 0, 0];
  const db: [number, number, number] = [0, 0, 0];
  const dc: [number, number, number] = [0, 0, 0];
  gridDir(face, i, j, n, da);
  gridDir(face, bi, bj, n, db);
  gridDir(face, ci, cj, n, dc);
  const ra = R + terrain.vertexHeight(face, i, j);
  const rb = R + terrain.vertexHeight(face, bi, bj);
  const rc = R + terrain.vertexHeight(face, ci, cj);
  const ax = da[0] * ra, ay = da[1] * ra, az = da[2] * ra;
  const bx = db[0] * rb, by = db[1] * rb, bz = db[2] * rb;
  const cx = dc[0] * rc, cy = dc[1] * rc, cz = dc[2] * rc;
  const x = ax * wa + bx * wb + cx * wc;
  const y = ay * wa + by * wb + cy * wc;
  const z = az * wa + bz * wb + cz * wc;
  const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
  const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
  let nx = e1y * e2z - e1z * e2y;
  let ny = e1z * e2x - e1x * e2z;
  let nz = e1x * e2y - e1y * e2x;
  const nl = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
  nx /= nl; ny /= nl; nz /= nl;
  const l = Math.sqrt(x * x + y * y + z * z);
  let flat = (nx * x + ny * y + nz * z) / l;
  if (flat < 0) flat = -flat;
  out.x = x;
  out.y = y;
  out.z = z;
  out.h = l - R;
  out.flatness = flat;
  return out;
}

const maskNoise = new Map<string, Noise3>();
function maskFor(body: BodyDef, rule: number): Noise3 {
  const key = `${body.id}:${rule}`;
  let nz = maskNoise.get(key);
  if (!nz) {
    nz = createNoise3(body.seed + 7001 + rule * 131);
    maskNoise.set(key, nz);
  }
  return nz;
}

/**
 * Props whose candidate lands inside chunk (face, cx, cy). Deterministic and order-stable. `only`:
 * just these kinds (each rule is independent, so the result is exactly that subset).
 */
export function naturalChunkProps(terrain: Terrain, face: Face, cx: number, cy: number, only?: ReadonlySet<PropKind>): PropInstance[] {
  const body = terrain.body;
  const rules = PROP_STYLES[body.id];
  const out: PropInstance[] = [];
  const q = CHUNK_QUADS;
  const i0 = cx * q, j0 = cy * q;
  const i1 = i0 + q, j1 = j0 + q;
  const pads = body.terrain.kind === "hub" ? [] : padDirs(body);
  const hub = body.terrain.kind === "hub";
  const n = terrain.n;
  const R = body.radius;
  const sp: SurfacePoint = { x: 0, y: 0, z: 0, h: 0, flatness: 0 };
  const arena = bossArena(terrain);
  const clearings = [
    ...(arena ? [{ dir: arena.up, radius: arena.radius + 6 }] : []),
    ...objectsOn(body.id).map((o) => ({ dir: objectDir(o), radius: Math.max(2, o.range) + 4 })),
    ...portalSpots(body, terrain).map((o) => ({ dir: o.dir, radius: 6 })),
  ];
  const faceSeed = hash4(body.seed, face, 0x5eed);
  // The pad-0 outpost (D42): its frame, to test props near pad 0 against its ground mask.
  const outpost: SiteAnchor | null = hub ? null : siteAnchor(pads[0]!);
  const outpostReach = (OUTPOST_GROUND_HALF * 1.45) / R; // chord (unit sphere) that covers the mask's corners

  for (let r = 0; r < rules.length; r++) {
    const rule = rules[r]!;
    if (only && !only.has(rule.kind)) continue;
    const kindIndex = PROP_KINDS.indexOf(rule.kind);
    const E = rule.every;
    const minFlat = Math.max(PROP_MIN_FLATNESS, rule.minFlat);
    const minH = Math.max(PROP_MIN_ABOVE_WATER, rule.minH);
    const mask = rule.maskScale ? maskFor(body, rule.maskSeed ?? r) : null;
    // Global cells overlapping this chunk.
    const ca = Math.floor(i0 / E), cb = Math.floor((i1 - 1) / E);
    const da = Math.floor(j0 / E), db = Math.floor((j1 - 1) / E);
    for (let cj = da; cj <= db; cj++) {
      for (let ci = ca; ci <= cb; ci++) {
        const hseed = hash4(faceSeed, ci, cj, r);
        const span = 1 - 2 * PROP_JITTER_MIN;
        const gx = (ci + PROP_JITTER_MIN + span * hash01(hseed, 1)) * E;
        const gy = (cj + PROP_JITTER_MIN + span * hash01(hseed, 2)) * E;
        // The chunk that owns the jittered point owns the prop.
        if (gx < i0 || gx >= i1 || gy < j0 || gy >= j1) continue;
        // Cells start at the face's near edge; at the far edge the last cell may be partial, so keep
        // the same margin there (no near-duplicates across a cube-face seam).
        if (gx > n - PROP_JITTER_MIN * E || gy > n - PROP_JITTER_MIN * E) continue;
        if (hash01(hseed, 3) >= rule.chance) continue;
        surfaceAtGrid(terrain, face, gx, gy, sp);
        const hw = sp.h - body.waterLevel;
        if (hw < minH || hw > rule.maxH) continue;
        if (sp.flatness < minFlat) continue;
        const l = Math.sqrt(sp.x * sp.x + sp.y * sp.y + sp.z * sp.z);
        const ux = sp.x / l, uy = sp.y / l, uz = sp.z / l;
        if (mask) {
          const m = mask((ux * R) / rule.maskScale!, (uy * R) / rule.maskScale!, (uz * R) / rule.maskScale!);
          if (m < (rule.maskMin ?? 0)) continue;
        }
        let blocked = false;
        for (const p of pads) {
          if (chordMetres(p, ux, uy, uz, R) < PROP_PAD_CLEARANCE) {
            blocked = true;
            break;
          }
        }
        if (blocked) continue;
        if (clearings.some((c) => chordMetres(c.dir, ux, uy, uz, R) < c.radius)) continue;
        if (hub) {
          const dx = ux, dy = uy - 1, dz = uz;
          if (Math.sqrt(dx * dx + dy * dy + dz * dz) * R < PORTUS_PLAZA_CLEAR) continue;
          // The castle town (D38): not on its roads or paving, by its structures or under its trees.
          townCoords(ux, uy, uz, R, townAt);
          if (!townPropClear(townAt[0], townAt[1])) continue;
        } else if (outpost && chordMetres(pads[0]!, ux, uy, uz, 1) < outpostReach) {
          siteCoords(outpost, ux, uy, uz, R, outpostAt);
          if (!outpostPropClear(body.id, outpostAt[0], outpostAt[1])) continue;
        }
        const s = rule.scale[0] + (rule.scale[1] - rule.scale[0]) * hash01(hseed, 4);
        out.push({ kind: rule.kind, kindIndex, x: sp.x, y: sp.y, z: sp.z, scale: s, yaw: hash01(hseed, 5) * Math.PI * 2 });
      }
    }
  }
  return out;
}

/** Breakables yield to the frozen v2 solid placement, then all visual vegetation yields to the
 * authoritative fitted breakable footprints. This avoids a props -> breakables -> props recursion.
 * Portus' castle town keeps its own walls, roads and paving clear (naturalChunkProps, D38);
 * elsewhere there are no separate path meshes. Portal approaches and quest interactions have
 * their own clearings. */
export function chunkProps(terrain: Terrain, face: Face, cx: number, cy: number): PropInstance[] {
  return clearOfBreakables(terrain, naturalChunkProps(terrain, face, cx, cy));
}

/**
 * The solid props of a chunk (D-solid-1): exactly the props chunkProps draws there whose propSolid
 * is not null, computed without the walk-through rules (the server and the client's collider build
 * them from this; the renderer draws chunkProps).
 */
export function solidChunkProps(terrain: Terrain, face: Face, cx: number, cy: number): PropInstance[] {
  return clearOfBreakables(terrain, naturalChunkProps(terrain, face, cx, cy, SOLID_KINDS)).filter((p) => propSolid(p.kind, p.scale) !== null);
}

function clearOfBreakables(terrain: Terrain, props: PropInstance[]): PropInstance[] {
  const breakables = bodyBreakables(terrain);
  if (breakables.length === 0) return props;
  return props.filter((p) => {
    const l = Math.hypot(p.x, p.y, p.z);
    const clearance = Math.max(1.5, PROP_DEFS[p.kind].radius * p.scale);
    return !breakables.some((b) => chordMetres([b.ux, b.uy, b.uz], p.x / l, p.y / l, p.z / l, terrain.body.radius) < b.foot + clearance);
  });
}

/** Floats per prop in the packed transfer format: kindIndex, x, y, z, scale, yaw. */
export const PROP_STRIDE = 6;

export function packProps(props: readonly PropInstance[]): Float32Array {
  const a = new Float32Array(props.length * PROP_STRIDE);
  props.forEach((p, i) => {
    const o = i * PROP_STRIDE;
    a[o] = p.kindIndex;
    a[o + 1] = p.x;
    a[o + 2] = p.y;
    a[o + 3] = p.z;
    a[o + 4] = p.scale;
    a[o + 5] = p.yaw;
  });
  return a;
}
