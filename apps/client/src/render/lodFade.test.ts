import { describe, expect, it } from "vitest";
import * as THREE from "three/webgpu";
import { BODIES, packProps, PROP_KINDS } from "@firstlight/shared";
import { applyLodFade, LOD_SLACK, lodBand, lodBlend, lodCoverage, lodKeep, lodKeeps, lodRanges, lodShadowKeep, lodUniforms, setLodEye } from "./lodFade.ts";
import { applyOccluderFade } from "./occluderFade.ts";
import { PropSystem } from "./props.ts";
import { emptyStored, resolveSettings } from "./quality.ts";
import { testVegetationAssets } from "./vegetationAsset.testutil.ts";

describe("LOD cross-fade (#74)", () => {
  it("puts the band inside the near mesh's reach, with slack on both sides", () => {
    const b = lodBand(30); // Medium
    expect(b.nearTo).toBe(30);
    expect(b.end).toBe(30 - LOD_SLACK);
    expect(b.end - b.start).toBeCloseTo(10.5);
    expect(b.farFrom).toBeCloseTo(b.start - LOD_SLACK);
    expect(lodBand(60).end - lodBand(60).start).toBe(16); // Ultra: capped
    expect(lodBand(0)).toEqual({ start: 0, end: 0, nearTo: 0, farFrom: 0 }); // Low: far cards only
  });

  it("blends smoothly from the near mesh to the far card across the band", () => {
    const b = lodBand(40);
    expect(lodBlend(b.start - 1, b)).toBe(0);
    expect(lodBlend(b.end + 1, b)).toBe(1);
    expect(lodBlend((b.start + b.end) / 2, b)).toBeCloseTo(0.5);
    let prev = -1;
    for (let d = b.start; d <= b.end; d += 0.25) {
      const v = lodBlend(d, b);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });

  it("the two levels share every pixel exactly once at any blend", () => {
    for (const blend of [0, 0.2, 0.5, 0.93, 1])
      for (let i = 0; i < 64; i++) {
        const noise = i / 64;
        expect(Number(lodKeeps(1, noise, blend)) + Number(lodKeeps(2, noise, blend))).toBe(1);
      }
    expect(lodKeeps(0, 0.1, 0.9)).toBe(true);
  });

  it("no instance in the band is missing a level between two refreshes (hysteresis)", () => {
    // The refresh classifies instances by distance from the camera at refresh time; the camera then
    // moves up to 2 m before the next one. Every instance the shader shows partly must be in both sets.
    for (const fullTo of [30, 40, 60]) {
      const b = lodBand(fullTo);
      for (let atRefresh = 0; atRefresh < fullTo + 10; atRefresh += 0.5)
        for (const moved of [-2, -1, 0, 1, 2]) {
          const now = atRefresh + moved;
          const t = lodBlend(now, b);
          if (t < 1) expect(atRefresh < b.nearTo, `near mesh at ${atRefresh} → ${now}`).toBe(true);
          if (t > 0) expect(atRefresh >= b.farFrom, `far card at ${atRefresh} → ${now}`).toBe(true);
        }
    }
  });
});

describe("LOD cross-fade: procedural fallback and shadows (review findings 6 and 7)", () => {
  it("a kind without the dither keeps one exclusive split; a faded kind overlaps through the band", () => {
    for (const fullTo of [0, 30, 40, 60]) {
      const plain = lodRanges(fullTo, false);
      expect(plain).toEqual({ nearTo: fullTo, farFrom: fullTo }); // every distance in exactly one level
      const faded = lodRanges(fullTo, true);
      expect(faded).toEqual({ nearTo: lodBand(fullTo).nearTo, farFrom: lodBand(fullTo).farFrom });
    }
    expect(lodRanges(30, true).farFrom).toBeLessThan(30);
  });

  it("the near mesh's shadow is gone by the band's end, before the CPU stops drawing it, and fades as its colour does", () => {
    for (const fullTo of [30, 40, 60]) {
      const b = lodBand(fullTo);
      // From the band's end to fullTo the near mesh is still drawn: it must cover nothing there, shadow included.
      for (let d = b.end; d < b.nearTo; d += 0.25) expect(lodCoverage(1, d, b)).toBe(0);
      expect(lodCoverage(1, b.start, b)).toBe(1);
      let prev = 1;
      for (let d = b.start; d <= b.end; d += 0.5) {
        const c = lodCoverage(1, d, b);
        expect(c).toBeLessThanOrEqual(prev);
        expect(c + lodCoverage(2, d, b)).toBeCloseTo(1);
        prev = c;
      }
    }
  });

  it("puts the fade in the shadow mask too, after the material's own shadow mask (the occluder fade still leaves shadows whole)", () => {
    const plain = applyLodFade(new THREE.MeshStandardNodeMaterial());
    expect(plain.maskNode).toBe(lodKeep());
    expect(plain.maskShadowNode).toBe(lodShadowKeep());
    expect(lodShadowKeep()).not.toBe(lodKeep()); // measured from the view camera, not the shadow camera
    const m = applyOccluderFade(new THREE.MeshStandardNodeMaterial());
    const shadowBefore = m.maskShadowNode;
    applyLodFade(m);
    expect(m.maskShadowNode).not.toBe(shadowBefore);
    expect(m.maskShadowNode).not.toBe(m.maskNode);
  });

  it("the eye uniform follows the view camera", () => {
    setLodEye(new THREE.Vector3(1, 2, 3));
    expect(lodUniforms.eye.value.toArray()).toEqual([1, 2, 3]);
  });
});

describe("PropSystem LOD selection (finding 6)", () => {
  const R = BODIES.arcadia.radius;
  const cam = new THREE.Vector3(0, R + 1.7, 0);
  const at = [10, 20, 26, 40]; // Medium: band 17–27.5 m, near meshes to 30 m
  const packed = packProps(at.map((dx) => ({ kindIndex: PROP_KINDS.indexOf("oak"), x: dx, y: R, z: 0, scale: 1, yaw: 0.3 }) as never));
  const levels = (sys: PropSystem) => {
    const out: Record<string, number[]> = { L0: [], L1: [] };
    const mat = new THREE.Matrix4(), pos = new THREE.Vector3();
    for (const m of sys.group.children as THREE.InstancedMesh[]) {
      if (!m.name.startsWith("prop:oak:")) continue;
      for (let i = 0; i < m.count; i++) out[m.name.slice(-2)]!.push(Math.round(pos.setFromMatrixPosition((m.getMatrixAt(i, mat), mat)).distanceTo(cam)));
    }
    return { L0: out.L0!.sort((a, b) => a - b), L1: out.L1!.sort((a, b) => a - b) };
  };

  it("draws procedural props in one level only, and modelled ones in both through the band", async () => {
    const assets = await testVegetationAssets();
    const sys = new PropSystem("arcadia", assets);
    sys.applySettings(resolveSettings("medium", false, true, emptyStored(), new Set()));
    sys.addChunk("c", packed, cam.clone().setY(R), 100);
    sys.update(cam, 1000); // before the assets install: procedural material, no dither
    expect(levels(sys)).toEqual({ L0: [10, 20, 26], L1: [40] });
    await sys.ready;
    sys.update(cam, 2000);
    expect(levels(sys)).toEqual({ L0: [10, 20, 26], L1: [20, 26, 40] });
    sys.dispose();
  });
});
