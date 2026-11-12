// Rez-in / de-rez (D-gfx-hub-1): an avatar materialises out of light when it appears (join, portal
// arrival, fast travel, rebirth), dissolves top-down when it leaves, and breaks into drifting light
// shards when it dies.
//
// Two parts, both driven by per-object uniforms (no material variant, no extra shadow build):
//   1. the body: avatarMaterial() ANDs rezKeep() into its mask and adds rezGlow() to its emissive. A
//      scan plane rises through the body (fragments above it are gone; a band of voxel cells just
//      above it flickers in, the edge glows in the palette's accent), or a voxel dissolve eats it
//      (death). Idle avatars carry values that keep every fragment. Shadows keep three's default
//      opaque path (the material's shadow mask stays keep-all, D-load-3); the view just stops casting
//      while most of the body is missing.
//   2. the light: one small additive mesh per effect (rezFxMesh: a column, a ground ring, the scan
//      ring and ~56 shards in one geometry, one shared material, one draw), parented to the avatar.
//
// The timing is pure (rezPose) and unit-tested; AvatarView steps it and writes the uniforms.

import * as THREE from "three/webgpu";
import { attribute, dot, float, floor, fract, max, mix, normalize, positionLocal, positionWorld, select, sin, smoothstep, uniform, uv, vec3 } from "three/tsl";

export type RezKind = "in" | "out" | "death";

/** Seconds each effect lasts. */
export const REZ_SECONDS: Record<RezKind, number> = { in: 1.25, out: 0.85, death: 1.7 };
/** The scan plane's travel (m above the feet): from under the soles to over the tallest hat. */
export const REZ_FLOOR = -0.25;
export const REZ_TOP = 2.65;
/** Height of the band of voxel cells above the scan plane that are still flickering in (m). */
export const REZ_BAND = 0.3;
/** Death: the body falls for this long before it starts to break up (s). */
export const DEATH_HOLD = 0.4;
/** Cut value that keeps every fragment (idle) / drops every fragment (gone). */
export const CUT_IDLE = 1e9;
export const CUT_GONE = -1e9;

export interface RezPose {
  /** Scan plane height above the feet (m): fragments above it (plus the band) are discarded. */
  cut: number;
  /** Voxel dissolve, 0 whole … 1 gone. */
  dissolve: number;
  /** Edge glow strength on the body, 0 … 1. */
  glow: number;
  /** Progress of the light effect, 0 … 1 (the fx mesh hides at 1). */
  fx: number;
  /** Whether the body casts its shadow / shows what it holds and wears now. */
  solid: boolean;
  /** The effect has finished. */
  done: boolean;
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const ease = (x: number) => {
  const t = clamp01(x);
  return t * t * (3 - 2 * t);
};

/** The effect `kind` at `t` seconds after its start (pure; `out` is reused when given). */
export function rezPose(kind: RezKind, t: number, out: RezPose = { cut: CUT_IDLE, dissolve: 0, glow: 0, fx: 1, solid: true, done: true }): RezPose {
  const p = clamp01(t / REZ_SECONDS[kind]);
  out.fx = p;
  out.done = p >= 1;
  if (kind === "in") {
    // The light arrives first (0 … 0.12), the plane climbs (0.12 … 0.82), the glow fades (… 1).
    const scan = ease((p - 0.12) / 0.7);
    out.cut = out.done ? CUT_IDLE : REZ_FLOOR + (REZ_TOP - REZ_FLOOR) * scan;
    out.dissolve = 0;
    out.glow = out.done ? 0 : 1 - ease((p - 0.82) / 0.18);
    out.solid = scan > 0.6;
  } else if (kind === "out") {
    const scan = ease(p / 0.85);
    out.cut = out.done ? CUT_GONE : REZ_TOP + (REZ_FLOOR - REZ_TOP) * scan;
    out.dissolve = 0;
    out.glow = 1;
    out.solid = scan < 0.4;
  } else {
    const hold = DEATH_HOLD / REZ_SECONDS.death;
    const d = clamp01((p - hold) / (1 - hold));
    out.cut = out.done ? CUT_GONE : CUT_IDLE;
    out.dissolve = out.done ? 1 : d * d * 0.2 + d * 0.8;
    out.glow = p < hold ? p / hold : 1;
    out.solid = d < 0.35;
  }
  return out;
}

/** What the body's shader reads for one skinned mesh: feet (planet space), cut, dissolve, glow. */
export interface RezBody {
  feet: THREE.Vector3;
  /** x cut, y dissolve, z glow. */
  p: THREE.Vector3;
}

const bodies = new WeakMap<THREE.Object3D, RezBody>();
const IDLE_FEET = new THREE.Vector3(0, 1, 0);
const IDLE_P = new THREE.Vector3(CUT_IDLE, 0, 0);

/** Give `mesh` (a skinned avatar body) its rez values; AvatarView mutates the returned object. */
export function rezBody(mesh: THREE.Object3D): RezBody {
  let b = bodies.get(mesh);
  if (!b) bodies.set(mesh, (b = { feet: IDLE_FEET.clone(), p: IDLE_P.clone() }));
  return b;
}

// Per-object uniforms: three sets them from the drawn mesh right before it writes that draw's own
// uniform buffer (the palette's and the camera fade gate's pattern, D-load-4 / D-view-5).
const uFeet = uniform(IDLE_FEET.clone());
uFeet.onObjectUpdate(({ object }) => void uFeet.value.copy(bodies.get(object as THREE.Object3D)?.feet ?? IDLE_FEET));
const uBody = uniform(IDLE_P.clone());
uBody.onObjectUpdate(({ object }) => void uBody.value.copy(bodies.get(object as THREE.Object3D)?.p ?? IDLE_P));

/** Voxel cells per metre of the dissolve pattern. */
const CELLS = 15;

let nodes: { keep: THREE.Node; glow: THREE.Node } | null = null;
function bodyNodes() {
  if (nodes) return nodes;
  // Relative to the feet: small numbers (the planet's radius is thousands of metres), and the
  // pattern travels with the avatar.
  const rel = positionWorld.sub(uFeet);
  const h = dot(rel, normalize(uFeet));
  const cell = floor(rel.mul(CELLS));
  const n = fract(sin(dot(cell, vec3(12.9898, 78.233, 37.719))).mul(43758.5453));
  const cut = uBody.x;
  const diss = uBody.y;
  const keep = h.lessThan(cut.add(n.mul(REZ_BAND))).and(n.greaterThanEqual(diss));
  // The glowing edge: just under the scan plane and through the flickering band; and the cells about
  // to go in a dissolve.
  const scanEdge = smoothstep(cut.sub(0.16), cut, h);
  const dissEdge = smoothstep(diss.add(0.22), diss, n).mul(smoothstep(0.0, 0.02, diss));
  const glow = max(scanEdge, dissEdge).mul(uBody.z);
  nodes = { keep: keep as unknown as THREE.Node, glow: glow as unknown as THREE.Node };
  return nodes;
}

/** Keep (true) or drop (false) this fragment of a rezzing body. Shared by every avatar material. */
export function rezKeep(): THREE.Node {
  return bodyNodes().keep;
}

/** 0 … 1: how much this fragment glows as the edge of the effect. */
export function rezGlow(): THREE.Node {
  return bodyNodes().glow;
}

// ---------------------------------------------------------------------------------------- light

/** What the light mesh's shader reads: x progress, y mode (0 in, 1 out, 2 death), z cut (m), w strength. */
export interface RezFx {
  p: THREE.Vector4;
  color: THREE.Color;
}

const fxOf = new WeakMap<THREE.Object3D, RezFx>();
const FX_IDLE = new THREE.Vector4(1, 0, 0, 0);
const FX_COLOR = new THREE.Color(0x9fe8ff);
const uFx = uniform(FX_IDLE.clone());
uFx.onObjectUpdate(({ object }) => void uFx.value.copy(fxOf.get(object as THREE.Object3D)?.p ?? FX_IDLE));
const uFxColor = uniform(FX_COLOR.clone());
uFxColor.onObjectUpdate(({ object }) => void uFxColor.value.copy(fxOf.get(object as THREE.Object3D)?.color ?? FX_COLOR));

export const REZ_SHARDS = 56;
const KIND = { column: 0, ground: 1, scan: 2, shard: 3 } as const;

/** A small deterministic generator (the geometry is the same every session). */
function lcg(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}

let fxGeo: THREE.BufferGeometry | null = null;
/** Column, ground ring, scan ring and shards in one geometry (avatar space: y up from the feet). */
export function rezFxGeometry(): THREE.BufferGeometry {
  if (fxGeo) return fxGeo;
  const pos: number[] = [];
  const uvs: number[] = [];
  const fx: number[] = []; // kind, seed a, seed b, seed c
  const ctr: number[] = [];
  const idx: number[] = [];
  const vert = (x: number, y: number, z: number, u: number, v: number, kind: number, a = 0, b = 0, c = 0, cx = 0, cy = 0, cz = 0) => {
    pos.push(x, y, z);
    uvs.push(u, v);
    fx.push(kind, a, b, c);
    ctr.push(cx, cy, cz);
    return pos.length / 3 - 1;
  };
  const tube = (kind: number, r0: number, r1: number, y0: number, y1: number, seg: number) => {
    const base = pos.length / 3;
    for (let i = 0; i <= seg; i++) {
      const a = (i / seg) * Math.PI * 2;
      vert(Math.cos(a) * r0, y0, Math.sin(a) * r0, i / seg, 0, kind);
      vert(Math.cos(a) * r1, y1, Math.sin(a) * r1, i / seg, 1, kind);
    }
    for (let i = 0; i < seg; i++) {
      const k = base + i * 2;
      idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2);
    }
  };
  tube(KIND.column, 0.56, 0.3, 0, 5.2, 24); // the column of light
  tube(KIND.ground, 0.35, 1.0, 0.04, 0.04, 32); // the ground ring (a flat annulus; uv.y 0 inner … 1 outer)
  tube(KIND.scan, 0.58, 0.58, -0.05, 0.05, 28); // the scan ring (rides the cut)
  const rnd = lcg(0x51f7);
  for (let i = 0; i < REZ_SHARDS; i++) {
    // A point in the body's volume, a drift direction (outwards and up) and a small random triangle.
    const a = rnd() * Math.PI * 2;
    const r = 0.08 + rnd() * 0.24;
    const cx = Math.cos(a) * r, cy = 0.15 + rnd() * 1.65, cz = Math.sin(a) * r;
    const da = a + (rnd() - 0.5) * 1.2;
    const seedA = rnd(), seedB = rnd(), seedC = rnd();
    const dx = Math.cos(da), dz = Math.sin(da);
    const size = 0.05 + rnd() * 0.07;
    const base = pos.length / 3;
    for (let k = 0; k < 3; k++) {
      const ox = (rnd() - 0.5) * 2 * size, oy = (rnd() - 0.5) * 2 * size, oz = (rnd() - 0.5) * 2 * size;
      // uv carries the drift direction (xz); seeds: a = delay, b = lift, c = twinkle.
      vert(cx + ox, cy + oy, cz + oz, dx, dz, KIND.shard, seedA, seedB, seedC, cx, cy, cz);
    }
    idx.push(base, base + 1, base + 2);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  g.setAttribute("aFx", new THREE.Float32BufferAttribute(fx, 4));
  g.setAttribute("aCenter", new THREE.Float32BufferAttribute(ctr, 3));
  g.setIndex(idx);
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 2.4, 0), 4.5);
  fxGeo = g;
  return g;
}

let fxMat: THREE.MeshBasicNodeMaterial | null = null;
/** The one additive material of every rez light (per-object uniforms: progress, mode, cut, colour). */
export function rezFxMaterial(): THREE.MeshBasicNodeMaterial {
  if (fxMat) return fxMat;
  const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false });
  m.name = "rez_fx";
  const a = attribute("aFx", "vec4");
  const center = attribute("aCenter", "vec3");
  const kind = a.x;
  const p = uFx.x;
  const mode = uFx.y;
  const cut = uFx.z;
  const isIn = mode.lessThan(0.5);
  const isDeath = mode.greaterThan(1.5);
  const isShard = kind.greaterThan(2.5);
  const isScan = kind.greaterThan(1.5).and(kind.lessThan(2.5));
  const isGround = kind.greaterThan(0.5).and(kind.lessThan(1.5));

  // Shards: each has its own short life inside the effect (delayed by seed a). Arriving, they fall in
  // from outside onto the body; leaving and dying, they drift out and up.
  const life = p.mul(1.5).sub(a.y.mul(0.5)).clamp(0, 1);
  const travel = select(isIn, float(1).sub(life), life);
  const reach = select(isDeath, float(1.9), float(1.1));
  const dir = vec3(uv().x, 0, uv().y);
  const drift = dir.mul(travel.mul(reach).mul(a.z.mul(0.7).add(0.5)))
    .add(vec3(0, 1, 0).mul(travel.mul(travel).mul(a.z.mul(1.6).add(0.5)).mul(select(isIn, float(1.4), float(1.0)))));
  const grow = sin(life.mul(Math.PI)).mul(select(isDeath, float(1.5), float(1.0)));
  const shardPos = center.add(drift).add(positionLocal.sub(center).mul(grow));
  // The ground ring spreads; the scan ring rides the cut and closes in at head height.
  const spread = mix(float(0.5), float(1.7), p);
  const groundPos = vec3(positionLocal.x.mul(spread), positionLocal.y, positionLocal.z.mul(spread));
  const scanPos = positionLocal.add(vec3(0, cut.clamp(REZ_FLOOR, REZ_TOP), 0));
  m.positionNode = select(isShard, shardPos, select(isScan, scanPos, select(isGround, groundPos, positionLocal)));

  // Brightness per part. The column: bright at the base, gone by the top, with slow vertical streaks;
  // quick on, slow off.
  const v = uv().y;
  const env = smoothstep(0.0, 0.1, p).mul(float(1).sub(smoothstep(0.55, 1.0, p)));
  const streak = sin(uv().x.mul(Math.PI * 2 * 9).add(v.mul(5)).sub(p.mul(14))).mul(0.45).add(0.55);
  const column = float(1).sub(v).pow(2.2).mul(env).mul(streak).mul(select(isDeath, float(0.2), float(0.4)));
  const ground = smoothstep(0.0, 0.35, v).mul(smoothstep(1.0, 0.55, v)).mul(float(1).sub(p).pow(1.5)).mul(1.6);
  const scanning = smoothstep(REZ_FLOOR, REZ_FLOOR + 0.2, cut).mul(smoothstep(REZ_TOP, REZ_TOP - 0.25, cut));
  const scan = scanning.mul(select(isDeath, float(0), float(2.4)));
  const twinkle = sin(a.w.mul(40).add(p.mul(30))).mul(0.35).add(0.75);
  const shard = sin(life.mul(Math.PI)).mul(twinkle).mul(2.6);
  const bright = select(isShard, shard, select(isScan, scan, select(isGround, ground, column)));
  m.colorNode = uFxColor.mul(bright.mul(uFx.w));
  fxMat = m;
  return m;
}

/** A light mesh for one avatar (hidden until its first effect) and the values its shader reads. */
export function rezFxMesh(): { mesh: THREE.Mesh; fx: RezFx } {
  const mesh = new THREE.Mesh(rezFxGeometry(), rezFxMaterial());
  mesh.name = "rez_fx";
  mesh.visible = false;
  mesh.renderOrder = 6;
  const fx: RezFx = { p: FX_IDLE.clone(), color: FX_COLOR.clone() };
  fxOf.set(mesh, fx);
  return { mesh, fx };
}

/** `?norez` / the Rez toggle: off, rez() calls do nothing (set from the resolved settings). */
export const rezSwitch = { on: true };

/** Rez effects that may run at once (each is one additive draw of ~200 triangles on top of its body). */
export const REZ_MAX_ACTIVE = 6;
/** Further than this from the camera an effect isn't worth its draw (m). */
export const REZ_RANGE_M = 90;
/** Effects running now, each with its light (AvatarView counts them in and out). */
export const rezActive = { count: 0 };

/**
 * Whether one more effect may start: the player's own always does; anyone else's needs a free slot
 * and to be within range of the camera (`dist` m; Infinity when unknown is refused, NaN never is).
 */
export function rezAdmits(active: number, dist: number, own = false): boolean {
  if (own) return true;
  return active < REZ_MAX_ACTIVE && !(dist > REZ_RANGE_M);
}

const MODE: Record<RezKind, number> = { in: 0, out: 1, death: 2 };
export function rezMode(kind: RezKind): number {
  return MODE[kind];
}
