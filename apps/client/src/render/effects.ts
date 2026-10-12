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
  fists: 0xffffff,
};

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
  ];
}

export class Effects {
  private readonly list: Fx[] = [];
  readonly projectiles = new Map<number, ProjectileSim>();
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

  spawnProjectile(id: number, weaponIndex: number, pos: THREE.Vector3, vel: THREE.Vector3, g: number) {
    const color = weaponColor(weaponIndex);
    const id_ = WEAPONS[weaponIndex]?.id;
    const mesh = new THREE.Mesh(id_ === "longbow" ? arrowGeo : boltGeo, glow(color));
    if (id_ === "comet" || id_ === "emberglass") mesh.scale.setScalar(1.6);
    mesh.position.copy(pos);
    this.group.add(mesh);
    this.projectiles.set(id, { id, mesh, pos: pos.clone(), vel: vel.clone(), g, until: performance.now() + 6000 });
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
      if (now > p.until) this.endProjectile(p.id);
    }
  }

  dispose() {
    for (const f of this.list) retire(f.obj, f.ownGeometry);
    for (const p of this.projectiles.values()) retire(p.mesh);
    this.list.length = 0;
    this.projectiles.clear();
    this.group.removeFromParent();
    releaseObjects(this.group);
  }
}
