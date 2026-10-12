import { describe, expect, it } from "vitest";
import { BODY_IDS, PROP_KINDS } from "@firstlight/shared";
import { vegetationModels } from "./vegetationModels.ts";
import { vegetationMaterial } from "./vegetationAssets.ts";
import { testVegetationAssets, vegetationBytes, vegetationDocument } from "./vegetationAsset.testutil.ts";
import * as THREE from "three/webgpu";
import { emptyStored, resolveSettings } from "./quality.ts";
import { PropSystem } from "./props.ts";
import { lookKey } from "./warmupLooks.testutil.ts";

describe("shipped vegetation", () => {
  it("stays under 4 MB, uses two embedded cutout PNG atlases and meshopt compression", () => {
    expect(vegetationBytes.length).toBeLessThanOrEqual(4_000_000);
    expect(vegetationDocument.extensionsRequired).toContain("EXT_meshopt_compression");
    expect(vegetationDocument.images).toHaveLength(2);
    expect(vegetationDocument.images[0].mimeType).toBe("image/png");
    expect(vegetationDocument.images[0].uri).toBeUndefined();
    expect(vegetationDocument.materials).toHaveLength(2);
    expect(vegetationDocument.materials[0].alphaMode).toBe("MASK");
  });

  it("ships both normalized LODs for every mapped model, within triangle budgets", async () => {
    const assets = await testVegetationAssets();
    for (const body of BODY_IDS) for (const kind of PROP_KINDS) for (const model of vegetationModels(body, kind)) {
      if (!model) continue;
      for (const lod of [0, 1]) {
        const geo = assets.geometry.get(`${model}_L${lod}`)!;
        expect(geo, `${model} L${lod}`).toBeTruthy();
        geo.computeBoundingBox();
        const tree = /Tree|Pine/.test(model);
        // Crossed cards include transparent padding below the painted root.
        if (lod === 0 || !tree) expect(Math.abs(geo.boundingBox!.min.y), model).toBeLessThan(0.12);
        else expect(geo.index!.count / 3, model).toBe(4);
        expect(geo.boundingBox!.max.y, model).toBeGreaterThan(0.2);
        const triangles = geo.index!.count / 3;
        expect(triangles, `${model} L${lod}`).toBeLessThanOrEqual(lod === 0 ? 900 : 96);
        expect(geo.getAttribute("color")).toBeTruthy();
        expect(geo.getAttribute("uv")).toBeTruthy();
      }
    }
    expect(assets.geometry.get("CommonTree_1_L0")!.boundingBox!.max.y).toBeCloseTo(6.2, 1);
    expect(assets.geometry.get("Pine_1_L0")!.boundingBox!.max.y).toBeCloseTo(8.2, 1);
    const leaf = assets.geometry.get("CommonTree_1_L0")!.getAttribute("color");
    const roles = new Set(Array.from({ length: leaf.count }, (_, i) => [leaf.getX(i), leaf.getY(i), leaf.getZ(i)].map(Math.round).join("")));
    expect(roles.has("100")).toBe(true);
    expect(roles.has("010")).toBe(true);
  });

  it("uses opaque double-sided cutouts and retains matching instanced warm-up samples", async () => {
    const assets = await testVegetationAssets();
    const sys = new PropSystem("arcadia", assets);
    await sys.ready;
    sys.setForceAll(true);
    const live = sys.group.children.filter((o) => o.type === "Mesh") as import("three/webgpu").InstancedMesh[];
    const samples = sys.group.children.find((o) => o.name === "vegetation:arcadia")!;
    expect(samples.children).toHaveLength(live.length);
    for (let i = 0; i < live.length; i++) {
      const sample = samples.children[i] as import("three/webgpu").InstancedMesh;
      expect(lookKey(sample)).toBe(lookKey(live[i]!));
      expect(sample.instanceMatrix.count).toBe(live[i]!.instanceMatrix.count);
      expect(sample.receiveShadow).toBe(true);
      const mat = vegetationMaterial("arcadia", "oak", assets.atlas);
      expect(mat.transparent).toBe(false);
      expect(mat.alphaTest).toBe(0.5);
      expect(mat.opacityNode).toBeTruthy();
      expect(mat.positionNode).toBeTruthy();
    }
    sys.setForceAll(false);
    expect(samples.parent).toBeNull();
    sys.dispose();
  });
  it("keeps the yaw wind phase through LOD and tier changes, with shadows only on LOD0", async () => {
    const sys = new PropSystem("arcadia", await testVegetationAssets());
    await sys.ready;
    const settings = resolveSettings("medium", false, true, emptyStored(), new Set());
    sys.applySettings(settings);
    sys.addChunk("test", new Float32Array([0, 0, 1000, 0, 1, 1.25]), new THREE.Vector3(0, 1000, 0), 1);
    sys.update(new THREE.Vector3(0, 1010, 0), 1000);
    const near = (sys.group.children as THREE.InstancedMesh[]).find((m) => m.count === 1)!;
    expect(near.name.endsWith("L0")).toBe(true);
    expect(near.castShadow).toBe(true);
    const phase = near.geometry.getAttribute("iWind").getX(0);
    expect(phase).toBe(21.25);
    sys.applySettings(resolveSettings("low", false, false, emptyStored(), new Set()));
    sys.update(new THREE.Vector3(0, 1040, 0), 2000);
    const far = (sys.group.children as THREE.InstancedMesh[]).find((m) => m.count === 1)!;
    expect(far.name.endsWith("L1")).toBe(true);
    expect(far.geometry.getAttribute("iWind").getX(0)).toBe(phase);
    expect(far.castShadow).toBe(false);
    sys.dispose();
  });

});
