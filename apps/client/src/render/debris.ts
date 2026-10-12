// Breakable-prop debris (SPEC §6.9, D8). Every pre-fractured piece of every archetype variant lives
// in ONE BatchedMesh: one material, one draw call for all live fragments (fresh fracture faces are
// flagged by the `inner` vertex attribute and tinted in the shader instead of a second material).
// A fixed pool of instances (≤ 150 live; the oldest despawn early) runs cheap custom physics:
// radial gravity toward the planet centre, terrain-height collision with a little bounce and
// friction, damping, no debris–debris contacts. Pieces settle, then shrink away after ~10 s.
// The per-frame loop works on typed arrays and scratch objects only (no allocations).

import * as THREE from "three/webgpu";
import { hash01, type Terrain } from "@firstlight/shared";

/** A pre-fractured piece as delivered by the fracture worker. */
export interface DebrisPiece {
  positions: Float32Array;
  normals: Float32Array;
  colors: Float32Array;
  inner: Float32Array;
  /** Centre in the prop's object space (scale 1) and bounding radius around it. */
  center: [number, number, number];
  radius: number;
}

/** Where a prop stands: base point, orthonormal frame (right, up, forward) and uniform scale. */
export interface DebrisSource {
  px: number; py: number; pz: number;
  rx: number; ry: number; rz: number;
  ux: number; uy: number; uz: number;
  fx: number; fy: number; fz: number;
  scale: number;
  h: number;
}

interface PieceSet {
  geometryIds: number[];
  cx: Float32Array;
  cy: Float32Array;
  cz: Float32Array;
  radius: Float32Array;
}

export const DEBRIS_MAX = 150;
const GRAVITY = 11;
const AIR_DAMP = 0.35;
const BOUNCE = 0.28;
const FADE_S = 0.8;

/** A tiny closed tetrahedron with the debris attribute layout (shader warm-up before the worker answers). */
function placeholderGeometry(): THREE.BufferGeometry {
  const g = new THREE.TetrahedronGeometry(0.01).toNonIndexed();
  g.deleteAttribute("uv");
  const n = g.getAttribute("position").count;
  g.setAttribute("color", new THREE.BufferAttribute(new Float32Array(n * 3).fill(1), 3));
  g.setAttribute("inner", new THREE.BufferAttribute(new Float32Array(n), 1));
  return g;
}

export class Debris {
  mesh: THREE.BatchedMesh;
  private readonly parent: THREE.Object3D;
  private readonly material: THREE.Material;
  private readonly sets = new Map<number, PieceSet>();
  private budget = DEBRIS_MAX;
  // Pool state (structure of arrays), slot = 0..DEBRIS_MAX-1; instance id = slot + 1 (0 = keep-alive).
  private readonly px = new Float32Array(DEBRIS_MAX);
  private readonly py = new Float32Array(DEBRIS_MAX);
  private readonly pz = new Float32Array(DEBRIS_MAX);
  private readonly vx = new Float32Array(DEBRIS_MAX);
  private readonly vy = new Float32Array(DEBRIS_MAX);
  private readonly vz = new Float32Array(DEBRIS_MAX);
  private readonly qx = new Float32Array(DEBRIS_MAX);
  private readonly qy = new Float32Array(DEBRIS_MAX);
  private readonly qz = new Float32Array(DEBRIS_MAX);
  private readonly qw = new Float32Array(DEBRIS_MAX);
  private readonly wx = new Float32Array(DEBRIS_MAX);
  private readonly wy = new Float32Array(DEBRIS_MAX);
  private readonly wz = new Float32Array(DEBRIS_MAX);
  private readonly scl = new Float32Array(DEBRIS_MAX);
  private readonly rad = new Float32Array(DEBRIS_MAX);
  private readonly age = new Float32Array(DEBRIS_MAX);
  private readonly life = new Float32Array(DEBRIS_MAX);
  private readonly asleep = new Uint8Array(DEBRIS_MAX);
  /** Live slots (dense) and free slots (stack). */
  private readonly live = new Int32Array(DEBRIS_MAX);
  private liveCount = 0;
  private readonly free = new Int32Array(DEBRIS_MAX);
  private freeCount = 0;
  // Scratch.
  private readonly m4 = new THREE.Matrix4();
  private readonly v3 = new THREE.Vector3();
  private readonly s3 = new THREE.Vector3();
  private readonly q4 = new THREE.Quaternion();
  private readonly basis = new THREE.Matrix4();
  private readonly qObj = new THREE.Quaternion();
  private readonly ax = new THREE.Vector3();
  private readonly ay = new THREE.Vector3();
  private readonly az = new THREE.Vector3();

  constructor(parent: THREE.Object3D, material: THREE.Material) {
    this.parent = parent;
    this.material = material;
    this.mesh = this.createMesh([]);
  }

  get count(): number {
    return this.liveCount;
  }

  /** Max live fragments (tier budget, ≤ DEBRIS_MAX). Extra live pieces despawn now. */
  setBudget(n: number) {
    this.budget = Math.max(0, Math.min(DEBRIS_MAX, n));
    while (this.liveCount > this.budget) this.despawnOldest();
  }

  /**
   * Replace every piece geometry (keyed `archetype * 16 + variant`). Builds a fresh BatchedMesh:
   * same material and attribute layout, so no new shader compiles.
   */
  install(sets: Map<number, DebrisPiece[]>) {
    this.clear();
    this.sets.clear();
    const old = this.mesh;
    const pieces: DebrisPiece[] = [];
    for (const list of sets.values()) for (const p of list) pieces.push(p);
    this.mesh = this.createMesh(pieces);
    old.removeFromParent();
    old.dispose();
    let gid = 1; // 0 = the placeholder
    for (const [key, list] of sets) {
      const s: PieceSet = { geometryIds: [], cx: new Float32Array(list.length), cy: new Float32Array(list.length), cz: new Float32Array(list.length), radius: new Float32Array(list.length) };
      list.forEach((p, i) => {
        s.geometryIds.push(gid++);
        s.cx[i] = p.center[0];
        s.cy[i] = p.center[1];
        s.cz[i] = p.center[2];
        s.radius[i] = p.radius;
      });
      this.sets.set(key, s);
    }
  }

  private createMesh(pieces: DebrisPiece[]): THREE.BatchedMesh {
    const ph = placeholderGeometry();
    let verts = ph.getAttribute("position").count;
    for (const p of pieces) verts += p.positions.length / 3;
    const mesh = new THREE.BatchedMesh(DEBRIS_MAX + 1, verts, verts, this.material);
    mesh.name = "debris";
    mesh.perObjectFrustumCulled = false;
    mesh.sortObjects = false;
    mesh.frustumCulled = false;
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    mesh.addGeometry(ph);
    ph.dispose();
    for (const p of pieces) {
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(p.positions, 3));
      g.setAttribute("normal", new THREE.BufferAttribute(p.normals, 3));
      g.setAttribute("color", new THREE.BufferAttribute(p.colors, 3));
      g.setAttribute("inner", new THREE.BufferAttribute(p.inner, 1));
      mesh.addGeometry(g);
    }
    // Instance 0 keeps one (invisible, 1 cm) draw alive so the shader compiles in the warm-up.
    mesh.addInstance(0);
    mesh.setMatrixAt(0, this.m4.makeScale(1e-3, 1e-3, 1e-3));
    this.freeCount = 0;
    for (let s = 0; s < DEBRIS_MAX; s++) {
      const id = mesh.addInstance(0);
      mesh.setVisibleAt(id, false);
      this.free[this.freeCount++] = DEBRIS_MAX - 1 - s;
    }
    this.liveCount = 0;
    this.parent.add(mesh);
    return mesh;
  }

  /** Shatter: spawn a prop's pre-fractured pieces at its transform, pushed away from the impact. */
  spawn(src: DebrisSource, archetype: number, variant: number, ix: number, iy: number, iz: number, force: number, seed: number): number {
    const set = this.sets.get(archetype * 16 + variant);
    if (!set || this.budget === 0) return 0;
    const n = Math.min(set.geometryIds.length, this.budget);
    while (this.liveCount + n > this.budget) this.despawnOldest();
    const s = src.scale;
    // Object orientation from its frame.
    this.ax.set(src.rx, src.ry, src.rz);
    this.ay.set(src.ux, src.uy, src.uz);
    this.az.set(src.fx, src.fy, src.fz);
    this.basis.makeBasis(this.ax, this.ay, this.az);
    this.qObj.setFromRotationMatrix(this.basis);
    const ocx = src.px + src.ux * src.h * 0.5, ocy = src.py + src.uy * src.h * 0.5, ocz = src.pz + src.uz * src.h * 0.5;
    const f = Math.max(0.5, Math.min(3, force));
    for (let k = 0; k < n; k++) {
      const slot = this.free[--this.freeCount]!;
      this.live[this.liveCount++] = slot;
      const lx = set.cx[k]! * s, ly = set.cy[k]! * s, lz = set.cz[k]! * s;
      const x = src.px + src.rx * lx + src.ux * ly + src.fx * lz;
      const y = src.py + src.ry * lx + src.uy * ly + src.fy * lz;
      const z = src.pz + src.rz * lx + src.uz * ly + src.fz * lz;
      this.px[slot] = x;
      this.py[slot] = y;
      this.pz[slot] = z;
      // Push: along the hit, outward from the prop's centre, and a little up (deterministic per piece).
      let ox = x - ocx, oy = y - ocy, oz = z - ocz;
      const ol = Math.hypot(ox, oy, oz) || 1;
      ox /= ol; oy /= ol; oz /= ol;
      const r1 = hash01(seed, k, 1), r2 = hash01(seed, k, 2), r3 = hash01(seed, k, 3);
      const kImp = (1.0 + 2.2 * r1) * f, kOut = (0.8 + 1.8 * r2) * Math.sqrt(f), kUp = 1.0 + 2.0 * r3;
      this.vx[slot] = ix * kImp + ox * kOut + src.ux * kUp;
      this.vy[slot] = iy * kImp + oy * kOut + src.uy * kUp;
      this.vz[slot] = iz * kImp + oz * kOut + src.uz * kUp;
      this.qx[slot] = this.qObj.x;
      this.qy[slot] = this.qObj.y;
      this.qz[slot] = this.qObj.z;
      this.qw[slot] = this.qObj.w;
      const spin = 1.5 + 5 * hash01(seed, k, 4);
      let wx = hash01(seed, k, 5) - 0.5, wy = hash01(seed, k, 6) - 0.5, wz = hash01(seed, k, 7) - 0.5;
      const wl = Math.hypot(wx, wy, wz) || 1;
      wx = (wx / wl) * spin; wy = (wy / wl) * spin; wz = (wz / wl) * spin;
      this.wx[slot] = wx;
      this.wy[slot] = wy;
      this.wz[slot] = wz;
      this.scl[slot] = s;
      this.rad[slot] = set.radius[k]! * s;
      this.age[slot] = 0;
      this.life[slot] = 9 + 2 * hash01(seed, k, 8);
      this.asleep[slot] = 0;
      const id = slot + 1;
      this.mesh.setGeometryIdAt(id, set.geometryIds[k]!);
      this.mesh.setVisibleAt(id, true);
      this.writeMatrix(slot, 1);
    }
    return n;
  }

  update(dt: number, terrain: Terrain, waterLevel: number) {
    if (this.liveCount === 0) return;
    const R = terrain.body.radius;
    const damp = Math.exp(-AIR_DAMP * dt);
    let i = 0;
    while (i < this.liveCount) {
      const s = this.live[i]!;
      const age = (this.age[s] = this.age[s]! + dt);
      if (age >= this.life[s]!) {
        this.release(i);
        continue;
      }
      if (!this.asleep[s]) this.step(s, dt, damp, terrain, R, waterLevel);
      const fade = this.life[s]! - age;
      if (!this.asleep[s] || fade < FADE_S) this.writeMatrix(s, fade < FADE_S ? Math.max(0, fade / FADE_S) : 1);
      i++;
    }
  }

  private step(s: number, dt: number, damp: number, terrain: Terrain, R: number, waterLevel: number) {
    let x = this.px[s]!, y = this.py[s]!, z = this.pz[s]!;
    let l = Math.sqrt(x * x + y * y + z * z);
    let ux = x / l, uy = y / l, uz = z / l;
    let vx = this.vx[s]!, vy = this.vy[s]!, vz = this.vz[s]!;
    // Radial gravity, air damping (much more under water).
    const wet = l < R + waterLevel;
    const g = wet ? GRAVITY * 0.25 : GRAVITY;
    const d = wet ? Math.exp(-3 * dt) : damp;
    vx = (vx - ux * g * dt) * d;
    vy = (vy - uy * g * dt) * d;
    vz = (vz - uz * g * dt) * d;
    x += vx * dt;
    y += vy * dt;
    z += vz * dt;
    l = Math.sqrt(x * x + y * y + z * z);
    ux = x / l; uy = y / l; uz = z / l;
    // Terrain-height collision: keep the piece's centre about half its radius above the ground.
    const rest = R + terrain.groundHeight(ux, uy, uz) + this.rad[s]! * 0.45;
    let w = Math.hypot(this.wx[s]!, this.wy[s]!, this.wz[s]!);
    if (l < rest) {
      x = ux * rest; y = uy * rest; z = uz * rest;
      const vn = vx * ux + vy * uy + vz * uz;
      if (vn < 0) {
        vx -= ux * vn * (1 + BOUNCE);
        vy -= uy * vn * (1 + BOUNCE);
        vz -= uz * vn * (1 + BOUNCE);
      }
      // Ground friction on the tangential part and the spin.
      const fr = Math.max(0, 1 - 7 * dt);
      const vn2 = vx * ux + vy * uy + vz * uz;
      vx = (vx - ux * vn2) * fr + ux * vn2;
      vy = (vy - uy * vn2) * fr + uy * vn2;
      vz = (vz - uz * vn2) * fr + uz * vn2;
      const wf = Math.max(0, 1 - 6 * dt);
      this.wx[s] = this.wx[s]! * wf;
      this.wy[s] = this.wy[s]! * wf;
      this.wz[s] = this.wz[s]! * wf;
      w *= wf;
      if (vx * vx + vy * vy + vz * vz < 0.09 && w < 0.4) this.asleep[s] = 1;
    }
    this.px[s] = x; this.py[s] = y; this.pz[s] = z;
    this.vx[s] = vx; this.vy[s] = vy; this.vz[s] = vz;
    // Integrate the orientation: q += ½·(ω, 0)·q·dt, then normalise.
    if (w > 1e-4) {
      const qx = this.qx[s]!, qy = this.qy[s]!, qz = this.qz[s]!, qw = this.qw[s]!;
      const ox = this.wx[s]! * dt * 0.5, oy = this.wy[s]! * dt * 0.5, oz = this.wz[s]! * dt * 0.5;
      let nx = qx + ox * qw + oy * qz - oz * qy;
      let ny = qy + oy * qw + oz * qx - ox * qz;
      let nz = qz + oz * qw + ox * qy - oy * qx;
      let nw = qw - ox * qx - oy * qy - oz * qz;
      const ql = Math.hypot(nx, ny, nz, nw) || 1;
      nx /= ql; ny /= ql; nz /= ql; nw /= ql;
      this.qx[s] = nx; this.qy[s] = ny; this.qz[s] = nz; this.qw[s] = nw;
    }
  }

  private writeMatrix(s: number, k: number) {
    this.v3.set(this.px[s]!, this.py[s]!, this.pz[s]!);
    this.q4.set(this.qx[s]!, this.qy[s]!, this.qz[s]!, this.qw[s]!);
    const sc = Math.max(1e-4, this.scl[s]! * k);
    this.s3.set(sc, sc, sc);
    this.m4.compose(this.v3, this.q4, this.s3);
    this.mesh.setMatrixAt(s + 1, this.m4);
  }

  /** Remove the live entry at dense index i. */
  private release(i: number) {
    const s = this.live[i]!;
    this.mesh.setVisibleAt(s + 1, false);
    this.live[i] = this.live[--this.liveCount]!;
    this.free[this.freeCount++] = s;
  }

  private despawnOldest() {
    let best = -1, bestAge = -1;
    for (let i = 0; i < this.liveCount; i++) {
      const a = this.age[this.live[i]!]!;
      if (a > bestAge) {
        bestAge = a;
        best = i;
      }
    }
    if (best >= 0) this.release(best);
  }

  /** Despawn everything (leaving a body, kill switch). */
  clear() {
    while (this.liveCount > 0) this.release(this.liveCount - 1);
  }

  dispose() {
    this.clear();
    this.mesh.removeFromParent();
    this.mesh.dispose();
  }
}
