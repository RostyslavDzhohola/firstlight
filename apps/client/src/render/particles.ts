// "Digital matter is light" (SPEC §7.2 rule 4): additive glowing corpuscles. One instanced quad
// draw for everything: ambient motes drifting around the camera plus bursts from burst() for
// spawns, deaths, loot and teleports. CPU-updated instance buffers on both backends (the WebGL2
// fallback can't run real compute; a WebGPU compute path for High+ is not built yet).
// Max live particles follow the tier table; HDR colours exceed the bloom threshold on purpose.

import * as THREE from "three/webgpu";
import {
  attribute, cameraPosition, cameraProjectionMatrix, cameraViewMatrix, distance, float, length, positionGeometry,
  smoothstep, vec4,
} from "three/tsl";
import type { ResolvedSettings } from "./quality.ts";

export interface BurstOptions {
  /** Initial speed range (m/s). */
  speed?: [number, number];
  /** Lifetime range (s). */
  life?: [number, number];
  /** Size range (m). */
  size?: [number, number];
  /** HDR intensity multiplier (bloom). */
  intensity?: number;
  /** Upward drift along local up (m/s²). */
  lift?: number;
  /** Spread: 1 = sphere, 0 = straight up. */
  spread?: number;
}

const STRIDE = 4;

export class ParticleSystem {
  readonly mesh: THREE.Mesh;
  private geo: THREE.InstancedBufferGeometry;
  private posAttr: THREE.InstancedBufferAttribute;
  private colAttr: THREE.InstancedBufferAttribute;
  private capacity = 0;
  // Simulation state (structure of arrays).
  private px = new Float32Array(0);
  private py = new Float32Array(0);
  private pz = new Float32Array(0);
  private vx = new Float32Array(0);
  private vy = new Float32Array(0);
  private vz = new Float32Array(0);
  private life = new Float32Array(0);
  private maxLife = new Float32Array(0);
  private size = new Float32Array(0);
  private lift = new Float32Array(0);
  private cr = new Float32Array(0);
  private cg = new Float32Array(0);
  private cb = new Float32Array(0);
  private live = 0;
  // Motes.
  private moteCount = 0;
  private moteEnabled = true;
  private enabled = true;
  private readonly moteColor = new THREE.Color(1.0, 0.92, 0.7);
  private seed = 1;

  constructor(private readonly scene: THREE.Scene) {
    const g = ParticleSystem.makeGeometry(1);
    this.geo = g.geo;
    this.posAttr = g.pos;
    this.colAttr = g.col;

    const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false });
    m.name = "particles";
    const ip = attribute("iPos", "vec4");
    const ic = attribute("iCol", "vec4");
    const viewCenter = cameraViewMatrix.mul(vec4(ip.xyz, 1));
    const corner = positionGeometry.xy;
    m.vertexNode = cameraProjectionMatrix.mul(vec4(viewCenter.xyz.add(vec4(corner.mul(ip.w), 0, 0).xyz), 1));
    const r = length(corner);
    const soft = smoothstep(1.0, 0.0, r);
    // Fade with distance instead of fog (additive + fog would brighten).
    const far = smoothstep(140.0, 60.0, distance(ip.xyz, cameraPosition));
    m.colorNode = ic.rgb;
    m.opacityNode = ic.a.mul(soft.mul(soft)).mul(far).mul(float(1));
    this.mesh = new THREE.Mesh(this.geo, m);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 5;
    this.mesh.name = "particles";
    scene.add(this.mesh);
  }

  applySettings(s: ResolvedSettings) {
    this.enabled = s.on.particles;
    this.mesh.visible = this.enabled;
    this.moteEnabled = s.on.motes;
    const cap = s.particles;
    if (cap !== this.capacity) this.resize(cap);
    const wantMotes = this.moteEnabled ? Math.min(s.motes, Math.floor(cap / 4)) : 0;
    if (wantMotes !== this.moteCount) {
      // Motes occupy the first slots; rebuild them.
      this.live = 0;
      this.moteCount = wantMotes;
      this.motesNeedInit = true;
    }
  }

  private motesNeedInit = true;

  /**
   * A fresh geometry with its own quad attributes, so disposing an old one (which frees every
   * attribute it references) can't take buffers another geometry still uses.
   */
  private static makeGeometry(cap: number) {
    const quad = new THREE.PlaneGeometry(2, 2);
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = quad.index;
    geo.setAttribute("position", quad.getAttribute("position"));
    // Static usage + needsUpdate with update ranges: uploaded once per change (DynamicDrawUsage
    // would re-upload the whole buffer on every render in r186).
    const pos = new THREE.InstancedBufferAttribute(new Float32Array(cap * STRIDE), 4);
    const col = new THREE.InstancedBufferAttribute(new Float32Array(cap * STRIDE), 4);
    geo.setAttribute("iPos", pos);
    geo.setAttribute("iCol", col);
    geo.instanceCount = 0;
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    return { geo, pos, col };
  }

  private resize(cap: number) {
    this.capacity = cap;
    const mk = () => new Float32Array(cap);
    this.px = mk(); this.py = mk(); this.pz = mk();
    this.vx = mk(); this.vy = mk(); this.vz = mk();
    this.life = mk(); this.maxLife = mk(); this.size = mk(); this.lift = mk();
    this.cr = mk(); this.cg = mk(); this.cb = mk();
    this.live = 0;
    this.motesNeedInit = true;
    // New GPU buffers sized to the tier: swap in a new geometry, then free the old one.
    const old = this.geo;
    const g = ParticleSystem.makeGeometry(cap);
    this.geo = g.geo;
    this.posAttr = g.pos;
    this.colAttr = g.col;
    this.mesh.geometry = this.geo;
    old.dispose();
  }

  private rand() {
    // xorshift: cheap, deterministic enough for visuals.
    let x = this.seed;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.seed = x >>> 0;
    return this.seed / 4294967296;
  }

  /** Emit `count` glowing corpuscles at a planet-space position. Returns how many were spawned. */
  burst(position: THREE.Vector3, color: THREE.ColorRepresentation, count: number, opts: BurstOptions = {}): number {
    if (!this.enabled || this.capacity === 0) return 0;
    const c = new THREE.Color(color);
    const intensity = opts.intensity ?? 4;
    const [s0, s1] = opts.speed ?? [0.8, 3.2];
    const [l0, l1] = opts.life ?? [0.7, 1.6];
    const [z0, z1] = opts.size ?? [0.04, 0.11];
    const lift = opts.lift ?? 1.2;
    const spread = opts.spread ?? 1;
    const up = position.clone().normalize();
    let spawned = 0;
    for (let i = 0; i < count; i++) {
      let slot: number;
      if (this.live < this.capacity) slot = this.live++;
      else {
        // Full: recycle a random non-mote slot.
        if (this.capacity <= this.moteCount) return spawned;
        slot = this.moteCount + Math.floor(this.rand() * (this.capacity - this.moteCount));
      }
      // Random direction biased towards local up.
      let dx = this.rand() * 2 - 1, dy = this.rand() * 2 - 1, dz = this.rand() * 2 - 1;
      const dl = Math.hypot(dx, dy, dz) || 1;
      dx = (dx / dl) * spread + up.x * (1 - spread * 0.5);
      dy = (dy / dl) * spread + up.y * (1 - spread * 0.5);
      dz = (dz / dl) * spread + up.z * (1 - spread * 0.5);
      const sp = s0 + (s1 - s0) * this.rand();
      this.px[slot] = position.x; this.py[slot] = position.y; this.pz[slot] = position.z;
      this.vx[slot] = dx * sp; this.vy[slot] = dy * sp; this.vz[slot] = dz * sp;
      this.maxLife[slot] = this.life[slot] = l0 + (l1 - l0) * this.rand();
      this.size[slot] = z0 + (z1 - z0) * this.rand();
      this.lift[slot] = lift;
      const k = intensity * (0.7 + 0.6 * this.rand());
      this.cr[slot] = c.r * k; this.cg[slot] = c.g * k; this.cb[slot] = c.b * k;
      spawned++;
    }
    return spawned;
  }

  get liveCount() {
    return this.live;
  }

  /** Simulate and upload. `focus` = where motes gather (camera position). */
  update(dt: number, focus: THREE.Vector3, now: number) {
    if (!this.enabled || this.capacity === 0) {
      this.geo.instanceCount = 0;
      return;
    }
    const up = focus.clone().normalize();
    const M = this.moteCount;
    if (this.motesNeedInit) {
      this.motesNeedInit = false;
      this.live = Math.max(this.live, M);
      for (let i = 0; i < M; i++) this.spawnMote(i, focus, up, true);
    }
    const P = this.posAttr.array as Float32Array;
    const C = this.colAttr.array as Float32Array;
    const t = now * 0.001;
    // Motes: slow drift + bob, respawn when too far from the focus.
    for (let i = 0; i < M; i++) {
      const ph = i * 1.37;
      this.px[i] += (this.vx[i]! + Math.sin(t * 0.7 + ph) * 0.08) * dt;
      this.py[i] += (this.vy[i]! + Math.cos(t * 0.6 + ph) * 0.08) * dt;
      this.pz[i] += (this.vz[i]! + Math.sin(t * 0.5 + ph * 1.3) * 0.08) * dt;
      const dx = this.px[i]! - focus.x, dy = this.py[i]! - focus.y, dz = this.pz[i]! - focus.z;
      if (dx * dx + dy * dy + dz * dz > 26 * 26) this.spawnMote(i, focus, up, false);
      const tw = 0.55 + 0.45 * Math.sin(t * 2.1 + ph * 2.7);
      const o = i * 4;
      P[o] = this.px[i]!; P[o + 1] = this.py[i]!; P[o + 2] = this.pz[i]!; P[o + 3] = this.size[i]!;
      C[o] = this.cr[i]!; C[o + 1] = this.cg[i]!; C[o + 2] = this.cb[i]!; C[o + 3] = tw;
    }
    // Bursts.
    const drag = Math.exp(-1.6 * dt);
    let i = M;
    while (i < this.live) {
      this.life[i] -= dt;
      if (this.life[i]! <= 0) {
        // Swap-remove with the last live particle.
        const last = --this.live;
        if (i !== last) this.copy(last, i);
        continue;
      }
      const lx = this.px[i]!, ly = this.py[i]!, lz = this.pz[i]!;
      const l = Math.hypot(lx, ly, lz) || 1;
      const lift = this.lift[i]! * dt;
      this.vx[i] = this.vx[i]! * drag + (lx / l) * lift;
      this.vy[i] = this.vy[i]! * drag + (ly / l) * lift;
      this.vz[i] = this.vz[i]! * drag + (lz / l) * lift;
      this.px[i] = lx + this.vx[i]! * dt;
      this.py[i] = ly + this.vy[i]! * dt;
      this.pz[i] = lz + this.vz[i]! * dt;
      const a = this.life[i]! / this.maxLife[i]!;
      const o = i * 4;
      P[o] = this.px[i]!; P[o + 1] = this.py[i]!; P[o + 2] = this.pz[i]!; P[o + 3] = this.size[i]! * (0.4 + 0.6 * a);
      C[o] = this.cr[i]!; C[o + 1] = this.cg[i]!; C[o + 2] = this.cb[i]!; C[o + 3] = Math.min(1, a * 1.6);
      i++;
    }
    this.geo.instanceCount = this.live;
    if (this.live > 0) {
      this.posAttr.clearUpdateRanges();
      this.posAttr.addUpdateRange(0, this.live * 4);
      this.posAttr.needsUpdate = true;
      this.colAttr.clearUpdateRanges();
      this.colAttr.addUpdateRange(0, this.live * 4);
      this.colAttr.needsUpdate = true;
    }
  }

  private copy(from: number, to: number) {
    for (const a of [this.px, this.py, this.pz, this.vx, this.vy, this.vz, this.life, this.maxLife, this.size, this.lift, this.cr, this.cg, this.cb]) {
      a[to] = a[from]!;
    }
  }

  private spawnMote(i: number, focus: THREE.Vector3, up: THREE.Vector3, anywhere: boolean) {
    // Random point in a 24 m disc around the focus, 0.3–5 m above it.
    const r = (anywhere ? Math.sqrt(this.rand()) : 0.75 + 0.25 * this.rand()) * 24;
    let ax = this.rand() * 2 - 1, ay = this.rand() * 2 - 1, az = this.rand() * 2 - 1;
    const d = ax * up.x + ay * up.y + az * up.z;
    ax -= up.x * d; ay -= up.y * d; az -= up.z * d;
    const al = Math.hypot(ax, ay, az) || 1;
    const h = 0.3 + this.rand() * 4.7 - 1.6;
    this.px[i] = focus.x + (ax / al) * r + up.x * h;
    this.py[i] = focus.y + (ay / al) * r + up.y * h;
    this.pz[i] = focus.z + (az / al) * r + up.z * h;
    this.vx[i] = (this.rand() - 0.5) * 0.25 + up.x * 0.05;
    this.vy[i] = (this.rand() - 0.5) * 0.25 + up.y * 0.05;
    this.vz[i] = (this.rand() - 0.5) * 0.25 + up.z * 0.05;
    this.size[i] = 0.025 + this.rand() * 0.045;
    const k = 1.6 + this.rand() * 1.6;
    this.cr[i] = this.moteColor.r * k; this.cg[i] = this.moteColor.g * k; this.cb[i] = this.moteColor.b * k;
    this.life[i] = this.maxLife[i] = 1;
  }

  /** Mote tint per body (warm light by default). */
  setMoteColor(c: THREE.ColorRepresentation) {
    this.moteColor.set(c);
    this.motesNeedInit = true;
  }

  dispose() {
    this.scene.remove(this.mesh);
    this.geo.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}
