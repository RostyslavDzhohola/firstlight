// Placeholder avatars until the Blender characters land (M7): a stylised capsule body, head,
// visor and an emissive trim in the player's palette. Oriented to local up and facing.

import * as THREE from "three/webgpu";
import { ANIM } from "@firstlight/shared/net/schema";

const PALETTE_COLORS = [0xf2efe6, 0xd8b98a, 0x2a2f45, 0x5f7a4a, 0xc0482e, 0x6a4fa0];
const TRIM_COLORS = [0x36f9f6, 0xffb86b, 0xff7edb, 0x9cff6b, 0xffd166, 0xb48cff];

const bodyGeo = new THREE.CapsuleGeometry(0.34, 0.95, 6, 12);
bodyGeo.translate(0, 0.82, 0);
const headGeo = new THREE.SphereGeometry(0.24, 16, 12);
headGeo.translate(0, 1.62, 0);
const visorGeo = new THREE.BoxGeometry(0.34, 0.09, 0.12);
visorGeo.translate(0, 1.64, 0.2);
const ringGeo = new THREE.TorusGeometry(0.36, 0.035, 6, 24);
ringGeo.rotateX(Math.PI / 2);
ringGeo.translate(0, 1.0, 0);

const mats = new Map<string, THREE.Material>();
function mat(colorHex: number, emissive = false): THREE.Material {
  const key = `${colorHex}:${emissive}`;
  let m = mats.get(key);
  if (!m) {
    const sm = new THREE.MeshStandardNodeMaterial({ color: colorHex, roughness: emissive ? 0.4 : 0.6, metalness: 0.05 });
    if (emissive) {
      sm.emissive = new THREE.Color(colorHex);
      sm.emissiveIntensity = 2.2;
    }
    m = sm;
    mats.set(key, m);
  }
  return m;
}

export class AvatarView {
  readonly root = new THREE.Group();
  private readonly model = new THREE.Group();
  private readonly detailMeshes: THREE.Mesh[] = [];
  private readonly allMeshes: THREE.Mesh[] = [];
  private full = true;
  private t = Math.random() * 10;

  constructor(palette = 0, starter = 0) {
    const base = PALETTE_COLORS[palette % PALETTE_COLORS.length]!;
    const trim = TRIM_COLORS[(palette + starter) % TRIM_COLORS.length]!;
    const body = new THREE.Mesh(bodyGeo, mat(base));
    const head = new THREE.Mesh(headGeo, mat(base));
    const visor = new THREE.Mesh(visorGeo, mat(trim, true));
    const ring = new THREE.Mesh(ringGeo, mat(trim, true));
    for (const m of [body, head, visor, ring]) {
      m.castShadow = true;
      this.model.add(m);
    }
    this.allMeshes.push(body, head, visor, ring);
    this.detailMeshes.push(visor, ring);
    this.root.add(this.model);
  }

  /**
   * Full detail (all parts, casts shadows) or reduced (body + head, no shadow) for avatars beyond
   * the tier's full-detail count (SPEC §7.3 "full-detail avatars").
   */
  setDetail(full: boolean) {
    if (full === this.full) return;
    this.full = full;
    for (const m of this.detailMeshes) m.visible = full;
    for (const m of this.allMeshes) m.castShadow = full;
  }

  /** Place at a planet-space position, standing on local up, facing a tangent direction. */
  set(x: number, y: number, z: number, fx: number, fy: number, fz: number, anim: number, dt: number) {
    this.root.position.set(x, y, z);
    const up = new THREE.Vector3(x, y, z).normalize();
    const fwd = new THREE.Vector3(fx, fy, fz);
    fwd.addScaledVector(up, -fwd.dot(up));
    if (fwd.lengthSq() < 1e-6) fwd.set(1, 0, 0).addScaledVector(up, -up.x).normalize();
    fwd.normalize();
    const right = new THREE.Vector3().crossVectors(up, fwd);
    const m = new THREE.Matrix4().makeBasis(right, up, fwd);
    this.root.quaternion.setFromRotationMatrix(m);
    // Cheap procedural motion by state.
    this.t += dt * (anim === ANIM.SPRINT ? 14 : anim === ANIM.RUN ? 11 : anim === ANIM.WALK ? 7 : 2);
    const moving = anim === ANIM.WALK || anim === ANIM.RUN || anim === ANIM.SPRINT;
    this.model.position.y = moving ? Math.abs(Math.sin(this.t)) * 0.08 : Math.sin(this.t) * 0.01;
    this.model.rotation.x = anim === ANIM.SPRINT ? 0.18 : anim === ANIM.RUN ? 0.1 : 0;
    this.model.rotation.z = anim === ANIM.DODGE ? Math.sin(this.t * 3) * 0.6 : 0;
    this.model.scale.y = anim === ANIM.SWIM ? 0.6 : 1;
  }

  dispose() {
    this.root.removeFromParent();
  }
}
