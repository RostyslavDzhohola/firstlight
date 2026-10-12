// Breakable props (SPEC §6.9, content.md §2.2): crates, barrels, fence segments, statues, pillars,
// camp walls and boss-arena cover. Placement is a pure function of the body and its terrain, so the
// server (HP, colliders, shot occlusion) and every client (meshes, debris) build the same list.
//
// Each body has a list of sites: one per fast-travel pad (cover clusters just outside the 12 m safe
// ring) followed by points of interest (camps, ruins, farms, shores, ridges, boss arenas). A site's
// template emits its items with a seeded RNG *before* any terrain test, and an item's id is
// `${site}.${slot}` of that unfiltered list, so ids never shift when an item is rejected (water,
// steep ground, a tree in the way, a safe ring). Portus has none: its buildings never break.

import { hash4, mulberry32 } from "../rng.ts";
import type { BodyDef, BodyId, FeatureAnchor } from "./bodies.ts";
import { chunkOf } from "./cubesphere.ts";
import { anchorDir, chordMetres, padDirs, PAD_SAFE_RADIUS, type Dir } from "./pads.ts";
import { chunkProps, PROP_DEFS, type PropInstance } from "./props.ts";
import { bossArena } from "../content/arenas.ts";
import { placeDir } from "../content/places.ts";
import type { Terrain } from "./terrain.ts";

// ------------------------------------------------------------------------------------ archetypes

export const BREAKABLE_ARCHETYPES = ["crate", "barrel", "fence", "statue", "pillar", "campwall", "cover", "fueldrum"] as const;
export type BreakableArchetype = (typeof BREAKABLE_ARCHETYPES)[number];

/** "light" props break to light or heavy weapons; "heavy" props only to heavy ones (content.md §2.2). */
export type BreakSize = "light" | "heavy";
/** A weapon's destruction class (same values as WeaponDef.destroys). */
export type BreakClass = "none" | "light" | "heavy";

/** Collider at scale 1 in the prop's local frame (x = right, y = up from the base, z = forward). */
export type ColliderShape =
  | { kind: "box"; hx: number; hz: number; h: number }
  | { kind: "cyl"; r: number; h: number };

export interface ArchetypeDef {
  hp: number;
  size: BreakSize;
  rebuildS: number;
  collider: ColliderShape;
  /** Largest ground-height difference under the footprint we accept (m, at scale 1). */
  maxStep: number;
}

const ARCHETYPES: Record<BreakableArchetype, ArchetypeDef> = {
  crate: { hp: 40, size: "light", rebuildS: 180, collider: { kind: "box", hx: 0.5, hz: 0.5, h: 1.0 }, maxStep: 0.4 },
  barrel: { hp: 40, size: "light", rebuildS: 180, collider: { kind: "cyl", r: 0.42, h: 1.12 }, maxStep: 0.35 },
  fence: { hp: 60, size: "light", rebuildS: 180, collider: { kind: "box", hx: 1.0, hz: 0.09, h: 1.1 }, maxStep: 0.55 },
  statue: { hp: 300, size: "heavy", rebuildS: 300, collider: { kind: "cyl", r: 0.6, h: 2.75 }, maxStep: 0.5 },
  pillar: { hp: 500, size: "heavy", rebuildS: 300, collider: { kind: "cyl", r: 0.5, h: 4.2 }, maxStep: 0.6 },
  campwall: { hp: 600, size: "heavy", rebuildS: 300, collider: { kind: "box", hx: 2.0, hz: 0.3, h: 2.6 }, maxStep: 1.1 },
  // Boss-arena cover differs per planet (content.md §4): see COVER below.
  cover: { hp: 400, size: "heavy", rebuildS: 180, collider: { kind: "cyl", r: 0.8, h: 3.0 }, maxStep: 0.9 },
  // Meridian camps only (content.md §2.2): any hit (fists too) damages it; it explodes when it breaks.
  fueldrum: { hp: 30, size: "light", rebuildS: 240, collider: { kind: "cyl", r: 0.36, h: 0.95 }, maxStep: 0.35 },
};

/**
 * Fuel drum blast (content.md §2.2): share of each victim's max HP, 25% at the centre → 8% at 3.5 m.
 * Props in the blast (and a Prism Bubble shell that stops it) take `props` with the usual falloff.
 */
export const FUEL_DRUM_BLAST = { radius: 3.5, centre: 0.25, edge: 0.08, props: 60 } as const;

/** Boss-arena cover per planet: Coral Pillars (Gull Point), Nave pillars, Freight Containers. */
const COVER: Partial<Record<BodyId, ArchetypeDef>> = {
  arcadia: { hp: 400, size: "heavy", rebuildS: 180, collider: { kind: "cyl", r: 0.8, h: 3.0 }, maxStep: 0.9 },
  hollowmere: { hp: 600, size: "heavy", rebuildS: 180, collider: { kind: "cyl", r: 0.62, h: 5.6 }, maxStep: 0.8 },
  meridian: { hp: 900, size: "heavy", rebuildS: 180, collider: { kind: "box", hx: 3.0, hz: 1.2, h: 2.6 }, maxStep: 1.3 },
};

export function archetypeDef(body: BodyId, archetype: number | BreakableArchetype): ArchetypeDef {
  const name = typeof archetype === "number" ? BREAKABLE_ARCHETYPES[archetype] : archetype;
  if (!name) throw new Error(`unknown breakable archetype ${archetype}`);
  return (name === "cover" ? COVER[body] : undefined) ?? ARCHETYPES[name];
}

export function archetypeIndex(a: BreakableArchetype): number {
  return BREAKABLE_ARCHETYPES.indexOf(a);
}

/** Can a weapon of destruction class `cls` damage a prop of size `size`? */
export function canBreak(size: BreakSize, cls: BreakClass): boolean {
  return cls === "heavy" || (cls === "light" && size === "light");
}

// ------------------------------------------------------------------------------------ instances

export interface Breakable {
  /** Stable id `${site}.${slot}` (also the key of BodyState.broken). */
  id: string;
  /** Index in the body's list (a cheap handle; not sent over the wire). */
  index: number;
  site: number;
  archetype: number;
  kind: BreakableArchetype;
  /** Base centre (on the ground, planet space) and the local frame: right (x), up (y), forward (z). */
  px: number; py: number; pz: number;
  rx: number; ry: number; rz: number;
  ux: number; uy: number; uz: number;
  fx: number; fy: number; fz: number;
  scale: number;
  hp: number;
  size: BreakSize;
  rebuildMs: number;
  /** 0 = box (hx, hz half extents), 1 = cylinder (radius hx = hz). Height h. All scaled. */
  shape: 0 | 1;
  hx: number;
  hz: number;
  h: number;
  /** Collider centre and bounding-sphere radius (broadphase). */
  cx: number; cy: number; cz: number;
  bound: number;
  /** Horizontal footprint radius (overlap checks). */
  foot: number;
}

// ------------------------------------------------------------------------------------ geometry

type V3 = [number, number, number];

function norm(x: number, y: number, z: number): V3 {
  const l = Math.sqrt(x * x + y * y + z * z);
  return [x / l, y / l, z / l];
}

/** Local frame at `up`: north = +Z (or +X near the Z poles) projected on the tangent plane; east = north × up. */
function frameAt(up: Dir): { north: V3; east: V3 } {
  const ref: V3 = Math.abs(up[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  const k = ref[0] * up[0] + ref[1] * up[1] + ref[2] * up[2];
  const north = norm(ref[0] - k * up[0], ref[1] - k * up[1], ref[2] - k * up[2]);
  const east: V3 = [north[1] * up[2] - north[2] * up[1], north[2] * up[0] - north[0] * up[2], north[0] * up[1] - north[1] * up[0]];
  return { north, east };
}

/** Move `east`/`north` metres along the surface from `d` (great circle). Mirrors places.offsetDir. */
function offsetDir(d: Dir, east: number, north: number, radius: number): V3 {
  if (!east && !north) return [d[0], d[1], d[2]];
  const f = frameAt(d);
  const tx = (f.east[0] * east + f.north[0] * north) / radius;
  const ty = (f.east[1] * east + f.north[1] * north) / radius;
  const tz = (f.east[2] * east + f.north[2] * north) / radius;
  const len = Math.sqrt(tx * tx + ty * ty + tz * tz);
  const c = Math.cos(len);
  const s = Math.sin(len) / len;
  return norm(d[0] * c + tx * s, d[1] * c + ty * s, d[2] * c + tz * s);
}

/** Walk `metres` along the great circle from `from` toward `to`. Mirrors places.towardDir. */
function towardDir(from: Dir, to: Dir, metres: number, radius: number): V3 {
  const k = from[0] * to[0] + from[1] * to[1] + from[2] * to[2];
  let tx = to[0] - k * from[0], ty = to[1] - k * from[1], tz = to[2] - k * from[2];
  const tl = Math.sqrt(tx * tx + ty * ty + tz * tz);
  if (tl < 1e-9) return [from[0], from[1], from[2]];
  tx /= tl; ty /= tl; tz /= tl;
  const a = metres / radius;
  const c = Math.cos(a), s = Math.sin(a);
  return norm(from[0] * c + tx * s, from[1] * c + ty * s, from[2] * c + tz * s);
}

// ------------------------------------------------------------------------------------ sites

/** A local item: archetype, position (east/north metres from the site centre), yaw (rad, 0 = right along east). */
interface Item {
  a: BreakableArchetype;
  e: number;
  n: number;
  yaw: number;
  s: number;
  /** Items of one cluster may touch each other (they're laid out not to overlap). */
  cluster: number;
}

type Rng = () => number;

interface SiteDef {
  name: string;
  /** A named place (content/places.ts) or a pad anchor, then optional "walk toward" and tangent offsets. */
  at: FeatureAnchor | { place: string };
  toward?: FeatureAnchor | { place: string };
  dist?: number;
  east?: number;
  north?: number;
  /** Search this far (m) around the anchor for the spot where most items fit (flat, dry). */
  search?: number;
  build: (rng: Rng, out: ItemSink) => void;
}

class ItemSink {
  readonly items: Item[] = [];
  /** Per cluster (index = cluster id): how far (m) the whole cluster may slide to fit the ground. */
  readonly nudge: number[] = [0];
  private cluster = 0;
  private ox = 0;
  private on = 0;
  private c = 1;
  private s = 0;
  private rot = 0;
  /** Start a new cluster at (e, n) rotated by `rot`: subsequent `add` calls are relative to it. */
  begin(e: number, n: number, rot: number, nudge = 0) {
    this.cluster++;
    this.nudge[this.cluster] = nudge;
    this.ox = e;
    this.on = n;
    this.rot = rot;
    this.c = Math.cos(rot);
    this.s = Math.sin(rot);
  }
  add(a: BreakableArchetype, x: number, y: number, yaw = 0, s = 1) {
    this.items.push({ a, e: this.ox + x * this.c - y * this.s, n: this.on + x * this.s + y * this.c, yaw: yaw + this.rot, s, cluster: this.cluster });
  }
}

const TAU = Math.PI * 2;
const jit = (rng: Rng, a: number) => (rng() - 0.5) * 2 * a;

// --- cluster templates (local metres; +x = east of the cluster frame) ---

function crates(rng: Rng, o: ItemSink) {
  const s1 = 0.9 + rng() * 0.25, s2 = 0.85 + rng() * 0.25;
  o.add("crate", 0, 0, jit(rng, 0.15), s1);
  o.add("crate", 0.55 * s1 + 0.55 * s2 + 0.08, jit(rng, 0.15), jit(rng, 0.25), s2);
  if (rng() < 0.6) o.add("crate", 0.2, 0.55 * s1 + 0.55 + 0.1, jit(rng, 0.4), 0.85 + rng() * 0.2);
  if (rng() < 0.7) o.add("barrel", -0.55 * s1 - 0.65, 0.3, rng() * TAU, 0.92 + rng() * 0.15);
}

/** Two or three fuel drums (Meridian camps). */
function fuelDrums(rng: Rng, o: ItemSink) {
  o.add("fueldrum", 0, 0, rng() * TAU, 1);
  o.add("fueldrum", 0.85, 0.1, rng() * TAU, 1);
  if (rng() < 0.7) o.add("fueldrum", 0.4, 0.8, rng() * TAU, 1);
}

function barrels(rng: Rng, o: ItemSink) {
  o.add("barrel", 0, 0, rng() * TAU, 0.95 + rng() * 0.1);
  o.add("barrel", 1.0, 0.05, rng() * TAU, 0.95 + rng() * 0.1);
  o.add("barrel", 0.5, 0.88, rng() * TAU, 0.95 + rng() * 0.1);
  if (rng() < 0.6) o.add("crate", -1.15, 0.4, jit(rng, 0.3), 0.9 + rng() * 0.2);
}

function fenceRun(rng: Rng, o: ItemSink, count: number) {
  for (let i = 0; i < count; i++) o.add("fence", i * 2.02 - (count - 1) * 1.01, 0, 0, 1);
  if (rng() < 0.5) o.add("crate", (count - 1) * 1.01 + 0.2, 1.1, jit(rng, 0.3), 0.85 + rng() * 0.2);
}

/** A rectangular pen of fence segments (w × d segments) with a gate gap on the south side. */
function pen(rng: Rng, o: ItemSink, w: number, d: number) {
  const W = w * 2.02, D = d * 2.02;
  const gate = Math.floor(rng() * w);
  for (let i = 0; i < w; i++) {
    const x = -W / 2 + 1.01 + i * 2.02;
    if (i !== gate) o.add("fence", x, -D / 2, 0);
    o.add("fence", x, D / 2, 0);
  }
  for (let j = 0; j < d; j++) {
    const y = -D / 2 + 1.01 + j * 2.02;
    o.add("fence", -W / 2, y, Math.PI / 2);
    o.add("fence", W / 2, y, Math.PI / 2);
  }
}

/** Concrete/stone barrier line: `count` 4 m wall segments in a row. */
function barrierLine(_rng: Rng, o: ItemSink, count: number) {
  for (let i = 0; i < count; i++) o.add("campwall", i * 4.05 - (count - 1) * 2.025, 0, 0);
}

/** Walls on a circle of `radius` with `gates` gaps; crates and barrels inside. */
function campRing(rng: Rng, o: ItemSink, radius: number, gates: number) {
  const n = Math.max(6, Math.floor((TAU * radius) / 4.3));
  const gate0 = Math.floor(rng() * n);
  for (let i = 0; i < n; i++) {
    let isGate = false;
    for (let g = 0; g < gates; g++) if (i === (gate0 + Math.floor((g * n) / gates)) % n) isGate = true;
    if (isGate) continue;
    const a = (i / n) * TAU;
    o.add("campwall", Math.cos(a) * radius, Math.sin(a) * radius, a + Math.PI / 2);
  }
}

function colonnade(rng: Rng, o: ItemSink, rows: number, cols: number, dx: number, dy: number, a: BreakableArchetype = "pillar") {
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      // Ruins: a few columns are missing.
      if (rng() < 0.15) continue;
      o.add(a, (c - (cols - 1) / 2) * dx, (r - (rows - 1) / 2) * dy, rng() * TAU);
    }
  }
}

function ring(o: ItemSink, a: BreakableArchetype, count: number, radius: number, phase: number, faceIn = false) {
  for (let i = 0; i < count; i++) {
    const ang = phase + (i / count) * TAU;
    o.add(a, Math.cos(ang) * radius, Math.sin(ang) * radius, faceIn ? ang + Math.PI / 2 : ang * 3.7);
  }
}

/** A few clusters scattered on a disc (ridge cover, ruins), each built by `fill`. */
function scatter(rng: Rng, o: ItemSink, count: number, radius: number, fill: (rng: Rng, o: ItemSink, i: number) => void) {
  for (let i = 0; i < count; i++) {
    const r = radius * Math.sqrt(0.15 + 0.85 * rng());
    const a = rng() * TAU;
    o.begin(Math.cos(a) * r, Math.sin(a) * r, rng() * TAU, 14);
    fill(rng, o, i);
  }
}

// --- pad clusters: three clusters around every pad, just outside the safe ring ---

const PAD_RING = [16.5, 19.5] as const;

function padCover(body: BodyId) {
  return (rng: Rng, o: ItemSink) => {
    const phase = rng() * TAU;
    for (let k = 0; k < 3; k++) {
      const a = phase + (k / 3) * TAU + jit(rng, 0.35);
      const r = PAD_RING[0] + rng() * (PAD_RING[1] - PAD_RING[0]);
      // Cluster faces the pad (fences/barriers run tangentially: cover from the open ground).
      o.begin(Math.cos(a) * r, Math.sin(a) * r, a + Math.PI / 2, 6);
      const pick = rng();
      if (body === "arcadia") {
        if (pick < 0.4) crates(rng, o);
        else if (pick < 0.7) barrels(rng, o);
        else fenceRun(rng, o, 3);
      } else if (body === "hollowmere") {
        if (pick < 0.35) crates(rng, o);
        else if (pick < 0.65) fenceRun(rng, o, 3);
        else {
          o.add("pillar", 0, 0, rng() * TAU);
          o.add("crate", 1.3, 0.2, jit(rng, 0.3), 0.9);
          if (rng() < 0.5) o.add("statue", -1.6, 0.3, rng() * TAU);
        }
      } else {
        if (pick < 0.3) crates(rng, o);
        else if (pick < 0.5) barrels(rng, o);
        else if (pick < 0.7) fenceRun(rng, o, 3);
        else {
          barrierLine(rng, o, 2);
          o.add("crate", 0.3, 1.2, jit(rng, 0.3), 0.9);
        }
      }
    }
  };
}

// --- points of interest per planet, anchored on content/places.ts ---
// Boss-arena cover (Coral Pillars, Nave pillars, Freight Containers, Crane Legs) belongs to the NPC
// lane's arena layout (content/arenas.ts: HP, toppling, blocking boss attacks); nothing here is
// placed inside a boss arena. The `cover` archetype (the same heavy coral/pillar/container shapes)
// is used as ordinary fight cover elsewhere.

const SITES: Partial<Record<BodyId, SiteDef[]>> = {
  arcadia: [
    {
      name: "Blockyard Camp", at: { place: "blockyard_camp" }, search: 45,
      build: (rng, o) => {
        o.begin(0, 0, rng() * TAU);
        campRing(rng, o, 15, 2);
        o.begin(-4, 2, rng() * TAU);
        crates(rng, o);
        o.begin(4, -3, rng() * TAU);
        barrels(rng, o);
        o.begin(1, 6, rng() * TAU);
        crates(rng, o);
      },
    },
    {
      name: "Highscore Hill ruins", at: { place: "highscore_hill" }, search: 60,
      build: (rng, o) => {
        o.begin(0, 0, rng() * TAU);
        colonnade(rng, o, 2, 4, 5, 7);
        o.add("statue", 0, 0, rng() * TAU);
        scatter(rng, o, 4, 30, (r, s) => (r() < 0.5 ? crates(r, s) : s.add("statue", 0, 0, r() * TAU)));
      },
    },
    {
      name: "Clover Fields farm", at: { place: "lone_oak" }, east: -30, north: 20, search: 30,
      build: (rng, o) => {
        o.begin(0, 0, rng() * TAU);
        pen(rng, o, 4, 3);
        o.begin(14, 4, rng() * TAU);
        pen(rng, o, 3, 3);
        o.begin(6, -10, rng() * TAU);
        barrels(rng, o);
        o.begin(-10, -6, rng() * TAU);
        crates(rng, o);
        o.begin(-4, 12, rng() * TAU);
        fenceRun(rng, o, 4);
      },
    },
    {
      // Coral outcrops and a dock's worth of crates on the Glasswater shore (away from Gull Point).
      name: "Glasswater shore", at: { place: "glasswater_lake" }, north: 84,
      build: (rng, o) => {
        scatter(rng, o, 4, 22, (r, s) => (r() < 0.5 ? crates(r, s) : barrels(r, s)));
        scatter(rng, o, 3, 26, (r, s) => {
          s.add("cover", 0, 0, r() * TAU);
          if (r() < 0.5) s.add("crate", 1.5, 0.3, r() * TAU, 0.9);
        });
      },
    },
  ],
  hollowmere: [
    {
      name: "Saint Orrin's ruin", at: { place: "saint_orrins" }, search: 45,
      build: (rng, o) => {
        o.begin(0, 0, rng() * TAU);
        colonnade(rng, o, 2, 5, 5, 9);
        o.add("statue", 0, -7, Math.PI);
        o.add("statue", 0, 7, 0);
        o.begin(14, 0, rng() * TAU);
        fenceRun(rng, o, 4);
        scatter(rng, o, 3, 26, (r, s) => crates(r, s));
      },
    },
    {
      // Tall nave-style pillars (heavy cover) around the flooded chapel.
      name: "Drowned Chapel", at: { place: "drowned_chapel" }, search: 25,
      build: (rng, o) => {
        o.begin(0, 0, rng() * TAU);
        for (let i = 0; i < 3; i++) {
          o.add("cover", -5, -8 + i * 8, 0);
          o.add("cover", 5, -8 + i * 8, 0);
        }
        o.add("statue", 0, 0, rng() * TAU);
      },
    },
    {
      name: "Ossuary Camp", at: { place: "ossuary_camp" }, search: 40,
      build: (rng, o) => {
        o.begin(0, 0, rng() * TAU);
        campRing(rng, o, 13, 2);
        o.begin(-3, 3, rng() * TAU);
        crates(rng, o);
        o.begin(4, -2, rng() * TAU);
        o.add("statue", 0, 0, rng() * TAU);
      },
    },
    {
      name: "Thornwood ruins", at: { place: "thornwood" },
      build: (rng, o) => {
        scatter(rng, o, 5, 60, (r, s) => {
          s.add("pillar", 0, 0, r() * TAU);
          if (r() < 0.6) s.add("statue", 2.2, 0.4, r() * TAU);
          if (r() < 0.5) s.add("crate", -1.6, 0.6, r() * TAU, 0.9);
        });
      },
    },
  ],
  meridian: [
    {
      name: "Checkpoint Seven", at: { place: "checkpoint_seven" }, search: 40,
      build: (rng, o) => {
        const rot = rng() * TAU;
        // Two barrier walls either side of the road, a gate gap in the middle, containers as cover.
        o.begin(0, 8, rot);
        barrierLine(rng, o, 3);
        o.begin(0, -8, rot);
        barrierLine(rng, o, 3);
        o.begin(9, 0, rot + Math.PI / 2);
        barrierLine(rng, o, 2);
        o.begin(-4, 3, rng() * TAU);
        crates(rng, o);
        o.begin(4, -3, rng() * TAU);
        barrels(rng, o);
        o.begin(-12, 0, rot + Math.PI / 2);
        fenceRun(rng, o, 4);
        o.begin(-3, -16, rot);
        o.add("cover", 0, 0, 0);
        o.begin(5, 16, rot);
        o.add("cover", 0, 0, 0);
        // Fuel drums (appended so the ids above don't shift): by the gate and behind the crates.
        o.begin(2, 5, rng() * TAU);
        fuelDrums(rng, o);
        o.begin(-7, -4, rng() * TAU);
        fuelDrums(rng, o);
      },
    },
    {
      name: "Signal Ridge cover", at: { mid: [2, 0] },
      build: (rng, o) => {
        scatter(rng, o, 8, 70, (r, s) => (r() < 0.5 ? barrierLine(r, s, 2) : r() < 0.5 ? crates(r, s) : barrels(r, s)));
      },
    },
    {
      name: "Chrome Spires slopes", at: { place: "chrome_spires" }, toward: { pad: 15 }, dist: 95,
      build: (rng, o) => {
        scatter(rng, o, 6, 50, (r, s) => (r() < 0.4 ? barrierLine(r, s, 2) : r() < 0.6 ? s.add("cover", 0, 0, r() * TAU) : crates(r, s)));
      },
    },
    {
      name: "Cinder Canyons cover", at: { place: "cinder_canyons" },
      build: (rng, o) => {
        scatter(rng, o, 8, 90, (r, s) => (r() < 0.4 ? barrierLine(r, s, 2) : r() < 0.55 ? crates(r, s) : r() < 0.8 ? barrels(r, s) : s.add("cover", 0, 0, r() * TAU)));
      },
    },
    {
      name: "Oversight Lobby plaza", at: { place: "oversight_lobby" }, search: 30,
      build: (rng, o) => {
        o.begin(0, 0, rng() * TAU);
        colonnade(rng, o, 2, 4, 6, 10);
        o.add("statue", 0, 0, rng() * TAU);
        o.begin(12, 6, rng() * TAU);
        crates(rng, o);
        // Freight containers parked at the plaza's edge.
        o.begin(-16, -4, rng() * TAU);
        o.add("cover", 0, 0, 0);
        o.begin(16, -6, rng() * TAU);
        o.add("cover", 0, 0, 0);
      },
    },
  ],
};

// ------------------------------------------------------------------------------------ placement

/** Clearance between a breakable's footprint and a pad's safe ring (m). */
export const BREAKABLE_SAFE_MARGIN = 1.0;
/** Minimum ground height above the water surface (m). */
export const BREAKABLE_MIN_DRY = 0.25;
/** Base sunk below the lowest footprint sample so no corner floats (m). */
const SINK = 0.06;

interface ResolvedSite {
  name: string;
  dir: V3;
  search: number;
  build: SiteDef["build"];
}

function siteDirs(body: BodyDef): ResolvedSite[] {
  const out: ResolvedSite[] = [];
  const pads = padDirs(body);
  for (let i = 0; i < pads.length; i++) out.push({ name: `pad ${i}`, dir: [...pads[i]!] as V3, search: 0, build: padCover(body.id) });
  const resolve = (a: FeatureAnchor | { place: string }): Dir => ("place" in a ? placeDir(a.place) : anchorDir(body, a));
  for (const s of SITES[body.id] ?? []) {
    let d: V3 = [...resolve(s.at)] as V3;
    if (s.toward && s.dist) d = towardDir(d, resolve(s.toward), s.dist, body.radius);
    if (s.east || s.north) d = offsetDir(d, s.east ?? 0, s.north ?? 0, body.radius);
    if (!Number.isFinite(d[0] + d[1] + d[2])) throw new Error(`${body.id}: site ${s.name} has no direction (antipodal anchor?)`);
    out.push({ name: s.name, dir: d, search: s.search ?? 0, build: s.build });
  }
  return out;
}

const cache = new Map<BodyId, readonly Breakable[]>();

/** Every breakable on a body, in a stable order. Cached per body (the list is immutable). */
export function bodyBreakables(terrain: Terrain): readonly Breakable[] {
  const body = terrain.body;
  const hit = cache.get(body.id);
  if (hit) return hit;
  const list = body.terrain.kind === "hub" ? [] : place(terrain);
  cache.set(body.id, list);
  return list;
}

/** Uncached placement (tests): recomputes from scratch every call. */
export function placeBreakables(terrain: Terrain): Breakable[] {
  return terrain.body.terrain.kind === "hub" ? [] : place(terrain);
}

/** Name of each site on a body (index = the site part of a breakable id). */
export function breakableSites(body: BodyDef): string[] {
  return body.terrain.kind === "hub" ? [] : siteDirs(body).map((s) => s.name);
}

/** Why items were dropped, per site (tests and tuning). */
export interface PlacementReport {
  site: string;
  kept: number;
  water: number;
  steep: number;
  safe: number;
  arena: number;
  props: number;
  overlap: number;
}

/** Re-run placement and count, per site, how many items were kept or dropped and why. */
export function breakablePlacementReport(terrain: Terrain): PlacementReport[] {
  if (terrain.body.terrain.kind === "hub") return [];
  const report = siteDirs(terrain.body).map((s) => ({ site: s.name, kept: 0, water: 0, steep: 0, safe: 0, arena: 0, props: 0, overlap: 0 }));
  place(terrain, report);
  return report;
}

const FIT_OK = 0, FIT_WATER = 1, FIT_STEEP = 2, FIT_SAFE = 3, FIT_ARENA = 4;

/** Ground the breakables keep out of: every pad's safe ring, and the boss arena (NPC-owned cover). */
interface KeepOut {
  pads: readonly Dir[];
  arena: { dir: Dir; radius: number } | null;
}

/** Extra clearance around a boss arena's engagement radius (m). */
export const BREAKABLE_ARENA_MARGIN = 6;

function keepOutFor(terrain: Terrain): KeepOut {
  const a = bossArena(terrain);
  return { pads: padDirs(terrain.body), arena: a ? { dir: a.up, radius: a.radius + BREAKABLE_ARENA_MARGIN } : null };
}

/** One item fitted to the ground at a site: frame, collider size and the ground under it. */
interface Fit {
  status: number;
  /** Footprint height range relative to the allowed step (0 = flat, 1 = at the limit). */
  steep: number;
  dir: V3;
  right: V3;
  fwd: V3;
  hx: number;
  hz: number;
  h: number;
  foot: number;
  gmin: number;
}

function fitItem(terrain: Terrain, keep: KeepOut, site: V3, frame: { north: V3; east: V3 }, it: Item, de: number, dn: number): Fit {
  const body = terrain.body;
  const R = body.radius;
  const def = archetypeDef(body.id, it.a);
  const s = it.s;
  const dir = offsetDir(site, it.e + de, it.n + dn, R);
  // Orientation: the site frame's yawed east axis, re-orthonormalised to this item's up.
  const c = Math.cos(it.yaw), sn = Math.sin(it.yaw);
  const ax = frame.east[0] * c + frame.north[0] * sn;
  const ay = frame.east[1] * c + frame.north[1] * sn;
  const az = frame.east[2] * c + frame.north[2] * sn;
  const k = ax * dir[0] + ay * dir[1] + az * dir[2];
  const right = norm(ax - k * dir[0], ay - k * dir[1], az - k * dir[2]);
  // forward = right × up (so right, up, forward is a right-handed basis).
  const fwd: V3 = [right[1] * dir[2] - right[2] * dir[1], right[2] * dir[0] - right[0] * dir[2], right[0] * dir[1] - right[1] * dir[0]];
  const col = def.collider;
  const hx = (col.kind === "box" ? col.hx : col.r) * s;
  const hz = (col.kind === "box" ? col.hz : col.r) * s;
  const h = col.h * s;
  const foot = col.kind === "box" ? Math.sqrt(hx * hx + hz * hz) : hx;
  // Dry, not too steep: sample the ground at the centre and the footprint corners.
  const g0 = terrain.groundHeight(dir[0], dir[1], dir[2]);
  let gmin = g0, gmax = g0;
  for (let q = 0; q < 4; q++) {
    const sx = q & 1 ? 1 : -1, sz = q & 2 ? 1 : -1;
    const lx = col.kind === "box" ? sx * hx : sx * hx * 0.7071;
    const lz = col.kind === "box" ? sz * hz : sz * hz * 0.7071;
    const px = dir[0] * R + right[0] * lx + fwd[0] * lz;
    const py = dir[1] * R + right[1] * lx + fwd[1] * lz;
    const pz = dir[2] * R + right[2] * lx + fwd[2] * lz;
    const gl = Math.sqrt(px * px + py * py + pz * pz);
    const g = terrain.groundHeight(px / gl, py / gl, pz / gl);
    if (g < gmin) gmin = g;
    if (g > gmax) gmax = g;
  }
  const steep = (gmax - gmin) / (def.maxStep * Math.max(1, s));
  let status = FIT_OK;
  if (gmin - body.waterLevel < BREAKABLE_MIN_DRY) status = FIT_WATER;
  else if (steep > 1) status = FIT_STEEP;
  else {
    for (const p of keep.pads) {
      if (chordMetres(p, dir[0], dir[1], dir[2], R) < PAD_SAFE_RADIUS + foot + BREAKABLE_SAFE_MARGIN) {
        status = FIT_SAFE;
        break;
      }
    }
    if (status === FIT_OK && keep.arena && chordMetres(keep.arena.dir, dir[0], dir[1], dir[2], R) < keep.arena.radius + foot) status = FIT_ARENA;
  }
  return { status, steep, dir, right, fwd, hx, hz, h, foot, gmin };
}

/** Candidate offsets (m) for a search of radius `r`: the origin, then rings of 8 at r/3, 2r/3, r. */
function searchOffsets(r: number): [number, number][] {
  const out: [number, number][] = [[0, 0]];
  if (r <= 0) return out;
  for (let ring = 1; ring <= 3; ring++) {
    const d = (r * ring) / 3;
    for (let i = 0; i < 8; i++) {
      const a = ((i + (ring & 1 ? 0 : 0.5)) / 8) * TAU;
      out.push([Math.cos(a) * d, Math.sin(a) * d]);
    }
  }
  return out;
}

/** Score items at an offset: failures dominate, then summed steepness. Lower is better. */
function scoreAt(terrain: Terrain, keep: KeepOut, site: V3, frame: { north: V3; east: V3 }, items: readonly Item[], de: number, dn: number): number {
  let fails = 0, steep = 0;
  for (const it of items) {
    const f = fitItem(terrain, keep, site, frame, it, de, dn);
    if (f.status !== FIT_OK) fails++;
    steep += Math.min(2, f.steep);
  }
  return fails * 1000 + steep + Math.hypot(de, dn) * 0.01;
}

function place(terrain: Terrain, report?: PlacementReport[]): Breakable[] {
  const body = terrain.body;
  const R = body.radius;
  const keep = keepOutFor(terrain);
  const sites = siteDirs(body);
  const out: Breakable[] = [];
  const propCache = new Map<string, PropInstance[]>();
  const chunkKeys = new Set<string>();
  /** Solid props (trees, rocks, spires) of every chunk within `reach` metres of a direction. */
  const propsNear = (dir: V3, right: V3, fwd: V3, reach: number): PropInstance[] => {
    chunkKeys.clear();
    for (let q = 0; q < 5; q++) {
      const a = q === 0 ? 0 : q & 1 ? reach : -reach;
      const ox = q === 0 ? 0 : q < 3 ? a : 0, oz = q >= 3 ? a : 0;
      const x = dir[0] * R + right[0] * ox + fwd[0] * oz;
      const y = dir[1] * R + right[1] * ox + fwd[1] * oz;
      const z = dir[2] * R + right[2] * ox + fwd[2] * oz;
      const k = chunkOf(x, y, z, body.chunksPerFace);
      chunkKeys.add(`${k.face}:${k.cx}:${k.cy}`);
    }
    const all: PropInstance[] = [];
    for (const key of chunkKeys) {
      let p = propCache.get(key);
      if (!p) {
        const [f, cx, cy] = key.split(":").map(Number) as [number, number, number];
        p = chunkProps(terrain, f as 0 | 1 | 2 | 3 | 4 | 5, cx, cy).filter((q) => PROP_DEFS[q.kind].collider !== "none");
        propCache.set(key, p);
      }
      for (const x of p) all.push(x);
    }
    return all;
  };
  // Accepted items (footprint overlap between clusters and sites).
  const accepted: { x: number; y: number; z: number; foot: number; cluster: string }[] = [];

  for (let si = 0; si < sites.length; si++) {
    const site = sites[si]!;
    const rng = mulberry32(hash4(body.seed, si, 0xb12e));
    const sink = new ItemSink();
    site.build(rng, sink);
    const items = sink.items;
    const frame = frameAt(site.dir);
    // 1. A point of interest moves (within `search` m of its anchor) to where most of it fits.
    let sde = 0, sdn = 0;
    if (site.search > 0) {
      let best = Infinity;
      for (const [de, dn] of searchOffsets(site.search)) {
        const sc = scoreAt(terrain, keep, site.dir, frame, items, de, dn);
        if (sc < best) {
          best = sc;
          sde = de;
          sdn = dn;
        }
      }
    }
    // 2. Free clusters (pad cover, scattered cover) slide on their own to fit the ground.
    const shift = new Map<number, [number, number]>();
    for (let ci = 1; ci < sink.nudge.length; ci++) {
      const r = sink.nudge[ci] ?? 0;
      if (r <= 0) continue;
      const members = items.filter((x) => x.cluster === ci);
      if (!members.length) continue;
      let best = Infinity, bde = 0, bdn = 0;
      for (const [de, dn] of searchOffsets(r)) {
        const sc = scoreAt(terrain, keep, site.dir, frame, members, sde + de, sdn + dn);
        if (sc < best) {
          best = sc;
          bde = de;
          bdn = dn;
        }
      }
      shift.set(ci, [bde, bdn]);
    }
    // 3. Fit every item; drop the ones that still don't fit (ids keep their slot).
    const rep = report?.[si];
    for (let slot = 0; slot < items.length; slot++) {
      const it = items[slot]!;
      const cs = shift.get(it.cluster);
      const f = fitItem(terrain, keep, site.dir, frame, it, sde + (cs?.[0] ?? 0), sdn + (cs?.[1] ?? 0));
      if (f.status !== FIT_OK) {
        if (rep) {
          if (f.status === FIT_WATER) rep.water++;
          else if (f.status === FIT_STEEP) rep.steep++;
          else if (f.status === FIT_ARENA) rep.arena++;
          else rep.safe++;
        }
        continue;
      }
      const { dir, right, fwd, hx, hz, h, foot } = f;
      const base = R + f.gmin - SINK;
      const bx = dir[0] * base, by = dir[1] * base, bz = dir[2] * base;
      // Trees, rocks and spires keep their place; the breakable yields.
      let blocked = false;
      for (const p of propsNear(dir, right, fwd, foot + 3.5)) {
        const pr = PROP_DEFS[p.kind].radius * p.scale;
        const dx = p.x - bx, dy = p.y - by, dz = p.z - bz;
        const up = dx * dir[0] + dy * dir[1] + dz * dir[2];
        const horiz = Math.sqrt(Math.max(0, dx * dx + dy * dy + dz * dz - up * up));
        if (horiz < pr + foot + 0.15) {
          blocked = true;
          break;
        }
      }
      if (blocked) {
        if (rep) rep.props++;
        continue;
      }
      // Other clusters' items (a cluster's own items are laid out not to overlap).
      const clusterKey = `${si}:${it.cluster}`;
      for (const a of accepted) {
        if (a.cluster === clusterKey) continue;
        const dx = a.x - bx, dy = a.y - by, dz = a.z - bz;
        if (dx * dx + dy * dy + dz * dz < (a.foot + foot + 0.2) * (a.foot + foot + 0.2)) {
          blocked = true;
          break;
        }
      }
      if (blocked) {
        if (rep) rep.overlap++;
        continue;
      }
      if (rep) rep.kept++;
      accepted.push({ x: bx, y: by, z: bz, foot, cluster: clusterKey });
      const def = archetypeDef(body.id, it.a);
      const half = h / 2;
      out.push({
        id: `${si}.${slot}`,
        index: out.length,
        site: si,
        archetype: archetypeIndex(it.a),
        kind: it.a,
        px: bx, py: by, pz: bz,
        rx: right[0], ry: right[1], rz: right[2],
        ux: dir[0], uy: dir[1], uz: dir[2],
        fx: fwd[0], fy: fwd[1], fz: fwd[2],
        scale: it.s,
        hp: def.hp,
        size: def.size,
        rebuildMs: def.rebuildS * 1000,
        shape: def.collider.kind === "box" ? 0 : 1,
        hx, hz, h,
        cx: bx + dir[0] * half, cy: by + dir[1] * half, cz: bz + dir[2] * half,
        bound: Math.sqrt(foot * foot + half * half),
        foot,
      });
    }
  }
  return out;
}

// ------------------------------------------------------------------------------------ hit tests

/**
 * Distance along a ray (origin o, unit direction d) to the breakable's collider within [0, maxT],
 * or Infinity. A ray starting inside returns 0.
 */
export function rayBreakable(b: Breakable, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxT: number): number {
  const qx = ox - b.px, qy = oy - b.py, qz = oz - b.pz;
  // Local origin and direction (x = right, y = up, z = forward).
  const lx = qx * b.rx + qy * b.ry + qz * b.rz;
  const ly = qx * b.ux + qy * b.uy + qz * b.uz;
  const lz = qx * b.fx + qy * b.fy + qz * b.fz;
  const vx = dx * b.rx + dy * b.ry + dz * b.rz;
  const vy = dx * b.ux + dy * b.uy + dz * b.uz;
  const vz = dx * b.fx + dy * b.fy + dz * b.fz;
  let t0 = 0, t1 = maxT;
  // Height slab y ∈ [0, h].
  if (Math.abs(vy) < 1e-12) {
    if (ly < 0 || ly > b.h) return Infinity;
  } else {
    let a = -ly / vy, c = (b.h - ly) / vy;
    if (a > c) { const tmp = a; a = c; c = tmp; }
    if (a > t0) t0 = a;
    if (c < t1) t1 = c;
    if (t0 > t1) return Infinity;
  }
  if (b.shape === 0) {
    // Box slabs x ∈ [-hx, hx], z ∈ [-hz, hz].
    for (let axis = 0; axis < 2; axis++) {
      const o = axis === 0 ? lx : lz, v = axis === 0 ? vx : vz, e = axis === 0 ? b.hx : b.hz;
      if (Math.abs(v) < 1e-12) {
        if (o < -e || o > e) return Infinity;
      } else {
        let a = (-e - o) / v, c = (e - o) / v;
        if (a > c) { const tmp = a; a = c; c = tmp; }
        if (a > t0) t0 = a;
        if (c < t1) t1 = c;
        if (t0 > t1) return Infinity;
      }
    }
    return t0;
  }
  // Cylinder x² + z² ≤ r².
  const r = b.hx;
  const A = vx * vx + vz * vz;
  const C = lx * lx + lz * lz - r * r;
  if (A < 1e-12) return C <= 0 ? t0 : Infinity;
  const B = 2 * (lx * vx + lz * vz);
  const disc = B * B - 4 * A * C;
  if (disc < 0) return Infinity;
  const sq = Math.sqrt(disc);
  const a = (-B - sq) / (2 * A), c = (-B + sq) / (2 * A);
  if (a > t0) t0 = a;
  if (c < t1) t1 = c;
  return t0 <= t1 ? t0 : Infinity;
}

/** Distance from a point to the breakable's collider (0 inside). Writes the closest point to `out` if given. */
export function distanceToBreakable(b: Breakable, x: number, y: number, z: number, out?: V3): number {
  const qx = x - b.px, qy = y - b.py, qz = z - b.pz;
  const lx = qx * b.rx + qy * b.ry + qz * b.rz;
  const ly = qx * b.ux + qy * b.uy + qz * b.uz;
  const lz = qx * b.fx + qy * b.fy + qz * b.fz;
  let cx: number, cz: number;
  if (b.shape === 0) {
    cx = Math.max(-b.hx, Math.min(b.hx, lx));
    cz = Math.max(-b.hz, Math.min(b.hz, lz));
  } else {
    const rl = Math.sqrt(lx * lx + lz * lz);
    const k = rl > b.hx ? b.hx / rl : 1;
    cx = lx * k;
    cz = lz * k;
  }
  const cy = Math.max(0, Math.min(b.h, ly));
  if (out) {
    out[0] = b.px + b.rx * cx + b.ux * cy + b.fx * cz;
    out[1] = b.py + b.ry * cx + b.uy * cy + b.fy * cz;
    out[2] = b.pz + b.rz * cx + b.uz * cy + b.fz * cz;
  }
  const ex = lx - cx, ey = ly - cy, ez = lz - cz;
  return Math.sqrt(ex * ex + ey * ey + ez * ez);
}

/** Does the segment (o, d, maxT) pass within `b.bound` of the collider centre? (broadphase) */
export function segmentNearBreakable(b: Breakable, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxT: number): boolean {
  const qx = b.cx - ox, qy = b.cy - oy, qz = b.cz - oz;
  let t = qx * dx + qy * dy + qz * dz;
  if (t < 0) t = 0;
  else if (t > maxT) t = maxT;
  const ex = qx - dx * t, ey = qy - dy * t, ez = qz - dz * t;
  return ex * ex + ey * ey + ez * ez <= b.bound * b.bound;
}

// ------------------------------------------------------------------------------------ spatial index

/** Uniform grid over the breakables of one body: candidates for segments and spheres. */
export class BreakableGrid {
  readonly cell: number;
  private readonly cells = new Map<number, number[]>();
  private readonly seen: Uint32Array;
  private stamp = 0;
  private readonly maxBound: number;

  readonly list: readonly Breakable[];

  constructor(list: readonly Breakable[], cell = 24) {
    this.list = list;
    this.cell = cell;
    this.seen = new Uint32Array(list.length);
    let mb = 0;
    for (const b of list) {
      mb = Math.max(mb, b.bound);
      const k = this.key(Math.floor(b.cx / cell), Math.floor(b.cy / cell), Math.floor(b.cz / cell));
      let arr = this.cells.get(k);
      if (!arr) this.cells.set(k, (arr = []));
      arr.push(b.index);
    }
    this.maxBound = mb;
  }

  private key(i: number, j: number, k: number): number {
    // Cells span ±2048 per axis (planets ≤ 1.2 km radius at 24 m cells → ±50).
    return ((i + 2048) * 4096 + (j + 2048)) * 4096 + (k + 2048);
  }

  /**
   * Collects into `out` (cleared first) every breakable whose cell overlaps the box around a
   * segment (o, d, maxT) widened by `radius`; use maxT = 0 for a sphere at o. Returns the count.
   * Allocation-free when `out` has capacity.
   */
  collect(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxT: number, radius: number, out: number[]): number {
    out.length = 0;
    if (this.list.length === 0) return 0;
    const pad = radius + this.maxBound;
    const ex = ox + dx * maxT, ey = oy + dy * maxT, ez = oz + dz * maxT;
    const c = this.cell;
    const i0 = Math.floor((Math.min(ox, ex) - pad) / c), i1 = Math.floor((Math.max(ox, ex) + pad) / c);
    const j0 = Math.floor((Math.min(oy, ey) - pad) / c), j1 = Math.floor((Math.max(oy, ey) + pad) / c);
    const k0 = Math.floor((Math.min(oz, ez) - pad) / c), k1 = Math.floor((Math.max(oz, ez) + pad) / c);
    if (++this.stamp === 0xffffffff) {
      this.seen.fill(0);
      this.stamp = 1;
    }
    const stamp = this.stamp;
    for (let i = i0; i <= i1; i++) {
      for (let j = j0; j <= j1; j++) {
        for (let k = k0; k <= k1; k++) {
          const arr = this.cells.get(this.key(i, j, k));
          if (!arr) continue;
          for (let n = 0; n < arr.length; n++) {
            const idx = arr[n]!;
            if (this.seen[idx] === stamp) continue;
            this.seen[idx] = stamp;
            out.push(idx);
          }
        }
      }
    }
    return out.length;
  }
}
