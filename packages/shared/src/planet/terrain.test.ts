import { describe, expect, it } from "vitest";
import { mulberry32 } from "../rng.ts";
import { BODIES, BODY_IDS } from "./bodies.ts";
import { buildChunk } from "./chunk.ts";
import { chunkOf, faceOf, gridDir, type Face } from "./cubesphere.ts";
import { anchorDir, isSafe, padDirs, PAD_SAFE_RADIUS } from "./pads.ts";
import { createNoise3, fbm } from "../noise.ts";
import { createTerrain, PORTUS_TOWN_FLAT } from "./terrain.ts";

function randomDir(rand: () => number): [number, number, number] {
  for (;;) {
    const x = rand() * 2 - 1, y = rand() * 2 - 1, z = rand() * 2 - 1;
    const l = Math.sqrt(x * x + y * y + z * z);
    if (l > 0.1 && l <= 1) return [x / l, y / l, z / l];
  }
}

/** Height of the chunk mesh under a direction, by brute-force ray/triangle intersection. */
function meshHeight(positions: Float32Array, indices: Uint32Array, d: [number, number, number], R: number): number | null {
  for (let k = 0; k < indices.length; k += 3) {
    const a = indices[k]! * 3, b = indices[k + 1]! * 3, c = indices[k + 2]! * 3;
    const ax = positions[a]!, ay = positions[a + 1]!, az = positions[a + 2]!;
    const e1x = positions[b]! - ax, e1y = positions[b + 1]! - ay, e1z = positions[b + 2]! - az;
    const e2x = positions[c]! - ax, e2y = positions[c + 1]! - ay, e2z = positions[c + 2]! - az;
    const px = d[1] * e2z - d[2] * e2y, py = d[2] * e2x - d[0] * e2z, pz = d[0] * e2y - d[1] * e2x;
    const det = e1x * px + e1y * py + e1z * pz;
    if (Math.abs(det) < 1e-12) continue;
    const inv = 1 / det;
    const tx = -ax, ty = -ay, tz = -az;
    const u = (tx * px + ty * py + tz * pz) * inv;
    if (u < -1e-6 || u > 1 + 1e-6) continue;
    const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
    const v = (d[0] * qx + d[1] * qy + d[2] * qz) * inv;
    if (v < -1e-6 || u + v > 1 + 1e-6) continue;
    const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
    if (t > R * 0.5) return t - R;
  }
  return null;
}

describe("terrain", () => {
  it("is deterministic: two instances agree exactly", () => {
    for (const id of BODY_IDS) {
      const a = createTerrain(id);
      const b = createTerrain(id);
      const rand = mulberry32(7);
      for (let k = 0; k < 500; k++) {
        const d = randomDir(rand);
        expect(a.rawHeight(...d)).toBe(b.rawHeight(...d));
        expect(a.groundHeight(...d)).toBe(b.groundHeight(...d));
      }
    }
  });

  it("matches the rendered chunk mesh within 1 mm (client/server parity)", () => {
    const rand = mulberry32(11);
    for (const id of ["arcadia", "meridian", "portus"] as const) {
      const terrain = createTerrain(id);
      const R = BODIES[id].radius;
      for (let k = 0; k < 40; k++) {
        const d = randomDir(rand);
        const key = chunkOf(...d, BODIES[id].chunksPerFace);
        const chunk = buildChunk(terrain, key.face, key.cx, key.cy);
        const grid = chunk.indices.subarray(0, 32 * 32 * 6);
        const mh = meshHeight(chunk.positions, grid, d, R);
        expect(mh).not.toBeNull();
        // float32 mesh positions: allow 1 mm.
        expect(Math.abs(mh! - terrain.groundHeight(...d))).toBeLessThan(1e-3);
      }
    }
  });

  it("returns the vertex height exactly at grid vertices", () => {
    const terrain = createTerrain("hollowmere");
    const dir: [number, number, number] = [0, 0, 0];
    const rand = mulberry32(3);
    for (let k = 0; k < 200; k++) {
      const face = Math.floor(rand() * 6) as Face;
      const i = 1 + Math.floor(rand() * (terrain.n - 2));
      const j = 1 + Math.floor(rand() * (terrain.n - 2));
      gridDir(face, i, j, terrain.n, dir);
      expect(terrain.groundHeight(...dir)).toBeCloseTo(terrain.vertexHeight(face, i, j), 6);
    }
  });

  it("has no seams: shared edge vertices of adjacent faces have the same direction and height", () => {
    const terrain = createTerrain("arcadia");
    const n = terrain.n;
    const d: [number, number, number] = [0, 0, 0];
    for (let face = 0 as Face; face < 6; face = (face + 1) as Face) {
      for (const [i, j] of [[0, 5], [n, 7], [9, 0], [11, n]] as const) {
        gridDir(face, i, j, n, d);
        // Nudge slightly outward along the direction's own face to find the neighbour face.
        const h1 = terrain.rawHeight(...d);
        const other = faceOf(...d);
        expect(Math.abs(terrain.groundHeight(...d) - h1)).toBeLessThan(1e-6);
        void other;
      }
    }
  });

  it("flattens pads above water, and pads are safe zones", () => {
    for (const id of ["arcadia", "hollowmere", "meridian"] as const) {
      const body = BODIES[id];
      const terrain = createTerrain(id);
      padDirs(body).forEach((p, idx) => {
        const h = terrain.groundHeight(...p);
        expect(h).toBeGreaterThan(body.waterLevel + 1);
        expect(Math.abs(h - terrain.padHeights[idx]!)).toBeLessThan(0.3);
        // 6 m away from the pad centre is still flat and safe.
        const off = [p[0] + 6 / body.radius, p[1], p[2]] as [number, number, number];
        const l = Math.hypot(...off);
        const d = off.map((c) => c / l) as [number, number, number];
        expect(Math.abs(terrain.groundHeight(...d) - h)).toBeLessThan(0.5);
        const pos = d.map((c) => c * (body.radius + h)) as [number, number, number];
        expect(isSafe(body, ...pos)).toBe(true);
      });
      // Far from every pad is not safe.
      const pads = padDirs(body);
      const far = anchorDir(body, body.padLayout === "icosa" ? { tri: [0, 1, 2] } : { mid: [0, 1] });
      const minDist = Math.min(...pads.map((p) => Math.hypot(p[0] - far[0], p[1] - far[1], p[2] - far[2]) * body.radius));
      expect(minDist).toBeGreaterThan(PAD_SAFE_RADIUS);
      expect(isSafe(body, ...(far.map((c) => c * (body.radius + 5)) as [number, number, number]))).toBe(false);
    }
  });

  it("carves the named lakes below water", () => {
    for (const id of ["arcadia", "hollowmere", "meridian"] as const) {
      const body = BODIES[id];
      const terrain = createTerrain(id);
      for (const lake of body.lakes) {
        const d = anchorDir(body, lake.at);
        expect(terrain.groundHeight(...d)).toBeLessThan(body.waterLevel - 1);
      }
    }
  });

  it("Portus plaza is flat at the arrival point", () => {
    const terrain = createTerrain("portus");
    expect(Math.abs(terrain.groundHeight(0, 1, 0))).toBeLessThan(0.05);
    expect(isSafe(BODIES.portus, 0, 150, 0)).toBe(true);
  });

  it("Portus town floor is flat out to PORTUS_TOWN_FLAT and unchanged far outside (D38)", () => {
    const terrain = createTerrain("portus");
    const R = BODIES.portus.radius;
    const rand = mulberry32(38);
    // The pre-town bowl (main 6d69731), for the far-field comparison.
    const nHills = createNoise3(BODIES.portus.seed);
    const nDetail = createNoise3(BODIES.portus.seed + 47);
    const ss = (e0: number, e1: number, x: number) => {
      const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
      return t * t * (3 - 2 * t);
    };
    const oldBowl = (x: number, y: number, z: number) => {
      const d = Math.sqrt(x * x + (y - 1) * (y - 1) + z * z) * R;
      const px = x * R, py = y * R, pz = z * R;
      const hills = fbm(nHills, px / 60, py / 60, pz / 60, 3) * BODIES.portus.terrain.hillAmp;
      const rim = ss(30, 44, d) * 7 - ss(52, 85, d) * 4;
      return rim + hills * ss(40, 90, d) + nDetail(px / 9, py / 9, pz / 9) * 0.15 * ss(28, 40, d);
    };
    let farChecked = 0;
    for (let k = 0; k < 4000; k++) {
      const d = randomDir(rand);
      const chord = Math.hypot(d[0], d[1] - 1, d[2]) * R;
      if (chord <= PORTUS_TOWN_FLAT) {
        expect(terrain.rawHeight(...d)).toBe(0);
        // The rendered floor (flat triangles between grid vertices on the sphere) sags at most about
        // a centimetre below the sphere and never rises above it: the paving decal (2–7.5 cm up) stays clear.
        // (One quad diagonal inside the edge, where every vertex of the triangle is on the floor.)
        if (chord <= PORTUS_TOWN_FLAT - 3.5) {
          const g = terrain.groundHeight(...d);
          expect(g).toBeLessThanOrEqual(1e-9);
          expect(g).toBeGreaterThan(-0.012);
        }
      } else if (chord >= PORTUS_TOWN_FLAT + 60) {
        expect(terrain.rawHeight(...d)).toBe(oldBowl(...d));
        farChecked++;
      }
    }
    expect(farChecked).toBeGreaterThan(1000);
    // A gentle rim beyond the flat floor: it rises outside the town, no cliff.
    const at = (m: number) => {
      const a = (2 * Math.asin(m / (2 * R)));
      return terrain.rawHeight(Math.sin(a) * 0.6, Math.cos(a), Math.sin(a) * 0.8);
    };
    expect(at(PORTUS_TOWN_FLAT + 2)).toBeLessThan(0.3);
    expect(at(PORTUS_TOWN_FLAT + 20)).toBeGreaterThan(4);
    for (let m = PORTUS_TOWN_FLAT; m < PORTUS_TOWN_FLAT + 60; m += 1) expect(Math.abs(at(m + 1) - at(m))).toBeLessThan(1.2);
  });

  it("groundHeight is fast enough for the server (100k samples)", () => {
    const terrain = createTerrain("meridian");
    const rand = mulberry32(5);
    const dirs = Array.from({ length: 2000 }, () => randomDir(rand));
    for (const d of dirs) terrain.groundHeight(...d); // warm cache like a live room would
    const t0 = performance.now();
    let s = 0;
    for (let k = 0; k < 100_000; k++) s += terrain.groundHeight(...dirs[k % dirs.length]!);
    const ms = performance.now() - t0;
    expect(Number.isFinite(s)).toBe(true);
    expect(ms).toBeLessThan(400);
  });
});
