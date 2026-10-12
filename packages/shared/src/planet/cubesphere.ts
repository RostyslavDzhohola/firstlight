// Cube-sphere geometry: six faces, each an N×N quad grid projected onto the unit sphere by plain
// normalisation (no trig, so every engine agrees). Face bases satisfy tu × tv = n, so quads wound
// (i,j) → (i+1,j) → (i+1,j+1) face outward.

export type Face = 0 | 1 | 2 | 3 | 4 | 5;

export interface FaceBasis {
  n: readonly [number, number, number];
  tu: readonly [number, number, number];
  tv: readonly [number, number, number];
}

export const FACES: readonly FaceBasis[] = [
  { n: [1, 0, 0], tu: [0, 1, 0], tv: [0, 0, 1] },
  { n: [-1, 0, 0], tu: [0, 0, 1], tv: [0, 1, 0] },
  { n: [0, 1, 0], tu: [0, 0, 1], tv: [1, 0, 0] },
  { n: [0, -1, 0], tu: [1, 0, 0], tv: [0, 0, 1] },
  { n: [0, 0, 1], tu: [1, 0, 0], tv: [0, 1, 0] },
  { n: [0, 0, -1], tu: [0, 1, 0], tv: [1, 0, 0] },
];

/** Quads per chunk edge. */
export const CHUNK_QUADS = 32;

/** Face containing a direction (largest absolute component). */
export function faceOf(x: number, y: number, z: number): Face {
  const ax = x < 0 ? -x : x;
  const ay = y < 0 ? -y : y;
  const az = z < 0 ? -z : z;
  if (ax >= ay && ax >= az) return x >= 0 ? 0 : 1;
  if (ay >= az) return y >= 0 ? 2 : 3;
  return z >= 0 ? 4 : 5;
}

/**
 * Face-plane coordinates (u, v) in [-1, 1] of a direction on a given face.
 * Writes into `out` and returns it.
 */
export function faceUV(face: Face, x: number, y: number, z: number, out: [number, number]): [number, number] {
  const b = FACES[face]!;
  const dn = x * b.n[0] + y * b.n[1] + z * b.n[2];
  out[0] = (x * b.tu[0] + y * b.tu[1] + z * b.tu[2]) / dn;
  out[1] = (x * b.tv[0] + y * b.tv[1] + z * b.tv[2]) / dn;
  return out;
}

/** Unit direction of grid vertex (i, j) on `face` for a grid of `n` quads per edge. */
export function gridDir(face: Face, i: number, j: number, n: number, out: [number, number, number]): [number, number, number] {
  const b = FACES[face]!;
  const u = (2 * i) / n - 1;
  const v = (2 * j) / n - 1;
  const x = b.n[0] + u * b.tu[0] + v * b.tv[0];
  const y = b.n[1] + u * b.tu[1] + v * b.tv[1];
  const z = b.n[2] + u * b.tu[2] + v * b.tv[2];
  const inv = 1 / Math.sqrt(x * x + y * y + z * z);
  out[0] = x * inv;
  out[1] = y * inv;
  out[2] = z * inv;
  return out;
}

export interface ChunkKey {
  face: Face;
  cx: number;
  cy: number;
}

export function chunkId(face: number, cx: number, cy: number): string {
  return `${face}:${cx}:${cy}`;
}

/** Chunk containing a direction, for a body with `chunksPerFace` chunks per face edge. */
export function chunkOf(x: number, y: number, z: number, chunksPerFace: number): ChunkKey {
  const face = faceOf(x, y, z);
  const uv: [number, number] = [0, 0];
  faceUV(face, x, y, z, uv);
  const cx = Math.min(chunksPerFace - 1, Math.max(0, Math.floor(((uv[0] + 1) / 2) * chunksPerFace)));
  const cy = Math.min(chunksPerFace - 1, Math.max(0, Math.floor(((uv[1] + 1) / 2) * chunksPerFace)));
  return { face, cx, cy };
}
