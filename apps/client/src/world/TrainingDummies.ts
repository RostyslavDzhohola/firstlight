// The three onboarding training dummies in Portus (positions from shared/content/onboarding.ts, so
// they stand exactly where the server tests hits). Placeholder geometry in the quests-lane style:
// a post, a burlap body with a crossbar, a head and a glowing target. Hits wobble a dummy on a
// spring; one you knocked down leans back and its target turns photon blue (your progress only).

import * as THREE from "three/webgpu";
import type { Terrain } from "@firstlight/shared";
import { dummyPos, TRAINING_DUMMIES } from "@firstlight/shared/content/onboarding";

const DOWN_ANGLE = 1.2; // radians leaned back once knocked down
const SPRING = 90;
const DAMP = 7;

const TARGET = 0xff8a3d;
const TARGET_DOWN = 0x7ad8ff;

interface Dummy {
  root: THREE.Group;
  pivot: THREE.Group;
  /** Own target material: knocking down recolours it (a uniform change, no new shader to compile). */
  target: THREE.MeshStandardNodeMaterial;
  pos: THREE.Vector3;
  angle: number;
  vel: number;
  down: boolean;
}

export class TrainingDummies {
  readonly group = new THREE.Group();
  readonly dummies: Dummy[] = [];
  private readonly geos: THREE.BufferGeometry[] = [];
  private readonly mats: THREE.Material[] = [];

  constructor(scene: THREE.Scene, terrain: Terrain) {
    this.group.name = "trainingDummies";
    const mat = (color: number, rough = 0.8, emissive = 0) => {
      const m = new THREE.MeshStandardNodeMaterial({ color, roughness: rough, metalness: 0.02 });
      if (emissive) {
        m.emissive = new THREE.Color(color);
        m.emissiveIntensity = emissive;
      }
      this.mats.push(m);
      return m;
    };
    const geo = <T extends THREE.BufferGeometry>(g: T): T => {
      this.geos.push(g);
      return g;
    };
    const wood = mat(0x7a5536);
    const burlap = mat(0xc9a46a, 0.95);
    const rope = mat(0x8a6a3e, 0.9);
    const base = mat(0x3a3a40, 0.7);
    const gBase = geo(new THREE.CylinderGeometry(0.42, 0.48, 0.12, 14));
    const gPost = geo(new THREE.CylinderGeometry(0.07, 0.08, 1.1, 8));
    const gBody = geo(new THREE.CylinderGeometry(0.3, 0.34, 0.75, 12));
    const gArm = geo(new THREE.BoxGeometry(1.15, 0.11, 0.11));
    const gHead = geo(new THREE.SphereGeometry(0.22, 12, 10));
    const gBand = geo(new THREE.TorusGeometry(0.31, 0.025, 6, 18));
    const gRing = geo(new THREE.TorusGeometry(0.16, 0.035, 8, 20));
    const gDot = geo(new THREE.CircleGeometry(0.06, 12));

    TRAINING_DUMMIES.forEach((_, i) => {
      const p = dummyPos(i, (x, y, z) => terrain.groundHeight(x, y, z));
      const pos = new THREE.Vector3(p[0], p[1], p[2]);
      const root = new THREE.Group();
      root.position.copy(pos);
      // Face the plaza centre (Portus arrival point at +Y).
      const up = pos.clone().normalize();
      const toward = new THREE.Vector3(0, 1, 0).multiplyScalar(pos.length()).sub(pos);
      toward.addScaledVector(up, -toward.dot(up)).normalize();
      const right = new THREE.Vector3().crossVectors(up, toward).normalize();
      root.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(right, up, toward));
      const pivot = new THREE.Group(); // tips around its base (local x axis)
      root.add(this.mesh(gBase, base, 0, 0.06, 0), pivot);
      pivot.add(
        this.mesh(gPost, wood, 0, 0.62, 0),
        this.mesh(gBody, burlap, 0, 1.3, 0),
        this.mesh(gArm, wood, 0, 1.52, 0),
        this.mesh(gHead, burlap, 0, 1.9, 0),
      );
      for (const y of [1.05, 1.55]) {
        const band = this.mesh(gBand, rope, 0, y, 0);
        band.rotation.x = Math.PI / 2;
        pivot.add(band);
      }
      const target = mat(TARGET, 0.5, 1.6);
      pivot.add(this.mesh(gRing, target, 0, 1.32, 0.33), this.mesh(gDot, target, 0, 1.32, 0.345));
      this.group.add(root);
      this.dummies.push({ root, pivot, target, pos, angle: 0, vel: 0, down: false });
    });
    scene.add(this.group);
  }

  private mesh(g: THREE.BufferGeometry, m: THREE.Material, x: number, y: number, z: number): THREE.Mesh {
    const mesh = new THREE.Mesh(g, m);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    return mesh;
  }

  /** A hit: knock the dummy back on its spring. */
  hit(i: number) {
    const d = this.dummies[i];
    if (d) d.vel -= 4.5;
  }

  /** Lean back (knocked down by you) or stand up again. */
  setDown(i: number, down: boolean) {
    const d = this.dummies[i];
    if (!d || d.down === down) return;
    d.down = down;
    d.target.color.setHex(down ? TARGET_DOWN : TARGET);
    d.target.emissive.setHex(down ? TARGET_DOWN : TARGET);
  }

  /** Chest position of dummy `i` (for the callout and effects). */
  chest(i: number, out = new THREE.Vector3()): THREE.Vector3 {
    const d = this.dummies[i]!;
    return out.copy(d.pos).addScaledVector(d.pos.clone().normalize(), 1.35);
  }

  update(dt: number) {
    for (const d of this.dummies) {
      const rest = d.down ? -DOWN_ANGLE : 0;
      d.vel += (-SPRING * (d.angle - rest) - DAMP * d.vel) * dt;
      d.angle += d.vel * dt;
      d.pivot.rotation.x = d.angle;
    }
  }

  dispose() {
    this.group.removeFromParent();
    for (const g of this.geos) g.dispose();
    for (const m of this.mats) m.dispose();
  }
}
