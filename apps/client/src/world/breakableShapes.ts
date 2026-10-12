// Pre-fractured debris for the breakable props (SPEC §6.9): every archetype's solids
// (breakableIntact.ts) fractured on their own with @dgreenheck/three-pinata (MIT, npm package only,
// D17) into a fixed number of pieces for a few fixed seeds. Runs in the fracture worker (and in
// tests), never on the main thread: it pulls in three-piñata. Fresh fracture faces get the part's
// inner colour and an `inner` = 1 vertex flag (one material, one draw: the shader tints them).

import { DestructibleMesh, FractureOptions } from "@dgreenheck/three-pinata";
import type { BufferGeometry } from "three";
import { BREAKABLE_ARCHETYPES, bodyBreakables, createTerrain, type BodyId } from "@firstlight/shared";
import {
  archetypeShape, colourIntact, intactArrays, jitter, lin, type BreakableAssets, type MeshArrays, type PieceArrays, type RGB, type ShapePart,
} from "./breakableIntact.ts";

export { archetypeShape, buildIntactAssets, intactArrays, type BreakableAssets, type MeshArrays, type PieceArrays, type ShapePart } from "./breakableIntact.ts";

const _rgb: RGB = [0, 0, 0];

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
