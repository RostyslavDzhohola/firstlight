// Fast-travel pads (with their 12 m safe rings), the portal home on each planet's main pad, and
// Portus' three portals and the safe-zone line across the walled zones' gates (Portus' two town gates,
// each planet's outpost gates). Walking into a portal travels to its body. On a planet whose outpost
// assets are drawn (SiteTown, D42) the landing platforms and pad 0's portal gate replace the plain pad
// discs and the portal's base (setPadModels); the rings, beams and portals stay. Round 2 (D-b2-2): the
// Opus gate A (Portus' courts, Meridian) gets a swirling arched membrane in its opening instead of the
// ring and disc; Astra's gate B (Arcadia, Hollowmere) keeps the ring.

import * as THREE from "three/webgpu";
import { atan, float, length, materialColor, mix, positionLocal, sin, smoothstep, time, vec2 } from "three/tsl";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { BODIES, padDirs, PAD_SAFE_RADIUS, portalSpots, TOWN_SAFE, type BodyId, type PortalSpot, type Terrain } from "@firstlight/shared";
import { OUTPOSTS, type OutpostBody } from "@firstlight/shared/content/padOutposts";
import { townDir, townFrame, type TownPlacement } from "@firstlight/shared/planet/townFrame";
import { atmo } from "../render/atmosphere.ts";
import { disposeTree } from "../render/dispose.ts";
import { outpostGateStrips } from "./gateStrips.ts";
import { portalAt } from "./portalEntry.ts";
import { BEAM_HEIGHT, beamMaterial, PULSE_SECONDS, vortexMaterial, type PortalVortex } from "./portalVortex.ts";
import type { ResolvedSettings } from "../render/quality.ts";

/** A portal answers (pulses) when someone appears or vanishes within this many metres of its ring centre. */
export const PULSE_REACH = 7;

export const PORTAL_COLORS: Record<BodyId, number> = {
  portus: 0xffd8a8,
  arcadia: 0x36f9f6,
  hollowmere: 0xb48cff,
  meridian: 0xff7a4a,
};

/** Portal ring brightness in Portus (the planets' portal homes use 4). */
export const PORTUS_RING_GLOW = 2.2;

/**
 * The gate each body's portals stand in (D-b2-2). "arch": the Opus gate A (tools/blender/round2), whose
 * opening the game fills with a swirling membrane: `base` is the opening's floor above the portal's
 * base (Portus: the dais top over the ground; Meridian: the landing platform, 0.2 m over the portal's
 * base), `spring` where its arch starts and `half` its half width (gate.py OPEN + 0.08). "ring": the
 * ring and disc (Astra's gate B is built round them).
 */
export const PORTAL_GATES: Record<BodyId, { style: "arch" | "ring"; base: number; spring: number; half: number }> = {
  portus: { style: "arch", base: 0.14, spring: 5.0, half: 1.93 },
  meridian: { style: "arch", base: 0.2, spring: 5.06, half: 1.93 },
  arcadia: { style: "ring", base: 0, spring: 0, half: 0 },
  hollowmere: { style: "ring", base: 0, spring: 0, half: 0 },
};

/** The arched membrane's outline in the portal's frame (x right, y up from the portal's base). */
export function archOutline(gate: { base: number; spring: number; half: number }, steps = 16): [number, number][] {
  const pts: [number, number][] = [[-gate.half, gate.base], [gate.half, gate.base]];
  for (let k = 0; k <= steps; k++) {
    const a = (Math.PI * k) / steps;
    pts.push([gate.half * Math.cos(a), gate.spring + gate.half * Math.sin(a)]);
  }
  return pts;
}

/** A slow spiral of the destination's colour, brighter at the rim (glows over the bloom threshold). */
function membraneMaterial(color: number, gate: { base: number; spring: number }) {
  const m = new THREE.MeshBasicNodeMaterial({ color: new THREE.Color(color).multiplyScalar(2.4), transparent: true, depthWrite: false, side: THREE.DoubleSide, forceSinglePass: true });
  m.name = "portal_membrane";
  const p = positionLocal.xy.sub(vec2(0, (gate.base + gate.spring) / 2 + 0.6));
  const r = length(p.mul(vec2(1, 0.62)));
  const swirl = sin(atan(p.y, p.x).mul(3).add(r.mul(4.5)).sub(time.mul(1.3))).mul(0.5).add(0.5);
  const rim = smoothstep(1.1, 2.0, r);
  m.colorNode = materialColor.mul(mix(float(0.4), float(1.15), swirl).add(rim.mul(0.55))).mul(atmo.glowBoost);
  m.opacityNode = mix(float(0.45), float(0.85), swirl.mul(0.5).add(rim.mul(0.5)));
  return m;
}

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
  /**
   * Each portal's fill, plain and vortex (D-gfx-hub-2): `arch` in gate A's opening (null: a ring
   * portal), `disc` in the ring. One of the four is drawn (refresh()).
   */
  private readonly fills: { arch: { plain: THREE.Object3D; vortex: THREE.Object3D } | null; disc: { plain: THREE.Object3D; vortex: THREE.Object3D }; ring: THREE.Object3D; hub: boolean; fx: PortalVortex[]; center: THREE.Vector3 }[] = [];
  private fx = true;
  private readonly beams: THREE.Object3D[] = [];
  private beamsOn = true;

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
    const gate = PORTAL_GATES[body];
    const addPortal = (to: BodyId, dir: THREE.Vector3, h: number, faceDir: THREE.Vector3) => {
      const color = PORTAL_COLORS[to];
      const g = new THREE.Group();
      const ring = new THREE.Mesh(new THREE.TorusGeometry(2.2, 0.16, 12, 48), glow(color, ringK));
      ring.position.y = 2.6;
      const disc = new THREE.Mesh(new THREE.CircleGeometry(2.05, 40), glow(color, 0.9, 0.35));
      disc.position.y = 2.6;
      const base = new THREE.Mesh(new THREE.CylinderGeometry(2.6, 3, 0.4, 32), padMat);
      base.position.y = 0.2;
      // The vortex in the ring (Medium and up): the same disc, still (the shader swirls).
      const discFx = vortexMaterial(to, color, { kind: "disc", radius: 2.05 });
      const discVortex = new THREE.Mesh(disc.geometry, discFx.material);
      discVortex.name = "portal_vortex";
      discVortex.position.y = 2.6;
      g.add(ring, disc, discVortex, base);
      const fill: (typeof this.fills)[number] = { arch: null, disc: { plain: disc, vortex: discVortex }, ring, hub: def.terrain.kind === "hub", fx: [discFx], center: new THREE.Vector3() };
      this.fills.push(fill);
      if (def.terrain.kind !== "hub") this.portalBases.push(base);
      if (gate.style === "arch") {
        // Gate A: the membrane fills the arch. Portus' courts always stand; on a planet the gate is an
        // outpost model, so the ring and base come back when the models aren't drawn (setPadModels).
        const shape = new THREE.Shape(archOutline(gate).map(([x, y]) => new THREE.Vector2(x, y)));
        const membrane = new THREE.Mesh(new THREE.ShapeGeometry(shape, 8), membraneMaterial(color, gate));
        membrane.name = "portal_membrane";
        const archFx = vortexMaterial(to, color, { kind: "arch", base: gate.base, spring: gate.spring, half: gate.half });
        const vortex = new THREE.Mesh(membrane.geometry, archFx.material);
        vortex.name = "portal_vortex";
        g.add(membrane, vortex);
        fill.arch = { plain: membrane, vortex };
        fill.fx.push(archFx);
        if (def.terrain.kind === "hub") base.visible = false;
      }
      this.spinners.push(disc);
      place(g, dir, h);
      // Turn the ring to face `faceDir` (tangent).
      const up = dir.clone();
      const f = faceDir.clone().addScaledVector(up, -faceDir.dot(up)).normalize();
      const right = new THREE.Vector3().crossVectors(up, f).normalize();
      g.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(right, up, f));
      this.group.add(g);
      this.cullables.push({ obj: g, at: dir.clone().multiplyScalar(R + h) });
      const center = dir.clone().multiplyScalar(R + h).addScaledVector(up, 2.6);
      fill.center.copy(center);
      const label = makeLabel(BODIES[to].name.toUpperCase(), color);
      // Over gate A's floating keystone and globe (9.9 m), or 3.2 m over the ring.
      label.position.copy(center).addScaledVector(up, gate.style === "arch" ? 8.0 : 3.2);
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
      const beamGeo = new THREE.CylinderGeometry(1.5, 0.55, BEAM_HEIGHT, 12, 1, true);
      const thinBeamGeo = new THREE.CylinderGeometry(0.25, 0.25, 60, 8, 1, true);
      const beamMats: Record<number, THREE.Material> = {};
      const thinMats: Record<number, THREE.Material> = {};
      // The walled outpost round pad 0 (D-b2-1): its wall is the zone's edge, so pad 0 has no ring of
      // its own; the border is drawn across the gate passages instead, like Portus'.
      const wall = OUTPOSTS[body as OutpostBody]?.wall;
      if (wall) {
        // Draped on the terrain across each gate passage, over the gate's path (gateStrips.ts).
        const geo = new THREE.BufferGeometry();
        geo.setAttribute("position", new THREE.BufferAttribute(outpostGateStrips(body as OutpostBody, terrain), 3));
        const border = new THREE.Mesh(geo, ringMat);
        border.name = "outpost_gate_border";
        this.group.add(border);
        this.cullables.push({ obj: border, at: new THREE.Vector3(...pads[0]!).multiplyScalar(R) });
      }
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
        if (i === 0 && wall) ring.visible = false;
        // The pad's beam into the sky (D-gfx-hub-4): tall, tapered, strong from dusk; the thin plain one
        // when the sky's extras are off.
        const beamColor = i === 0 ? 0xffd8a8 : 0x72f1b8;
        const beam = new THREE.Mesh(beamGeo, (beamMats[beamColor] ??= beamMaterial(beamColor)));
        beam.name = "pad_beam";
        beam.position.y = BEAM_HEIGHT / 2;
        const thin = new THREE.Mesh(thinBeamGeo, (thinMats[beamColor] ??= glow(beamColor, 1.2, 0.25)));
        thin.position.y = 30;
        const bh = new THREE.Group();
        bh.add(beam, thin);
        this.beams.push(beam, thin);
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
    this.refresh();
  }

  /** The portal vortex and the tall pad beams follow their feature switches (Low: the plain ones). */
  applySettings(s: ResolvedSettings) {
    this.fx = s.on.portalfx;
    this.beamsOn = s.on.skylife;
    this.refresh();
  }

  /** Which fill each portal draws: the arch's (gate A drawn) or the ring's, vortex or plain. */
  private refresh() {
    for (const f of this.fills) {
      const arch = !!f.arch && (f.hub || this.padModels);
      if (f.arch) {
        f.arch.vortex.visible = arch && this.fx;
        f.arch.plain.visible = arch && !this.fx;
      }
      f.ring.visible = !arch;
      f.disc.vortex.visible = !arch && this.fx;
      f.disc.plain.visible = !arch && !this.fx;
    }
    for (let i = 0; i < this.beams.length; i += 2) {
      this.beams[i]!.visible = this.beamsOn;
      this.beams[i + 1]!.visible = !this.beamsOn;
    }
  }

  /** Someone appeared or vanished at `pos`: the portal they stand in (within PULSE_REACH) pulses. */
  pulseNear(pos: THREE.Vector3): boolean {
    for (const f of this.fills) {
      if (f.center.distanceToSquared(pos) > PULSE_REACH * PULSE_REACH) continue;
      for (const v of f.fx) v.pulseAge.value = 0;
      return true;
    }
    return false;
  }

  /** The portal the player (feet at `pos`) is standing in, if any (every frame: no allocation). */
  check(pos: THREE.Vector3): BodyId | null {
    return portalAt(this.spots, pos.x, pos.y, pos.z)?.to ?? null;
  }

  /** The planet's outpost models are drawn (landing platforms, pad 0's portal gate): hide the plain pad discs and portal base. */
  setPadModels(on: boolean) {
    this.padModels = on;
    for (const b of this.portalBases) b.visible = !on;
    this.refresh();
    if (on) for (const d of this.padDiscs) d.visible = false;
  }

  update(dt: number, playerPos?: THREE.Vector3, maxDistance = 450) {
    this.t += dt;
    for (const s of this.spinners) s.rotation.z = this.t * 0.6;
    for (const f of this.fills) for (const v of f.fx) if (v.pulseAge.value < PULSE_SECONDS) v.pulseAge.value = Math.min(PULSE_SECONDS, v.pulseAge.value + dt);
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

/** A floating world label (white text with a coloured glow) on a sprite 6 × 1.1 m; the caller owns its disposal. */
export function makeLabel(text: string, color: number): THREE.Sprite {
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
