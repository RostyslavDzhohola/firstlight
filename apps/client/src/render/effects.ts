// Combat visuals: tracers, projectiles (simulated with the server's physics), explosions, muzzle
// flashes and melee arcs. Emissive HDR colours so bloom makes them read as light (film rule 4–5).

import * as THREE from "three/webgpu";
import { WEAPONS } from "@firstlight/shared/content/weapons";
import { releaseObjects } from "./dispose.ts";
import { warmupSamples } from "./warmup.ts";

const WEAPON_COLORS: Record<string, number> = {
  carbine: 0x7af8ff,
  scatterpipe: 0xffc46b,
  stillshot: 0xff6b9a,
  hexquill: 0xc59bff,
  emberglass: 0xff7a2e,
  stormcoil: 0x9fe8ff,
  longbow: 0xfff2c4,
  comet: 0xffa040,
  grenade: 0xffd166,
  sunbrand: 0xffb347,
  riverstaff: 0x9cff6b,
  axe: 0xff8866,
  hammer: 0xffdd88,
  kunai: 0xffb27a,
  ember_seal: 0xff6a1f,
  fists: 0xffffff,
};
/** Ember sparks: the Ember Seal's trail, burst and hand-seal glow (light particles, shared material). */
const EMBER = 0xffa040;

export function weaponColor(index: number): number {
  return WEAPON_COLORS[WEAPONS[index]?.id ?? "fists"] ?? 0xffffff;
}

const matCache = new Map<number, THREE.MeshBasicNodeMaterial>();
function glow(color: number, opacity = 1): THREE.MeshBasicNodeMaterial {
  const key = color * 1000 + Math.round(opacity * 100);
  let m = matCache.get(key);
  if (!m) {
    m = new THREE.MeshBasicNodeMaterial({ color: new THREE.Color(color).multiplyScalar(4), transparent: opacity < 1, opacity, depthWrite: false, blending: THREE.AdditiveBlending });
    matCache.set(key, m);
  }
  return m;
}

interface Fx {
  obj: THREE.Mesh;
  until: number;
  update?: (t: number, dt: number) => boolean | void; // return true to remove early
  fade?: boolean;
  born: number;
  /** The mesh's geometry is its own (melee arcs): freed with it. */
  ownGeometry?: boolean;
}

/**
 * Effect meshes share the cached glow materials and module geometry, so taking one off the scene
 * must also free its render state (WebGPU keeps it, listening on the shared material, otherwise).
 */
function retire(m: THREE.Mesh, ownGeometry = false) {
  m.removeFromParent();
  m.dispose();
  if (ownGeometry) m.geometry.dispose();
}

const tracerGeo = new THREE.CylinderGeometry(0.03, 0.03, 1, 6, 1, true);
tracerGeo.translate(0, 0.5, 0);
tracerGeo.rotateX(Math.PI / 2);
const ballGeo = new THREE.SphereGeometry(1, 16, 12);
const boltGeo = new THREE.SphereGeometry(0.16, 10, 8);
const arrowGeo = new THREE.CylinderGeometry(0.02, 0.02, 0.9, 5);
arrowGeo.rotateX(Math.PI / 2);
const ringGeo = new THREE.TorusGeometry(1, 0.05, 6, 32);
const _up = new THREE.Vector3();
const _ahead = new THREE.Vector3();

export interface ProjectileSim {
  id: number;
  mesh: THREE.Mesh;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  g: number;
  until: number;
  /** Next ember-trail spark (performance.now ms), for fireballs. */
  trailAt?: number;
}

/** Every effect look (material settings × geometry layout), for the shader warm-up (S8). */
function effectLooks(): [THREE.BufferGeometry, THREE.Material][] {
  const c = WEAPON_COLORS.fists!;
  return [
    [tracerGeo, glow(c, 0.9)], // tracers
    [ballGeo, glow(c, 0.9)], // muzzle flashes, impacts
    [ballGeo, glow(c, 0.85)], // explosion cores
    [ringGeo, glow(c, 0.8)], // explosion rings, melee arcs (same layout)
    [boltGeo, glow(c)], // bolts, orbs, grenades (opaque)
    [arrowGeo, glow(c)], // arrows
    [ballGeo, glow(c, 0.12)], // Prism Bubble shells
  ];
}

export class Effects {
  private readonly list: Fx[] = [];
  readonly projectiles = new Map<number, ProjectileSim>();
  private readonly bubbles = new Map<number, THREE.Object3D>();
  readonly group = new THREE.Group();
  /** Hidden samples the warm-up compiles; kept for the session so the first shot doesn't hitch. */
  readonly samples = warmupSamples("effectsWarmup", effectLooks());

  constructor(scene: THREE.Scene) {
    this.group.add(this.samples);
    scene.add(this.group);
  }

  tracer(from: THREE.Vector3, to: THREE.Vector3, color: number, width = 1) {
    const len = from.distanceTo(to);
    if (len < 0.1) return;
    const m = new THREE.Mesh(tracerGeo, glow(color, 0.9));
    m.position.copy(from);
    m.lookAt(to);
    m.scale.set(width, width, len);
    this.add(m, 90, true);
  }

  flash(at: THREE.Vector3, color: number, size = 0.35, ms = 70) {
    const m = new THREE.Mesh(ballGeo, glow(color, 0.9));
    m.position.copy(at);
    m.scale.setScalar(size);
    this.add(m, ms, true);
  }

  explosion(at: THREE.Vector3, radius: number, color: number) {
    const core = new THREE.Mesh(ballGeo, glow(color, 0.85));
    core.position.copy(at);
    const r = Math.max(0.6, radius);
    const born = performance.now();
    this.add(core, 450, true, (t) => {
      const k = (t - born) / 450;
      core.scale.setScalar(r * (0.3 + k * 0.9));
    });
    const ring = new THREE.Mesh(ringGeo, glow(color, 0.8));
    ring.position.copy(at);
    ring.lookAt(at.clone().multiplyScalar(2));
    this.add(ring, 600, true, (t) => {
      const k = (t - born) / 600;
      ring.scale.setScalar(r * (0.4 + k * 1.4));
    });
  }

  impact(at: THREE.Vector3, color: number) {
    this.flash(at, color, 0.25, 110);
  }

  arc(origin: THREE.Vector3, facing: THREE.Vector3, up: THREE.Vector3, range: number, color: number) {
    const geo = new THREE.TorusGeometry(range * 0.75, 0.05, 4, 24, Math.PI * 0.6);
    const m = new THREE.Mesh(geo, glow(color, 0.8));
    m.position.copy(origin).addScaledVector(up, 1.1);
    const right = new THREE.Vector3().crossVectors(facing, up).normalize();
    const basis = new THREE.Matrix4().makeBasis(right, facing, up.clone().negate());
    m.quaternion.setFromRotationMatrix(basis);
    m.rotateZ(-Math.PI * 0.3 + Math.PI / 2);
    this.add(m, 160, true, undefined, true);
  }

  /** Prism Bubble: a faint shimmering shell at the owner's feet until it pops or times out. */
  bubble(id: number, at: THREE.Vector3, radius: number, ms: number, color = 0x9fd8ff) {
    if (this.bubbles.has(id)) return; // already shown (a snapshot after the live message)
    const m = new THREE.Mesh(ballGeo, glow(color, 0.12));
    m.position.copy(at);
    m.scale.setScalar(radius);
    const born = performance.now();
    this.bubbles.set(id, m);
    this.add(m, ms, true, (t) => {
      if (!this.bubbles.has(id) || t >= born + ms - 20) {
        this.bubbles.delete(id);
        return true;
      }
      m.scale.setScalar(radius * (1 + 0.015 * Math.sin((t - born) / 120)));
    });
  }

  popBubble(id: number) {
    const m = this.bubbles.get(id);
    if (!m) return;
    this.bubbles.delete(id);
    this.flash(m.position, 0x9fd8ff, m.scale.x, 160);
  }

  spawnProjectile(id: number, weaponIndex: number, pos: THREE.Vector3, vel: THREE.Vector3, g: number) {
    const color = weaponColor(weaponIndex);
    const id_ = WEAPONS[weaponIndex]?.id;
    const mesh = new THREE.Mesh(id_ === "longbow" || id_ === "kunai" ? arrowGeo : boltGeo, glow(color));
    if (id_ === "comet" || id_ === "emberglass") mesh.scale.setScalar(1.6);
    if (id_ === "kunai") mesh.scale.set(1.4, 1.4, 0.32); // a short, bright dart
    if (id_ === "ember_seal") mesh.scale.setScalar(2.3);
    mesh.position.copy(pos);
    this.group.add(mesh);
    const now = performance.now();
    this.projectiles.set(id, { id, mesh, pos: pos.clone(), vel: vel.clone(), g, until: now + 6000, trailAt: id_ === "ember_seal" ? now : undefined });
  }

  /** A spark that drifts and shrinks (`vel` m/s, `grav` m/s² along -up). */
  private spark(at: THREE.Vector3, vel: THREE.Vector3, size: number, ms: number, grav = 0) {
    const m = new THREE.Mesh(ballGeo, glow(EMBER, 0.85));
    m.position.copy(at);
    m.scale.setScalar(size);
    const born = performance.now();
    const v = vel.clone();
    const up = at.clone().normalize();
    this.add(m, ms, true, (t, dt) => {
      v.addScaledVector(up, -grav * dt);
      m.position.addScaledVector(v, dt);
      m.scale.setScalar(size * Math.max(0.05, 1 - (t - born) / ms));
    });
  }

  /** Ember Seal burst: the blast plus a shower of embers. */
  emberBurst(at: THREE.Vector3, radius: number) {
    const up = at.clone().normalize();
    for (let i = 0; i < 16; i++) {
      const dir = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize().addScaledVector(up, 0.6).normalize();
      this.spark(at, dir.multiplyScalar(radius * (1.5 + Math.random() * 2)), 0.06 + Math.random() * 0.06, 500 + Math.random() * 400, 6);
    }
  }

  /** The hand seal's glow while the Ember Seal winds up: a ring of light growing before the hands. */
  sealCharge(at: THREE.Vector3, facing: THREE.Vector3, ms: number) {
    const ring = new THREE.Mesh(ringGeo, glow(EMBER, 0.8));
    ring.position.copy(at);
    ring.lookAt(at.clone().add(facing));
    const born = performance.now();
    this.add(ring, ms, true, (t) => {
      ring.scale.setScalar(0.05 + 0.2 * Math.min(1, (t - born) / ms));
    });
    this.spark(at, facing.clone().multiplyScalar(0.4), 0.05, ms);
  }

  endProjectile(id: number) {
    const p = this.projectiles.get(id);
    if (!p) return;
    retire(p.mesh);
    this.projectiles.delete(id);
  }

  private add(obj: THREE.Mesh, ms: number, fade: boolean, update?: Fx["update"], ownGeometry = false) {
    this.group.add(obj);
    const now = performance.now();
    this.list.push({ obj, until: now + ms, fade, update, born: now, ownGeometry });
  }

  /** Live effect meshes (tests). */
  get live(): number {
    return this.list.length + this.projectiles.size;
  }

  update(dt: number, now: number) {
    for (let i = this.list.length - 1; i >= 0; i--) {
      const f = this.list[i]!;
      if (now >= f.until || f.update?.(now, dt) === true) {
        retire(f.obj, f.ownGeometry);
        this.list.splice(i, 1);
      }
    }
    for (const p of this.projectiles.values()) {
      const up = _up.copy(p.pos).normalize();
      p.vel.addScaledVector(up, -p.g * dt);
      p.pos.addScaledVector(p.vel, dt);
      p.mesh.position.copy(p.pos);
      p.mesh.lookAt(_ahead.copy(p.pos).add(p.vel));
      if (p.trailAt !== undefined && now >= p.trailAt) {
        p.trailAt = now + 35;
        this.spark(p.pos, _ahead.copy(up).multiplyScalar(0.6), 0.09 + Math.random() * 0.05, 380);
      }
      if (now > p.until) this.endProjectile(p.id);
    }
  }

  dispose() {
    for (const f of this.list) retire(f.obj, f.ownGeometry);
    for (const p of this.projectiles.values()) retire(p.mesh);
    this.list.length = 0;
    this.projectiles.clear();
    this.bubbles.clear();
    this.group.removeFromParent();
    releaseObjects(this.group);
  }
}
