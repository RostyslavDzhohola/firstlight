// Loot piles as "digital matter": a slowly turning cluster of glowing cubes with a faint beam,
// sized by how much it holds. Reads room.state.piles (view-filtered by distance).

import * as THREE from "three/webgpu";
import { releaseObjects } from "../render/dispose.ts";

const cubeGeo = new THREE.BoxGeometry(0.28, 0.28, 0.28);
const beamGeo = new THREE.CylinderGeometry(0.12, 0.35, 6, 8, 1, true);
beamGeo.translate(0, 3, 0);
const cubeMat = new THREE.MeshBasicNodeMaterial({ color: new THREE.Color(0xffd166).multiplyScalar(3) });
const cubeMat2 = new THREE.MeshBasicNodeMaterial({ color: new THREE.Color(0x36f9f6).multiplyScalar(3) });
const beamMat = new THREE.MeshBasicNodeMaterial({ color: new THREE.Color(0xffd8a8).multiplyScalar(1.4), transparent: true, opacity: 0.22, depthWrite: false });

interface PileView {
  group: THREE.Group;
  spin: THREE.Group;
  items: number;
}

/** A pile's meshes share the module geometry/materials: dropping one frees only its render state. */
function drop(v: PileView) {
  v.group.removeFromParent();
  releaseObjects(v.group);
}

export class PilesView {
  private readonly views = new Map<string, PileView>();
  private readonly seen = new Set<string>();
  private t = 0;

  constructor(private readonly scene: THREE.Scene) {}

  update(state: any, dt: number) {
    this.t += dt;
    const seen = this.seen;
    seen.clear();
    state?.piles?.forEach((p: any, id: string) => {
      seen.add(id);
      let v = this.views.get(id);
      if (!v || v.items !== p.items) {
        if (v) drop(v);
        v = this.build(p);
        this.views.set(id, v);
      }
    });
    for (const [id, v] of this.views) {
      if (!seen.has(id)) {
        drop(v);
        this.views.delete(id);
      } else {
        v.spin.rotation.y = this.t * 0.8;
        v.spin.position.y = 0.6 + Math.sin(this.t * 2 + v.items) * 0.12;
      }
    }
  }

  private build(p: any): PileView {
    const group = new THREE.Group();
    const pos = new THREE.Vector3(p.x, p.y, p.z);
    const up = pos.clone().normalize();
    const ref = Math.abs(up.z) < 0.9 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, 0, 0);
    const fwd = ref.addScaledVector(up, -ref.dot(up)).normalize();
    const right = new THREE.Vector3().crossVectors(fwd, up);
    group.position.copy(pos);
    group.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(right, up, fwd));
    const spin = new THREE.Group();
    const n = Math.max(4, Math.min(18, 4 + (p.items ?? 0) * 2 + (p.coins > 0 ? 3 : 0)));
    for (let i = 0; i < n; i++) {
      const c = new THREE.Mesh(cubeGeo, i % 3 === 0 ? cubeMat2 : cubeMat);
      const a = (i / n) * Math.PI * 2;
      const r = 0.25 + (i % 3) * 0.18;
      c.position.set(Math.cos(a) * r, (i % 4) * 0.16, Math.sin(a) * r);
      c.rotation.set(i, i * 1.7, i * 0.3);
      spin.add(c);
    }
    group.add(spin, new THREE.Mesh(beamGeo, beamMat));
    this.scene.add(group);
    return { group, spin, items: p.items };
  }

  dispose() {
    for (const v of this.views.values()) drop(v);
    this.views.clear();
  }
}
