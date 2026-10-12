// CPU-side checks of the grass and prop systems on real terrain chunks (no GPU): blade counts
// match the tier budget, blades sit on the rendered ground, props split into LODs by distance.

import { describe, expect, it } from "vitest";
import * as THREE from "three/webgpu";
import { BODIES, buildChunk, chunkOf, chunkProps, createTerrain, packProps, padDirs, type Face } from "@firstlight/shared";
import { GrassSystem, type GrassChunk } from "./grass.ts";
import { PropSystem } from "./props.ts";
import { resolveSettings, type StoredGfx, type Tier } from "./quality.ts";
import { grassWeight, PALETTES } from "../world/palette.ts";

const stored: StoredGfx = { v: 1, tier: null, autoTier: null, renderScale: null, features: {} };
const settingsFor = (t: Tier) => resolveSettings(t, false, true, stored, new Set());

function chunksAround(body: "arcadia", d: readonly [number, number, number], radius: number) {
  const terrain = createTerrain(body);
  const R = BODIES[body].radius;
  const cpf = BODIES[body].chunksPerFace;
  const keys = new Map<string, [Face, number, number]>();
  const ref = Math.abs(d[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const t = new THREE.Vector3(...ref).cross(new THREE.Vector3(...d)).normalize();
  const b = new THREE.Vector3(...d).cross(t).normalize();
  for (let r = 0; r <= radius; r += 8) {
    for (let a = 0; a < 48; a++) {
      const ang = (a / 48) * Math.PI * 2;
      const p = new THREE.Vector3(...d).multiplyScalar(R).addScaledVector(t, Math.cos(ang) * r).addScaledVector(b, Math.sin(ang) * r).normalize();
      const k = chunkOf(p.x, p.y, p.z, cpf);
      keys.set(`${k.face}:${k.cx}:${k.cy}`, [k.face, k.cx, k.cy]);
    }
  }
  const pal = PALETTES[body];
  const chunks: GrassChunk[] = [];
  const props: { key: string; packed: Float32Array; center: THREE.Vector3; radius: number }[] = [];
  for (const [key, [face, cx, cy]] of keys) {
    const g = buildChunk(terrain, face, cx, cy);
    const side = 33;
    const grass = new Float32Array(side * side);
    for (let v = 0; v < side * side; v++) grass[v] = grassWeight(pal, g.heights[v]!, BODIES[body].waterLevel, g.flatness[v]!, 0);
    const mid = R + (g.minHeight + g.maxHeight) / 2;
    const center = new THREE.Vector3(...g.center).multiplyScalar(mid);
    chunks.push({ key, face, cx, cy, positions: g.positions, grass, center, radius: g.boundRadius });
    props.push({ key, packed: packProps(chunkProps(terrain, face, cx, cy)), center, radius: g.boundRadius });
  }
  return { terrain, chunks, props };
}

describe("vegetation (CPU)", () => {
  // A grassy spot near Arcadia's main pad: every sample within 30 m is 3–40 m above water.
  const R = BODIES.arcadia.radius;
  const probe = createTerrain("arcadia");
  const pad = new THREE.Vector3(...padDirs(BODIES.arcadia)[0]!);
  const tA = new THREE.Vector3(0, 1, 0).cross(pad).normalize();
  const tB = pad.clone().cross(tA).normalize();
  let spot = pad.clone();
  search: for (let r = 60; r < 400; r += 20) {
    for (let a = 0; a < 16; a++) {
      const c = pad.clone().multiplyScalar(R).addScaledVector(tA, Math.cos(a) * r).addScaledVector(tB, Math.sin(a) * r).normalize();
      let ok = true;
      for (let k = 0; k < 12 && ok; k++) {
        const q = c.clone().multiplyScalar(R).addScaledVector(tA, Math.cos(k) * 30).addScaledVector(tB, Math.sin(k) * 30).normalize();
        const h = probe.groundHeight(q.x, q.y, q.z);
        ok = h > 3 && h < 40;
      }
      if (ok) {
        spot = c;
        break search;
      }
    }
  }
  const { terrain, chunks, props } = chunksAround("arcadia", [spot.x, spot.y, spot.z], 260);
  const g = terrain.groundHeight(spot.x, spot.y, spot.z);
  const cam = spot.clone().multiplyScalar(R + g + 1.7);

  for (const tier of ["low", "medium", "high"] as const) {
    it(`grass on ${tier}: blades on the ground, count in the tier's budget`, () => {
      const s = settingsFor(tier);
      const grass = new GrassSystem(R, terrain.n);
      grass.applySettings(s);
      const t0 = performance.now();
      for (let i = 0; i < 400; i++) grass.update(cam, chunks, i * 16, 1000);
      const ms = performance.now() - t0;
      let inRadius = 0;
      let total = 0;
      for (const mesh of grass.group.children as THREE.Mesh[]) {
        const geo = mesh.geometry as THREE.InstancedBufferGeometry;
        const a = geo.getAttribute("iPos").array as Float32Array;
        for (let k = 0; k < geo.instanceCount; k++) {
          const p = new THREE.Vector3(a[k * 4]!, a[k * 4 + 1]!, a[k * 4 + 2]!);
          const l = p.length();
          const gh = terrain.groundHeight(p.x / l, p.y / l, p.z / l);
          expect(Math.abs(l - R - gh)).toBeLessThan(0.01);
          const scale = Math.floor(a[k * 4 + 3]!) / 100;
          expect(scale).toBeGreaterThan(0.3);
          expect(scale).toBeLessThan(2.1);
          total++;
          if (p.distanceTo(cam) < s.grass.radius) inRadius++;
        }
      }
      // Grassy areas reach close to the tier count; never far beyond it.
      expect(inRadius).toBeGreaterThan(s.grass.count * 0.25);
      expect(inRadius).toBeLessThan(s.grass.count * 1.3);
      expect(total).toBeLessThan(s.grass.count * 4);
      expect(ms).toBeLessThan(4000);
    });
  }

  it("props split into LOD0 near and LOD1 far, within capacity", () => {
    const s = settingsFor("medium");
    const sys = new PropSystem("arcadia");
    sys.applySettings(s);
    for (const p of props) sys.addChunk(p.key, p.packed, p.center, p.radius);
    sys.update(cam, 1000);
    let near = 0, far = 0;
    for (const m of sys.group.children as THREE.InstancedMesh[]) {
      const lod0 = m.name.endsWith("L0");
      const mat = new THREE.Matrix4();
      const pos = new THREE.Vector3();
      for (let i = 0; i < m.count; i++) {
        m.getMatrixAt(i, mat);
        pos.setFromMatrixPosition(mat);
        const d = pos.distanceTo(cam);
        if (lod0) {
          expect(d).toBeLessThan(s.props.fullTo + 0.5);
          near++;
        } else {
          expect(d).toBeGreaterThanOrEqual(s.props.fullTo - 0.5);
          expect(d).toBeLessThan(s.props.lodTo + 0.5);
          far++;
        }
      }
    }
    expect(near + far).toBe(sys.instances);
    expect(far).toBeGreaterThan(0);
  });
});
