// The waypoint in the world: a magenta light pillar rising from a ground ring at the waypoint
// (ui/waypoint.ts). Unfogged, solid at the base and wider with distance, so it reads against a
// bright sky from across the body (additive washed out in daylight).
// Built once per body and added hidden, so the warm-up compiles its two materials.

import * as THREE from "three/webgpu";
import { materialColor, materialOpacity, pow, uv } from "three/tsl";
import type { Terrain } from "@firstlight/shared";
import { atmo } from "../render/atmosphere.ts";
import { WAYPOINT_COLOUR } from "../ui/waypoint.ts";
import type { V3 } from "../social/compassMath.ts";

const PILLAR_HEIGHT = 90;
const _up = new THREE.Vector3();
const _y = new THREE.Vector3(0, 1, 0);

function glowMaterial(fade: boolean, opacity: number): THREE.MeshBasicNodeMaterial {
  const m = new THREE.MeshBasicNodeMaterial({
    color: new THREE.Color(WAYPOINT_COLOUR).multiplyScalar(1.15),
    transparent: true,
    opacity,
    depthWrite: false,
    side: THREE.DoubleSide,
    fog: false,
  });
  m.colorNode = materialColor.mul(atmo.glowBoost);
  // The pillar fades out towards its top (cylinder v runs 0 at the base to 1 at the top).
  if (fade) m.opacityNode = materialOpacity.mul(pow(uv().y.oneMinus(), 1.6));
  m.name = fade ? "waypointPillar" : "waypointRing";
  return m;
}

export class WaypointBeacon {
  readonly group = new THREE.Group();
  private readonly pillar: THREE.Mesh;
  private readonly ring: THREE.Mesh;
  private readonly base = new THREE.Vector3();

  constructor(private readonly scene: THREE.Scene, private readonly terrain: Terrain, private readonly radius: number) {
    const pg = new THREE.CylinderGeometry(1, 1, 1, 16, 1, true);
    pg.translate(0, 0.5, 0);
    this.pillar = new THREE.Mesh(pg, glowMaterial(true, 0.85));
    this.pillar.scale.set(0.8, PILLAR_HEIGHT, 0.8);
    const rg = new THREE.RingGeometry(2.1, 2.7, 40);
    rg.rotateX(-Math.PI / 2);
    this.ring = new THREE.Mesh(rg, glowMaterial(false, 0.85));
    this.ring.position.y = 0.15;
    for (const m of [this.pillar, this.ring]) {
      m.frustumCulled = false; // tall and thin: its bounds don't follow the per-frame width
      m.renderOrder = 5;
      this.group.add(m);
    }
    this.group.name = "waypointBeacon";
    this.group.visible = false;
    scene.add(this.group);
  }

  /** Stand the beacon at a unit direction on the body, or hide it. */
  set(dir: V3 | null) {
    if (!dir) {
      this.group.visible = false;
      return;
    }
    const h = this.terrain.groundHeight(dir[0], dir[1], dir[2]);
    _up.set(dir[0], dir[1], dir[2]).normalize();
    this.base.copy(_up).multiplyScalar(this.radius + Math.max(h, this.terrain.body.waterLevel));
    this.group.position.copy(this.base);
    this.group.quaternion.setFromUnitVectors(_y, _up);
    this.group.visible = true;
  }

  /** Keep the pillar a few pixels wide however far away it is. */
  update(camera: THREE.Vector3) {
    if (!this.group.visible) return;
    const w = Math.max(0.8, camera.distanceTo(this.base) * 0.009);
    this.pillar.scale.x = this.pillar.scale.z = w;
  }

  dispose() {
    this.scene.remove(this.group);
    for (const m of [this.pillar, this.ring]) {
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
    }
  }
}
