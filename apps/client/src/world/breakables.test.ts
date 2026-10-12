// CPU-side checks of the breakable props (no GPU): the procedural meshes are closed (three-piñata
// needs manifold input), pre-fracture gives 8–12 pieces (fewer on Low) with flagged inner faces,
// deterministically per seed; the debris pool falls onto the terrain, settles, respects its budget
// and fades out.

import { describe, expect, it } from "vitest";
import * as THREE from "three/webgpu";
import { archetypeDef, BREAKABLE_ARCHETYPES, createTerrain, PLANET_IDS, type Breakable } from "@firstlight/shared";
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
  });

  it("is deterministic: every client builds the same pieces for a variant", () => {
    const again = buildBreakableAssets("hollowmere", { quality: 0 });
    const first = get("hollowmere", 0);
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
  });
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

  it("pieces fly, land on the terrain, settle, and fade out after ~10 s", () => {
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

  it("never exceeds its budget: the oldest pieces despawn early", () => {
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
