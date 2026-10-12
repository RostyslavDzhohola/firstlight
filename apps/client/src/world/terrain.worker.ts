// Web Worker: builds terrain chunk meshes off the main thread with the shared terrain code, then
// colours them and bakes per-vertex extras: concavity AO, sun visibility (Low tier), grass density,
// the chunk's water surface with baked depth, and the chunk's deterministic props. Arrays are
// transferred back without copying.

import {
  buildChunk, chunkProps, CHUNK_QUADS, createTerrain, gridDir, hash01, packProps, type BodyId, type Face, type Terrain,
} from "@firstlight/shared";
import { LOOKS } from "../render/looks.ts";
import { skyDir, type V3 } from "../render/sunFrame.ts";
import { grassWeight, PALETTES, terrainColor } from "./palette.ts";

export interface ChunkRequest {
  id: number;
  body: BodyId;
  face: Face;
  cx: number;
  cy: number;
  /** Bake sun visibility (only Low uses it; it costs ~5 extra height samples per vertex). */
  bakeSun: boolean;
}

export interface WaterMeshData {
  positions: Float32Array;
  /** Water depth below the surface per vertex (m); negative = above water (shore). */
  depth: Float32Array;
  indices: Uint16Array;
}

export interface ChunkResult {
  id: number;
  body: BodyId;
  face: Face;
  cx: number;
  cy: number;
  positions: Float32Array;
  normals: Float32Array;
  colors: Float32Array;
  /** Per vertex: concavity AO, sun visibility. */
  bake: Float32Array;
  /** Grass density 0..1 per grid vertex ((q+1)² entries, row-major b*side + a). */
  grass: Float32Array;
  indices: Uint32Array;
  water: WaterMeshData | null;
  /** Packed props (PROP_STRIDE floats each). */
  props: Float32Array;
  center: [number, number, number];
  boundRadius: number;
  minHeight: number;
  maxHeight: number;
}

const terrains = new Map<BodyId, Terrain>();

function clampIdx(v: number, n: number) {
  return v < 0 ? 0 : v > n ? n : v;
}

self.onmessage = (e: MessageEvent<ChunkRequest>) => {
  const req = e.data;
  let terrain = terrains.get(req.body);
  if (!terrain) {
    terrain = createTerrain(req.body);
    terrains.set(req.body, terrain);
  }
  const body = terrain.body;
  const R = body.radius;
  const n = terrain.n;
  const q = CHUNK_QUADS;
  const side = q + 1;
  const g = buildChunk(terrain, req.face, req.cx, req.cy);
  const pal = PALETTES[req.body];
  const count = g.heights.length;
  const gridCount = side * side;
  const colors = new Float32Array(count * 3);
  const bake = new Float32Array(count * 2);
  const grass = new Float32Array(gridCount);
  const water = body.waterLevel;
  const i0 = req.cx * q, j0 = req.cy * q;
  const look = LOOKS[req.body];
  const hub = body.terrain.kind === "hub";
  const sd: V3 = [0, 0, 0];
  const dir: V3 = [0, 0, 0];

  for (let v = 0; v < count; v++) {
    const x = g.positions[v * 3]!, y = g.positions[v * 3 + 1]!, z = g.positions[v * 3 + 2]!;
    const nz = hash01(Math.floor(x * 0.7), Math.floor(y * 0.7), Math.floor(z * 0.7)) * 2 - 1;
    terrainColor(pal, g.heights[v]!, water, g.flatness[v]!, nz * 0.6, colors, v * 3);
  }

  for (let b = 0; b <= q; b++) {
    for (let a = 0; a <= q; a++) {
      const v = b * side + a;
      const gi = i0 + a, gj = j0 + b;
      const h = g.heights[v]!;
      // Concavity AO: how far the surroundings rise above this vertex (clamped neighbours keep
      // the vertex-height cache keys valid at face edges).
      let near = 0, far = 0;
      for (const [di, dj] of [[3, 0], [-3, 0], [0, 3], [0, -3]] as const) {
        near += terrain.vertexHeight(req.face, clampIdx(gi + di, n), clampIdx(gj + dj, n));
      }
      for (const [di, dj] of [[7, 7], [-7, 7], [7, -7], [-7, -7]] as const) {
        far += terrain.vertexHeight(req.face, clampIdx(gi + di, n), clampIdx(gj + dj, n));
      }
      const cav = Math.max(0, near / 4 - h) * 0.09 + Math.max(0, far / 4 - h) * 0.035;
      bake[v * 2] = Math.max(0.45, Math.min(1, 1 - cav));

      // Sun visibility: march towards the sun (the sun as seen from this vertex's own frame).
      let vis = 1;
      if (req.bakeSun) {
        const x = g.positions[v * 3]!, y = g.positions[v * 3 + 1]!, z = g.positions[v * 3 + 2]!;
        const l = Math.hypot(x, y, z);
        skyDir(x / l, y / l, z / l, look.sunElev, look.sunAz, sd);
        for (const d of [3, 8, 18, 36, 70]) {
          const px = x + sd[0] * d, py = y + sd[1] * d, pz = z + sd[2] * d;
          const pl = Math.hypot(px, py, pz);
          const gh = terrain.rawHeight(px / pl, py / pl, pz / pl);
          const above = pl - (R + gh);
          vis = Math.min(vis, Math.max(0, Math.min(1, (above + 0.5) / 2.5)));
          if (vis <= 0) break;
        }
      }
      bake[v * 2 + 1] = vis;

      // Grass density.
      const nz = hash01(gi, gj, req.face, 77) * 2 - 1;
      let w = grassWeight(pal, h, water, g.flatness[v]!, nz);
      if (hub) {
        gridDir(req.face, gi, gj, n, dir);
        const dc = Math.hypot(dir[0], dir[1] - 1, dir[2]) * R;
        w *= Math.max(0, Math.min(1, (dc - 26) / 8));
      }
      grass[v] = w;
    }
  }
  // Skirts copy their edge vertex's bake values (skirt i mirrors grid edge vertex order).
  for (let v = gridCount; v < count; v++) {
    bake[v * 2] = 0.6;
    bake[v * 2 + 1] = 1;
  }

  // Water surface (spherical cap at the water radius) for chunks that reach below it.
  let waterMesh: WaterMeshData | null = null;
  if (g.minHeight < water + 0.3) {
    const wr = R + water;
    const positions = new Float32Array(gridCount * 3);
    const depth = new Float32Array(gridCount);
    for (let b = 0; b <= q; b++) {
      for (let a = 0; a <= q; a++) {
        const v = b * side + a;
        gridDir(req.face, i0 + a, j0 + b, n, dir);
        positions[v * 3] = dir[0] * wr;
        positions[v * 3 + 1] = dir[1] * wr;
        positions[v * 3 + 2] = dir[2] * wr;
        depth[v] = water - g.heights[v]!;
      }
    }
    const idx: number[] = [];
    for (let b = 0; b < q; b++) {
      for (let a = 0; a < q; a++) {
        const v00 = b * side + a, v10 = v00 + 1, v11 = v00 + side + 1, v01 = v00 + side;
        const minH = Math.min(g.heights[v00]!, g.heights[v10]!, g.heights[v11]!, g.heights[v01]!);
        if (minH > water + 0.25) continue;
        idx.push(v00, v10, v11, v00, v11, v01);
      }
    }
    if (idx.length > 0) waterMesh = { positions, depth, indices: new Uint16Array(idx) };
  }

  const props = packProps(chunkProps(terrain, req.face, req.cx, req.cy));

  const res: ChunkResult = {
    id: req.id, body: req.body, face: req.face, cx: req.cx, cy: req.cy,
    positions: g.positions, normals: g.normals, colors, bake, grass, indices: g.indices, water: waterMesh, props,
    center: g.center, boundRadius: g.boundRadius, minHeight: g.minHeight, maxHeight: g.maxHeight,
  };
  const transfer: Transferable[] = [
    res.positions.buffer, res.normals.buffer, res.colors.buffer, res.bake.buffer, res.grass.buffer, res.indices.buffer, res.props.buffer,
  ];
  if (waterMesh) transfer.push(waterMesh.positions.buffer, waterMesh.depth.buffer, waterMesh.indices.buffer);
  (self as unknown as Worker).postMessage(res, transfer);
};
