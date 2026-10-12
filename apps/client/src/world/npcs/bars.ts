// Health bars over NPCs being fought: two camera-facing instanced quads (background + fill).

import * as THREE from "three/webgpu";

const CAP = 96;

export class HealthBars {
  readonly group = new THREE.Group();
  private readonly bg: THREE.InstancedMesh;
  private readonly fill: THREE.InstancedMesh;
  private readonly geo = new THREE.PlaneGeometry(1, 1);
  private readonly mats: THREE.MeshBasicNodeMaterial[];
  private n = 0;
  private readonly m = new THREE.Matrix4();
  private readonly p = new THREE.Vector3();
  private readonly s = new THREE.Vector3();
  private readonly right = new THREE.Vector3();
  private readonly c = new THREE.Color();

  constructor() {
    const bgMat = new THREE.MeshBasicNodeMaterial({ color: 0xffffff, transparent: true, opacity: 0.75, depthTest: false, depthWrite: false });
    const fillMat = new THREE.MeshBasicNodeMaterial({ color: 0xffffff, depthTest: false, depthWrite: false, transparent: true });
    this.mats = [bgMat, fillMat];
    this.bg = new THREE.InstancedMesh(this.geo, bgMat, CAP);
    this.fill = new THREE.InstancedMesh(this.geo, fillMat, CAP);
    for (const mesh of [this.bg, this.fill]) {
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(CAP * 3), 3);
      mesh.frustumCulled = false;
      mesh.count = 0;
      mesh.visible = false;
      this.group.add(mesh);
    }
    this.bg.renderOrder = 20;
    this.fill.renderOrder = 21;
  }

  begin() {
    this.n = 0;
  }

  /** A bar at `pos` (planet space), width scaled with distance so it stays readable. */
  push(pos: THREE.Vector3, frac: number, camera: THREE.Camera, width: number, hostile: boolean, shield = 0) {
    if (this.n >= CAP) return;
    const i = this.n++;
    const q = camera.quaternion;
    this.right.set(1, 0, 0).applyQuaternion(q);
    const h = width * 0.11;
    this.s.set(width + 0.06, h + 0.05, 1);
    this.m.compose(pos, q, this.s);
    this.m.toArray(this.bg.instanceMatrix.array as Float32Array, i * 16);
    this.c.setRGB(0.04, 0.04, 0.05);
    this.c.toArray(this.bg.instanceColor!.array as Float32Array, i * 3);
    const f = Math.max(0, Math.min(1, frac));
    this.p.copy(pos).addScaledVector(this.right, (-width * (1 - f)) / 2);
    this.s.set(Math.max(0.001, width * f), h, 1);
    this.m.compose(this.p, q, this.s);
    this.m.toArray(this.fill.instanceMatrix.array as Float32Array, i * 16);
    if (shield > 0) this.c.setRGB(0.4, 0.9, 1.2);
    else if (hostile) this.c.setRGB(1.25, 0.18 + 0.5 * f, 0.12);
    else this.c.setRGB(0.9, 0.85, 0.4);
    this.c.toArray(this.fill.instanceColor!.array as Float32Array, i * 3);
  }

  end() {
    for (const mesh of [this.bg, this.fill]) {
      mesh.count = this.n;
      mesh.visible = this.n > 0;
      if (this.n) {
        mesh.instanceMatrix.needsUpdate = true;
        mesh.instanceColor!.needsUpdate = true;
      }
    }
  }

  dispose() {
    this.group.removeFromParent();
    this.bg.dispose();
    this.fill.dispose();
    this.geo.dispose();
    for (const m of this.mats) m.dispose();
  }
}
