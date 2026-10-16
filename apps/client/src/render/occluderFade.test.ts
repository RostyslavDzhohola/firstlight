import { describe, expect, it } from "vitest";
import * as THREE from "three/webgpu";
import { bool } from "three/tsl";
import { applyOccluderFade, FADE_AIM_RADIUS, FADE_CHEST, FADE_CORE, FADE_RADIUS, fadeParams, occluderKeep, occluderUniforms, updateOccluderFade } from "./occluderFade.ts";

describe("fadeParams", () => {
  it("clears a cone the player's size at the player's distance, softer at its rim", () => {
    for (const d of [2.5, 4.6, 9]) {
      const p = fadeParams(d);
      // The cone's outer half-angle covers FADE_RADIUS metres at the chest's distance.
      expect(Math.tan(Math.acos(p.cosOuter)) * d).toBeCloseTo(FADE_RADIUS, 6);
      expect(Math.acos(p.cosInner)).toBeCloseTo(Math.acos(p.cosOuter) * FADE_CORE, 6);
      expect(Math.tan(Math.acos(p.cosAimOuter)) * d).toBeCloseTo(FADE_AIM_RADIUS, 6);
      expect(p.cosInner).toBeGreaterThan(p.cosOuter); // smoothstep(outer, inner) rises inward
      expect(p.depth).toBe(d);
    }
    // A camera pulled in close gets a wider cone (the player fills more of the screen).
    expect(Math.acos(fadeParams(2.5).cosOuter)).toBeGreaterThan(Math.acos(fadeParams(4.6).cosOuter));
  });
});

describe("updateOccluderFade", () => {
  it("aims at the chest above the feet along the local up, from the camera, and switches off when inactive", () => {
    const feet = new THREE.Vector3(0, 500, 0);
    const camera = new THREE.PerspectiveCamera();
    camera.position.set(0, 501.9, -4.6);
    camera.lookAt(0, 501.9, 10);
    camera.updateMatrixWorld();
    updateOccluderFade(camera, feet, true);
    expect(occluderUniforms.target.value.toArray()).toEqual([0, 500 + FADE_CHEST, 0]);
    expect(occluderUniforms.depth.value).toBeCloseTo(Math.hypot(0.9, 4.6), 6);
    expect(occluderUniforms.aim.value.z).toBeCloseTo(1, 6);
    expect(occluderUniforms.strength.value).toBe(1);
    updateOccluderFade(camera, feet, false);
    expect(occluderUniforms.strength.value).toBe(0);
    updateOccluderFade(camera, null, true);
    expect(occluderUniforms.strength.value).toBe(0);
  });
});

describe("applyOccluderFade", () => {
  it("dissolves the main pass only: shadows keep the full shape", () => {
    const m = applyOccluderFade(new THREE.MeshStandardNodeMaterial());
    expect(m.maskNode).toBe(occluderKeep());
    expect(m.maskShadowNode).toBeTruthy();
    expect(m.maskShadowNode).not.toBe(occluderKeep());
  });

  it("keeps a material's own mask in both passes", () => {
    const own = bool(true) as unknown as THREE.Node;
    const m = new THREE.MeshStandardNodeMaterial();
    m.maskNode = own;
    applyOccluderFade(m);
    expect(m.maskShadowNode).toBe(own);
    expect(m.maskNode).not.toBe(own);
    expect(m.maskNode).not.toBe(occluderKeep());
  });

  it("is one shared node: every fading material gets the same mask (no per-material uniforms)", () => {
    const a = applyOccluderFade(new THREE.MeshStandardNodeMaterial());
    const b = applyOccluderFade(new THREE.MeshLambertNodeMaterial());
    expect(a.maskNode).toBe(b.maskNode);
  });
});
