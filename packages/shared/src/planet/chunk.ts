// Builds the render mesh for one terrain chunk. Pure function: runs in the client's Web Worker and
// in tests, so the mesh the player sees is provably the surface the server uses.

import { CHUNK_QUADS, gridDir, type Face } from "./cubesphere.ts";
import type { Terrain } from "./terrain.ts";

export interface ChunkGeometry {
  face: Face;
  cx: number;
  cy: number;
  /** Absolute planet-space positions (x, y, z per vertex). Skirt vertices come after the grid. */
  positions: Float32Array;
  /** Smooth normals from central differences of the height field. */
  normals: Float32Array;
  /** Height above the radius per vertex (metres). */
  heights: Float32Array;
  /** dot(normal, radial up) per vertex: 1 = flat, 0 = vertical. */
  flatness: Float32Array;
  indices: Uint32Array;
  /** Centre direction and bounding radius for culling. */
  center: [number, number, number];
  boundRadius: number;
  minHeight: number;
  maxHeight: number;
}

const SKIRT_DEPTH = 3;

export function buildChunk(terrain: Terrain, face: Face, cx: number, cy: number): ChunkGeometry {
  const R = terrain.body.radius;
  const n = terrain.n;
  const q = CHUNK_QUADS;
  const side = q + 1;
  const gridCount = side * side;
  const total = gridCount + 4 * side;
  const positions = new Float32Array(total * 3);
  const normals = new Float32Array(total * 3);
  const heights = new Float32Array(total);
  const flatness = new Float32Array(total);

  const dir: [number, number, number] = [0, 0, 0];
  const t1: [number, number, number] = [0, 0, 0];
  const t2: [number, number, number] = [0, 0, 0];
  const t3: [number, number, number] = [0, 0, 0];
  const t4: [number, number, number] = [0, 0, 0];
  let minH = Infinity;
  let maxH = -Infinity;
  const i0 = cx * q;
  const j0 = cy * q;

  const pos = (fi: number, fj: number, out: [number, number, number]) => {
    gridDir(face, fi, fj, n, out);
    const r = R + terrain.rawHeight(out[0], out[1], out[2]);
    out[0] *= r;
    out[1] *= r;
    out[2] *= r;
    return out;
  };

  for (let b = 0; b <= q; b++) {
    for (let a = 0; a <= q; a++) {
      const v = b * side + a;
      const gi = i0 + a;
      const gj = j0 + b;
      gridDir(face, gi, gj, n, dir);
      const h = terrain.vertexHeight(face, gi, gj);
      const r = R + h;
      positions[v * 3] = dir[0] * r;
      positions[v * 3 + 1] = dir[1] * r;
      positions[v * 3 + 2] = dir[2] * r;
      heights[v] = h;
      if (h < minH) minH = h;
      if (h > maxH) maxH = h;
      // Central differences in grid space (works across face edges because gridDir extrapolates).
      pos(gi + 0.5, gj, t1);
      pos(gi - 0.5, gj, t2);
      pos(gi, gj + 0.5, t3);
      pos(gi, gj - 0.5, t4);
      const ux = t1[0] - t2[0], uy = t1[1] - t2[1], uz = t1[2] - t2[2];
      const wx = t3[0] - t4[0], wy = t3[1] - t4[1], wz = t3[2] - t4[2];
      let nx = uy * wz - uz * wy;
      let ny = uz * wx - ux * wz;
      let nz = ux * wy - uy * wx;
      const l = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
      nx /= l; ny /= l; nz /= l;
      if (nx * dir[0] + ny * dir[1] + nz * dir[2] < 0) { nx = -nx; ny = -ny; nz = -nz; }
      normals[v * 3] = nx;
      normals[v * 3 + 1] = ny;
      normals[v * 3 + 2] = nz;
      flatness[v] = nx * dir[0] + ny * dir[1] + nz * dir[2];
    }
  }

  // Skirts: copy each edge's vertices, pushed down radially.
  const edges: number[][] = [[], [], [], []];
  for (let k = 0; k <= q; k++) {
    edges[0]!.push(k); // b = 0
    edges[1]!.push(q * side + k); // b = q
    edges[2]!.push(k * side); // a = 0
    edges[3]!.push(k * side + q); // a = q
  }
  let sv = gridCount;
  const skirtOf: number[][] = [[], [], [], []];
  for (let e = 0; e < 4; e++) {
    for (const v of edges[e]!) {
      const x = positions[v * 3]!, y = positions[v * 3 + 1]!, z = positions[v * 3 + 2]!;
      const l = Math.sqrt(x * x + y * y + z * z);
      const s = (l - SKIRT_DEPTH) / l;
      positions[sv * 3] = x * s;
      positions[sv * 3 + 1] = y * s;
      positions[sv * 3 + 2] = z * s;
      normals[sv * 3] = normals[v * 3]!;
      normals[sv * 3 + 1] = normals[v * 3 + 1]!;
      normals[sv * 3 + 2] = normals[v * 3 + 2]!;
      heights[sv] = heights[v]! - SKIRT_DEPTH;
      flatness[sv] = flatness[v]!;
      skirtOf[e]!.push(sv);
      sv++;
    }
  }

  const idx: number[] = [];
  for (let b = 0; b < q; b++) {
    for (let a = 0; a < q; a++) {
      const v00 = b * side + a;
      const v10 = v00 + 1;
      const v11 = v00 + side + 1;
      const v01 = v00 + side;
      // Grid (i=a, j=b): same split as Terrain.groundHeight: (i,j)(i+1,j)(i+1,j+1) and (i,j)(i+1,j+1)(i,j+1).
      idx.push(v00, v10, v11, v00, v11, v01);
    }
  }
  for (let e = 0; e < 4; e++) {
    const top = edges[e]!;
    const bot = skirtOf[e]!;
    for (let k = 0; k < q; k++) {
      const a = top[k]!, b = top[k + 1]!, c = bot[k + 1]!, d = bot[k]!;
      // Both windings: skirts only hide cracks, so they must show from either side.
      idx.push(a, b, c, a, c, d, a, c, b, a, d, c);
    }
  }

  gridDir(face, i0 + q / 2, j0 + q / 2, n, dir);
  let boundRadius = 0;
  const cxp = dir[0] * (R + (minH + maxH) / 2), cyp = dir[1] * (R + (minH + maxH) / 2), czp = dir[2] * (R + (minH + maxH) / 2);
  for (let v = 0; v < gridCount; v++) {
    const dx = positions[v * 3]! - cxp, dy = positions[v * 3 + 1]! - cyp, dz = positions[v * 3 + 2]! - czp;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (d > boundRadius) boundRadius = d;
  }

  return {
    face, cx, cy, positions, normals, heights, flatness,
    indices: new Uint32Array(idx),
    center: [dir[0], dir[1], dir[2]],
    boundRadius,
    minHeight: minH,
    maxHeight: maxH,
  };
}
