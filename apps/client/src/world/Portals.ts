// Fast-travel pads (with their 12 m safe rings), the portal home on each planet's main pad, and
// Portus' three portals. Walking into a portal travels to its body.

import * as THREE from "three/webgpu";
import { BODIES, padDirs, PAD_SAFE_RADIUS, portalSpots, type BodyId, type Terrain } from "@firstlight/shared";

export const PORTAL_COLORS: Record<BodyId, number> = {
  portus: 0xffd8a8,
  arcadia: 0x36f9f6,
  hollowmere: 0xb48cff,
  meridian: 0xff7a4a,
};

export interface Portal {
  to: BodyId;
  center: THREE.Vector3;
  normal: THREE.Vector3;
}

function glow(color: number, k = 3, opacity = 1) {
  return new THREE.MeshBasicNodeMaterial({ color: new THREE.Color(color).multiplyScalar(k), transparent: opacity < 1, opacity, depthWrite: opacity >= 1 });
}

function frame(up: THREE.Vector3): { right: THREE.Vector3; fwd: THREE.Vector3 } {
  const ref = Math.abs(up.z) < 0.9 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, 0, 0);
  const fwd = ref.addScaledVector(up, -ref.dot(up)).normalize();
  // Right-handed basis for makeBasis(right, up, fwd): right = up × fwd (fwd × up mirrors it).
  const right = new THREE.Vector3().crossVectors(up, fwd).normalize();
  return { right, fwd };
}

export class Portals {
  readonly group = new THREE.Group();
  readonly portals: Portal[] = [];
  private readonly spinners: THREE.Object3D[] = [];
  /** Objects culled by distance from the player (far side of the planet isn't streamed). */
  private readonly cullables: { obj: THREE.Object3D; at: THREE.Vector3 }[] = [];
  private t = 0;

  constructor(scene: THREE.Scene, body: BodyId, terrain: Terrain) {
    scene.add(this.group);
    const def = BODIES[body];
    const R = def.radius;
    const padMat = new THREE.MeshStandardNodeMaterial({ color: 0x8a86a0, roughness: 0.45, metalness: 0.55 });
    const ringMat = glow(0x72f1b8, 1.6, 0.55);

    const place = (obj: THREE.Object3D, dir: THREE.Vector3, h: number, up = dir) => {
      const { right, fwd } = frame(up);
      obj.position.copy(dir).multiplyScalar(R + h);
      obj.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(right, up, fwd));
    };

    const addPortal = (to: BodyId, dir: THREE.Vector3, h: number, faceDir: THREE.Vector3) => {
      const color = PORTAL_COLORS[to];
      const g = new THREE.Group();
      const ring = new THREE.Mesh(new THREE.TorusGeometry(2.2, 0.16, 12, 48), glow(color, 4));
      ring.position.y = 2.6;
      const disc = new THREE.Mesh(new THREE.CircleGeometry(2.05, 40), glow(color, 0.9, 0.35));
      disc.position.y = 2.6;
      const base = new THREE.Mesh(new THREE.CylinderGeometry(2.6, 3, 0.4, 32), padMat);
      base.position.y = 0.2;
      g.add(ring, disc, base);
      place(g, dir, h);
      // Turn the ring to face `faceDir` (tangent).
      const up = dir.clone();
      const f = faceDir.clone().addScaledVector(up, -faceDir.dot(up)).normalize();
      const right = new THREE.Vector3().crossVectors(up, f).normalize();
      g.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(right, up, f));
      this.group.add(g);
      this.cullables.push({ obj: g, at: dir.clone().multiplyScalar(R + h) });
      this.spinners.push(disc);
      const center = dir.clone().multiplyScalar(R + h).addScaledVector(up, 2.6);
      this.portals.push({ to, center, normal: f });
      const label = makeLabel(BODIES[to].name.toUpperCase(), color);
      label.position.copy(center).addScaledVector(up, 3.2);
      this.group.add(label);
      this.cullables.push({ obj: label, at: center.clone() });
    };

    if (def.terrain.kind === "hub") {
      // Portus: three portals around the plaza (positions shared with the server).
    } else {
      const pads = padDirs(def);
      pads.forEach((p, i) => {
        const dir = new THREE.Vector3(p[0], p[1], p[2]);
        const h = terrain.padHeights[i] ?? terrain.groundHeight(p[0], p[1], p[2]);
        // Top surface sits 2 cm above the flattened ground so feet rest on it.
        const pad = new THREE.Mesh(new THREE.CylinderGeometry(8, 8.6, 0.6, 48), padMat);
        place(pad, dir, h - 0.28);
        pad.receiveShadow = true;
        const ring = new THREE.Mesh(new THREE.TorusGeometry(PAD_SAFE_RADIUS, 0.08, 6, 96), ringMat);
        ring.rotation.x = Math.PI / 2;
        const holder = new THREE.Group();
        holder.add(ring);
        ring.position.y = 0.3;
        place(holder, dir, h);
        const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.25, 60, 8, 1, true), glow(i === 0 ? 0xffd8a8 : 0x72f1b8, 1.2, 0.25));
        beam.position.y = 30;
        const bh = new THREE.Group();
        bh.add(beam);
        place(bh, dir, h);
        this.group.add(pad, holder, bh);
        const at = dir.clone().multiplyScalar(R + h);
        for (const o of [pad, holder, bh]) this.cullables.push({ obj: o, at });

      });
    }
    // Portals at the shared, server-validated positions.
    for (const spot of portalSpots(def, terrain)) {
      addPortal(spot.to, new THREE.Vector3(...spot.dir), spot.h, new THREE.Vector3(...spot.facing));
    }
  }

  /** The portal the player is standing in, if any. */
  check(pos: THREE.Vector3): BodyId | null {
    for (const p of this.portals) {
      const d = pos.clone().sub(p.center);
      const along = d.dot(p.normal);
      const lateral = d.addScaledVector(p.normal, -along).length();
      if (Math.abs(along) < 0.9 && lateral < 2.2) return p.to;
    }
    return null;
  }

  update(dt: number, playerPos?: THREE.Vector3, maxDistance = 450) {
    this.t += dt;
    for (const s of this.spinners) s.rotation.z = this.t * 0.6;
    if (playerPos) for (const c of this.cullables) c.obj.visible = c.at.distanceTo(playerPos) < maxDistance;
  }

  dispose() {
    this.group.removeFromParent();
  }
}

function makeLabel(text: string, color: number): THREE.Sprite {
  const c = document.createElement("canvas");
  c.width = 512;
  c.height = 96;
  const g = c.getContext("2d")!;
  g.font = "700 54px ui-sans-serif, system-ui, sans-serif";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.shadowColor = `#${color.toString(16).padStart(6, "0")}`;
  g.shadowBlur = 18;
  g.fillStyle = "#ffffff";
  g.fillText(text, 256, 50);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteNodeMaterial({ map: tex, transparent: true, depthWrite: false }));
  s.scale.set(6, 1.1, 1);
  return s;
}
