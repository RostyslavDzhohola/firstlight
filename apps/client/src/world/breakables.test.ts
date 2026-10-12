// CPU-side checks of the breakable props (no GPU): the procedural meshes are closed (three-piñata
// needs manifold input), pre-fracture gives 8–12 pieces (fewer on Low) with flagged inner faces,
// deterministically per seed; the debris pool falls onto the terrain, settles, respects its budget
// and fades out.

import { describe, expect, it } from "vitest";
import * as THREE from "three/webgpu";
import { archetypeDef, BREAKABLE_ARCHETYPES, createTerrain, distanceToBreakable, PLANET_IDS, rayBreakable, scaledCollider, type Breakable, type BodyId, type BreakableArchetype } from "@firstlight/shared";
import { Debris, DEBRIS_MAX } from "../render/debris.ts";
import { archetypeShape, buildBreakableAssets, FRACTURE_VARIANTS, type BreakableAssets } from "./breakableShapes.ts";

const assets = new Map<string, BreakableAssets>();
function get(body: (typeof PLANET_IDS)[number], quality: 0 | 1) {
  const k = `${body}:${quality}`;
  if (!assets.has(k)) assets.set(k, buildBreakableAssets(body, { quality }));
  return assets.get(k)!;
}

/** Every undirected edge of a welded triangle soup is shared by exactly two triangles. */
function isClosed(pos: ArrayLike<number>): boolean {
  const key = (i: number) => `${Math.round(pos[i * 3]! * 1e4)},${Math.round(pos[i * 3 + 1]! * 1e4)},${Math.round(pos[i * 3 + 2]! * 1e4)}`;
  const edges = new Map<string, number>();
  for (let t = 0; t < pos.length / 9; t++) {
    const k = [key(t * 3), key(t * 3 + 1), key(t * 3 + 2)];
    if (k[0] === k[1] || k[1] === k[2] || k[0] === k[2]) continue; // degenerate (cap centres)
    for (let e = 0; e < 3; e++) {
      const a = k[e]!, b = k[(e + 1) % 3]!;
      const id = a < b ? `${a}|${b}` : `${b}|${a}`;
      edges.set(id, (edges.get(id) ?? 0) + 1);
    }
  }
  for (const n of edges.values()) if (n !== 2) return false;
  return edges.size > 0;
}

type V3 = [number, number, number];

/** The intact mesh's triangles (object space, scale 1). */
function meshTris(body: BodyId, a: BreakableArchetype): Float32Array[] {
  return archetypeShape(body, a).map((p) => p.geometry.getAttribute("position").array as Float32Array);
}

/** The shared collider at scale 1, standing at the origin (x right, y up, z forward). */
function collider(body: BodyId, a: BreakableArchetype): Breakable {
  const c = scaledCollider(archetypeDef(body, a).collider, 1);
  return { px: 0, py: 0, pz: 0, rx: 1, ry: 0, rz: 0, ux: 0, uy: 1, uz: 0, fx: 0, fy: 0, fz: 1, ...c } as unknown as Breakable;
}

/** Does a ray hit any triangle (Möller–Trumbore, t > 0)? */
function rayMesh(tris: Float32Array[], o: V3, d: V3): boolean {
  for (const p of tris) {
    for (let t = 0; t < p.length; t += 9) {
      const e1x = p[t + 3]! - p[t]!, e1y = p[t + 4]! - p[t + 1]!, e1z = p[t + 5]! - p[t + 2]!;
      const e2x = p[t + 6]! - p[t]!, e2y = p[t + 7]! - p[t + 1]!, e2z = p[t + 8]! - p[t + 2]!;
      const hx = d[1] * e2z - d[2] * e2y, hy = d[2] * e2x - d[0] * e2z, hz = d[0] * e2y - d[1] * e2x;
      const det = e1x * hx + e1y * hy + e1z * hz;
      if (Math.abs(det) < 1e-12) continue;
      const f = 1 / det, sx = o[0] - p[t]!, sy = o[1] - p[t + 1]!, sz = o[2] - p[t + 2]!;
      const u = f * (sx * hx + sy * hy + sz * hz);
      if (u < 0 || u > 1) continue;
      const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
      const v = f * (d[0] * qx + d[1] * qy + d[2] * qz);
      if (v < 0 || u + v > 1) continue;
      if (f * (e2x * qx + e2y * qy + e2z * qz) > 0) return true;
    }
  }
  return false;
}

describe("breakable meshes and pre-fracture", () => {
  it("every archetype part on every planet is a closed (manifold) solid", () => {
    for (const body of PLANET_IDS) {
      for (const a of BREAKABLE_ARCHETYPES) {
        for (const part of archetypeShape(body, a)) {
          expect(isClosed(part.geometry.getAttribute("position").array), `${body} ${a}`).toBe(true);
        }
      }
    }
  });

  it("meshes fill their shared colliders (what blocks a shot is what you see)", () => {
    for (const body of PLANET_IDS) {
      for (const a of BREAKABLE_ARCHETYPES) {
        const c = collider(body, a);
        let vol = 0, reach = 0, top = 0;
        for (const p of meshTris(body, a)) {
          for (let t = 0; t < p.length; t += 9) {
            const [ax, ay, az, bx, by, bz, cx, cy, cz] = Array.from(p.subarray(t, t + 9)) as [number, number, number, number, number, number, number, number, number];
            vol += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
          }
          for (let i = 0; i < p.length; i += 3) {
            reach = Math.max(reach, Math.hypot(p[i]!, p[i + 2]!));
            top = Math.max(top, p[i + 1]!);
          }
        }
        // Collider volume by sampling (compound colliders overlap their parts).
        const N = 24, F = c.foot;
        let inside = 0;
        for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) for (let k = 0; k < N; k++) {
          const x = -F + (2 * F * (i + 0.5)) / N, y = (c.h * (j + 0.5)) / N, z = -F + (2 * F * (k + 0.5)) / N;
          if (distanceToBreakable(c, x, y, z) === 0) inside++;
        }
        const cvol = (inside / N ** 3) * 4 * F * F * c.h;
        expect(vol / cvol, `${body} ${a} volume`).toBeGreaterThan(0.5); // the rail fence was 12%, statues ~30%
        expect(reach / c.foot, `${body} ${a} width`).toBeGreaterThan(0.95);
        expect(top / c.h, `${body} ${a} height`).toBeGreaterThan(0.9);
      }
    }
  });

  it("mesh and collider agree on what a shot hits (down, front and side ray fans)", () => {
    for (const body of PLANET_IDS) {
      for (const a of BREAKABLE_ARCHETYPES) {
        const c = collider(body, a);
        const tris = meshTris(body, a);
        const N = 13, F = c.foot * 1.1;
        let agree = 0, n = 0;
        for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
          const u = -F + (2 * F * i) / (N - 1), w = -F + (2 * F * j) / (N - 1), y = c.h * (0.05 + (0.9 * j) / (N - 1));
          const rays: [V3, V3][] = [[[u, c.h + 1, w], [0, -1, 0]], [[u, y, -10], [0, 0, 1]], [[-10, y, u], [1, 0, 0]]];
          for (const [o, d] of rays) {
            n++;
            if (rayMesh(tris, o, d) === rayBreakable(c, o[0], o[1], o[2], d[0], d[1], d[2], 50) < Infinity) agree++;
          }
        }
        expect(agree / n, `${body} ${a}`).toBeGreaterThan(0.9);
      }
    }
    // The review's probes: shots down onto a statue base's corner and a pillar cap's corner.
    for (const body of PLANET_IDS) {
      for (const [a, x] of [["statue", 0.36], ["pillar", 0.32]] as const) {
        if (body === "meridian" && a === "statue") continue; // a narrower plinth: no corner there
        const o: V3 = [x, 6, x];
        expect(rayMesh(meshTris(body, a), o, [0, -1, 0]), `${body} ${a} mesh`).toBe(true);
        expect(rayBreakable(collider(body, a), o[0], o[1], o[2], 0, -1, 0, 50), `${body} ${a} collider`).toBeLessThan(Infinity);
      }
    }
  });

  it("fractures into 8–12 pieces per prop (fewer on Low), with inner faces flagged, and no fallbacks", () => {
    for (const body of PLANET_IDS) {
      const full = get(body, 0), low = get(body, 1);
      expect(full.failures).toBe(0);
      expect(low.failures).toBe(0);
      expect(full.breakables.length).toBeGreaterThan(100);
      for (const [k, variants] of Object.entries(full.fragments)) {
        const a = Number(k);
        expect(variants.length).toBe(FRACTURE_VARIANTS);
        for (let v = 0; v < variants.length; v++) {
          const pieces = variants[v]!;
          expect(pieces.length, `${body} ${BREAKABLE_ARCHETYPES[a]}`).toBeGreaterThanOrEqual(8);
          expect(pieces.length).toBeLessThanOrEqual(12);
          expect(low.fragments[a]![v]!.length).toBeLessThan(pieces.length);
          expect(low.fragments[a]![v]!.length).toBeGreaterThanOrEqual(5);
          let inner = 0;
          for (const p of pieces) {
            const n = p.positions.length / 3;
            expect(n % 3).toBe(0);
            expect(p.normals.length).toBe(n * 3);
            expect(p.colors.length).toBe(n * 3);
            expect(p.inner.length).toBe(n);
            expect(p.radius).toBeGreaterThan(0.01);
            for (let i = 0; i < n; i++) inner += p.inner[i]!;
            for (const c of p.colors) expect(c).toBeGreaterThanOrEqual(0);
            // Pieces sit inside the prop (collider bounds at scale 1, with fracture slack).
            const def = archetypeDef(body, BREAKABLE_ARCHETYPES[a]!);
            const ext = def.collider.kind === "box" ? Math.max(def.collider.hx, def.collider.hz) : def.collider.r;
            expect(Math.hypot(p.center[0], p.center[2])).toBeLessThan(ext * 1.5 + 0.3);
            expect(p.center[1]).toBeGreaterThan(-0.05);
            expect(p.center[1]).toBeLessThan(def.collider.h + 0.05);
          }
          expect(inner).toBeGreaterThan(0);
        }
        // Different seeds shatter differently.
        const sig = (v: number) => variants[v]!.map((p) => p.center.map((x) => x.toFixed(3)).join(",")).join(";");
        expect(sig(0)).not.toBe(sig(1));
      }
      // Intact meshes have no inner faces.
      for (const m of Object.values(full.intact)) {
        expect(m.inner.every((x) => x === 0)).toBe(true);
        expect(m.positions.length % 9).toBe(0);
      }
    }
  }, 60_000);

  it("is deterministic: every client builds the same pieces for a variant", () => {
    const again = buildBreakableAssets("hollowmere", { quality: 1 });
    const first = get("hollowmere", 1);
    for (const [k, variants] of Object.entries(first.fragments)) {
      variants.forEach((pieces, v) => {
        const other = again.fragments[Number(k)]![v]!;
        expect(other.length).toBe(pieces.length);
        pieces.forEach((p, i) => {
          expect(other[i]!.center).toEqual(p.center);
          expect(other[i]!.positions).toEqual(p.positions);
        });
      });
    }
  }, 60_000);
});

describe("debris pool", () => {
  const terrain = createTerrain("arcadia");
  const set = get("arcadia", 0);
  const crateArch = BREAKABLE_ARCHETYPES.indexOf("crate");

  function pool(): { debris: Debris; crates: Breakable[] } {
    const debris = new Debris(new THREE.Group(), new THREE.MeshStandardNodeMaterial());
    const sets = new Map();
    for (const [k, variants] of Object.entries(set.fragments)) variants.forEach((pieces, v) => sets.set(Number(k) * 16 + v, pieces));
    debris.install(sets);
    return { debris, crates: set.breakables.filter((b) => b.archetype === crateArch) };
  }

  it("pieces fly, land on the terrain, settle, and fade out after ~10 s", { timeout: 30_000 }, () => {
    const { debris, crates } = pool();
    const b = crates[0]!;
    const n = debris.spawn(b, b.archetype, 1, b.fx, b.fy, b.fz, 1.5, 42);
    expect(n).toBe(set.fragments[crateArch]![1]!.length);
    const R = terrain.body.radius;
    const internals = debris as unknown as { px: Float32Array; py: Float32Array; pz: Float32Array; live: Int32Array; asleep: Uint8Array };
    let minClearance = Infinity;
    for (let f = 0; f < 60 * 4; f++) {
      debris.update(1 / 60, terrain, terrain.body.waterLevel);
      for (let i = 0; i < debris.count; i++) {
        const s = internals.live[i]!;
        const x = internals.px[s]!, y = internals.py[s]!, z = internals.pz[s]!;
        const l = Math.hypot(x, y, z);
        minClearance = Math.min(minClearance, l - (R + terrain.groundHeight(x / l, y / l, z / l)));
      }
    }
    // Never below the ground; after 4 s most pieces rest near it.
    expect(minClearance).toBeGreaterThan(-1e-3);
    let asleep = 0;
    for (let i = 0; i < debris.count; i++) asleep += internals.asleep[internals.live[i]!]!;
    expect(asleep).toBeGreaterThanOrEqual(Math.floor(n * 0.6));
    for (let f = 0; f < 60 * 8; f++) debris.update(1 / 60, terrain, terrain.body.waterLevel);
    expect(debris.count).toBe(0);
  });

  it("never exceeds its budget: the oldest pieces despawn early", { timeout: 30_000 }, () => {
    const { debris, crates } = pool();
    debris.setBudget(40);
    for (let k = 0; k < 12; k++) {
      const b = crates[k % crates.length]!;
      debris.spawn(b, b.archetype, k % 3, 0, 0, 1, 1, k);
      debris.update(1 / 60, terrain, 0);
      expect(debris.count).toBeLessThanOrEqual(40);
    }
    expect(debris.count).toBeGreaterThan(30);
    debris.setBudget(DEBRIS_MAX);
    for (let k = 0; k < 40; k++) debris.spawn(crates[k % crates.length]!, crateArch, 0, 0, 0, 1, 1, k);
    expect(debris.count).toBeLessThanOrEqual(DEBRIS_MAX);
    debris.setBudget(0);
    expect(debris.count).toBe(0);
    expect(debris.spawn(crates[0]!, crateArch, 0, 0, 0, 1, 1, 1)).toBe(0);
  });
});
