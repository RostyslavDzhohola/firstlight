import { describe, expect, it } from "vitest";
import * as THREE from "three/webgpu";
import { bool } from "three/tsl";
import { applyOccluderFade, avatarChest, FADE_AIM_RADIUS, FADE_CHEST, FADE_CORE, FADE_RADIUS, fadeAmount, fadeParams, occluderKeep, occluderUniforms, updateOccluderFade } from "./occluderFade.ts";

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
  it("aims at the chest it is given, from the camera, and switches off when inactive", () => {
    const chest = new THREE.Vector3(0, 501, 0);
    const camera = new THREE.PerspectiveCamera();
    camera.position.set(0, 501.9, -4.6);
    camera.lookAt(0, 501.9, 10);
    camera.updateMatrixWorld();
    updateOccluderFade(camera, chest, true);
    expect(occluderUniforms.target.value.toArray()).toEqual([0, 501, 0]);
    expect(occluderUniforms.depth.value).toBeCloseTo(Math.hypot(0.9, 4.6), 6);
    expect(occluderUniforms.aim.value.z).toBeCloseTo(1, 6);
    expect(occluderUniforms.strength.value).toBe(1);
    updateOccluderFade(camera, chest, false);
    expect(occluderUniforms.strength.value).toBe(0);
    updateOccluderFade(camera, null, true);
    expect(occluderUniforms.strength.value).toBe(0);
  });
});

describe("avatarChest", () => {
  it("is the chest bone when the skinned model is in (in the saddle too: wherever the bone is drawn)", () => {
    const root = new THREE.Group();
    root.position.set(0, 500.8, 0); // a rider's drawn feet, ~0.8 m up in the saddle
    const bone = new THREE.Object3D();
    bone.position.set(0, 1.35, 0.05);
    root.add(bone);
    const out = avatarChest(root, bone, new THREE.Vector3());
    expect(out.y).toBeCloseTo(502.15, 6);
    expect(out.z).toBeCloseTo(0.05, 6);
  });

  it("falls back to the drawn feet + FADE_CHEST along local up (the capsule stand-in)", () => {
    const root = new THREE.Group();
    root.position.set(300, 400, 0); // planet space: local up is the radial direction
    const out = avatarChest(root, null, new THREE.Vector3());
    expect(out.x).toBeCloseTo(300 + 0.6 * FADE_CHEST, 6);
    expect(out.y).toBeCloseTo(400 + 0.8 * FADE_CHEST, 6);
  });
});

describe("fadeAmount (the shader's formula)", () => {
  const up = new THREE.Vector3(0, 1, 0);
  const at = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

  it("clears a trunk between a normal camera and the player, never what is beside or behind them", () => {
    const cam = at(0.55, 501.9, -4.6), chest = at(0, 501, 0);
    const aim = at(0.55, 501.65, 6).sub(cam).normalize();
    expect(fadeAmount(cam, aim, chest, at(0.3, 501.4, -2))).toBe(1); // a trunk halfway
    expect(fadeAmount(cam, aim, chest, at(0, 501, 0.6))).toBe(0); // just behind the player
    expect(fadeAmount(cam, aim, chest, at(1.6, 501, 0))).toBe(0); // beside
    expect(fadeAmount(cam, aim, chest, at(4, 501, -2))).toBe(0); // off to the side of the view
    void up;
  });

  it("with the camera pulled in to the head by a wall, nothing far along the aim fades (Codex review)", () => {
    // placeCamera replay: pitch 0.9 and camera reach 0.01 m: the chest is 0.64 m away, the aim points up.
    const chest = at(0, 501, 0);
    for (const [pitch, cam] of [[0.9, at(0.01, 501.64, -0.01)], [0, at(0.01, 501.64, -0.01)], [-0.3, at(0.02, 501.65, -0.05)]] as const) {
      const aim = at(0, Math.sin(pitch), Math.cos(pitch)).normalize();
      for (const d of [2, 5, 10]) expect(fadeAmount(cam, aim, chest, cam.clone().addScaledVector(aim, d))).toBe(0);
    }
  });

  it("an upward aim from a normal camera fades nothing beyond the player's distance", () => {
    const cam = at(0.55, 501.9, -4.6), chest = at(0, 501, 0);
    const aim = at(0, Math.sin(0.6), Math.cos(0.6)).normalize();
    const depth = chest.distanceTo(cam);
    for (const d of [depth + 0.2, 8, 20]) expect(fadeAmount(cam, aim, chest, cam.clone().addScaledVector(aim, d))).toBe(0);
    expect(fadeAmount(cam, aim, chest, cam.clone().addScaledVector(aim, 2))).toBe(1); // a branch right in front still clears
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
