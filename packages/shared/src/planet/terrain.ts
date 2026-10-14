// Deterministic planet terrain, shared by the client renderer and the server.
// `rawHeight` is the procedural field; the rendered mesh samples it at grid vertices, and
// `groundHeight` returns the height of the rendered triangle under a direction, so feet never
// float or sink on either side.

import { createNoise3, fbm, type Noise3 } from "../noise.ts";
import { BODIES, quadsPerFace, type BodyDef, type BodyId } from "./bodies.ts";
import { FACES, faceOf, faceUV, gridDir, type Face } from "./cubesphere.ts";
import { anchorDir, padDirs, PAD_FLAT_INNER, PAD_FLAT_OUTER, type Dir } from "./pads.ts";

function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

interface ResolvedFeature {
  dir: Dir;
  radius: number;
  amount: number; // lake depth or peak height
}

/**
 * Portus: the town floor is flat out to this chord distance (m) from the arrival point (+Y): the
 * walls stand at 43–46 m, the castle's far towers at 64 m (content/portusTown.ts, D38).
 */
export const PORTUS_TOWN_FLAT = 72;

export interface Terrain {
  body: BodyDef;
  /** Quads per face edge. */
  n: number;
  /** Procedural height (metres above the radius) for a unit direction. */
  rawHeight(x: number, y: number, z: number): number;
  /** Height at grid vertex (face, i, j); cached. */
  vertexHeight(face: Face, i: number, j: number): number;
  /** Height of the rendered surface under a unit direction. */
  groundHeight(x: number, y: number, z: number): number;
  /** Ground height for any position (normalised internally). */
  groundHeightAt(px: number, py: number, pz: number): number;
  /** Heights of the flat pad platforms, by pad index. */
  padHeights: readonly number[];
}

export function createTerrain(bodyOrId: BodyDef | BodyId): Terrain {
  const body = typeof bodyOrId === "string" ? BODIES[bodyOrId] : bodyOrId;
  const R = body.radius;
  const p = body.terrain;
  const n = quadsPerFace(body);
  const nHills = createNoise3(body.seed);
  const nMask = createNoise3(body.seed + 17);
  const nRidge = createNoise3(body.seed + 31);
  const nDetail = createNoise3(body.seed + 47);

  const lakes: ResolvedFeature[] = body.lakes.map((l) => ({ dir: anchorDir(body, l.at), radius: l.radius, amount: l.depth }));
  const peaks: ResolvedFeature[] = body.peaks.map((k) => ({ dir: anchorDir(body, k.at), radius: k.radius, amount: k.height }));
  const pads = body.terrain.kind === "hub" ? [] : padDirs(body);

  const distM = (d: Dir, x: number, y: number, z: number) => {
    const dx = d[0] - x;
    const dy = d[1] - y;
    const dz = d[2] - z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz) * R;
  };

  function planetBase(x: number, y: number, z: number): number {
    const px = x * R;
    const py = y * R;
    const pz = z * R;
    let h = fbm(nHills, px / p.hillScale, py / p.hillScale, pz / p.hillScale, 4) * p.hillAmp;
    if (p.mountainAmp > 0) {
      const mask = smoothstep(p.maskThreshold, p.maskThreshold + 0.35, fbm(nMask, px / p.maskScale, py / p.maskScale, pz / p.maskScale, 2));
      if (mask > 0) {
        const r1 = 1 - Math.abs(nRidge(px / p.mountainScale, py / p.mountainScale, pz / p.mountainScale));
        const r2 = 1 - Math.abs(nRidge((px * 2.1) / p.mountainScale, (py * 2.1) / p.mountainScale, (pz * 2.1) / p.mountainScale));
        h += mask * (r1 * r1 * 0.75 + r2 * r2 * 0.25) * p.mountainAmp;
      }
    }
    h += nDetail(px / 17, py / 17, pz / 17) * p.detailAmp;
    h += p.offset;
    if (p.terrace > 0 && h > 1) {
      const s = h / p.terrace;
      const f = s - Math.floor(s);
      h = (Math.floor(s) + smoothstep(0.55, 0.85, f)) * p.terrace * 0.7 + h * 0.3;
    }
    for (const k of peaks) {
      const d = distM(k.dir, x, y, z);
      if (d < k.radius) {
        const t = 1 - d / k.radius;
        const ridge = 0.75 + 0.25 * (1 - Math.abs(nRidge(px / 22, py / 22, pz / 22)));
        h += k.amount * t * t * (3 - 2 * t) * ridge;
      }
    }
    for (const l of lakes) {
      const d = distM(l.dir, x, y, z);
      if (d < l.radius * 1.5) {
        const q = d / l.radius;
        const bed = -l.amount * (1 - q * q) + 0.5;
        const w = 1 - smoothstep(0.8, 1.5, q);
        const carved = Math.min(h, bed);
        h = h + (carved - h) * w;
      }
    }
    return h;
  }

  function hubBase(x: number, y: number, z: number): number {
    // The town floor around +Y: flat (exactly the radius) out to PORTUS_TOWN_FLAT, so the walled
    // town and its castle stand on the sphere as built; then a ring rim and gentle hills beyond.
    // From PORTUS_TOWN_FLAT + 60 m on it is the old bowl's outer terrain unchanged (D38).
    const d = Math.sqrt(x * x + (y - 1) * (y - 1) + z * z) * R;
    const F = PORTUS_TOWN_FLAT;
    if (d <= F) return 0;
    const px = x * R;
    const py = y * R;
    const pz = z * R;
    const hills = fbm(nHills, px / 60, py / 60, pz / 60, 3) * p.hillAmp;
    const rim = smoothstep(F, F + 20, d) * 7 - smoothstep(F + 26, F + 60, d) * 4;
    return rim + hills * smoothstep(F + 4, F + 50, d) + nDetail(px / 9, py / 9, pz / 9) * 0.15 * smoothstep(F, F + 12, d);
  }

  const base = body.terrain.kind === "hub" ? hubBase : planetBase;
  const padHeights = pads.map((d) => Math.max(base(d[0], d[1], d[2]), body.waterLevel + 1.5));

  function rawHeight(x: number, y: number, z: number): number {
    let h = base(x, y, z);
    for (let i = 0; i < pads.length; i++) {
      const d = distM(pads[i]!, x, y, z);
      if (d < PAD_FLAT_OUTER) {
        const w = 1 - smoothstep(PAD_FLAT_INNER, PAD_FLAT_OUTER, d);
        h = h + (padHeights[i]! - h) * w;
      }
    }
    return h;
  }

  // Vertex height cache keyed by (face, i, j).
  const stride = n + 1;
  const cache = new Map<number, number>();
  const tmp: [number, number, number] = [0, 0, 0];
  function vertexHeight(face: Face, i: number, j: number): number {
    const key = (face * stride + i) * stride + j;
    let h = cache.get(key);
    if (h === undefined) {
      gridDir(face, i, j, n, tmp);
      h = rawHeight(tmp[0], tmp[1], tmp[2]);
      if (cache.size > 400_000) cache.clear();
      cache.set(key, h);
    }
    return h;
  }

  const uv: [number, number] = [0, 0];
  const da: [number, number, number] = [0, 0, 0];
  const db: [number, number, number] = [0, 0, 0];
  const dc: [number, number, number] = [0, 0, 0];

  function groundHeight(x: number, y: number, z: number): number {
    const face = faceOf(x, y, z);
    faceUV(face, x, y, z, uv);
    const gx = ((uv[0] + 1) / 2) * n;
    const gy = ((uv[1] + 1) / 2) * n;
    const i = Math.min(n - 1, Math.max(0, Math.floor(gx)));
    const j = Math.min(n - 1, Math.max(0, Math.floor(gy)));
    const fx = gx - i;
    const fy = gy - j;
    // Triangles: (i,j)(i+1,j)(i+1,j+1) when fx >= fy, else (i,j)(i+1,j+1)(i,j+1). Same split as the mesh.
    let bi: number, bj: number, ci: number, cj: number;
    if (fx >= fy) {
      bi = i + 1; bj = j; ci = i + 1; cj = j + 1;
    } else {
      bi = i + 1; bj = j + 1; ci = i; cj = j + 1;
    }
    const ha = R + vertexHeight(face, i, j);
    const hb = R + vertexHeight(face, bi, bj);
    const hc = R + vertexHeight(face, ci, cj);
    gridDir(face, i, j, n, da);
    gridDir(face, bi, bj, n, db);
    gridDir(face, ci, cj, n, dc);
    const ax = da[0] * ha, ay = da[1] * ha, az = da[2] * ha;
    const e1x = db[0] * hb - ax, e1y = db[1] * hb - ay, e1z = db[2] * hb - az;
    const e2x = dc[0] * hc - ax, e2y = dc[1] * hc - ay, e2z = dc[2] * hc - az;
    const nx = e1y * e2z - e1z * e2y;
    const ny = e1z * e2x - e1x * e2z;
    const nz = e1x * e2y - e1y * e2x;
    // Ray from the centre along (x,y,z) hits the triangle plane at distance t.
    const t = (nx * ax + ny * ay + nz * az) / (nx * x + ny * y + nz * z);
    return t - R;
  }

  function groundHeightAt(px: number, py: number, pz: number): number {
    const l = Math.sqrt(px * px + py * py + pz * pz);
    return groundHeight(px / l, py / l, pz / l);
  }

  return { body, n, rawHeight, vertexHeight, groundHeight, groundHeightAt, padHeights };
}

/** Faces exported for chunk builders. */
export { FACES };
