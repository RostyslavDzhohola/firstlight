// Web Worker: builds terrain chunk meshes off the main thread with the shared terrain code,
// then colours them. Arrays are transferred back without copying.

import { buildChunk, createTerrain, hash01, type BodyId, type Face, type Terrain } from "@firstlight/shared";
import { PALETTES, terrainColor } from "./palette.ts";

export interface ChunkRequest {
  id: number;
  body: BodyId;
  face: Face;
  cx: number;
  cy: number;
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
  indices: Uint32Array;
  center: [number, number, number];
  boundRadius: number;
  minHeight: number;
  maxHeight: number;
}

const terrains = new Map<BodyId, Terrain>();

self.onmessage = (e: MessageEvent<ChunkRequest>) => {
  const req = e.data;
  let terrain = terrains.get(req.body);
  if (!terrain) {
    terrain = createTerrain(req.body);
    terrains.set(req.body, terrain);
  }
  const g = buildChunk(terrain, req.face, req.cx, req.cy);
  const pal = PALETTES[req.body];
  const count = g.heights.length;
  const colors = new Float32Array(count * 3);
  const water = terrain.body.waterLevel;
  for (let v = 0; v < count; v++) {
    const x = g.positions[v * 3]!, y = g.positions[v * 3 + 1]!, z = g.positions[v * 3 + 2]!;
    const n = hash01(Math.floor(x * 0.7), Math.floor(y * 0.7), Math.floor(z * 0.7)) * 2 - 1;
    terrainColor(pal, g.heights[v]!, water, g.flatness[v]!, n * 0.6, colors, v * 3);
  }
  const res: ChunkResult = {
    id: req.id, body: req.body, face: req.face, cx: req.cx, cy: req.cy,
    positions: g.positions, normals: g.normals, colors, indices: g.indices,
    center: g.center, boundRadius: g.boundRadius, minHeight: g.minHeight, maxHeight: g.maxHeight,
  };
  (self as unknown as Worker).postMessage(res, [res.positions.buffer, res.normals.buffer, res.colors.buffer, res.indices.buffer]);
};
