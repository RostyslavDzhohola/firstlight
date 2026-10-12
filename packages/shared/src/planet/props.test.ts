import { describe, expect, it } from "vitest";
import { mulberry32 } from "../rng.ts";
import { BODIES, BODY_IDS, type BodyId } from "./bodies.ts";
import { buildChunk } from "./chunk.ts";
import { chunkOf, type Face } from "./cubesphere.ts";
import { chordMetres, padDirs } from "./pads.ts";
import {
  chunkProps, packProps, PORTUS_PLAZA_CLEAR, PROP_JITTER_MIN, PROP_KINDS, PROP_MIN_FLATNESS, PROP_PAD_CLEARANCE, PROP_STRIDE, PROPS_VERSION,
  PROP_STYLES, surfaceAtGrid, type PropInstance, type SurfacePoint,
} from "./props.ts";
import { createTerrain, type Terrain } from "./terrain.ts";

function sampleChunks(id: BodyId, count: number, seed: number): [Face, number, number][] {
  const rand = mulberry32(seed);
  const cpf = BODIES[id].chunksPerFace;
  const out: [Face, number, number][] = [];
  for (let k = 0; k < count; k++) out.push([Math.floor(rand() * 6) as Face, Math.floor(rand() * cpf), Math.floor(rand() * cpf)]);
  return out;
}

/**
 * Flatness of the rendered chunk mesh under a direction, measured independently: brute-force
 * ray/triangle intersection against buildChunk's grid triangles, then that triangle's normal.
 */
function meshFlatness(positions: Float32Array, indices: Uint32Array, x: number, y: number, z: number): number | null {
  const l = Math.hypot(x, y, z);
  const d = [x / l, y / l, z / l] as const;
  for (let k = 0; k < indices.length; k += 3) {
    const a = indices[k]! * 3, b = indices[k + 1]! * 3, c = indices[k + 2]! * 3;
    const ax = positions[a]!, ay = positions[a + 1]!, az = positions[a + 2]!;
    const e1x = positions[b]! - ax, e1y = positions[b + 1]! - ay, e1z = positions[b + 2]! - az;
    const e2x = positions[c]! - ax, e2y = positions[c + 1]! - ay, e2z = positions[c + 2]! - az;
    const px = d[1] * e2z - d[2] * e2y, py = d[2] * e2x - d[0] * e2z, pz = d[0] * e2y - d[1] * e2x;
    const det = e1x * px + e1y * py + e1z * pz;
    if (Math.abs(det) < 1e-12) continue;
    const inv = 1 / det;
    const u = (-ax * px - ay * py - az * pz) * inv;
    if (u < -1e-6 || u > 1 + 1e-6) continue;
    const qx = -ay * e1z + az * e1y, qy = -az * e1x + ax * e1z, qz = -ax * e1y + ay * e1x;
    const v = (d[0] * qx + d[1] * qy + d[2] * qz) * inv;
    if (v < -1e-6 || u + v > 1 + 1e-6) continue;
    const nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
    return Math.abs((nx * d[0] + ny * d[1] + nz * d[2]) / Math.hypot(nx, ny, nz));
  }
  return null;
}

describe("props", () => {
  const terrains = Object.fromEntries(BODY_IDS.map((id) => [id, createTerrain(id)])) as Record<BodyId, Terrain>;

  it("is deterministic: two terrain instances give identical props", () => {
    for (const id of BODY_IDS) {
      const other = createTerrain(id);
      for (const [f, cx, cy] of sampleChunks(id, 6, 1)) {
        const a = chunkProps(terrains[id], f, cx, cy);
        const b = chunkProps(other, f, cx, cy);
        expect(b).toEqual(a);
        // Repeated calls agree too (no hidden state).
        expect(chunkProps(terrains[id], f, cx, cy)).toEqual(a);
      }
    }
  });

  it("places props on the rendered ground, never on water or steep rock", () => {
    let total = 0;
    for (const id of BODY_IDS) {
      const terrain = terrains[id];
      const body = BODIES[id];
      for (const [f, cx, cy] of sampleChunks(id, 24, 2)) {
        const mesh = buildChunk(terrain, f, cx, cy);
        const grid = mesh.indices.subarray(0, 32 * 32 * 6);
        for (const p of chunkProps(terrain, f, cx, cy)) {
          total++;
          const l = Math.hypot(p.x, p.y, p.z);
          const g = terrain.groundHeight(p.x / l, p.y / l, p.z / l);
          // On the mesh surface (float64 here; the mesh itself is float32).
          expect(Math.abs(l - body.radius - g)).toBeLessThan(1e-3);
          expect(g).toBeGreaterThan(body.waterLevel);
          const flat = meshFlatness(mesh.positions, grid, p.x, p.y, p.z);
          expect(flat).not.toBeNull();
          expect(flat!).toBeGreaterThan(PROP_MIN_FLATNESS - 1e-4);
          expect(PROP_STYLES[id].some((r) => r.kind === p.kind)).toBe(true);
          expect(PROP_KINDS[p.kindIndex]).toBe(p.kind);
          expect(p.scale).toBeGreaterThan(0);
        }
      }
    }
    expect(total).toBeGreaterThan(200);
  });

  it("keeps pad clearings and the Portus plaza free", () => {
    for (const id of ["arcadia", "hollowmere", "meridian"] as const) {
      const body = BODIES[id];
      const terrain = terrains[id];
      // Chunks that contain each pad.
      for (const pad of padDirs(body)) {
        const ring = chunksAround(terrain, pad);
        for (const [f, cx, cy] of ring) {
          for (const p of chunkProps(terrain, f, cx, cy)) {
            const l = Math.hypot(p.x, p.y, p.z);
            expect(chordMetres(pad, p.x / l, p.y / l, p.z / l, body.radius)).toBeGreaterThanOrEqual(PROP_PAD_CLEARANCE);
          }
        }
      }
    }
    const portus = terrains.portus;
    let outside = 0;
    for (const [f, cx, cy] of chunksAround(portus, [0, 1, 0], PORTUS_PLAZA_CLEAR + 4)) {
      for (const p of chunkProps(portus, f, cx, cy)) {
        const l = Math.hypot(p.x, p.y, p.z);
        const d = Math.hypot(p.x / l, p.y / l - 1, p.z / l) * BODIES.portus.radius;
        expect(d).toBeGreaterThanOrEqual(PORTUS_PLAZA_CLEAR);
        outside++;
      }
    }
    expect(outside).toBeGreaterThanOrEqual(0);
  });

  it("does not depend on chunk boundaries: neighbours never duplicate a prop", () => {
    const terrain = terrains.arcadia;
    const seen = new Set<string>();
    for (let cy = 2; cy < 5; cy++) {
      for (let cx = 2; cx < 5; cx++) {
        for (const p of chunkProps(terrain, 4, cx, cy)) {
          const k = `${p.kind}:${p.x.toFixed(4)}:${p.y.toFixed(4)}:${p.z.toFixed(4)}`;
          expect(seen.has(k)).toBe(false);
          seen.add(k);
        }
      }
    }
    expect(seen.size).toBeGreaterThan(0);
  });

  it("keeps same-rule props apart, also across cube-face seams", () => {
    // Points on cube edges and a cube corner, where two or three face grids meet.
    const seams: [number, number, number][] = [[1, 1, 0.2], [1, -0.3, 1], [-1, 1, -1], [0.2, -1, -1]];
    for (const id of ["arcadia", "hollowmere", "meridian", "portus"] as const) {
      const terrain = terrains[id];
      const R = BODIES[id].radius;
      const minQuad = (0.5 * 2 * R) / terrain.n; // smallest quad side (at face edges/corners)
      for (const s of seams) {
        const l = Math.hypot(...s);
        const d: [number, number, number] = [s[0] / l, s[1] / l, s[2] / l];
        const props = chunksAround(terrain, d, 40).flatMap(([f, cx, cy]) => chunkProps(terrain, f, cx, cy));
        for (const rule of PROP_STYLES[id]) {
          const same = props.filter((p) => p.kind === rule.kind);
          const minDist = 2 * PROP_JITTER_MIN * rule.every * minQuad * 0.98;
          for (let a = 0; a < same.length; a++) {
            for (let b = a + 1; b < same.length; b++) {
              const pa = same[a]!, pb = same[b]!;
              expect(Math.hypot(pa.x - pb.x, pa.y - pb.y, pa.z - pb.z)).toBeGreaterThan(minDist);
            }
          }
        }
      }
    }
    expect(PROPS_VERSION).toBe(2);
  });

  it("surfaceAtGrid matches groundHeight at random grid points", () => {
    const terrain = terrains.meridian;
    const rand = mulberry32(9);
    const sp: SurfacePoint = { x: 0, y: 0, z: 0, h: 0, flatness: 0 };
    for (let k = 0; k < 300; k++) {
      const f = Math.floor(rand() * 6) as Face;
      surfaceAtGrid(terrain, f, rand() * terrain.n, rand() * terrain.n, sp);
      const l = Math.hypot(sp.x, sp.y, sp.z);
      expect(Math.abs(terrain.groundHeight(sp.x / l, sp.y / l, sp.z / l) - sp.h)).toBeLessThan(1e-6);
      expect(sp.flatness).toBeGreaterThan(0);
      expect(sp.flatness).toBeLessThanOrEqual(1 + 1e-9);
    }
  });

  it("packs props into a flat Float32Array", () => {
    const props: PropInstance[] = chunkProps(terrains.arcadia, 2, 3, 3);
    const a = packProps(props);
    expect(a.length).toBe(props.length * PROP_STRIDE);
    props.forEach((p, i) => {
      expect(a[i * PROP_STRIDE]).toBe(p.kindIndex);
      expect(a[i * PROP_STRIDE + 4]).toBeCloseTo(p.scale, 5);
    });
  });
});

/** Every chunk that has ground within `radius` metres of a direction (sampled on rings). */
function chunksAround(terrain: Terrain, d: readonly [number, number, number], radius = PROP_PAD_CLEARANCE + 4): [Face, number, number][] {
  const R = terrain.body.radius;
  const cpf = terrain.body.chunksPerFace;
  const ref = Math.abs(d[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  let tx = ref[1]! * d[2] - ref[2]! * d[1], ty = ref[2]! * d[0] - ref[0]! * d[2], tz = ref[0]! * d[1] - ref[1]! * d[0];
  const tl = Math.hypot(tx, ty, tz);
  tx /= tl; ty /= tl; tz /= tl;
  const bx = d[1] * tz - d[2] * ty, by = d[2] * tx - d[0] * tz, bz = d[0] * ty - d[1] * tx;
  const keys = new Map<string, [Face, number, number]>();
  for (let r = 0; r <= radius; r += 2) {
    for (let a = 0; a < 32; a++) {
      const c = Math.cos((a / 32) * Math.PI * 2) * (r / R), s = Math.sin((a / 32) * Math.PI * 2) * (r / R);
      const x = d[0] + tx * c + bx * s, y = d[1] + ty * c + by * s, z = d[2] + tz * c + bz * s;
      const k = chunkOf(x, y, z, cpf);
      keys.set(`${k.face}:${k.cx}:${k.cy}`, [k.face, k.cx, k.cy]);
    }
  }
  return [...keys.values()];
}
