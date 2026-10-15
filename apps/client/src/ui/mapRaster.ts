// Map terrain raster (pure: runs in world/mapAtlas.worker.ts, tested in node). Each body gets a
// colour atlas on the six cube-sphere faces, baked once from the shared height function and the
// game's terrain palette, hill-shaded from the north-west. Views are then drawn from it per pixel:
// the globe for the map (M) and the north-up tile the minimap scrolls. On Portus the town plan
// (paving, walls and towers, roofs, trees) comes from a 0.5 m raster in the town frame.

import { faceOf, faceUV, FACES, type BodyId, type Face, type Terrain } from "@firstlight/shared";
import { TOWN_LAYOUT, TOWN_PREFABS } from "@firstlight/shared/content/portusTown";
import { townCoords } from "@firstlight/shared/planet/townFrame";
import { townGroundDistance } from "@firstlight/shared/planet/townGround";
import { LOOKS } from "../render/looks.ts";
import { PALETTES, terrainColor } from "../world/palette.ts";
import type { MapView } from "./mapView.ts";

export interface Atlas {
  body: BodyId;
  /** Texels per face edge. */
  n: number;
  /** Six faces of n×n RGBA texels packed little-endian (r | g << 8 | b << 16 | a << 24); null until baked. */
  faces: (Uint32Array | null)[];
}

/** Texels per face edge: ~0.75 m on Portus (the town), 2–3 m on the planets; 128…512. */
export function atlasResolution(radius: number): number {
  const texel = radius <= 200 ? 0.75 : radius <= 600 ? 2 : radius <= 800 ? 2.5 : 3;
  return Math.max(128, Math.min(512, Math.round((radius * Math.PI) / 2 / texel / 32) * 32));
}

// ---------------------------------------------------------------- colour helpers

const SRGB = new Uint8Array(4097);
for (let i = 0; i <= 4096; i++) {
  const c = i / 4096;
  SRGB[i] = Math.round(255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055));
}
const toByte = (linear: number) => SRGB[Math.max(0, Math.min(4096, Math.round(linear * 4096)))]!;
const rgbHex = (hex: number): [number, number, number] => [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255];
const pack = (r: number, g: number, b: number) => ((255 << 24) | (Math.max(0, Math.min(255, b)) << 16) | (Math.max(0, Math.min(255, g)) << 8) | Math.max(0, Math.min(255, r))) >>> 0;

/** Unpacked channels of a texel (for tests and the main thread). */
export function rgba(c: number): [number, number, number, number] {
  return [c & 255, (c >>> 8) & 255, (c >>> 16) & 255, c >>> 24];
}

// ---------------------------------------------------------------- bake

/** Light from the north-west, 45° up (the cartographic convention); slopes exaggerated for relief. */
const LIGHT = { e: -0.5, n: 0.5, up: Math.SQRT1_2 };
const RELIEF = 2.2;

/** Bake one face of a body's atlas (n×n texels at texel centres). */
export function bakeFace(terrain: Terrain, face: Face, n: number): Uint32Array {
  const body = terrain.body;
  const R = body.radius;
  const water = body.waterLevel;
  const pal = PALETTES[body.id];
  const look = LOOKS[body.id];
  const shallow = rgbHex(look.waterShallow), deep = rgbHex(look.waterDeep);
  const b = FACES[face]!;
  const heights = new Float32Array(n * n);
  const dirs = new Float32Array(n * n * 3);
  for (let j = 0; j < n; j++) {
    const v = ((j + 0.5) * 2) / n - 1;
    for (let i = 0; i < n; i++) {
      const u = ((i + 0.5) * 2) / n - 1;
      let x = b.n[0] + u * b.tu[0] + v * b.tv[0];
      let y = b.n[1] + u * b.tu[1] + v * b.tv[1];
      let z = b.n[2] + u * b.tu[2] + v * b.tv[2];
      const l = 1 / Math.sqrt(x * x + y * y + z * z);
      x *= l;
      y *= l;
      z *= l;
      const k = j * n + i;
      dirs[k * 3] = x;
      dirs[k * 3 + 1] = y;
      dirs[k * 3 + 2] = z;
      heights[k] = terrain.rawHeight(x, y, z);
    }
  }
  const out = new Uint32Array(n * n);
  const lin = new Float32Array(3);
  for (let j = 0; j < n; j++) {
    const v = ((j + 0.5) * 2) / n - 1;
    for (let i = 0; i < n; i++) {
      const u = ((i + 0.5) * 2) / n - 1;
      const k = j * n + i;
      const h = heights[k]!;
      const d0 = dirs[k * 3]!, d1 = dirs[k * 3 + 1]!, d2 = dirs[k * 3 + 2]!;
      // Slope from the neighbours (one-sided at the face's edge), in metres per metre.
      const q = 1 + u * u + v * v;
      const mu = (R * (2 / n) * Math.sqrt(1 + v * v)) / q;
      const mv = (R * (2 / n) * Math.sqrt(1 + u * u)) / q;
      const iL = Math.max(0, i - 1), iR = Math.min(n - 1, i + 1), jD = Math.max(0, j - 1), jU = Math.min(n - 1, j + 1);
      const dhu = (heights[j * n + iR]! - heights[j * n + iL]!) / ((iR - iL) * mu);
      const dhv = (heights[jU * n + i]! - heights[jD * n + i]!) / ((jU - jD) * mv);
      // Face axes carried onto the tangent plane, and the compass frame (north toward +Z).
      const tuD = b.tu[0] * d0 + b.tu[1] * d1 + b.tu[2] * d2;
      const tvD = b.tv[0] * d0 + b.tv[1] * d1 + b.tv[2] * d2;
      const ux = b.tu[0] - tuD * d0, uy = b.tu[1] - tuD * d1, uz = b.tu[2] - tuD * d2;
      const vx = b.tv[0] - tvD * d0, vy = b.tv[1] - tvD * d1, vz = b.tv[2] - tvD * d2;
      const lu = Math.sqrt(ux * ux + uy * uy + uz * uz) || 1, lv = Math.sqrt(vx * vx + vy * vy + vz * vz) || 1;
      const gx = (dhu * ux) / lu + (dhv * vx) / lv, gy = (dhu * uy) / lu + (dhv * vy) / lv, gz = (dhu * uz) / lu + (dhv * vz) / lv;
      let nx = -d2 * d0, ny = -d2 * d1, nz = 1 - d2 * d2; // +Z minus its normal part (compassMath.northAt)
      if (Math.abs(d2) > 0.99999) {
        nx = -d1 * d0;
        ny = 1 - d1 * d1;
        nz = -d1 * d2;
      }
      const ln = 1 / Math.sqrt(nx * nx + ny * ny + nz * nz);
      nx *= ln;
      ny *= ln;
      nz *= ln;
      const ex = ny * d2 - nz * d1, ey = nz * d0 - nx * d2, ez = nx * d1 - ny * d0; // north × up
      const ge = gx * ex + gy * ey + gz * ez;
      const gn = gx * nx + gy * ny + gz * nz;
      const slope2 = ge * ge + gn * gn;
      if (h < water) {
        const t = Math.min(1, (water - h) / 10);
        const s = t * t * (3 - 2 * t);
        out[k] = pack(shallow[0] + (deep[0] - shallow[0]) * s, shallow[1] + (deep[1] - shallow[1]) * s, shallow[2] + (deep[2] - shallow[2]) * s);
        continue;
      }
      terrainColor(pal, h, water, 1 / Math.sqrt(1 + slope2), 0, lin, 0);
      const shade = (-RELIEF * ge * LIGHT.e - RELIEF * gn * LIGHT.n + LIGHT.up) / (LIGHT.up * Math.sqrt(1 + RELIEF * RELIEF * slope2));
      const light = 1 + (Math.max(0.35, Math.min(1.4, shade)) - 1) * 0.8;
      out[k] = pack(toByte(lin[0]! * light), toByte(lin[1]! * light), toByte(lin[2]! * light));
    }
  }
  return out;
}

export function bakeAtlas(terrain: Terrain, n = atlasResolution(terrain.body.radius)): Atlas {
  const faces: (Uint32Array | null)[] = [];
  for (let f = 0; f < 6; f++) faces.push(bakeFace(terrain, f as Face, n));
  return { body: terrain.body.id, n, faces };
}

// ---------------------------------------------------------------- Portus town plan

/** Town plan classes: nothing, paving, walls and towers, roofs, tree crowns. */
export const TOWN_CLASS = { none: 0, paving: 1, stone: 2, roof: 3, tree: 4 } as const;
const TOWN_COLOURS = [0, pack(196, 184, 160), pack(128, 124, 134), pack(178, 84, 60), pack(52, 112, 58)];

export interface TownRaster {
  cell: number;
  half: number;
  n: number;
  cls: Uint8Array;
}

/** The Portus town plan in the town frame (east/north metres at the pole), 0.5 m cells. */
export function townRaster(cell = 0.5, half = 96): TownRaster {
  const n = Math.round((2 * half) / cell);
  const cls = new Uint8Array(n * n);
  const cellOf = (m: number) => Math.floor((m + half) / cell);
  const centre = (i: number) => -half + (i + 0.5) * cell;
  const mark = (c: number, e0: number, e1: number, n0: number, n1: number, inside: (e: number, nn: number) => boolean) => {
    const i0 = Math.max(0, cellOf(e0)), i1 = Math.min(n - 1, cellOf(e1));
    const j0 = Math.max(0, cellOf(n0)), j1 = Math.min(n - 1, cellOf(n1));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) if (inside(centre(i), centre(j))) cls[j * n + i] = c;
  };
  // Paving: what the town ground raster calls paved (and isn't a structure, marked over it below).
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) if (townGroundDistance(centre(i), centre(j)) <= 0) cls[j * n + i] = TOWN_CLASS.paving;
  // Tree crowns first, then walls and roofs over them (footprints of solids that reach the ground).
  for (const pass of ["tree", "build"] as const) {
    for (const [pi, ie, inn, yaw, s] of TOWN_LAYOUT) {
      const pf = TOWN_PREFABS[pi]!;
      if (pass === "tree") {
        if (pf.cls !== "tree") continue;
        const r = pf.radius * s * 0.85;
        mark(TOWN_CLASS.tree, ie - r, ie + r, inn - r, inn + r, (e, nn) => (e - ie) ** 2 + (nn - inn) ** 2 <= r * r);
        continue;
      }
      const c = pf.cls === "building" ? TOWN_CLASS.roof : pf.cls === "static" && pf.height >= 3 ? TOWN_CLASS.stone : 0;
      if (!c) continue;
      const a = (yaw * Math.PI) / 180;
      const rE = Math.cos(a), rN = Math.sin(a); // right
      const fE = Math.sin(a), fN = -Math.cos(a); // front
      for (const [shape, cx, cz, hx, hz, y0, , sy] of pf.solids) {
        if (y0 > 0.5) continue;
        const ce = ie + (rE * cx + fE * cz) * s, cn = inn + (rN * cx + fN * cz) * s;
        if (shape === 1) {
          const r = hx * s;
          mark(c, ce - r, ce + r, cn - r, cn + r, (e, nn) => (e - ce) ** 2 + (nn - cn) ** 2 <= r * r);
          continue;
        }
        const bb = (sy * Math.PI) / 180;
        const xE = Math.cos(bb) * rE - Math.sin(bb) * fE, xN = Math.cos(bb) * rN - Math.sin(bb) * fN;
        const zE = Math.sin(bb) * rE + Math.cos(bb) * fE, zN = Math.sin(bb) * rN + Math.cos(bb) * fN;
        const ex = hx * s, ez = hz * s, ext = Math.hypot(ex, ez);
        mark(c, ce - ext, ce + ext, cn - ext, cn + ext, (e, nn) => {
          const de = e - ce, dn = nn - cn;
          return Math.abs(de * xE + dn * xN) <= ex && Math.abs(de * zE + dn * zN) <= ez;
        });
      }
    }
  }
  return { cell, half, n, cls };
}

// ---------------------------------------------------------------- sampling and views

const uvScratch: [number, number] = [0, 0];
/** Colour of a face that isn't baked yet. */
export const UNBAKED = ((255 << 24) | (34 << 16) | (28 << 8) | 24) >>> 0;

/** Bilinear atlas colour at a unit direction. */
export function sampleAtlas(atlas: Atlas, x: number, y: number, z: number): number {
  const face = faceOf(x, y, z);
  faceUV(face, x, y, z, uvScratch);
  const n = atlas.n;
  const t = atlas.faces[face];
  if (!t) return UNBAKED;
  let fx = ((uvScratch[0] + 1) / 2) * n - 0.5, fy = ((uvScratch[1] + 1) / 2) * n - 0.5;
  fx = fx < 0 ? 0 : fx > n - 1 ? n - 1 : fx;
  fy = fy < 0 ? 0 : fy > n - 1 ? n - 1 : fy;
  const i0 = fx | 0, j0 = fy | 0;
  const i1 = i0 + 1 < n ? i0 + 1 : i0, j1 = j0 + 1 < n ? j0 + 1 : j0;
  const ax = fx - i0, ay = fy - j0;
  const c00 = t[j0 * n + i0]!, c10 = t[j0 * n + i1]!, c01 = t[j1 * n + i0]!, c11 = t[j1 * n + i1]!;
  const w00 = (1 - ax) * (1 - ay), w10 = ax * (1 - ay), w01 = (1 - ax) * ay, w11 = ax * ay;
  // Weights sum to 1, so every channel stays within 0..255.
  const r = ((c00 & 255) * w00 + (c10 & 255) * w10 + (c01 & 255) * w01 + (c11 & 255) * w11 + 0.5) | 0;
  const g = (((c00 >>> 8) & 255) * w00 + ((c10 >>> 8) & 255) * w10 + ((c01 >>> 8) & 255) * w01 + ((c11 >>> 8) & 255) * w11 + 0.5) | 0;
  const bl = (((c00 >>> 16) & 255) * w00 + ((c10 >>> 16) & 255) * w10 + ((c01 >>> 16) & 255) * w01 + ((c11 >>> 16) & 255) * w11 + 0.5) | 0;
  return ((255 << 24) | (bl << 16) | (g << 8) | r) >>> 0;
}

/** Nearest-texel atlas colour (for views where a texel is smaller than a pixel). */
export function sampleAtlasNearest(atlas: Atlas, x: number, y: number, z: number): number {
  const face = faceOf(x, y, z);
  faceUV(face, x, y, z, uvScratch);
  const n = atlas.n;
  let i = (((uvScratch[0] + 1) / 2) * n) | 0, j = (((uvScratch[1] + 1) / 2) * n) | 0;
  i = i < 0 ? 0 : i >= n ? n - 1 : i;
  j = j < 0 ? 0 : j >= n ? n - 1 : j;
  const t = atlas.faces[face];
  return t ? t[j * n + i]! : UNBAKED;
}

export interface RenderOptions {
  /** Portus: overlay the town plan. */
  town?: TownRaster | null;
  /** Body radius (m), for the town frame. */
  radius: number;
  /** Darken toward the globe's rim (the whole-planet view). */
  limb?: boolean;
}

const townAt: [number, number] = [0, 0];

/**
 * Draw `view` (its w × h is the target size in pixels) into `out` (w·h packed RGBA). Pixels off
 * the globe stay transparent.
 */
export function renderView(atlas: Atlas, view: MapView, out: Uint32Array, opts: RenderOptions): void {
  const { e, n, c, ppr, w, h } = view;
  const town = opts.town ?? null;
  const tn = town?.n ?? 0;
  // A face edge spans ~π/2 radians: bilinear only where texels are bigger than pixels.
  const sample = ppr * (Math.PI / 2) > atlas.n * 0.9 ? sampleAtlas : sampleAtlasNearest;
  for (let py = 0; py < h; py++) {
    const b = (h / 2 - py - 0.5) / ppr;
    for (let px = 0; px < w; px++) {
      const a = (px + 0.5 - w / 2) / ppr;
      const rr = a * a + b * b;
      const k = py * w + px;
      if (rr >= 1) {
        out[k] = 0;
        continue;
      }
      const z = Math.sqrt(1 - rr);
      const x = a * e[0] + b * n[0] + z * c[0];
      const y = a * e[1] + b * n[1] + z * c[1];
      const zz = a * e[2] + b * n[2] + z * c[2];
      let col = sample(atlas, x, y, zz);
      if (town && y > 0.75) {
        townCoords(x, y, zz, opts.radius, townAt);
        const i = Math.floor((townAt[0] + town.half) / town.cell), j = Math.floor((townAt[1] + town.half) / town.cell);
        if (i >= 0 && j >= 0 && i < tn && j < tn) {
          const t = town.cls[j * tn + i]!;
          if (t) col = TOWN_COLOURS[t]!;
        }
      }
      if (opts.limb) {
        const k2 = 0.62 + 0.38 * z;
        col = ((255 << 24) | ((((col >>> 16) & 255) * k2) << 16) | ((((col >>> 8) & 255) * k2) << 8) | ((col & 255) * k2)) >>> 0;
      }
      out[k] = col;
    }
  }
}
