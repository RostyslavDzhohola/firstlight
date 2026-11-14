// Named regions inside each planet (#7): every planet is cut into cells about REGION_SPACING apart
// (a jittered grid on the cube faces, normalised onto the sphere, nearest site wins, the borders
// wobbled by noise), and each cell is one region kind of its planet: Arcadia's Clover Meadows,
// Fernshade Wood, Thistle Heath and Sedge Marsh, and so on. Neighbouring cells are given different
// kinds where the planet has enough, so a 500 m walk crosses at least two of them.
//
// A pure function of the body and a direction: no three, no DOM. The terrain worker colours the
// ground with it, the grass reads its dryness and bloom, the scatter rules filter cosmetic props by
// it, the HUD names the region you walk into, and the server keeps one population per cell (#15).
// Only + - * / sqrt and floor in the cell layout: the same cells in every JS engine. The border
// wobble uses value noise (also plain arithmetic).

import type { BodyId } from "./bodies.ts";
import { BODIES } from "./bodies.ts";
import { hash01, hash4 } from "../rng.ts";
import { regionLow, regionPatch, smooth01, valueNoise, type Region } from "./regionNoise.ts";

/** Target distance between region centres (m): a region is ~150–250 m across. */
export const REGION_SPACING = 200;
/** How far (m) the border between two regions wanders from the straight bisector. */
export const REGION_WOBBLE = 45;
/** Width (m) of the blend between two regions' looks on each side of the border. */
export const REGION_BLEND = 28;

export interface RegionKind {
  id: string;
  /** Shown when you walk in ("Thistle Heath"). Checked against content §10: original names. */
  name: string;
  /** Where the ground and the grass sit (0..1): dry = straw, ash, salt; deep = clover, moss, rust. */
  dry: number;
  deep: number;
  /** A colour the ground cover is pulled toward (sRGB hex) and how far (0..1). */
  ground: number;
  groundAmt: number;
  /** Flower drifts in the grass: 0 none … 1 the planet's usual … 2 a carpet. */
  bloom: number;
  /** Relative share of cells. */
  weight: number;
  /** One line under the name on the region card. */
  line: string;
}

const K = (id: string, name: string, line: string, dry: number, deep: number, ground: number, groundAmt: number, bloom: number, weight = 1): RegionKind =>
  ({ id, name, line, dry, deep, ground, groundAmt, bloom, weight });

/** Region kinds per body. Append only (a cell's kind is an index into its body's list). Portus has none. */
export const REGION_KINDS: Record<BodyId, readonly RegionKind[]> = {
  portus: [],
  arcadia: [
    K("meadow", "Clover Meadows", "Flowers to the knee. Woolbacks graze here.", 0.12, 0.1, 0x5f9a3c, 0.2, 1.8, 1.3),
    K("wood", "Fernshade Wood", "Ferns, toadstools and something watching.", 0.0, 0.95, 0x1f4a26, 0.45, 0.15),
    K("heath", "Thistle Heath", "Dry gorse and a long view.", 0.95, 0.0, 0xa58a4a, 0.4, 0.7),
    K("marsh", "Sedge Marsh", "Reeds, still water, wet boots.", 0.25, 0.7, 0x3c6656, 0.5, 0.35, 0.8),
  ],
  hollowmere: [
    K("fen", "Greyreed Fen", "Pale reeds whisper in no wind.", 0.35, 0.2, 0x5d6448, 0.25, 0.8, 1.2),
    K("mire", "Inkwater Mire", "Black water under moss. Mind your step.", 0.05, 0.95, 0x1f3a3c, 0.5, 0.3),
    K("ashwood", "Ashwood Barrens", "Grey ground where a forest burned.", 0.95, 0.0, 0x8a7f74, 0.45, 0.2),
    K("glowcap", "Glowcap Hollow", "The fungi light the way at night.", 0.1, 0.6, 0x3c2f52, 0.45, 2.0, 0.8),
  ],
  meridian: [
    K("flats", "Cracked Flats", "Baked clay to the horizon.", 0.6, 0.1, 0xb8854a, 0.15, 0.6, 1.2),
    K("dunes", "Pale Dunes", "Nothing grows. Everything shifts.", 1.0, 0.0, 0xe6d2b0, 0.5, 0.1),
    K("rust", "Rust Steppe", "Red grass and redder rock.", 0.2, 0.9, 0x8a3a24, 0.45, 1.0),
    K("salt", "Saltglass Pan", "A dry lake, white and blinding.", 1.0, 0.0, 0xf2eee6, 0.6, 0.0, 0.7),
  ],
  // Lumen (#6) is a dead moon: two looks of bare regolith, no life (the wildlife and food chain skip it).
  lumen: [
    K("mare", "Dark Mare", "Old lava, cold for an age.", 0.0, 0.9, 0x5a5854, 0.55, 0),
    K("uplands", "Pale Uplands", "Bright dust, deep silence.", 1.0, 0.0, 0xc4c0b8, 0.45, 0),
  ],
};

export interface RegionCell {
  /** Unit direction of the cell's centre. */
  dir: [number, number, number];
  /** Index into REGION_KINDS[body]. */
  kind: number;
}

interface Layout {
  cells: RegionCell[];
  /** Bucket grid over [-1, 1]³ (G per axis), CSR: start offsets and cell ids. */
  g: number;
  start: Int32Array;
  ids: Int32Array;
}

/** Cube-face basis (n, tu, tv) as in cubesphere.ts, kept local so the layout never moves if that file does. */
const FACE_BASIS: readonly (readonly number[])[] = [
  [1, 0, 0, 0, 0, -1, 0, 1, 0],
  [-1, 0, 0, 0, 0, 1, 0, 1, 0],
  [0, 1, 0, 1, 0, 0, 0, 0, -1],
  [0, -1, 0, 1, 0, 0, 0, 0, 1],
  [0, 0, 1, 1, 0, 0, 0, 1, 0],
  [0, 0, -1, -1, 0, 0, 0, 1, 0],
];

const layouts = new Map<BodyId, Layout | null>();

function bucketOf(v: number, g: number): number {
  return Math.min(g - 1, Math.max(0, Math.floor(((v + 1) / 2) * g)));
}

function buildLayout(body: BodyId): Layout | null {
  const kinds = REGION_KINDS[body];
  if (!kinds.length) return null;
  const def = BODIES[body];
  const R = def.radius;
  // Cells per face edge: a face is about πR/2 across.
  const n = Math.max(2, Math.round((Math.PI * R) / 2 / REGION_SPACING));
  const cells: RegionCell[] = [];
  for (let f = 0; f < 6; f++) {
    const b = FACE_BASIS[f]!;
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const h = hash4(def.seed, 0x2e610, f, j * 4096 + i);
        const u = ((i + 0.3 + 0.4 * hash01(h, 1)) / n) * 2 - 1;
        const v = ((j + 0.3 + 0.4 * hash01(h, 2)) / n) * 2 - 1;
        const x = b[0]! + u * b[3]! + v * b[6]!;
        const y = b[1]! + u * b[4]! + v * b[7]!;
        const z = b[2]! + u * b[5]! + v * b[8]!;
        const l = Math.sqrt(x * x + y * y + z * z);
        cells.push({ dir: [x / l, y / l, z / l], kind: 0 });
      }
    }
  }
  // Buckets about one cell spacing wide: the nearest centre is always within the 27 round a point.
  const g = Math.max(2, n);
  const count = new Int32Array(g * g * g + 1);
  const key = (d: readonly number[]) => (bucketOf(d[0]!, g) * g + bucketOf(d[1]!, g)) * g + bucketOf(d[2]!, g);
  for (const c of cells) count[key(c.dir) + 1]!++;
  for (let i = 1; i < count.length; i++) count[i] = count[i]! + count[i - 1]!;
  const start = count.slice();
  const fill = count.slice();
  const ids = new Int32Array(cells.length);
  cells.forEach((c, i) => {
    ids[fill[key(c.dir)]!++] = i;
  });
  const layout: Layout = { cells, g, start, ids };
  // Kinds: a weighted hashed pick, turned to the next kind while an earlier neighbour has it.
  const total = kinds.reduce((s, k) => s + k.weight, 0);
  const near = (1.6 * REGION_SPACING) / R;
  const near2 = near * near;
  const neighbours: number[][] = cells.map((c, i) => {
    const out: number[] = [];
    forNear(layout, c.dir[0], c.dir[1], c.dir[2], 2, (j) => {
      if (j === i) return;
      const o = cells[j]!.dir;
      const dx = o[0] - c.dir[0], dy = o[1] - c.dir[1], dz = o[2] - c.dir[2];
      if (dx * dx + dy * dy + dz * dz < near2) out.push(j);
    });
    return out.sort((a, b) => a - b);
  });
  for (let i = 0; i < cells.length; i++) {
    let x = hash01(def.seed, 0x7e61, i) * total;
    let pick = 0;
    for (let k = 0; k < kinds.length; k++) {
      x -= kinds[k]!.weight;
      if (x < 0) {
        pick = k;
        break;
      }
    }
    const taken = neighbours[i]!.filter((j) => j < i).map((j) => cells[j]!.kind);
    for (let t = 0; t < kinds.length && taken.includes(pick); t++) pick = (pick + 1) % kinds.length;
    cells[i]!.kind = pick;
  }
  // Repair passes: a cell that still shares its kind with a neighbour takes the kind its
  // neighbours use least (ties: the lowest index), in cell order.
  const uses = new Int32Array(kinds.length);
  for (let pass = 0; pass < 10; pass++) {
    for (let i = 0; i < cells.length; i++) {
      const c = cells[i]!;
      uses.fill(0);
      for (const j of neighbours[i]!) uses[cells[j]!.kind]!++;
      if (uses[c.kind] === 0) continue;
      let best = c.kind;
      for (let k = 0; k < kinds.length; k++) if (uses[k]! < uses[best]!) best = k;
      c.kind = best;
    }
  }
  return layout;
}

function forNear(l: Layout, x: number, y: number, z: number, reach: number, fn: (cell: number) => void) {
  const g = l.g;
  const bx = bucketOf(x, g), by = bucketOf(y, g), bz = bucketOf(z, g);
  for (let a = Math.max(0, bx - reach); a <= Math.min(g - 1, bx + reach); a++) {
    for (let b = Math.max(0, by - reach); b <= Math.min(g - 1, by + reach); b++) {
      for (let c = Math.max(0, bz - reach); c <= Math.min(g - 1, bz + reach); c++) {
        const k = (a * g + b) * g + c;
        for (let s = l.start[k]!; s < l.start[k + 1]!; s++) fn(l.ids[s]!);
      }
    }
  }
}

function layoutOf(body: BodyId): Layout | null {
  let l = layouts.get(body);
  if (l === undefined) {
    l = buildLayout(body);
    layouts.set(body, l);
  }
  return l;
}

/** Every region cell of a body (empty on Portus). The server keeps one population per cell. */
export function regionCells(body: BodyId): readonly RegionCell[] {
  return layoutOf(body)?.cells ?? [];
}

export interface RegionHit {
  /** Cell index (regionCells), its kind, and the neighbouring cell's kind across the nearest border. */
  cell: number;
  kind: number;
  other: number;
  /** Metres to the border (about half the difference of the two centre distances). */
  edge: number;
}

/**
 * The region at a direction (any length; the planet-space position works). Null on Portus.
 * Allocation-free when `out` is given (the terrain worker calls it per vertex).
 */
export function regionHit(body: BodyId, x: number, y: number, z: number, out: RegionHit = { cell: 0, kind: 0, other: 0, edge: 0 }): RegionHit | null {
  const l = layoutOf(body);
  if (!l) return null;
  const R = BODIES[body].radius;
  let len = Math.sqrt(x * x + y * y + z * z) || 1;
  let ux = x / len, uy = y / len, uz = z / len;
  // Wobble the border: shift the lookup point by smooth noise (~70 m features).
  const s = R / 70;
  const w = REGION_WOBBLE / R;
  ux += (valueNoise(ux * s + 5.1, uy * s + 1.3, uz * s + 9.7) - 0.5) * 2 * w;
  uy += (valueNoise(ux * s + 2.7, uy * s + 8.2, uz * s + 3.3) - 0.5) * 2 * w;
  uz += (valueNoise(ux * s + 7.4, uy * s + 4.6, uz * s + 0.9) - 0.5) * 2 * w;
  len = Math.sqrt(ux * ux + uy * uy + uz * uz);
  ux /= len; uy /= len; uz /= len;
  let b1 = -1, b2 = -1, d1 = Infinity, d2 = Infinity;
  const g = l.g;
  const bx = bucketOf(ux, g), by = bucketOf(uy, g), bz = bucketOf(uz, g);
  for (let a = Math.max(0, bx - 1); a <= Math.min(g - 1, bx + 1); a++) {
    for (let b = Math.max(0, by - 1); b <= Math.min(g - 1, by + 1); b++) {
      for (let c = Math.max(0, bz - 1); c <= Math.min(g - 1, bz + 1); c++) {
        const k = (a * g + b) * g + c;
        for (let si = l.start[k]!; si < l.start[k + 1]!; si++) {
          const id = l.ids[si]!;
          const d = l.cells[id]!.dir;
          const dx = d[0] - ux, dy = d[1] - uy, dz = d[2] - uz;
          const q = dx * dx + dy * dy + dz * dz;
          if (q < d1) {
            d2 = d1; b2 = b1;
            d1 = q; b1 = id;
          } else if (q < d2) {
            d2 = q; b2 = id;
          }
        }
      }
    }
  }
  if (b1 < 0) b1 = 0; // unreachable with the bucket size above; keeps the type honest
  out.cell = b1;
  out.kind = l.cells[b1]!.kind;
  out.other = b2 >= 0 ? l.cells[b2]!.kind : out.kind;
  out.edge = b2 >= 0 ? ((Math.sqrt(d2) - Math.sqrt(d1)) * R) / 2 : 1e9;
  return out;
}

/** The region kind at a direction (null on Portus). */
export function regionKindAt(body: BodyId, x: number, y: number, z: number): RegionKind | null {
  const h = regionHit(body, x, y, z, scratchHit);
  return h ? REGION_KINDS[body][h.kind]! : null;
}
const scratchHit: RegionHit = { cell: 0, kind: 0, other: 0, edge: 0 };

/** The region look at a point: the noise fields (regionNoise.ts) pulled toward the region kind's targets. */
export interface RegionLook extends Region {
  /** Linear RGB the ground cover is pulled toward, and how far (0..1). */
  gr: number;
  gg: number;
  gb: number;
  gAmt: number;
  /** Flower drift factor (RegionKind.bloom), blended across borders. */
  bloom: number;
}

export function newRegionLook(): RegionLook {
  return { dry: 0, deep: 0, patch: 0, gr: 0, gg: 0, gb: 0, gAmt: 0, bloom: 1 };
}

const lin = (v: number) => {
  const s = v / 255;
  return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
};
const linCache = new Map<number, [number, number, number]>();
function linRgb(hex: number): [number, number, number] {
  let c = linCache.get(hex);
  if (!c) {
    c = [lin((hex >> 16) & 255), lin((hex >> 8) & 255), lin(hex & 255)];
    linCache.set(hex, c);
  }
  return c;
}

/** How far a region kind's targets override the noise (the noise keeps variety inside a region). */
const PULL = 0.7;
const lookHit: RegionHit = { cell: 0, kind: 0, other: 0, edge: 0 };

/**
 * The look of the ground at a planet-space point (metres): `fast` false skips the patch octave (the
 * grass reads only the slow fields at its cell corners). On Portus: the plain noise fields.
 */
export function regionLook(body: BodyId, x: number, y: number, z: number, out: RegionLook = newRegionLook(), fast = true): RegionLook {
  regionLow(x, y, z, out);
  out.patch = fast ? regionPatch(x, y, z) : 0;
  const h = regionHit(body, x, y, z, lookHit);
  if (!h) {
    out.gAmt = 0;
    out.bloom = 1;
    return out;
  }
  const kinds = REGION_KINDS[body];
  const a = kinds[h.kind]!, b = kinds[h.other]!;
  // Weight of the neighbour: 0.5 on the border, 0 a blend-width inside.
  const t = 0.5 * (1 - smooth01(0, REGION_BLEND, h.edge));
  const dry = a.dry + (b.dry - a.dry) * t, deep = a.deep + (b.deep - a.deep) * t;
  out.dry = out.dry + (dry - out.dry) * PULL;
  out.deep = out.deep + (deep - out.deep) * PULL;
  const ca = linRgb(a.ground), cb = linRgb(b.ground);
  out.gr = ca[0] + (cb[0] - ca[0]) * t;
  out.gg = ca[1] + (cb[1] - ca[1]) * t;
  out.gb = ca[2] + (cb[2] - ca[2]) * t;
  out.gAmt = a.groundAmt + (b.groundAmt - a.groundAmt) * t;
  out.bloom = a.bloom + (b.bloom - a.bloom) * t;
  return out;
}
