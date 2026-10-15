// Fast-travel pads (with their 12 m safe rings), the portal home on each planet's main pad, and
// Portus' three portals and the safe-zone line across its two gates. Walking into a portal travels
// to its body. On a planet whose outpost assets are drawn (SiteTown, D42) the landing platforms and
// pad 0's portal gate replace the plain pad discs and the portal's base (setPadModels); the rings,
// beams and portals stay.

import * as THREE from "three/webgpu";
import { materialColor } from "three/tsl";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { BODIES, padDirs, PAD_SAFE_RADIUS, portalSpots, TOWN_SAFE, type BodyId, type PortalSpot, type Terrain } from "@firstlight/shared";
import { townDir, townFrame, type TownPlacement } from "@firstlight/shared/planet/townFrame";
import { atmo } from "../render/atmosphere.ts";
import { disposeTree } from "../render/dispose.ts";
import { portalAt } from "./portalEntry.ts";

export const PORTAL_COLORS: Record<BodyId, number> = {
  portus: 0xffd8a8,
  arcadia: 0x36f9f6,
  hollowmere: 0xb48cff,
  meridian: 0xff7a4a,
};

/** Portal ring brightness in Portus (the planets' portal homes use 4). */
export const PORTUS_RING_GLOW = 2.2;

function glow(color: number, k = 3, opacity = 1) {
  const m = new THREE.MeshBasicNodeMaterial({ color: new THREE.Color(color).multiplyScalar(k), transparent: opacity < 1, opacity, depthWrite: opacity >= 1 });
  // Glows brighter at night (shared uniform: no recompile as the day turns).
  m.colorNode = materialColor.mul(atmo.glowBoost);
  return m;
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
  /** The shared, server-validated portal spots on this body (entry test: portalEntry.ts). */
  readonly spots: PortalSpot[];
  private readonly spinners: THREE.Object3D[] = [];
  /** Objects culled by distance from the player (far side of the planet isn't streamed). */
  private readonly cullables: { obj: THREE.Object3D; at: THREE.Vector3 }[] = [];
  /** The plain pad discs and portal bases a planet's outpost models replace. */
  private readonly padDiscs = new Set<THREE.Object3D>();
  private readonly portalBases: THREE.Object3D[] = [];
  private padModels = false;
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

    // Portus' rings stand in the town's masonry courts: at the planets' strength their bloom washed out
    // the arches round them by day (browser round 1). Still over the bloom threshold, so they glow.
    const ringK = def.terrain.kind === "hub" ? PORTUS_RING_GLOW : 4;
    const addPortal = (to: BodyId, dir: THREE.Vector3, h: number, faceDir: THREE.Vector3) => {
      const color = PORTAL_COLORS[to];
      const g = new THREE.Group();
      const ring = new THREE.Mesh(new THREE.TorusGeometry(2.2, 0.16, 12, 48), glow(color, ringK));
      ring.position.y = 2.6;
      const disc = new THREE.Mesh(new THREE.CircleGeometry(2.05, 40), glow(color, 0.9, 0.35));
      disc.position.y = 2.6;
      const base = new THREE.Mesh(new THREE.CylinderGeometry(2.6, 3, 0.4, 32), padMat);
      base.position.y = 0.2;
      g.add(ring, disc, base);
      if (def.terrain.kind !== "hub") this.portalBases.push(base);
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
      const label = makeLabel(BODIES[to].name.toUpperCase(), color);
      label.position.copy(center).addScaledVector(up, 3.2);
      this.group.add(label);
      this.cullables.push({ obj: label, at: center.clone() });
    };

    if (def.terrain.kind === "hub") {
      // Portus: three portals around the plaza (positions shared with the server), and the safe-zone
      // border (D-zones-1) drawn where it crosses the two gate passages: a glowing line on the paving
      // in the pad rings' colour, both gates in one draw.
      const strips: THREE.BufferGeometry[] = [];
      const f: TownPlacement = { item: -1, prefab: -1, scale: 1, px: 0, py: 0, pz: 0, rx: 0, ry: 0, rz: 0, ux: 0, uy: 0, uz: 0, fx: 0, fy: 0, fz: 0 };
      for (const east of [TOWN_SAFE.radius, -TOWN_SAFE.radius]) {
        const d = townDir(east, 0, R);
        townFrame(east, 0, 0, R, f); // right = east, front = south: the strip spans the passage north–south
        const h = R + terrain.groundHeight(d[0], d[1], d[2]) + 0.03;
        const m = new THREE.Matrix4().makeBasis(new THREE.Vector3(f.rx, f.ry, f.rz), new THREE.Vector3(f.ux, f.uy, f.uz), new THREE.Vector3(f.fx, f.fy, f.fz));
        m.setPosition(d[0] * h, d[1] * h, d[2] * h);
        strips.push(new THREE.BoxGeometry(0.22, 0.05, 3.9).applyMatrix4(m));
      }
      const border = new THREE.Mesh(mergeGeometries(strips, false)!, ringMat);
      for (const g of strips) g.dispose();
      this.group.add(border);
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
        this.padDiscs.add(pad);
        const at = dir.clone().multiplyScalar(R + h);
        for (const o of [pad, holder, bh]) this.cullables.push({ obj: o, at });

      });
    }
    // Portals at the shared, server-validated positions.
    this.spots = portalSpots(def, terrain);
    for (const spot of this.spots) {
      addPortal(spot.to, new THREE.Vector3(...spot.dir), spot.h, new THREE.Vector3(...spot.facing));
    }
  }

  /** The portal the player (feet at `pos`) is standing in, if any (every frame: no allocation). */
  check(pos: THREE.Vector3): BodyId | null {
    return portalAt(this.spots, pos.x, pos.y, pos.z)?.to ?? null;
  }

  /** The planet's outpost models are drawn (landing platforms, pad 0's portal gate): hide the plain pad discs and portal base. */
  setPadModels(on: boolean) {
    this.padModels = on;
    for (const b of this.portalBases) b.visible = !on;
    if (on) for (const d of this.padDiscs) d.visible = false;
  }

  update(dt: number, playerPos?: THREE.Vector3, maxDistance = 450) {
    this.t += dt;
    for (const s of this.spinners) s.rotation.z = this.t * 0.6;
    if (playerPos) {
      for (const c of this.cullables) c.obj.visible = c.at.distanceTo(playerPos) < maxDistance && !(this.padModels && this.padDiscs.has(c.obj));
    }
  }

  /** Leaving the body: every pad, ring, beam, portal and label here is this instance's own. */
  dispose() {
    this.group.removeFromParent();
    disposeTree(this.group);
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
