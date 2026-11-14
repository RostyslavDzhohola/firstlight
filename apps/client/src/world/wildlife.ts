// Ambient wildlife (#7): small harmless animals that make a planet feel lived in. Client-side and
// cosmetic (the server never hears of them): a flock of birds pecking in the open that lifts off when
// you run at it, small grazers that keep their distance, rings on a lake where fish rise, and glowing
// insects that drift over the wood and the marsh at night. Three to four kinds per planet, chosen by
// the named region (planet/regions.ts) and the time of day. The moon and Portus have none.
//
// Cheap by construction: every animal is a few parts pushed into the NPC layer's instanced part
// batcher (world/npcs/parts.ts: shared unit primitives × its shared materials), so wildlife adds no
// material, no pipeline and, with any creature in view, no draw call; at most it shows the batcher's
// sphere/box/cone/torus batches when nothing else does. Animals live only within SPAWN_R of the
// player, at most MAX_ANIMALS at once, drawn within DRAW_R. All state lives in pools made once:
// nothing is allocated per frame.

import * as THREE from "three/webgpu";
import { BODIES, hash01, hash4, nearSafeZone, type BodyId, type Terrain } from "@firstlight/shared";
import { REGION_KINDS, regionHit, type RegionHit } from "@firstlight/shared/planet/regions";
import type { GeoKey, MatKey, PartBatcher } from "./npcs/parts.ts";

export type WildBehaviour = "bird" | "grazer" | "fish" | "glow";

export interface WildPart {
  g: GeoKey;
  m: MatKey;
  /** Offset and size in the animal's frame (x right, y up, z forward), metres at size 1. */
  p: [number, number, number];
  s: [number, number, number];
  c: number;
  /** Animated parts: wings flap about the body's long axis, a head bobs, a tail wags. */
  role?: "wingL" | "wingR" | "head" | "tail";
}

export interface WildSpecies {
  id: string;
  /** Shown nowhere yet; listed in docs/content.md. Original names (content §10). */
  name: string;
  behaviour: WildBehaviour;
  parts: WildPart[];
  /** Individuals per group. */
  count: [number, number];
  /** Region ids it lives in (land animals); fish live on any lake. */
  regions?: readonly string[];
  /** Only between dusk and dawn. */
  night?: boolean;
  /** Animal size (metres per model unit). */
  size: number;
}

// ---------------------------------------------------------------------------------------------- models

const bird = (back: number, chest: number, beak: number): WildPart[] => [
  { g: "sph", m: "std", p: [0, 0.16, 0], s: [0.16, 0.14, 0.26], c: back },
  { g: "sph", m: "std", p: [0, 0.13, 0.03], s: [0.12, 0.1, 0.16], c: chest },
  { g: "sph", m: "std", p: [0, 0.26, 0.13], s: [0.11, 0.11, 0.11], c: back, role: "head" },
  { g: "cone", m: "std", p: [0, 0.26, 0.21], s: [0.035, 0.07, 0.035], c: beak, role: "head" },
  { g: "box", m: "std", p: [0.12, 0.18, 0], s: [0.22, 0.015, 0.11], c: back, role: "wingL" },
  { g: "box", m: "std", p: [-0.12, 0.18, 0], s: [0.22, 0.015, 0.11], c: back, role: "wingR" },
  { g: "box", m: "std", p: [0, 0.17, -0.17], s: [0.07, 0.015, 0.12], c: back, role: "tail" },
];

const kit = (fur: number, belly: number): WildPart[] => [
  { g: "sph", m: "std", p: [0, 0.2, 0], s: [0.24, 0.24, 0.36], c: fur },
  { g: "sph", m: "std", p: [0, 0.16, 0.06], s: [0.18, 0.16, 0.24], c: belly },
  { g: "sph", m: "std", p: [0, 0.34, 0.2], s: [0.17, 0.16, 0.18], c: fur, role: "head" },
  { g: "box", m: "std", p: [0.04, 0.5, 0.17], s: [0.035, 0.18, 0.06], c: fur, role: "head" },
  { g: "box", m: "std", p: [-0.04, 0.5, 0.17], s: [0.035, 0.18, 0.06], c: fur, role: "head" },
  { g: "sph", m: "std", p: [0, 0.24, -0.19], s: [0.09, 0.09, 0.09], c: belly, role: "tail" },
];

const hopper = (skin: number, spots: number): WildPart[] => [
  { g: "sph", m: "std", p: [0, 0.1, 0], s: [0.26, 0.15, 0.3], c: skin },
  { g: "sph", m: "std", p: [0.07, 0.17, 0.1], s: [0.07, 0.07, 0.07], c: spots, role: "head" },
  { g: "sph", m: "std", p: [-0.07, 0.17, 0.1], s: [0.07, 0.07, 0.07], c: spots, role: "head" },
  { g: "box", m: "std", p: [0.13, 0.05, -0.06], s: [0.06, 0.06, 0.2], c: skin },
  { g: "box", m: "std", p: [-0.13, 0.05, -0.06], s: [0.06, 0.06, 0.2], c: skin },
];

const skink = (scales: number, stripe: number): WildPart[] => [
  { g: "sph", m: "std", p: [0, 0.07, 0], s: [0.13, 0.09, 0.36], c: scales },
  { g: "box", m: "std", p: [0, 0.11, 0], s: [0.04, 0.02, 0.3], c: stripe },
  { g: "sph", m: "std", p: [0, 0.08, 0.2], s: [0.1, 0.08, 0.13], c: scales, role: "head" },
  { g: "cone", m: "std", p: [0, 0.06, -0.3], s: [0.06, 0.32, 0.06], c: scales, role: "tail" },
];

/** A fish's rise: the ring on the water (the torus lies flat; it grows and thins as it fades). */
const ring = (c: number): WildPart[] => [{ g: "tor", m: "std", p: [0, 0.02, 0], s: [1, 1, 1], c }];
const glow = (c: number): WildPart[] => [{ g: "sph", m: "glow", p: [0, 0, 0], s: [0.07, 0.07, 0.07], c }];

/** Per planet (append-only ids are not needed: nothing is saved or sent). */
export const WILDLIFE: Record<BodyId, WildSpecies[]> = {
  portus: [],
  lumen: [],
  arcadia: [
    { id: "hedge_finch", name: "Hedge Finch", behaviour: "bird", parts: bird(0x7a5536, 0xe0a060, 0xf0c040), count: [4, 7], regions: ["meadow", "heath", "marsh"], size: 1.5 },
    { id: "clover_kit", name: "Clover Kit", behaviour: "grazer", parts: kit(0xb08a64, 0xeadcc4), count: [2, 4], regions: ["meadow", "heath"], size: 1.25 },
    { id: "lake_darter", name: "Lake Darter", behaviour: "fish", parts: ring(0xdff4ff), count: [1, 1], size: 1 },
    { id: "lamp_beetle", name: "Lamplight Beetle", behaviour: "glow", parts: glow(0xfff08a), count: [9, 14], regions: ["wood", "marsh", "meadow"], night: true, size: 1 },
  ],
  hollowmere: [
    { id: "fen_crow", name: "Fen Crow", behaviour: "bird", parts: bird(0x2a2633, 0x4a4458, 0x8a8070), count: [3, 6], regions: ["fen", "ashwood", "mire"], size: 1.7 },
    { id: "bog_hopper", name: "Bog Hopper", behaviour: "grazer", parts: hopper(0x5d7048, 0xc8e070), count: [2, 4], regions: ["fen", "mire", "glowcap"], size: 1 },
    { id: "mere_eel", name: "Mere Eel", behaviour: "fish", parts: ring(0xc8c0e8), count: [1, 1], size: 1 },
    { id: "ghost_moth", name: "Ghost Moth", behaviour: "glow", parts: glow(0xc8b0ff), count: [8, 12], regions: ["glowcap", "mire", "fen", "ashwood"], night: true, size: 1.3 },
  ],
  meridian: [
    { id: "dust_lark", name: "Dust Lark", behaviour: "bird", parts: bird(0xc09a6a, 0xf0dcb8, 0x5a3a20), count: [4, 7], regions: ["flats", "rust", "dunes"], size: 1.5 },
    { id: "rock_skink", name: "Rock Skink", behaviour: "grazer", parts: skink(0xa8552e, 0xf0b060), count: [2, 3], regions: ["flats", "rust", "salt"], size: 1.2 },
    { id: "brine_minnow", name: "Brine Minnow", behaviour: "fish", parts: ring(0xf0f8ff), count: [1, 1], size: 1 },
    { id: "ember_mite", name: "Ember Mite", behaviour: "glow", parts: glow(0xff9a40), count: [8, 12], regions: ["rust", "flats"], night: true, size: 1 },
  ],
};

// ---------------------------------------------------------------------------------------------- tuning

/** Groups exist within this distance of the player and are removed past DESPAWN_R. */
export const SPAWN_R = 85;
export const DESPAWN_R = 115;
/** Animals are drawn within this distance (birds that flew off further vanish into the haze). */
export const DRAW_R = 75;
/** Hard caps: animals and groups alive at once. */
export const MAX_ANIMALS = 110;
export const MAX_GROUPS = 18;
/** World cells (m) that may each hold one group, and the share that do. */
const CELL = 34;
const GROUP_CHANCE = 0.32;
/** How close (m) a walking or running player gets before birds lift and grazers move off. */
export const BIRD_FLEE = 7;
export const BIRD_FLEE_RUN = 13;
export const GRAZER_KEEP = 11;
/** Running: faster than this (m/s) counts as running at them. */
const RUNNING = 4.5;

// ---------------------------------------------------------------------------------------------- state

const MODE = { IDLE: 0, MOVE: 1, FLY: 2, GONE: 3 } as const;

interface Animal {
  group: number;
  x: number; y: number; z: number;
  /** Heading (unit, tangent). */
  fx: number; fy: number; fz: number;
  /** Velocity (m/s) while moving or flying. */
  vx: number; vy: number; vz: number;
  /** Height above the ground while flying. */
  alt: number;
  mode: number;
  /** Seconds left in this mode. */
  t: number;
  phase: number;
  /** Glow: orbit centre offset seed; fish: ring age (s). */
  a: number;
  b: number;
}

interface Group {
  key: number;
  alive: boolean;
  species: number;
  /** Surface point (planet space) of its home. */
  hx: number; hy: number; hz: number;
  first: number;
  count: number;
}

const _m = new THREE.Matrix4();
const _basis = new THREE.Matrix4();
const _local = new THREE.Matrix4();
const _rot = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _s = new THREE.Vector3();
const _up = new THREE.Vector3();
const _fw = new THREE.Vector3();
const _rt = new THREE.Vector3();
const _axisZ = new THREE.Vector3(0, 0, 1);
const _axisX = new THREE.Vector3(1, 0, 0);
const _hit: RegionHit = { cell: 0, kind: 0, other: 0, edge: 0 };

/** Linear RGB of a part colour, made once per species. */
function linear(hex: number): [number, number, number] {
  const c = new THREE.Color(hex);
  return [c.r, c.g, c.b];
}

export interface WildStats {
  groups: number;
  animals: number;
  parts: number;
}

/**
 * The simulation and drawing. `scan` (twice a second) adds and removes groups round the player;
 * `draw` (every frame, from the NPC layer between its batch begin and end) moves and draws them.
 */
export class Wildlife {
  readonly species: WildSpecies[];
  private readonly colours: [number, number, number][][];
  private readonly animals: Animal[] = [];
  private readonly groups: Group[] = [];
  private readonly R: number;
  private readonly water: number;
  private readonly regionIds: string[];
  /** Planet-space position and speed of the player, as of the last frame. */
  private px = 0; private py = 0; private pz = 0;
  private pspeed = 0;
  private lastX = 0; private lastY = 0; private lastZ = 0;
  night = 0;
  readonly stats: WildStats = { groups: 0, animals: 0, parts: 0 };

  constructor(readonly body: BodyId, private readonly terrain: Terrain) {
    this.species = WILDLIFE[body];
    this.colours = this.species.map((s) => s.parts.map((p) => linear(p.c)));
    this.R = BODIES[body].radius;
    this.water = BODIES[body].waterLevel;
    this.regionIds = REGION_KINDS[body].map((k) => k.id);
    for (let i = 0; i < MAX_ANIMALS; i++) this.animals.push({ group: -1, x: 0, y: 0, z: 0, fx: 1, fy: 0, fz: 0, vx: 0, vy: 0, vz: 0, alt: 0, mode: MODE.GONE, t: 0, phase: 0, a: 0, b: 0 });
    for (let i = 0; i < MAX_GROUPS; i++) this.groups.push({ key: 0, alive: false, species: 0, hx: 0, hy: 0, hz: 0, first: -1, count: 0 });
  }

  get enabled(): boolean {
    return this.species.length > 0;
  }

  /** The player moved: keep its position and speed (m/s) for the reactions. */
  setPlayer(x: number, y: number, z: number, dt: number) {
    if (dt > 0) {
      const d = Math.hypot(x - this.lastX, y - this.lastY, z - this.lastZ);
      // A teleport (travel, respawn) is not a sprint.
      if (d < 40) this.pspeed += (d / dt - this.pspeed) * Math.min(1, dt * 6);
    }
    this.lastX = this.px = x;
    this.lastY = this.py = y;
    this.lastZ = this.pz = z;
  }

  private ground(x: number, y: number, z: number): number {
    const l = Math.sqrt(x * x + y * y + z * z) || 1;
    return this.terrain.groundHeight(x / l, y / l, z / l);
  }

  /** Put (x, y, z) on the ground (or on the water for fish) plus `alt`, in place on `a`. */
  private settle(a: Animal, alt: number, onWater: boolean) {
    const l = Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z) || 1;
    const h = onWater ? this.water : Math.max(this.water, this.ground(a.x, a.y, a.z));
    const r = (this.R + h + alt) / l;
    a.x *= r; a.y *= r; a.z *= r;
  }

  /** Add groups for the world cells near the player, remove the far ones. Twice a second. */
  scan() {
    if (!this.enabled) return;
    const px = this.px, py = this.py, pz = this.pz;
    // Remove far groups, and night insects at dawn.
    for (let gi = 0; gi < this.groups.length; gi++) {
      const g = this.groups[gi]!;
      if (!g.alive) continue;
      const far = Math.hypot(g.hx - px, g.hy - py, g.hz - pz) > DESPAWN_R;
      if (far || (this.species[g.species]!.night && this.night < 0.35)) this.free(gi);
    }
    const r = SPAWN_R;
    const i0 = Math.floor((px - r) / CELL), i1 = Math.floor((px + r) / CELL);
    const j0 = Math.floor((py - r) / CELL), j1 = Math.floor((py + r) / CELL);
    const k0 = Math.floor((pz - r) / CELL), k1 = Math.floor((pz + r) / CELL);
    const seed = BODIES[this.body].seed;
    for (let i = i0; i <= i1; i++) {
      for (let j = j0; j <= j1; j++) {
        for (let k = k0; k <= k1; k++) {
          const cx = (i + 0.5) * CELL, cy = (j + 0.5) * CELL, cz = (k + 0.5) * CELL;
          const cl = Math.sqrt(cx * cx + cy * cy + cz * cz);
          // Only cells the planet's surface passes through (heights stay within ±CELL·2 of R here).
          if (Math.abs(cl - this.R) > CELL * 2.5) continue;
          const key = hash4(seed, i, j, k);
          if (hash01(key, 1) >= GROUP_CHANCE) continue;
          if (this.groups.some((g) => g.alive && g.key === key)) continue;
          // The home: the cell's jittered point, dropped onto the surface; it must lie in this cell.
          const ux = (i + hash01(key, 2)) * CELL, uy = (j + hash01(key, 3)) * CELL, uz = (k + hash01(key, 4)) * CELL;
          const ul = Math.sqrt(ux * ux + uy * uy + uz * uz);
          const dx = ux / ul, dy = uy / ul, dz = uz / ul;
          const h = this.terrain.groundHeight(dx, dy, dz);
          const wet = h < this.water - 0.8;
          const sr = this.R + (wet ? this.water : h);
          const hx = dx * sr, hy = dy * sr, hz = dz * sr;
          if (Math.floor(hx / CELL) !== i || Math.floor(hy / CELL) !== j || Math.floor(hz / CELL) !== k) continue;
          if (Math.hypot(hx - px, hy - py, hz - pz) > r) continue;
          if (!wet && h < this.water + 0.3) continue; // the beach: nobody lives on the wet sand
          if (nearSafeZone(BODIES[this.body], dx, dy, dz, 6)) continue; // not on pads and outposts
          const sp = this.pickSpecies(key, wet, dx, dy, dz);
          if (sp < 0) continue;
          this.spawn(key, sp, hx, hy, hz);
        }
      }
    }
  }

  private pickSpecies(key: number, wet: boolean, dx: number, dy: number, dz: number): number {
    const region = wet ? -1 : (regionHit(this.body, dx, dy, dz, _hit)?.kind ?? -1);
    let n = 0;
    const ok = (s: WildSpecies) => {
      if (wet) return s.behaviour === "fish";
      if (s.behaviour === "fish") return false;
      if (s.night && this.night < 0.45) return false;
      return !s.regions || (region >= 0 && s.regions.includes(this.regionIds[region]!));
    };
    for (const s of this.species) if (ok(s)) n++;
    if (!n) return -1;
    let pick = Math.floor(hash01(key, 5) * n);
    for (let i = 0; i < this.species.length; i++) {
      if (!ok(this.species[i]!)) continue;
      if (pick-- === 0) return i;
    }
    return -1;
  }

  private spawn(key: number, sp: number, hx: number, hy: number, hz: number) {
    const gi = this.groups.findIndex((g) => !g.alive);
    if (gi < 0) return;
    const s = this.species[sp]!;
    const want = s.count[0] + Math.floor(hash01(key, 6) * (s.count[1] - s.count[0] + 1));
    // A run of free animal slots.
    let first = -1;
    for (let i = 0; i + want <= this.animals.length; i++) {
      let free = true;
      for (let k = 0; k < want; k++) if (this.animals[i + k]!.group >= 0) { free = false; i += k; break; }
      if (free) { first = i; break; }
    }
    if (first < 0) return;
    const g = this.groups[gi]!;
    g.alive = true; g.key = key; g.species = sp; g.hx = hx; g.hy = hy; g.hz = hz; g.first = first; g.count = want;
    _up.set(hx, hy, hz).normalize();
    tangentBasis(_up, _rt, _fw);
    const spread = s.behaviour === "glow" ? 5 : s.behaviour === "fish" ? 0 : 3.5;
    for (let k = 0; k < want; k++) {
      const a = this.animals[first + k]!;
      a.group = gi;
      const ox = (hash01(key, 10 + k) - 0.5) * 2 * spread, oz = (hash01(key, 40 + k) - 0.5) * 2 * spread;
      a.x = hx + _rt.x * ox + _fw.x * oz;
      a.y = hy + _rt.y * ox + _fw.y * oz;
      a.z = hz + _rt.z * ox + _fw.z * oz;
      const yaw = hash01(key, 70 + k) * Math.PI * 2;
      a.fx = _rt.x * Math.cos(yaw) + _fw.x * Math.sin(yaw);
      a.fy = _rt.y * Math.cos(yaw) + _fw.y * Math.sin(yaw);
      a.fz = _rt.z * Math.cos(yaw) + _fw.z * Math.sin(yaw);
      a.vx = a.vy = a.vz = 0;
      a.alt = s.behaviour === "glow" ? 0.6 + hash01(key, 90 + k) * 1.6 : 0;
      a.mode = MODE.IDLE;
      a.t = hash01(key, 100 + k) * 3;
      a.phase = hash01(key, 120 + k) * 10;
      a.a = hash01(key, 140 + k) * Math.PI * 2;
      a.b = s.behaviour === "fish" ? hash01(key, 160 + k) * 4 : hash01(key, 160 + k);
      this.settle(a, a.alt, s.behaviour === "fish");
    }
  }

  private free(gi: number) {
    const g = this.groups[gi]!;
    for (let k = 0; k < g.count; k++) {
      const a = this.animals[g.first + k]!;
      a.group = -1;
      a.mode = MODE.GONE;
    }
    g.alive = false;
    g.count = 0;
  }

  /** Move and draw every animal. Called once per frame by the NPC layer between begin and end. */
  draw(batch: PartBatcher, dt: number, now: number) {
    let animals = 0, parts = 0, groups = 0;
    const t = now / 1000;
    for (let gi = 0; gi < this.groups.length; gi++) {
      const g = this.groups[gi]!;
      if (!g.alive) continue;
      groups++;
      const s = this.species[g.species]!;
      const cols = this.colours[g.species]!;
      for (let k = 0; k < g.count; k++) {
        const a = this.animals[g.first + k]!;
        if (a.mode === MODE.GONE) continue;
        this.step(a, s, g, dt, t);
        if (a.mode === MODE.GONE) continue;
        if (Math.hypot(a.x - this.px, a.y - this.py, a.z - this.pz) > DRAW_R) continue;
        animals++;
        parts += this.drawAnimal(batch, a, s, cols, t);
      }
    }
    this.stats.groups = groups;
    this.stats.animals = animals;
    this.stats.parts = parts;
  }

  private step(a: Animal, s: WildSpecies, g: Group, dt: number, t: number) {
    const dxp = a.x - this.px, dyp = a.y - this.py, dzp = a.z - this.pz;
    const dist = Math.sqrt(dxp * dxp + dyp * dyp + dzp * dzp);
    a.t -= dt;
    switch (s.behaviour) {
      case "bird": {
        if (a.mode !== MODE.FLY) {
          const flee = this.pspeed > RUNNING ? BIRD_FLEE_RUN : BIRD_FLEE;
          if (dist < flee) {
            // Lift off: away from the player, up, with a little scatter of its own.
            a.mode = MODE.FLY;
            a.t = 4 + a.b * 3;
            const inv = 1 / Math.max(0.1, dist);
            const sx = (Math.sin(a.phase * 7.1) * 0.5), sz = (Math.cos(a.phase * 5.3) * 0.5);
            _up.set(a.x, a.y, a.z).normalize();
            tangentBasis(_up, _rt, _fw);
            const v = 7 + a.b * 3;
            a.vx = (dxp * inv + _rt.x * sx + _fw.x * sz) * v;
            a.vy = (dyp * inv + _rt.y * sx + _fw.y * sz) * v;
            a.vz = (dzp * inv + _rt.z * sx + _fw.z * sz) * v;
            removeRadial(a, _up);
          } else if (a.t <= 0) {
            // Peck about: a short hop to a new spot, a turn.
            a.t = 0.8 + ((a.phase * 13.7) % 1) * 2.2;
            a.phase += 1.37;
            turn(a, Math.sin(a.phase * 3.3) * 1.4);
            a.x += a.fx * 0.35; a.y += a.fy * 0.35; a.z += a.fz * 0.35;
            this.settle(a, 0, false);
          }
        } else {
          // Flying: climb to ~9 m, then glide away; land again where it ends up.
          a.alt = Math.min(9 + a.b * 6, a.alt + dt * 5);
          a.x += a.vx * dt; a.y += a.vy * dt; a.z += a.vz * dt;
          const l = Math.hypot(a.vx, a.vy, a.vz) || 1;
          a.fx = a.vx / l; a.fy = a.vy / l; a.fz = a.vz / l;
          this.settle(a, a.alt, false);
          if (a.t <= 0) {
            a.alt = Math.max(0, a.alt - dt * 7);
            if (a.alt <= 0) {
              a.mode = MODE.IDLE;
              a.t = 1;
              // Re-home the group where it landed, so it doesn't fly straight back.
              g.hx = a.x; g.hy = a.y; g.hz = a.z;
            }
          }
        }
        break;
      }
      case "grazer": {
        if (dist < GRAZER_KEEP) {
          // Keep your distance: hop away, faster when the player runs.
          a.mode = MODE.MOVE;
          a.t = 0.6;
          const inv = 1 / Math.max(0.1, dist);
          _up.set(a.x, a.y, a.z).normalize();
          const v = this.pspeed > RUNNING ? 6.5 : 4;
          a.vx = dxp * inv * v; a.vy = dyp * inv * v; a.vz = dzp * inv * v;
          removeRadial(a, _up);
        } else if (a.mode === MODE.IDLE && a.t <= 0) {
          // Graze, then amble a few steps.
          a.mode = MODE.MOVE;
          a.t = 0.8 + a.b * 1.2;
          a.phase += 2.1;
          turn(a, Math.sin(a.phase) * 1.2);
          a.vx = a.fx * 0.9; a.vy = a.fy * 0.9; a.vz = a.fz * 0.9;
        } else if (a.mode === MODE.MOVE && a.t <= 0) {
          a.mode = MODE.IDLE;
          a.t = 2 + a.b * 4;
          a.vx = a.vy = a.vz = 0;
        }
        if (a.mode === MODE.MOVE) {
          a.x += a.vx * dt; a.y += a.vy * dt; a.z += a.vz * dt;
          const l = Math.hypot(a.vx, a.vy, a.vz);
          if (l > 0.01) { a.fx = a.vx / l; a.fy = a.vy / l; a.fz = a.vz / l; }
          // Hops: a little arc on top of the ground.
          const hop = Math.abs(Math.sin(t * 9 + a.phase)) * (l > 2 ? 0.35 : 0.08);
          this.settle(a, hop, false);
        }
        break;
      }
      case "fish": {
        // A ring every few seconds where the fish rose; a player wading close scares it off for a while.
        a.b += dt;
        if (dist < 4 && a.b > 0) a.b = -10;
        if (a.b > 3.2) {
          a.b = -(hash01(g.key, Math.floor(t)) * 2.5);
          // Rise somewhere else within a few metres of home.
          _up.set(g.hx, g.hy, g.hz).normalize();
          tangentBasis(_up, _rt, _fw);
          const ox = Math.sin(t * 1.7 + a.phase) * 3, oz = Math.cos(t * 2.3 + a.phase) * 3;
          a.x = g.hx + _rt.x * ox + _fw.x * oz;
          a.y = g.hy + _rt.y * ox + _fw.y * oz;
          a.z = g.hz + _rt.z * ox + _fw.z * oz;
          this.settle(a, 0, true);
        }
        break;
      }
      case "glow": {
        // Drift on slow loops round home; scatter from a player who walks through them.
        const scatter = dist < 2.5 ? 1 : 0;
        a.phase += dt * (0.35 + a.b * 0.3 + scatter * 2.5);
        _up.set(g.hx, g.hy, g.hz).normalize();
        tangentBasis(_up, _rt, _fw);
        const rad = 2 + a.b * 4 + scatter * 3;
        const ox = Math.cos(a.phase + a.a) * rad, oz = Math.sin(a.phase * 1.3 + a.a) * rad;
        a.x = g.hx + _rt.x * ox + _fw.x * oz;
        a.y = g.hy + _rt.y * ox + _fw.y * oz;
        a.z = g.hz + _rt.z * ox + _fw.z * oz;
        // Hover over the home's ground (no terrain lookup per insect per frame).
        const hr = (Math.hypot(g.hx, g.hy, g.hz) + a.alt + Math.sin(a.phase * 2.1) * 0.4) / (Math.hypot(a.x, a.y, a.z) || 1);
        a.x *= hr; a.y *= hr; a.z *= hr;
        break;
      }
    }
  }

  private drawAnimal(batch: PartBatcher, a: Animal, s: WildSpecies, cols: [number, number, number][], t: number): number {
    _up.set(a.x, a.y, a.z).normalize();
    _fw.set(a.fx, a.fy, a.fz);
    _fw.addScaledVector(_up, -_fw.dot(_up));
    if (_fw.lengthSq() < 1e-6) tangentBasis(_up, _rt, _fw);
    _fw.normalize();
    _rt.crossVectors(_up, _fw).normalize();
    // Columns: x = right, y = up, z = forward (models face +z).
    _basis.makeBasis(_rt, _up, _fw);
    _basis.setPosition(a.x, a.y, a.z);
    const size = s.size;
    let n = 0;
    if (s.behaviour === "fish") {
      // The ring grows and thins over ~1.6 s, then is gone until the next rise.
      const age = a.b;
      if (age < 0 || age > 1.6) return 0;
      const r = 0.2 + age * 0.9;
      const thin = Math.max(0.15, 1 - age / 1.6);
      _local.makeRotationAxis(_axisX, Math.PI / 2);
      _m.makeScale(r, r, r * 0.5 * thin);
      _local.multiply(_m);
      _m.multiplyMatrices(_basis, _local);
      const c = cols[0]!, k = 0.35 + 0.65 * thin;
      batch.push("tor", "std", _m, c[0] * k, c[1] * k, c[2] * k);
      return 1;
    }
    const flying = a.mode === MODE.FLY && a.alt > 0.2;
    for (let i = 0; i < s.parts.length; i++) {
      const p = s.parts[i]!;
      _local.identity();
      const role = p.role;
      if (role === "wingL" || role === "wingR") {
        const side = role === "wingL" ? 1 : -1;
        const flap = flying ? Math.sin(t * 22 + a.phase) * 0.9 : 0.15;
        // Pivot at the shoulder (x = ±0.03): rotate about the body's long axis.
        _local.makeTranslation(side * 0.03 * size, p.p[1] * size, p.p[2] * size);
        _rot.makeRotationAxis(_axisZ, side * flap);
        _local.multiply(_rot);
        _local.multiply(_m.makeTranslation((p.p[0] - side * 0.03) * size, 0, 0));
      } else if (role === "head") {
        const bob = a.mode === MODE.IDLE && !flying ? Math.max(0, Math.sin(t * (s.behaviour === "bird" ? 6 : 1.6) + a.phase)) * 0.06 : 0;
        _local.makeTranslation(p.p[0] * size, (p.p[1] - bob) * size, (p.p[2] + bob * 0.5) * size);
      } else if (role === "tail") {
        const wag = Math.sin(t * (s.behaviour === "grazer" ? 3 : 8) + a.phase) * 0.25;
        _local.makeTranslation(p.p[0] * size, p.p[1] * size, p.p[2] * size);
        _rot.makeRotationY(wag);
        _local.multiply(_rot);
        if (p.g === "cone") _local.multiply(_rot.makeRotationX(-Math.PI / 2));
      } else {
        _local.makeTranslation(p.p[0] * size, p.p[1] * size, p.p[2] * size);
      }
      _s.set(p.s[0] * size, p.s[1] * size, p.s[2] * size);
      if (p.g === "cone" && role === "head") _local.multiply(_rot.makeRotationX(Math.PI / 2));
      _m.compose(_v.set(0, 0, 0), _q.identity(), _s);
      _local.multiply(_m);
      _m.multiplyMatrices(_basis, _local);
      const c = cols[i]!;
      batch.push(p.g, p.m, _m, c[0], c[1], c[2]);
      n++;
    }
    return n;
  }

  /** Groups alive per behaviour (tests and the perf overlay). */
  census(): Record<WildBehaviour, number> {
    const out: Record<WildBehaviour, number> = { bird: 0, grazer: 0, fish: 0, glow: 0 };
    for (const g of this.groups) if (g.alive) out[this.species[g.species]!.behaviour]++;
    return out;
  }

  /** Animals of a group (tests). */
  animalsOf(behaviour: WildBehaviour): { x: number; y: number; z: number; mode: number; alt: number }[] {
    const out: { x: number; y: number; z: number; mode: number; alt: number }[] = [];
    for (const g of this.groups) {
      if (!g.alive || this.species[g.species]!.behaviour !== behaviour) continue;
      for (let k = 0; k < g.count; k++) out.push(this.animals[g.first + k]!);
    }
    return out;
  }
}

export const WILD_MODE = MODE;

/** Any two tangents at `up` (stable: built from the axis least aligned with it). */
function tangentBasis(up: THREE.Vector3, right: THREE.Vector3, fwd: THREE.Vector3) {
  const ax = Math.abs(up.x), ay = Math.abs(up.y), az = Math.abs(up.z);
  if (ax <= ay && ax <= az) right.set(0, -up.z, up.y);
  else if (ay <= az) right.set(-up.z, 0, up.x);
  else right.set(-up.y, up.x, 0);
  right.normalize();
  fwd.crossVectors(right, up).normalize();
}

/** Drop the radial part of an animal's velocity (keep it moving along the ground). */
function removeRadial(a: Animal, up: THREE.Vector3) {
  const d = a.vx * up.x + a.vy * up.y + a.vz * up.z;
  a.vx -= up.x * d; a.vy -= up.y * d; a.vz -= up.z * d;
}

/** Turn an animal's heading by `ang` radians about its local up. */
function turn(a: Animal, ang: number) {
  _up.set(a.x, a.y, a.z).normalize();
  _v.set(a.fx, a.fy, a.fz).applyAxisAngle(_up, ang);
  a.fx = _v.x; a.fy = _v.y; a.fz = _v.z;
}
