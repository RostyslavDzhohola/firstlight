import { describe, expect, it } from "vitest";
import * as THREE from "three/webgpu";
import { BODIES, BODY_IDS, buildChunk, chunkOf, chunkProps, createTerrain, packProps, padDirs, type Face } from "@firstlight/shared";
import { testVegetationAssets } from "./vegetationAsset.testutil.ts";
import { PropSystem } from "./props.ts";
import { emptyStored, resolveSettings } from "./quality.ts";

// Real deterministic terrain, sampled at four directions per body, including the pad approach
// and the densely vegetated cube seams. Count actual compressed geometry, never the manifest.
describe("vegetation tier budgets", () => {
  for (const tier of ["low", "medium", "high", "ultra"] as const) {
    it(`${tier}: limits prop instances, triangles and draws including a shadow pass`, async () => {
      const assets = await testVegetationAssets();
      const settings = resolveSettings(tier, false, true, emptyStored(), new Set());
      const results: { body: string; instances: number; triangles: number; draws: number }[] = [];
      for (const body of BODY_IDS) {
        const terrain = createTerrain(body), R = terrain.body.radius;
        const directions = [[1, 0, 0], [0.3, 1, 0.4], [1, 1, 0.2], padDirs(BODIES[body])[0]!] as const;
        for (const d of directions) {
          const up = new THREE.Vector3(...d).normalize();
          const cam = up.clone().multiplyScalar(R + terrain.groundHeight(up.x, up.y, up.z) + 1.7);
          const right = new THREE.Vector3(0, 0, 1).cross(up).normalize();
          const fwd = up.clone().cross(right);
          const keys = new Map<string, [Face, number, number]>();
          for (let r = 0; r <= settings.props.lodTo + 60; r += 24) for (let a = 0; a < 32; a++) {
            const ang = a * Math.PI / 16;
            const p = up.clone().multiplyScalar(R).addScaledVector(right, Math.cos(ang) * r).addScaledVector(fwd, Math.sin(ang) * r).normalize();
            const k = chunkOf(p.x, p.y, p.z, terrain.body.chunksPerFace);
            keys.set(`${k.face}:${k.cx}:${k.cy}`, [k.face, k.cx, k.cy]);
          }
          const sys = new PropSystem(body, assets);
          await sys.ready;
          sys.applySettings(settings);
          for (const [key, [face, cx, cy]] of keys) {
            const g = buildChunk(terrain, face, cx, cy);
            const center = new THREE.Vector3(...g.center).multiplyScalar(R + (g.minHeight + g.maxHeight) / 2);
            sys.addChunk(key, packProps(chunkProps(terrain, face, cx, cy)), center, g.boundRadius);
          }
          sys.update(cam, 1000);
          let triangles = 0, draws = 0;
          for (const mesh of sys.group.children as THREE.InstancedMesh[]) if (mesh.count > 0) {
            const passes = mesh.castShadow ? 2 : 1;
            triangles += mesh.count * (mesh.geometry.index?.count ?? mesh.geometry.getAttribute("position").count) / 3 * passes;
            draws += passes;
          }
          results.push({ body, instances: sys.instances, triangles, draws });
          expect(sys.instances).toBeLessThanOrEqual(tier === "low" ? 500 : tier === "medium" ? 1000 : tier === "high" ? 1800 : 2500);
          expect(triangles).toBeLessThanOrEqual(tier === "low" ? 35_000 : tier === "medium" ? 120_000 : tier === "high" ? 250_000 : 400_000);
          // This is a props-only cap, not evidence of whole-scene draw/FPS compliance.
          expect(draws).toBeLessThanOrEqual(tier === "low" ? 20 : tier === "medium" ? 30 : tier === "high" ? 40 : 45);
          sys.dispose();
        }
      }
      console.info(`[vegetation budget ${tier}]`, JSON.stringify(results));
    });
  }
});
