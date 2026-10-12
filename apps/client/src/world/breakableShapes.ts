// Procedural low-poly breakable props (SPEC §6.9, §7.2) and their pre-fractured debris.
// Runs in the fracture worker (and in tests), never on the main thread: it pulls in three-piñata.
//
// Every archetype is a few closed (manifold) solids, each fractured on its own with
// @dgreenheck/three-pinata (MIT, npm package only, D17) into a fixed number of pieces for a few
// fixed seeds. Colours are per triangle, computed from the triangle's object-space centroid and
// normal, so a fragment's outer faces keep the intact prop's look; fresh fracture faces get the
// part's inner colour and an `inner` = 1 vertex flag (one material, one draw: the shader tints them).

import { DestructibleMesh, FractureOptions } from "@dgreenheck/three-pinata";
import { BoxGeometry, BufferAttribute, BufferGeometry, Color, ConeGeometry, CylinderGeometry, IcosahedronGeometry, Matrix4 } from "three";
import {
  BREAKABLE_ARCHETYPES, bodyBreakables, createTerrain, hash01, type Breakable, type BreakableArchetype, type BodyId,
} from "@firstlight/shared";

type RGB = [number, number, number];

interface Palette {
  wood: number; wood2: number; frame: number;
  barrel: number; barrel2: number; band: number;
  stone: number; stone2: number; joint: number;
  figure: number; figure2: number;
  wall: number[]; wallJoint: number;
  cover: number; cover2: number;
  /** Fresh fracture faces (lighter raw material). */
  woodIn: number; stoneIn: number; metalIn: number; coverIn: number;
}

/** Planet palettes: saturated around each body's key hue + accent (film rule 1, content.md looks). */
const PALETTES: Record<Exclude<BodyId, "portus">, Palette> = {
  arcadia: {
    wood: 0xc8914a, wood2: 0xb37d3e, frame: 0x7a4f2a,
    barrel: 0x2fb3a3, barrel2: 0x279a8c, band: 0x3b3b44,
    stone: 0xd8d0bc, stone2: 0xc4baa2, joint: 0x9a907c,
    figure: 0x4a7fd0, figure2: 0xf2c14e,
    wall: [0x3b7dd8, 0xf2c94c, 0xe8605a, 0x5cc96b], wallJoint: 0x2c2c3c,
    cover: 0xf08a7a, cover2: 0xffd2b8,
    woodIn: 0xf0d6a8, stoneIn: 0xf0ead8, metalIn: 0xd8dde2, coverIn: 0xfff0e6,
  },
  hollowmere: {
    wood: 0x5e4a3a, wood2: 0x4f3e31, frame: 0x2e2620,
    barrel: 0x4a3a30, barrel2: 0x3e3028, band: 0x24242c,
    stone: 0x7c7290, stone2: 0x6a6080, joint: 0x4a4258,
    figure: 0xd8d0c0, figure2: 0x7f9478,
    wall: [0xc8c0b0, 0xb6ae9e, 0xa8a090, 0xd2cabb], wallJoint: 0x5a5260,
    cover: 0x6c6080, cover2: 0x5c5272,
    woodIn: 0xa8906e, stoneIn: 0xb4aac4, metalIn: 0xb8b8c4, coverIn: 0xb4aac4,
  },
  meridian: {
    wood: 0x5c636c, wood2: 0x515860, frame: 0xffb347,
    barrel: 0xd88a2a, barrel2: 0xc27a22, band: 0x2a2e34,
    stone: 0xb4aa9a, stone2: 0xa49a8a, joint: 0x7a7266,
    figure: 0xc8d0d8, figure2: 0xe8eef4,
    wall: [0xb0a898, 0xa39b8b], wallJoint: 0x6a6458,
    cover: 0xc0583a, cover2: 0x3fa8b0,
    woodIn: 0x9aa2ac, stoneIn: 0xd8d0c4, metalIn: 0xdfe4ea, coverIn: 0xb8bec6,
  },
};
const HAZARD = [0xffc23a, 0x26262a];

const _c = new Color();
function lin(hex: number, k = 1, out: RGB = [0, 0, 0]): RGB {
  _c.setHex(hex); // sRGB hex → linear working space
  out[0] = _c.r * k;
  out[1] = _c.g * k;
  out[2] = _c.b * k;
  return out;
}

/** Outer colour of a triangle from its object-space centroid (x, y, z) and face normal. */
type ColorFn = (x: number, y: number, z: number, nx: number, ny: number, nz: number, out: RGB) => void;

export interface ShapePart {
  /** Closed solid in object space (y up from the base), non-indexed with flat normals. */
  geometry: BufferGeometry;
  /** Pieces for this part at full / Low quality (1 = it flies off whole). */
  pieces: [number, number];
  color: ColorFn;
  inner: number;
}

// ------------------------------------------------------------------------------------ solids

function flat(g: BufferGeometry, m?: Matrix4): BufferGeometry {
  const out = g.index ? g.toNonIndexed() : g;
  out.deleteAttribute("uv");
  out.deleteAttribute("normal");
  if (m) out.applyMatrix4(m);
  out.computeVertexNormals(); // non-indexed → face normals (faceted look)
  return out;
}

const T = (x: number, y: number, z: number, ry = 0) => new Matrix4().makeRotationY(ry).setPosition(x, y, z);

function box(w: number, h: number, d: number, segs: [number, number, number], x: number, y: number, z: number): BufferGeometry {
  return flat(new BoxGeometry(w, h, d, segs[0], segs[1], segs[2]), T(x, y + h / 2, z));
}

/** A capped cylinder whose radius follows `profile(t)` (t = 0 bottom … 1 top); closed by construction. */
function lathe(h: number, radial: number, rows: number, profile: (t: number) => number, y0 = 0, twist = 0): BufferGeometry {
  const g = new CylinderGeometry(1, 1, h, radial, rows, false);
  const p = g.getAttribute("position") as BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const y = p.getY(i);
    const t = y / h + 0.5;
    const r = profile(t);
    const a = twist * t;
    const x = p.getX(i) * r, z = p.getZ(i) * r;
    p.setXYZ(i, x * Math.cos(a) - z * Math.sin(a), y + h / 2 + y0, x * Math.sin(a) + z * Math.cos(a));
  }
  return flat(g);
}

// ------------------------------------------------------------------------------------ archetypes

function jitter(x: number, y: number, z: number, seed: number): number {
  return 0.92 + 0.16 * hash01(Math.round(x * 97), Math.round(y * 97), Math.round(z * 97), seed);
}

function shaded(hex: number, x: number, y: number, z: number, seed: number, out: RGB, k = 1) {
  lin(hex, jitter(x, y, z, seed) * k, out);
}

/** Which face of a box a normal belongs to, and the face's (u, v) from the centroid. */
function faceUV(x: number, y: number, z: number, nx: number, ny: number, nz: number): { axis: 0 | 1 | 2; u: number; v: number } {
  const ax = Math.abs(nx), ay = Math.abs(ny), az = Math.abs(nz);
  if (ay >= ax && ay >= az) return { axis: 1, u: x, v: z };
  if (ax >= az) return { axis: 0, u: z, v: y };
  return { axis: 2, u: x, v: y };
}

export function archetypeShape(body: BodyId, kind: BreakableArchetype): ShapePart[] {
  if (body === "portus") return [];
  const P = PALETTES[body];
  switch (kind) {
    case "crate":
      return [{
        geometry: box(1, 1, 1, [3, 3, 3], 0, 0, 0),
        pieces: [8, 5],
        inner: P.woodIn,
        color: (x, y, z, nx, ny, nz, out) => {
          const f = faceUV(x, y, z, nx, ny, nz);
          const side = f.axis !== 1;
          // A one-cell frame around every face, a lighter panel inside.
          const frame = Math.abs(f.u) > 0.17 || (side ? f.v < 0.33 || f.v > 0.67 : Math.abs(f.v) > 0.17);
          shaded(frame ? P.frame : P.wood, x, y, z, frame ? 1 : 2, out);
        },
      }];
    case "barrel":
      return [{
        geometry: lathe(1.12, 10, 6, (t) => 0.395 + 0.03 * Math.sin(Math.PI * t)),
        pieces: [8, 5],
        inner: P.metalIn,
        color: (x, y, z, _nx, ny, _nz, out) => {
          if (Math.abs(ny) > 0.9) return shaded(P.barrel2, x, y, z, 3, out);
          const row = Math.floor((y / 1.12) * 6);
          if (row === 1 || row === 4) return shaded(P.band, x, y, z, 4, out);
          const stave = Math.floor(((Math.atan2(z, x) + Math.PI) / (Math.PI * 2)) * 10);
          shaded(stave % 2 ? P.barrel : P.barrel2, x, y, z, 5, out);
        },
      }];
    case "fence": {
      const post = (x: number): ShapePart => ({
        geometry: box(0.12, 1.1, 0.12, [1, 2, 1], x, 0, 0),
        pieces: [1, 1],
        inner: P.woodIn,
        color: (px, py, pz, _a, _b, _c2, out) => shaded(P.frame, px, py, pz, 6, out),
      });
      const rail = (y: number): ShapePart => ({
        geometry: box(1.76, 0.1, 0.05, [4, 1, 1], 0, y, 0),
        pieces: [3, 2],
        inner: P.woodIn,
        color: (px, py, pz, _a, _b, _c2, out) => shaded(body === "meridian" ? P.stone2 : P.wood, px, py, pz, 7, out),
      });
      return [post(-0.94), post(0.94), rail(0.4), rail(0.8)];
    }
    case "statue":
      return statue(body, P);
    case "pillar":
      return pillar(P, 0.84, 0.3, 0.36, 3.6, P.stone, P.stone2);
    case "campwall":
      return [campwall(body, P)];
    case "cover":
      if (body === "hollowmere") return pillar(P, 1.1, 0.35, 0.5, 4.9, P.cover, P.cover2);
      if (body === "meridian") return [container(P)];
      return [coral(P)];
  }
}

function statue(body: BodyId, P: Palette): ShapePart[] {
  const stone: ColorFn = (x, y, z, _a, _b, _c2, out) => shaded(y > 0.4 ? P.stone2 : P.stone, x, y, z, 8, out);
  if (body === "meridian") {
    // A corporate bust on a tall slate plinth.
    return [
      { geometry: box(0.7, 1.4, 0.7, [1, 3, 1], 0, 0, 0), pieces: [3, 2], inner: P.stoneIn, color: (x, y, z, _a, _b, _c2, out) => shaded(P.wood, x, y, z, 9, out) },
      { geometry: box(0.78, 0.62, 0.42, [2, 2, 1], 0, 1.4, 0), pieces: [4, 3], inner: P.metalIn, color: (x, y, z, _a, _b, _c2, out) => shaded(P.figure, x, y, z, 10, out) },
      { geometry: flat(new IcosahedronGeometry(0.22, 0), T(0, 2.3, 0)), pieces: [1, 1], inner: P.metalIn, color: (x, y, z, _a, _b, _c2, out) => shaded(P.figure2, x, y, z, 11, out) },
    ];
  }
  const robe = (t: number) => 0.34 - 0.1 * t + 0.08 * Math.sin(Math.PI * Math.min(1, t * 1.2)) * (t > 0.7 ? 0.3 : 1) - (t > 0.88 ? (t - 0.88) * 1.4 : 0);
  const parts: ShapePart[] = [
    { geometry: box(0.9, 0.5, 0.9, [2, 1, 2], 0, 0, 0), pieces: [3, 2], inner: P.stoneIn, color: stone },
    {
      geometry: lathe(1.88, 8, 6, robe, 0.5, 0.25),
      pieces: [5, 3],
      inner: P.stoneIn,
      color: (x, y, z, _a, _b, _c2, out) =>
        body === "hollowmere" ? shaded(y < 0.95 ? P.figure2 : P.figure, x, y, z, 12, out) : shaded(y > 2.0 ? P.figure2 : P.figure, x, y, z, 12, out),
    },
  ];
  // Hollowmere's saints are hooded; Arcadia's arcade hero has a round head.
  const head = body === "hollowmere" ? flat(new ConeGeometry(0.24, 0.42, 6), T(0, 2.54, 0)) : flat(new IcosahedronGeometry(0.19, 0), T(0, 2.56, 0));
  parts.push({ geometry: head, pieces: [1, 1], inner: P.stoneIn, color: (x, y, z, _a, _b, _c2, out) => shaded(body === "hollowmere" ? P.figure : P.figure2, x, y, z, 13, out) });
  return parts;
}

function pillar(P: Palette, w: number, cap: number, r: number, shaft: number, c1: number, c2: number): ShapePart[] {
  const rows = Math.round(shaft / 0.9);
  return [
    { geometry: box(w, cap, w, [1, 1, 1], 0, 0, 0), pieces: [2, 1], inner: P.stoneIn, color: (x, y, z, _a, _b, _c2, out) => shaded(c2, x, y, z, 14, out) },
    {
      geometry: lathe(shaft, 8, rows, (t) => r * (1.06 - 0.08 * t), cap),
      pieces: [6, 4],
      inner: P.stoneIn,
      color: (x, y, z, _a, _b, _c2, out) => shaded(Math.floor((y - cap) / 0.9) % 2 ? c1 : c2, x, y, z, 15, out),
    },
    { geometry: box(w, cap, w, [1, 1, 1], 0, cap + shaft, 0), pieces: [2, 1], inner: P.stoneIn, color: (x, y, z, _a, _b, _c2, out) => shaded(c2, x, y, z, 16, out) },
  ];
}

function campwall(body: BodyId, P: Palette): ShapePart {
  return {
    geometry: box(4, 2.6, 0.6, [8, 5, 1], 0, 0, 0),
    pieces: [10, 6],
    inner: P.stoneIn,
    color: (x, y, z, nx, ny, nz, out) => {
      const f = faceUV(x, y, z, nx, ny, nz);
      if (f.axis === 1) return shaded(P.wallJoint, x, y, z, 17, out);
      const i = Math.floor((f.u + 2) / 0.5), j = Math.floor(y / 0.52);
      if (body === "meridian") {
        // Concrete blast wall with a hazard stripe along the foot.
        if (j === 0) return shaded(HAZARD[(i + Math.floor(z > 0 ? 0 : 1)) % 2]!, x, y, z, 18, out);
        return shaded(P.wall[(j % 2)]!, x, y, z, 19, out);
      }
      if (body === "arcadia") {
        // Blockyard: chunky voxel blocks in the arcade palette.
        return shaded(P.wall[Math.floor(hash01(i, j, f.axis, 77) * P.wall.length)]!, x, y, z, 20, out);
      }
      return shaded(P.wall[(i + (j % 2)) % 2 ? 0 : 2]!, x, y, z, 21, out);
    },
  };
}

function container(P: Palette): ShapePart {
  return {
    geometry: box(6, 2.6, 2.4, [12, 1, 2], 0, 0, 0),
    pieces: [12, 7],
    inner: P.metalIn,
    color: (x, y, z, nx, ny, nz, out) => {
      const f = faceUV(x, y, z, nx, ny, nz);
      if (f.axis === 1) return shaded(P.cover, x, y, z, 22, out);
      // Teal double doors at the ends, ribbed rust-red sides.
      if (f.axis === 0) return shaded(P.cover2, x, y, z, 23, out, z < 0 ? 0.88 : 1);
      shaded(P.cover, x, y, z, 24, out, Math.floor((x + 3) / 0.5) % 2 ? 0.8 : 1);
    },
  };
}

function coral(P: Palette): ShapePart {
  return {
    geometry: lathe(3.0, 8, 8, (t) => 0.62 + 0.14 * Math.sin(t * 9.0) + 0.1 * Math.sin(t * 3.1 + 1) - 0.25 * t * t, 0, 0.9),
    pieces: [9, 6],
    inner: P.coverIn,
    color: (x, y, z, _a, _b, _c2, out) => {
      const a = lin(P.cover, 1, [0, 0, 0]);
      const b = lin(P.cover2, 1, [0, 0, 0]);
      const t = Math.min(1, Math.max(0, y / 3.0));
      const k = jitter(x, y, z, 25);
      out[0] = (a[0] + (b[0] - a[0]) * t) * k;
      out[1] = (a[1] + (b[1] - a[1]) * t) * k;
      out[2] = (a[2] + (b[2] - a[2]) * t) * k;
    },
  };
}

// ------------------------------------------------------------------------------------ meshes

/** Flat arrays for one mesh: positions, normals, colours (linear RGB), inner flag. */
export interface MeshArrays {
  positions: Float32Array;
  normals: Float32Array;
  colors: Float32Array;
  inner: Float32Array;
}

export interface PieceArrays extends MeshArrays {
  /** Piece centre in the prop's object space (scale 1). */
  center: [number, number, number];
  /** Bounding radius around the centre. */
  radius: number;
}

const _rgb: RGB = [0, 0, 0];

/** Colour a non-indexed solid's triangles (all outer). */
function colourIntact(part: ShapePart, g: BufferGeometry): MeshArrays {
  const pos = g.getAttribute("position").array as Float32Array;
  const nor = g.getAttribute("normal").array as Float32Array;
  const colors = new Float32Array(pos.length);
  for (let t = 0; t < pos.length; t += 9) {
    const cx = (pos[t]! + pos[t + 3]! + pos[t + 6]!) / 3, cy = (pos[t + 1]! + pos[t + 4]! + pos[t + 7]!) / 3, cz = (pos[t + 2]! + pos[t + 5]! + pos[t + 8]!) / 3;
    part.color(cx, cy, cz, nor[t]!, nor[t + 1]!, nor[t + 2]!, _rgb);
    for (let v = 0; v < 3; v++) colors.set(_rgb, t + v * 3);
  }
  return { positions: new Float32Array(pos), normals: new Float32Array(nor), colors, inner: new Float32Array(pos.length / 3) };
}

function concat(list: MeshArrays[]): MeshArrays {
  const n = list.reduce((s, m) => s + m.positions.length, 0);
  const out: MeshArrays = { positions: new Float32Array(n), normals: new Float32Array(n), colors: new Float32Array(n), inner: new Float32Array(n / 3) };
  let o = 0;
  for (const m of list) {
    out.positions.set(m.positions, o);
    out.normals.set(m.normals, o);
    out.colors.set(m.colors, o);
    out.inner.set(m.inner, o / 3);
    o += m.positions.length;
  }
  return out;
}

/** The intact prop: every part merged, coloured, inner = 0. */
export function intactArrays(parts: ShapePart[]): MeshArrays {
  return concat(parts.map((p) => colourIntact(p, p.geometry)));
}

/** A fracture output geometry (indexed, group 0 outer, group 1 inner) → coloured flat arrays. */
function pieceFromFragment(part: ShapePart, g: BufferGeometry, center: [number, number, number]): PieceArrays {
  const pos = g.getAttribute("position").array as ArrayLike<number>;
  const nor = g.getAttribute("normal").array as ArrayLike<number>;
  const index = g.index ? (g.index.array as ArrayLike<number>) : null;
  const triCount = (index ? index.length : pos.length / 3) / 3;
  const innerStart = g.groups.length === 2 ? g.groups[1]!.start / 3 : triCount;
  const P = new Float32Array(triCount * 9), N = new Float32Array(triCount * 9), C = new Float32Array(triCount * 9), I = new Float32Array(triCount * 3);
  const innerRGB = lin(part.inner, 1, [0, 0, 0]);
  let radius = 0;
  for (let t = 0; t < triCount; t++) {
    const isInner = t >= innerStart;
    let cx = 0, cy = 0, cz = 0;
    for (let v = 0; v < 3; v++) {
      const vi = index ? index[t * 3 + v]! : t * 3 + v;
      for (let k = 0; k < 3; k++) {
        P[t * 9 + v * 3 + k] = pos[vi * 3 + k]!;
        N[t * 9 + v * 3 + k] = nor[vi * 3 + k]!;
      }
      const x = pos[vi * 3]!, y = pos[vi * 3 + 1]!, z = pos[vi * 3 + 2]!;
      radius = Math.max(radius, Math.hypot(x, y, z));
      cx += x / 3; cy += y / 3; cz += z / 3;
    }
    if (isInner) {
      const k = jitter(cx + center[0], cy + center[1], cz + center[2], 31);
      _rgb[0] = innerRGB[0] * k; _rgb[1] = innerRGB[1] * k; _rgb[2] = innerRGB[2] * k;
    } else {
      // Face normal from the triangle (the fragment keeps the source's flat normals anyway).
      part.color(cx + center[0], cy + center[1], cz + center[2], N[t * 9]!, N[t * 9 + 1]!, N[t * 9 + 2]!, _rgb);
    }
    for (let v = 0; v < 3; v++) {
      C.set(_rgb, t * 9 + v * 3);
      I[t * 3 + v] = isInner ? 1 : 0;
    }
  }
  return { positions: P, normals: N, colors: C, inner: I, center, radius };
}

/** Fracture one part into `count` pieces (seeded). A failed fracture falls back to the whole part. */
function fracturePart(part: ShapePart, count: number, seed: number): { pieces: PieceArrays[]; failed: boolean } {
  if (count <= 1) return { pieces: [wholePart(part)], failed: false };
  try {
    const mesh = new DestructibleMesh(part.geometry);
    const frags = mesh.fracture(new FractureOptions({ fractureMethod: "voronoi", fragmentCount: count, voronoiOptions: { mode: "3D" }, seed }));
    const pieces = frags
      .map((f) => pieceFromFragment(part, f.geometry as BufferGeometry, [f.position.x, f.position.y, f.position.z]))
      .filter((p) => p.positions.length >= 9 * 4);
    if (!pieces.length) throw new Error("no pieces");
    return { pieces, failed: false };
  } catch {
    return { pieces: [wholePart(part)], failed: true };
  }
}

function wholePart(part: ShapePart): PieceArrays {
  const m = colourIntact(part, part.geometry);
  let cx = 0, cy = 0, cz = 0;
  const n = m.positions.length / 3;
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < n; i++) {
    const x = m.positions[i * 3]!, y = m.positions[i * 3 + 1]!, z = m.positions[i * 3 + 2]!;
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
  }
  cx = (minX + maxX) / 2; cy = (minY + maxY) / 2; cz = (minZ + maxZ) / 2;
  let radius = 0;
  for (let i = 0; i < n; i++) {
    m.positions[i * 3] -= cx; m.positions[i * 3 + 1] -= cy; m.positions[i * 3 + 2] -= cz;
    radius = Math.max(radius, Math.hypot(m.positions[i * 3]!, m.positions[i * 3 + 1]!, m.positions[i * 3 + 2]!));
  }
  return { ...m, center: [cx, cy, cz], radius };
}

// ------------------------------------------------------------------------------------ the set

export const FRACTURE_VARIANTS = 3;

export interface BreakableAssets {
  body: BodyId;
  /** 0 = full (8–12 pieces per prop), 1 = Low tier (5–7). */
  quality: 0 | 1;
  breakables: Breakable[];
  /** Per archetype index present on the body: the intact mesh. */
  intact: Record<number, MeshArrays>;
  /** fragments[archetype][variant] = pieces (empty when fracturing was skipped). */
  fragments: Record<number, PieceArrays[][]>;
  /** Fractures that fell back to whole parts (triangulation failures). */
  failures: number;
  ms: number;
}

/** Everything the client needs for one body's breakables (the fracture worker's job). */
export function buildBreakableAssets(body: BodyId, opts: { quality?: 0 | 1; fracture?: boolean } = {}): BreakableAssets {
  const t0 = performance.now();
  const quality = opts.quality ?? 0;
  const breakables = [...bodyBreakables(createTerrain(body))];
  const present = [...new Set(breakables.map((b) => b.archetype))].sort((a, b) => a - b);
  const intact: BreakableAssets["intact"] = {};
  const fragments: BreakableAssets["fragments"] = {};
  let failures = 0;
  for (const a of present) {
    const parts = archetypeShape(body, BREAKABLE_ARCHETYPES[a]!);
    intact[a] = intactArrays(parts);
    if (opts.fracture === false) continue;
    const perVariant: PieceArrays[][] = [];
    for (let v = 0; v < FRACTURE_VARIANTS; v++) {
      const pieces: PieceArrays[] = [];
      parts.forEach((part, pi) => {
        const r = fracturePart(part, part.pieces[quality]!, 1009 + v * 7919 + pi * 131 + a * 17);
        if (r.failed) failures++;
        pieces.push(...r.pieces);
      });
      perVariant.push(pieces);
    }
    fragments[a] = perVariant;
  }
  return { body, quality, breakables, intact, fragments, failures, ms: performance.now() - t0 };
}

/** Every transferable buffer in a set (postMessage transfer list). */
export function assetBuffers(a: BreakableAssets): ArrayBuffer[] {
  const out: ArrayBuffer[] = [];
  const add = (m: MeshArrays) => out.push(m.positions.buffer as ArrayBuffer, m.normals.buffer as ArrayBuffer, m.colors.buffer as ArrayBuffer, m.inner.buffer as ArrayBuffer);
  for (const m of Object.values(a.intact)) add(m);
  for (const v of Object.values(a.fragments)) for (const pieces of v) for (const p of pieces) add(p);
  return out;
}
