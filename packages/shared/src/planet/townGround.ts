// What covers the Portus town ground (render-only: grass and natural-prop masks, D38). A raster in
// the town frame (planet/town.ts: east/north metres at the pole) holds the distance from each cell to
// the nearest paved ground (plaza, streets, the castle ward, portal court floors) or structure
// footprint (collider solids that reach the ground). The flat-plane approximation is fine for masks
// (the azimuthal map stretches tangent lengths by < 4 % inside 72 m). Pure and deterministic; built
// once per thread on first use (a few milliseconds).

import { TOWN_AREAS, TOWN_FIXED, TOWN_LAYOUT, TOWN_PLAZA_PAVED, TOWN_PORTAL_FLOOR, TOWN_PREFABS, TOWN_STREETS } from "../content/portusTown.ts";

/** Raster cell size (m) and half extent (m) around the pole. */
export const TOWN_GROUND_CELL = 0.5;
export const TOWN_GROUND_HALF = 96;
/** Distances are capped here (m): everything farther reads as this. */
export const TOWN_GROUND_MAX = 24;

const N = Math.round((2 * TOWN_GROUND_HALF) / TOWN_GROUND_CELL);

let field: Float32Array | null = null;

/** Felzenszwalb's 1-D squared distance transform of f (length n) into d (scratch v, z). */
function edt1(f: Float64Array, n: number, d: Float64Array, v: Int32Array, z: Float64Array) {
  let k = 0;
  v[0] = 0;
  z[0] = -Infinity;
  z[1] = Infinity;
  for (let q = 1; q < n; q++) {
    let s: number;
    for (;;) {
      const p = v[k]!;
      s = (f[q]! + q * q - (f[p]! + p * p)) / (2 * q - 2 * p);
      if (s > z[k]!) break;
      k--;
      if (k < 0) {
        k = 0;
        s = -Infinity;
        break;
      }
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1]! < q) k++;
    const p = v[k]!;
    d[q] = (q - p) * (q - p) + f[p]!;
  }
}

function build(): Float32Array {
  const C = TOWN_GROUND_CELL, H = TOWN_GROUND_HALF;
  const blocked = new Uint8Array(N * N);
  const cellOf = (m: number) => Math.floor((m + H) / C);
  const centre = (i: number) => -H + (i + 0.5) * C;
  /** Mark every cell whose centre passes `inside`, within the box [e0, e1] × [n0, n1]. */
  const mark = (e0: number, e1: number, n0: number, n1: number, inside: (e: number, n: number) => boolean) => {
    const i0 = Math.max(0, cellOf(e0)), i1 = Math.min(N - 1, cellOf(e1));
    const j0 = Math.max(0, cellOf(n0)), j1 = Math.min(N - 1, cellOf(n1));
    for (let j = j0; j <= j1; j++) {
      const n = centre(j);
      for (let i = i0; i <= i1; i++) if (!blocked[j * N + i] && inside(centre(i), n)) blocked[j * N + i] = 1;
    }
  };
  const disc = (ce: number, cn: number, r: number) => mark(ce - r, ce + r, cn - r, cn + r, (e, n) => (e - ce) ** 2 + (n - cn) ** 2 <= r * r);
  // Paved ground.
  disc(0, 0, TOWN_PLAZA_PAVED);
  for (const p of Object.values(TOWN_FIXED.portals)) disc(p[0], p[1], TOWN_PORTAL_FLOOR);
  for (const s of TOWN_STREETS) {
    const hw = s.width / 2;
    for (let k = 0; k + 1 < s.pts.length; k++) {
      const [ae, an] = s.pts[k]!, [be, bn] = s.pts[k + 1]!;
      const de = be - ae, dn = bn - an, L2 = de * de + dn * dn || 1;
      mark(Math.min(ae, be) - hw, Math.max(ae, be) + hw, Math.min(an, bn) - hw, Math.max(an, bn) + hw, (e, n) => {
        const t = Math.max(0, Math.min(1, ((e - ae) * de + (n - an) * dn) / L2));
        return (e - ae - de * t) ** 2 + (n - an - dn * t) ** 2 <= hw * hw;
      });
    }
  }
  for (const a of TOWN_AREAS) {
    const xs = a.poly.map((p) => p[0]), ys = a.poly.map((p) => p[1]);
    mark(Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys), (e, n) => {
      let inside = false;
      for (let i = 0, j = a.poly.length - 1; i < a.poly.length; j = i++) {
        const [xi, yi] = a.poly[i]!, [xj, yj] = a.poly[j]!;
        if (yi > n !== yj > n && e < ((xj - xi) * (n - yi)) / (yj - yi) + xi) inside = !inside;
      }
      return inside;
    });
  }
  // Structure footprints: solids that reach the ground, in the town plane (E = x, N = y).
  for (const [pi, ie, inn, yaw, s] of TOWN_LAYOUT) {
    const a = (yaw * Math.PI) / 180;
    const rE = Math.cos(a), rN = Math.sin(a); // right
    const fE = Math.sin(a), fN = -Math.cos(a); // front
    for (const [shape, cx, cz, hx, hz, y0, , sy] of TOWN_PREFABS[pi]!.solids) {
      if (y0 > 0.5) continue;
      const ce = ie + (rE * cx + fE * cz) * s, cn = inn + (rN * cx + fN * cz) * s;
      if (shape === 1) {
        disc(ce, cn, hx * s);
        continue;
      }
      const b = (sy * Math.PI) / 180;
      const xE = Math.cos(b) * rE - Math.sin(b) * fE, xN = Math.cos(b) * rN - Math.sin(b) * fN;
      const zE = Math.sin(b) * rE + Math.cos(b) * fE, zN = Math.sin(b) * rN + Math.cos(b) * fN;
      const ex = hx * s, ez = hz * s, ext = Math.hypot(ex, ez);
      mark(ce - ext, ce + ext, cn - ext, cn + ext, (e, n) => {
        const de = e - ce, dn = n - cn;
        return Math.abs(de * xE + dn * xN) <= ex && Math.abs(de * zE + dn * zN) <= ez;
      });
    }
  }
  // Euclidean distance (in cells) to the nearest blocked cell, then metres.
  const INF = 1e12;
  const g = new Float64Array(N * N);
  for (let k = 0; k < N * N; k++) g[k] = blocked[k] ? 0 : INF;
  const f = new Float64Array(N), d = new Float64Array(N), z = new Float64Array(N + 1);
  const v = new Int32Array(N);
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) f[j] = g[j * N + i]!;
    edt1(f, N, d, v, z);
    for (let j = 0; j < N; j++) g[j * N + i] = d[j]!;
  }
  const out = new Float32Array(N * N);
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) f[i] = g[j * N + i]!;
    edt1(f, N, d, v, z);
    for (let i = 0; i < N; i++) out[j * N + i] = Math.min(TOWN_GROUND_MAX, Math.sqrt(d[i]!) * C);
  }
  return out;
}

/**
 * Distance (m) from town point (east, north) to the nearest paved ground or structure footprint:
 * 0 on them, TOWN_GROUND_MAX far away (and outside the raster).
 */
export function townGroundDistance(east: number, north: number): number {
  const i = Math.floor((east + TOWN_GROUND_HALF) / TOWN_GROUND_CELL);
  const j = Math.floor((north + TOWN_GROUND_HALF) / TOWN_GROUND_CELL);
  if (i < 0 || j < 0 || i >= N || j >= N) return TOWN_GROUND_MAX;
  field ??= build();
  return field[j * N + i]!;
}

/** Grass factor 0..1 at a town point: none on paving and footprints, full from 0.6 m off them. */
export function townGrass(east: number, north: number): number {
  return Math.max(0, Math.min(1, (townGroundDistance(east, north) - 0.1) / 0.5));
}

/** Town trees (layout items of class "tree"): [east, north, crown radius]. */
const TOWN_TREES: readonly (readonly [number, number, number])[] = TOWN_LAYOUT.filter((it) => TOWN_PREFABS[it[0]]!.cls === "tree").map(
  (it) => [it[1], it[2], TOWN_PREFABS[it[0]]!.radius * it[4]] as const,
);

/**
 * May a natural prop (blossom tree, rock) stand at this town point? Not within 3 m of paving, roads
 * or a structure, and not under a town tree's crown. (Inside the walls nothing natural grows:
 * props.ts PORTUS_PLAZA_CLEAR.)
 */
export function townPropClear(east: number, north: number): boolean {
  if (townGroundDistance(east, north) < 3) return false;
  for (const [e, n, r] of TOWN_TREES) if ((e - east) ** 2 + (n - north) ** 2 < (r + 1.5) ** 2) return false;
  return true;
}
