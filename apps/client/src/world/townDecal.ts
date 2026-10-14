// Laying the Portus town's paving decal onto the ground (browser round 1: the east road showed
// terrain through its paving). Inside the flat town floor the decal already lies on the sphere,
// 2–7.5 cm above the rendered ground. Its outer road ends run up the rim, where one road quad (2 m
// × 6 m) spans several terrain triangles and the terrain could bulge through its middle. There every
// triangle is cut into pieces under DECAL_STEP m (one cut count per connected group, so shared
// edges stay watertight), each vertex is lifted by the ground height under it plus a lift that grows to
// DECAL_LIFT off the floor, and the road surface's normals follow the new slope.

import { PORTUS_TOWN_FLAT, type Terrain } from "@firstlight/shared";
import type { TownPlacement } from "@firstlight/shared/planet/town";
import type { TownPart } from "../render/townAssets.ts";

/** Longest edge (m) of a lifted piece: well under a terrain quad (1.8 m on Portus). */
export const DECAL_STEP = 0.75;
/** Lift (m) off the rising ground on top of the decal's own height. */
export const DECAL_LIFT = 0.06;

function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/** The decal part `part` (prefab space) of placement `p`, laid onto `terrain` (prefab space again). */
export function conformDecal(part: TownPart, p: TownPlacement, terrain: Terrain): TownPart {
  const R = terrain.body.radius;
  const s = p.scale;
  const F = PORTUS_TOWN_FLAT;
  const toWorld = (x: number, y: number, z: number, out: number[]) => {
    out[0] = p.px + (p.rx * x + p.ux * y + p.fx * z) * s;
    out[1] = p.py + (p.ry * x + p.uy * y + p.fy * z) * s;
    out[2] = p.pz + (p.rz * x + p.uz * y + p.fz * z) * s;
  };
  const chordOf = (w: readonly number[]) => {
    const l = Math.hypot(w[0]!, w[1]!, w[2]!);
    return Math.hypot(w[0]! / l, w[1]! / l - 1, w[2]! / l) * R;
  };
  // Triangles reaching off the flat floor get cut. Each connected group of them (a road strip, a
  // curb run) uses one cut count, from its longest edge, so the edges it shares stay watertight.
  const n0 = part.position.length / 3;
  const w = [0, 0, 0];
  const off: number[] = [];
  for (let t = 0; t < part.index.length; t += 3) {
    for (let k = 0; k < 3; k++) {
      const v = part.index[t + k]!;
      toWorld(part.position[v * 3]!, part.position[v * 3 + 1]!, part.position[v * 3 + 2]!, w);
      if (chordOf(w) > F - 3) {
        off.push(t);
        break;
      }
    }
  }
  if (off.length === 0) return part;
  const key = (v: number) => `${Math.round(part.position[v * 3]! * 1000)},${Math.round(part.position[v * 3 + 1]! * 1000)},${Math.round(part.position[v * 3 + 2]! * 1000)}`;
  const parent = off.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  const owner = new Map<string, number>();
  off.forEach((t, i) => {
    for (let k = 0; k < 3; k++) {
      const kv = key(part.index[t + k]!);
      const o = owner.get(kv);
      if (o === undefined) owner.set(kv, i);
      else parent[find(i)] = find(o);
    }
  });
  const longest = new Map<number, number>();
  off.forEach((t, i) => {
    let m = 0;
    for (let k = 0; k < 3; k++) {
      const a = part.index[t + k]!, b = part.index[t + ((k + 1) % 3)]!;
      m = Math.max(m, Math.hypot(part.position[a * 3]! - part.position[b * 3]!, part.position[a * 3 + 1]! - part.position[b * 3 + 1]!, part.position[a * 3 + 2]! - part.position[b * 3 + 2]!) * s);
    }
    const r = find(i);
    longest.set(r, Math.max(longest.get(r) ?? 0, m));
  });
  const cuts = off.map((_, i) => Math.max(1, Math.ceil(longest.get(find(i))! / DECAL_STEP)));
  const cutSet = new Set(off);
  // Output: the kept triangles' vertices (compacted), then each cut triangle's grid of pieces.
  const remap = new Int32Array(n0).fill(-1);
  let kept = 0;
  for (let t = 0; t < part.index.length; t += 3) {
    if (cutSet.has(t)) continue;
    for (let k = 0; k < 3; k++) {
      const v = part.index[t + k]!;
      if (remap[v]! < 0) remap[v] = kept++;
    }
  }
  const total = kept + cuts.reduce((sum, n) => sum + ((n + 1) * (n + 2)) / 2, 0);
  const pos = new Float32Array(total * 3), nrm = new Float32Array(total * 3), uv = new Float32Array(total * 2);
  const col = new Uint8Array(total * 4);
  for (let v = 0; v < n0; v++) {
    const o = remap[v]!;
    if (o < 0) continue;
    pos.set(part.position.subarray(v * 3, v * 3 + 3), o * 3);
    nrm.set(part.normal.subarray(v * 3, v * 3 + 3), o * 3);
    uv.set(part.uv.subarray(v * 2, v * 2 + 2), o * 2);
    col.set(part.color.subarray(v * 4, v * 4 + 4), o * 4);
  }
  const idx: number[] = [];
  for (let t = 0; t < part.index.length; t += 3) if (!cutSet.has(t)) idx.push(remap[part.index[t]!]!, remap[part.index[t + 1]!]!, remap[part.index[t + 2]!]!);
  const firstNew = kept;
  const firstCutIndex = idx.length;
  let vo = kept;
  off.forEach((t, ci) => {
    const n = cuts[ci]!;
    const grid = (i: number, j: number) => vo + (i * (2 * n + 3 - i)) / 2 + j; // row i holds n - i + 1 vertices
    const [a, b, c] = [part.index[t]!, part.index[t + 1]!, part.index[t + 2]!];
    for (let i = 0; i <= n; i++) {
      for (let j = 0; j <= n - i; j++) {
        const wb = i / n, wc = j / n, wa = 1 - wb - wc;
        const v = grid(i, j);
        for (let k = 0; k < 3; k++) {
          pos[v * 3 + k] = part.position[a * 3 + k]! * wa + part.position[b * 3 + k]! * wb + part.position[c * 3 + k]! * wc;
          nrm[v * 3 + k] = part.normal[a * 3 + k]! * wa + part.normal[b * 3 + k]! * wb + part.normal[c * 3 + k]! * wc;
        }
        for (let k = 0; k < 2; k++) uv[v * 2 + k] = part.uv[a * 2 + k]! * wa + part.uv[b * 2 + k]! * wb + part.uv[c * 2 + k]! * wc;
        for (let k = 0; k < 3; k++) col[v * 4 + k] = Math.round(part.color[a * 4 + k]! * wa + part.color[b * 4 + k]! * wb + part.color[c * 4 + k]! * wc);
        col[v * 4 + 3] = part.color[a * 4 + 3]!; // the material slot
      }
    }
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n - i; j++) {
        idx.push(grid(i, j), grid(i + 1, j), grid(i, j + 1));
        if (j < n - i - 1) idx.push(grid(i + 1, j), grid(i + 1, j + 1), grid(i, j + 1));
      }
    }
    vo += ((n + 1) * (n + 2)) / 2;
  });
  // Lift every new vertex onto the ground (its own height above the sphere kept), back to prefab space.
  const inv = 1 / s;
  for (let v = firstNew; v < total; v++) {
    toWorld(pos[v * 3]!, pos[v * 3 + 1]!, pos[v * 3 + 2]!, w);
    const l = Math.hypot(w[0]!, w[1]!, w[2]!);
    const g = Math.max(0, terrain.groundHeight(w[0]! / l, w[1]! / l, w[2]! / l));
    const k = (l + g + DECAL_LIFT * smoothstep(F - 3, F + 3, chordOf(w))) / l;
    const x = w[0]! * k - p.px, y = w[1]! * k - p.py, z = w[2]! * k - p.pz;
    pos[v * 3] = (p.rx * x + p.ry * y + p.rz * z) * inv;
    pos[v * 3 + 1] = (p.ux * x + p.uy * y + p.uz * z) * inv;
    pos[v * 3 + 2] = (p.fx * x + p.fy * y + p.fz * z) * inv;
  }
  // The road surface (up-facing pieces) takes the lifted slope's normals; curb sides keep theirs.
  const acc = new Float32Array(total * 3);
  for (let q = firstCutIndex; q < idx.length; q += 3) {
    const [a, b, c] = [idx[q]!, idx[q + 1]!, idx[q + 2]!];
    const e1 = [pos[b * 3]! - pos[a * 3]!, pos[b * 3 + 1]! - pos[a * 3 + 1]!, pos[b * 3 + 2]! - pos[a * 3 + 2]!];
    const e2 = [pos[c * 3]! - pos[a * 3]!, pos[c * 3 + 1]! - pos[a * 3 + 1]!, pos[c * 3 + 2]! - pos[a * 3 + 2]!];
    const fn = [e1[1]! * e2[2]! - e1[2]! * e2[1]!, e1[2]! * e2[0]! - e1[0]! * e2[2]!, e1[0]! * e2[1]! - e1[1]! * e2[0]!];
    for (const v of [a, b, c]) for (let k = 0; k < 3; k++) acc[v * 3 + k] = acc[v * 3 + k]! + fn[k]!;
  }
  for (let v = firstNew; v < total; v++) {
    // Up-facing in the world: the normal against the local radial direction.
    const nx = nrm[v * 3]!, ny = nrm[v * 3 + 1]!, nz = nrm[v * 3 + 2]!;
    toWorld(pos[v * 3]!, pos[v * 3 + 1]!, pos[v * 3 + 2]!, w);
    const l = Math.hypot(w[0]!, w[1]!, w[2]!);
    const wx = p.rx * nx + p.ux * ny + p.fx * nz, wy = p.ry * nx + p.uy * ny + p.fy * nz, wz = p.rz * nx + p.uz * ny + p.fz * nz;
    if ((wx * w[0]! + wy * w[1]! + wz * w[2]!) / l < 0.8 * Math.hypot(wx, wy, wz)) continue;
    const ax = acc[v * 3]!, ay = acc[v * 3 + 1]!, az = acc[v * 3 + 2]!;
    const al = Math.hypot(ax, ay, az);
    const side = Math.sign(ax * nx + ay * ny + az * nz); // the faces' winding may point either way
    if (!(al > 0) || side === 0) continue;
    nrm[v * 3] = (side * ax) / al;
    nrm[v * 3 + 1] = (side * ay) / al;
    nrm[v * 3 + 2] = (side * az) / al;
  }
  return { position: pos, normal: nrm, uv, color: col, index: Uint32Array.from(idx) };
}
