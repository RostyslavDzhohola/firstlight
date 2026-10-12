// Digital-matter light particles (film rule: spawns and deaths are made of light): additive square
// pixels (Brightbits) or light motes, CPU-simulated, one InstancedMesh each (2 draw calls total).

import * as THREE from "three/webgpu";

const CAP = 900;

class Pool {
  readonly mesh: THREE.InstancedMesh;
  private readonly pos = new Float32Array(CAP * 3);
  private readonly vel = new Float32Array(CAP * 3);
  private readonly col = new Float32Array(CAP * 3);
  private readonly life = new Float32Array(CAP);
  private readonly maxLife = new Float32Array(CAP);
  private readonly size = new Float32Array(CAP);
  private readonly colors: Float32Array;
  private n = 0;
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly v = new THREE.Vector3();
  private readonly s = new THREE.Vector3();

  constructor(geo: THREE.BufferGeometry, material: THREE.Material) {
    this.mesh = new THREE.InstancedMesh(geo, material, CAP);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.colors = new Float32Array(CAP * 3);
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(this.colors, 3);
    this.mesh.count = 0;
    this.mesh.visible = false;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 3;
  }

  emit(x: number, y: number, z: number, vx: number, vy: number, vz: number, r: number, g: number, b: number, life: number, size: number) {
    let i = this.n;
    if (i >= CAP) {
      // Recycle the oldest-looking slot.
      i = Math.floor(Math.random() * CAP);
    } else this.n++;
    this.pos.set([x, y, z], i * 3);
    this.vel.set([vx, vy, vz], i * 3);
    this.col.set([r, g, b], i * 3);
    this.life[i] = life;
    this.maxLife[i] = life;
    this.size[i] = size;
  }

  update(dt: number) {
    let w = 0;
    for (let i = 0; i < this.n; i++) {
      const l = this.life[i]! - dt;
      if (l <= 0) continue;
      // Compact live particles to the front.
      if (w !== i) {
        this.pos.copyWithin(w * 3, i * 3, i * 3 + 3);
        this.vel.copyWithin(w * 3, i * 3, i * 3 + 3);
        this.col.copyWithin(w * 3, i * 3, i * 3 + 3);
        this.maxLife[w] = this.maxLife[i]!;
        this.size[w] = this.size[i]!;
      }
      this.life[w] = l;
      const o = w * 3;
      const drag = Math.exp(-1.6 * dt);
      this.vel[o] = this.vel[o]! * drag;
      this.vel[o + 1] = this.vel[o + 1]! * drag;
      this.vel[o + 2] = this.vel[o + 2]! * drag;
      this.pos[o] = this.pos[o]! + this.vel[o]! * dt;
      this.pos[o + 1] = this.pos[o + 1]! + this.vel[o + 1]! * dt;
      this.pos[o + 2] = this.pos[o + 2]! + this.vel[o + 2]! * dt;
      const k = l / this.maxLife[w]!;
      const sz = this.size[w]! * (0.35 + 0.65 * k);
      this.v.set(this.pos[o]!, this.pos[o + 1]!, this.pos[o + 2]!);
      this.s.set(sz, sz, sz);
      this.m.compose(this.v, this.q, this.s);
      this.m.toArray(this.mesh.instanceMatrix.array as Float32Array, w * 16);
      const fade = Math.min(1, k * 1.6);
      this.colors[o] = this.col[o]! * fade;
      this.colors[o + 1] = this.col[o + 1]! * fade;
      this.colors[o + 2] = this.col[o + 2]! * fade;
      w++;
    }
    this.n = w;
    this.mesh.count = w;
    this.mesh.visible = w > 0;
    if (w > 0) {
      this.mesh.instanceMatrix.clearUpdateRanges();
      this.mesh.instanceMatrix.addUpdateRange(0, w * 16);
      this.mesh.instanceMatrix.needsUpdate = true;
      const c = this.mesh.instanceColor!;
      c.clearUpdateRanges();
      c.addUpdateRange(0, w * 3);
      c.needsUpdate = true;
    }
  }
}

export class LightParticles {
  readonly group = new THREE.Group();
  private readonly pixels: Pool;
  private readonly motes: Pool;
  private readonly material: THREE.MeshBasicNodeMaterial;
  private readonly geos: THREE.BufferGeometry[];
  private readonly tmp = new THREE.Color();
  enabled = true;

  constructor() {
    this.material = new THREE.MeshBasicNodeMaterial({ transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
    this.geos = [new THREE.BoxGeometry(1, 1, 1), new THREE.IcosahedronGeometry(0.5, 0)];
    this.pixels = new Pool(this.geos[0]!, this.material);
    this.motes = new Pool(this.geos[1]!, this.material);
    this.group.add(this.pixels.mesh, this.motes.mesh);
  }

  /**
   * Burst of light around `at` (planet space) rising along local up. `inward` makes them converge
   * toward the point instead (materialise).
   */
  burst(at: THREE.Vector3, colorHex: number, count: number, opts: { pixels?: boolean; radius?: number; height?: number; speed?: number; size?: number; life?: number; inward?: boolean; intensity?: number } = {}) {
    if (!this.enabled) return;
    const pool = opts.pixels ? this.pixels : this.motes;
    const up = at.clone().normalize();
    const ref = Math.abs(up.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
    const t1 = new THREE.Vector3().crossVectors(up, ref).normalize();
    const t2 = new THREE.Vector3().crossVectors(up, t1);
    const c = this.tmp.setHex(colorHex).multiplyScalar(opts.intensity ?? 3);
    const radius = opts.radius ?? 0.6;
    const height = opts.height ?? 1.2;
    const speed = opts.speed ?? 2.2;
    const life = opts.life ?? 0.9;
    const size = opts.size ?? (opts.pixels ? 0.14 : 0.1);
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = radius * Math.sqrt(Math.random());
      const h = Math.random() * height;
      const ox = t1.x * Math.cos(a) * r + t2.x * Math.sin(a) * r + up.x * h;
      const oy = t1.y * Math.cos(a) * r + t2.y * Math.sin(a) * r + up.y * h;
      const oz = t1.z * Math.cos(a) * r + t2.z * Math.sin(a) * r + up.z * h;
      let vx: number, vy: number, vz: number;
      if (opts.inward) {
        // Start out on a shell and fly to the body.
        const sx = ox * 3.2, sy = oy * 3.2, sz = oz * 3.2;
        const L = life * 0.9;
        vx = (ox - sx) / L * 1.6;
        vy = (oy - sy) / L * 1.6;
        vz = (oz - sz) / L * 1.6;
        pool.emit(at.x + sx, at.y + sy, at.z + sz, vx, vy, vz, c.r, c.g, c.b, life, size);
        continue;
      }
      const s = speed * (0.4 + Math.random() * 0.8);
      vx = (ox / Math.max(0.2, radius)) * s * 0.4 + up.x * s;
      vy = (oy / Math.max(0.2, radius)) * s * 0.4 + up.y * s;
      vz = (oz / Math.max(0.2, radius)) * s * 0.4 + up.z * s;
      pool.emit(at.x + ox, at.y + oy, at.z + oz, vx, vy, vz, c.r, c.g, c.b, life * (0.6 + Math.random() * 0.6), size * (0.7 + Math.random() * 0.6));
    }
  }

  update(dt: number) {
    this.pixels.update(dt);
    this.motes.update(dt);
  }

  dispose() {
    this.group.removeFromParent();
    this.pixels.mesh.dispose();
    this.motes.mesh.dispose();
    for (const g of this.geos) g.dispose();
    this.material.dispose();
  }
}
