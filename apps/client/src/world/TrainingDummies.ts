// The three onboarding training dummies in Portus (positions from shared/content/onboarding.ts, so
// they stand exactly where the server tests hits). Straw dummies on posts with outstretched arms and
// a big red-and-white bullseye on the chest, under one floating "Training dummies" label, so they read
// as dummies from across the plaza (#68). Hits wobble a dummy on a spring; one you knocked down leans
// back and its bullseye turns photon blue (your progress only).

import * as THREE from "three/webgpu";
import type { Terrain } from "@firstlight/shared";
import { dummyPos, TRAINING_DUMMIES } from "@firstlight/shared/content/onboarding";
import { stepsFor } from "../game/frameClock.ts";
import { makeLabel } from "./Portals.ts";

const DOWN_ANGLE = 1.2; // radians leaned back once knocked down
const SPRING = 90;
const DAMP = 7;

const TARGET = 0xe8362b;
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
  private readonly textures: THREE.Texture[] = [];

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
    const burlap = mat(0xe2bd76, 0.95);
    const straw = mat(0xf0d27a, 1);
    const rope = mat(0x8a6a3e, 0.9);
    const base = mat(0x3a3a40, 0.7);
    const white = mat(0xf4efe4, 0.6, 0.35);
    const gBase = geo(new THREE.CylinderGeometry(0.42, 0.48, 0.12, 14));
    const gPost = geo(new THREE.CylinderGeometry(0.07, 0.08, 1.1, 8));
    const gBody = geo(new THREE.CylinderGeometry(0.3, 0.34, 0.75, 12));
    const gArm = geo(new THREE.BoxGeometry(1.5, 0.12, 0.12));
    const gTuft = geo(new THREE.ConeGeometry(0.1, 0.26, 7));
    const gHead = geo(new THREE.SphereGeometry(0.24, 12, 10));
    const gBand = geo(new THREE.TorusGeometry(0.31, 0.025, 6, 18));
    // The bullseye: white and red discs stacked a hair apart, the widest at the back.
    const rings = [0.3, 0.22, 0.14, 0.06].map((r) => geo(new THREE.CircleGeometry(r, 20)));

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
        this.mesh(gHead, burlap, 0, 1.92, 0),
      );
      for (const side of [-1, 1]) {
        const tuft = this.mesh(gTuft, straw, side * 0.83, 1.52, 0);
        tuft.rotation.z = (side * -Math.PI) / 2; // straw sticking out of the sleeve
        pivot.add(tuft);
      }
      for (const y of [1.05, 1.55]) {
        const band = this.mesh(gBand, rope, 0, y, 0);
        band.rotation.x = Math.PI / 2;
        pivot.add(band);
      }
      const target = mat(TARGET, 0.5, 1.2);
      rings.forEach((g, k) => pivot.add(this.mesh(g, k % 2 ? white : target, 0, 1.3, 0.345 + k * 0.004)));
      this.group.add(root);
      this.dummies.push({ root, pivot, target, pos, angle: 0, vel: 0, down: false });
    });
    // One label over the middle dummy, like the portals' names: readable from across the plaza.
    const mid = this.dummies[Math.floor(this.dummies.length / 2)];
    if (mid && typeof document !== "undefined") {
      const label = makeLabel("Training dummies", TARGET);
      label.scale.set(4.2, 0.77, 1);
      label.position.copy(mid.pos).addScaledVector(mid.pos.clone().normalize(), 3);
      const m = label.material as THREE.SpriteNodeMaterial;
      this.mats.push(m);
      if (m.map) this.textures.push(m.map);
      this.group.add(label);
    }
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
    // The spring is stiff: a slow frame (up to 250 ms, #33) runs as steps of at most 50 ms.
    const steps = stepsFor(dt);
    const h = dt / steps;
    for (const d of this.dummies) {
      const rest = d.down ? -DOWN_ANGLE : 0;
      for (let k = 0; k < steps; k++) {
        d.vel += (-SPRING * (d.angle - rest) - DAMP * d.vel) * h;
        d.angle += d.vel * h;
      }
      d.pivot.rotation.x = d.angle;
    }
  }

  dispose() {
    this.group.removeFromParent();
    for (const g of this.geos) g.dispose();
    for (const m of this.mats) m.dispose();
    for (const t of this.textures) t.dispose();
  }
}
