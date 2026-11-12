// Bones with nothing drawable below them are skipped by three's per-pass scene walk (#49, D-framerate-2).

import { describe, expect, it } from "vitest";
import * as THREE from "three/webgpu";
import { hideBareBones } from "./bareBones.ts";

/** hips → spine → arm → hand (→ socket), hips → leg → foot; the skinned mesh beside the bones. */
function rig() {
  const model = new THREE.Group();
  const hips = new THREE.Bone(), spine = new THREE.Bone(), arm = new THREE.Bone(), hand = new THREE.Bone();
  const leg = new THREE.Bone(), foot = new THREE.Bone();
  hips.add(spine, leg);
  spine.add(arm);
  arm.add(hand);
  leg.add(foot);
  const socket = new THREE.Object3D();
  hand.add(socket);
  const mesh = new THREE.SkinnedMesh(new THREE.BufferGeometry(), new THREE.MeshBasicNodeMaterial());
  model.add(hips, mesh);
  return { model, hips, spine, arm, hand, leg, foot, socket, mesh };
}

describe("hideBareBones", () => {
  it("hides the bones with no socket or mesh below them and keeps the way to each socket", () => {
    const r = rig();
    expect(hideBareBones(r.model)).toBe(2);
    expect([r.leg.visible, r.foot.visible]).toEqual([false, false]);
    expect([r.hips.visible, r.spine.visible, r.arm.visible, r.hand.visible, r.socket.visible, r.mesh.visible]).toEqual([true, true, true, true, true, true]);
  });

  it("a hidden bone still moves what it drives: its world matrix keeps updating", () => {
    const r = rig();
    hideBareBones(r.model);
    r.leg.position.set(0, 2, 0);
    r.model.updateMatrixWorld();
    expect(r.foot.matrixWorld.elements[13]).toBe(2);
  });

  it("three's render walk skips the hidden ones and still reaches what hangs from a socket", () => {
    const r = rig();
    const sword = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicNodeMaterial());
    r.socket.add(sword); // a weapon put in hand after the model was built
    hideBareBones(r.model);
    const seen: THREE.Object3D[] = [];
    const walk = (o: THREE.Object3D) => {
      if (!o.visible) return; // as Renderer._projectObject
      seen.push(o);
      for (const c of o.children) walk(c);
    };
    walk(r.model);
    expect(seen).toContain(sword);
    expect(seen).toContain(r.mesh);
    expect(seen).not.toContain(r.foot);
  });
});
