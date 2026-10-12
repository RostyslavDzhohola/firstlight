// Weather effects (SPEC §6.14 #3). "Glass box" rain: streaks live in a box around the camera
// (aligned to local up), not world-wide; drop positions are a pure function of per-instance seeds
// and a few uniforms, wrapped so they stay put in the world as the camera moves. One instanced draw
// serves rain, drizzle and dust (Meridian): only uniforms change, so weather changes never
// recompile anything and nothing is allocated per frame. Lightning bolts are a far-off emissive
// ribbon rebuilt into a preallocated buffer per strike (one more draw while a bolt shows).

import * as THREE from "three/webgpu";
import {
  abs, attribute, cameraPosition, cross, distance, float, Fn, fract, length, max, mix, normalize, positionGeometry,
  positionPrevious, renderGroup, smoothstep, uniform, vec2, vec3,
} from "three/tsl";
import { hash01 } from "@firstlight/shared";
import { localFrame, skyDir, type V3 } from "./sunFrame.ts";

export const weatherUniforms = {
  center: uniform(new THREE.Vector3()).setGroup(renderGroup),
  east: uniform(new THREE.Vector3(1, 0, 0)).setGroup(renderGroup),
  north: uniform(new THREE.Vector3(0, 0, 1)).setGroup(renderGroup),
  up: uniform(new THREE.Vector3(0, 1, 0)).setGroup(renderGroup),
  /** Half width of the box (m) and its height (m). */
  half: uniform(16).setGroup(renderGroup),
  height: uniform(14).setGroup(renderGroup),
  /** World-anchored wrap offsets along east/north (fractions of the box). */
  offE: uniform(0).setGroup(renderGroup),
  offN: uniform(0).setGroup(renderGroup),
  /** Fall progress: accumulated metres fallen / box height (CPU-integrated, so speed changes don't jump). */
  fallPhase: uniform(0).setGroup(renderGroup),
  /** Direction of motion of a drop (world, normalised) and streak size (m). */
  motion: uniform(new THREE.Vector3(0, -1, 0)).setGroup(renderGroup),
  len: uniform(0.55).setGroup(renderGroup),
  width: uniform(0.012).setGroup(renderGroup),
  color: uniform(new THREE.Color(0.6, 0.65, 0.72)).setGroup(renderGroup),
  alpha: uniform(0.35).setGroup(renderGroup),
  /** 0 = rain streaks, 1 = dust motes (round, floating low). */
  dust: uniform(0).setGroup(renderGroup),
  /** Bolt brightness (lightning). */
  bolt: uniform(0).setGroup(renderGroup),
};

const u = weatherUniforms;

function precipitationMaterial(): THREE.MeshBasicNodeMaterial {
  const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, fog: false, side: THREE.DoubleSide });
  m.name = "weatherDrops";
  const s = attribute("seed", "vec4");
  const lx = fract(s.x.add(u.offE)).sub(0.5);
  const lz = fract(s.y.add(u.offN)).sub(0.5);
  // Each drop falls at its own speed (0.85–1.15×); wraps from the top of the box to the bottom.
  const ly = fract(s.z.sub(u.fallPhase.mul(s.w.mul(0.3).add(0.85))));
  // Rain: −25%..75% of the box height around the eye. Dust: a low band above the ground.
  const yRain = ly.sub(0.25).mul(u.height);
  const yDust = ly.mul(0.45).sub(0.12).mul(u.height);
  const y = mix(yRain, yDust, u.dust);
  const base = u.center.add(u.east.mul(lx.mul(u.half.mul(2)))).add(u.north.mul(lz.mul(u.half.mul(2)))).add(u.up.mul(y));
  const view = normalize(base.sub(cameraPosition));
  const side = normalize(cross(u.motion, view));
  const along = normalize(mix(u.motion, cross(view, side), u.dust));
  const L = mix(u.len, u.width, u.dust);
  m.positionNode = Fn((builder: any) => {
    const p = base.add(along.mul(positionGeometry.y.sub(0.5).mul(L))).add(side.mul(positionGeometry.x.mul(u.width)));
    if (builder?.needsPreviousData?.()) positionPrevious.assign(p);
    return p;
  })();
  const q = positionGeometry.xy;
  // Rain: thin, tapered streak. Dust: a soft round mote.
  const streak = float(1).sub(abs(q.x).mul(2)).mul(smoothstep(0.0, 0.25, q.y)).mul(smoothstep(1.0, 0.6, q.y));
  const mote = smoothstep(0.5, 0.0, length(vec2(q.x, q.y.sub(0.5))));
  const shape = mix(streak, mote, u.dust);
  const edge = smoothstep(1.0, 0.65, max(abs(lx), abs(lz)).mul(2));
  const near = smoothstep(0.35, 1.6, distance(base, cameraPosition));
  m.colorNode = u.color;
  m.opacityNode = shape.mul(edge).mul(near).mul(u.alpha);
  return m;
}

function boltMaterial(): THREE.MeshBasicNodeMaterial {
  const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, fog: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
  m.name = "lightningBolt";
  m.colorNode = vec3(5.5, 6.0, 8.0).mul(u.bolt);
  m.opacityNode = u.bolt.min(1);
  return m;
}

const BOLT_SEGMENTS = 40;

/** The instanced drop quad with `n` per-instance seeds (none for n = 0: nothing draws then). */
function dropGeometry(n: number): THREE.InstancedBufferGeometry {
  const quad = new THREE.PlaneGeometry(1, 1);
  quad.translate(0, 0.5, 0); // y in [0, 1]
  const geo = new THREE.InstancedBufferGeometry();
  geo.index = quad.index;
  geo.setAttribute("position", quad.getAttribute("position"));
  if (n > 0) {
    const seeds = new Float32Array(n * 4);
    for (let i = 0; i < n * 4; i++) seeds[i] = hash01(i, 0x7a1d, 0x5eed);
    geo.setAttribute("seed", new THREE.InstancedBufferAttribute(seeds, 4));
  }
  geo.instanceCount = 0;
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
  return geo;
}

export class WeatherFx {
  readonly drops: THREE.Mesh;
  readonly bolt: THREE.Mesh;
  private geo: THREE.InstancedBufferGeometry;
  private readonly boltGeo: THREE.BufferGeometry;
  private readonly boltPos: Float32Array;
  private capacity = 0;
  private readonly east: V3 = [1, 0, 0];
  private readonly north: V3 = [0, 0, 1];
  private readonly tmp: V3 = [0, 0, 0];
  /** Accumulated wind drift (m) along east/north, for the wrap offsets. */
  private driftE = 0;
  private driftN = 0;
  private boltVisible = false;

  constructor(private readonly scene: THREE.Scene) {
    this.geo = dropGeometry(0);
    this.drops = new THREE.Mesh(this.geo, precipitationMaterial());
    this.drops.frustumCulled = false;
    this.drops.renderOrder = 6;
    this.drops.name = "weatherDrops";
    this.drops.matrixAutoUpdate = false;
    scene.add(this.drops);

    // Bolt ribbon: BOLT_SEGMENTS quads, positions rebuilt per strike.
    this.boltPos = new Float32Array(BOLT_SEGMENTS * 4 * 3);
    const idx: number[] = [];
    for (let i = 0; i < BOLT_SEGMENTS; i++) {
      const o = i * 4;
      idx.push(o, o + 1, o + 2, o + 2, o + 1, o + 3);
    }
    this.boltGeo = new THREE.BufferGeometry();
    this.boltGeo.setAttribute("position", new THREE.BufferAttribute(this.boltPos, 3));
    this.boltGeo.setIndex(idx);
    this.boltGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    this.bolt = new THREE.Mesh(this.boltGeo, boltMaterial());
    this.bolt.frustumCulled = false;
    this.bolt.visible = false;
    this.bolt.renderOrder = -8;
    this.bolt.name = "lightningBolt";
    scene.add(this.bolt);
  }

  /**
   * Size the seed buffer for the tier (rare). A whole new geometry: three frees GPU buffers per
   * geometry, so swapping only the attribute would leave the old buffer behind.
   */
  setCapacity(n: number) {
    if (n === this.capacity) return;
    this.capacity = n;
    const old = this.geo;
    this.geo = dropGeometry(n);
    this.geo.instanceCount = Math.min(old.instanceCount, n);
    this.drops.geometry = this.geo;
    old.dispose();
  }

  /**
   * Per frame. `kind`: rain-like (0) or dust (1); `amount` 0..1 scales the drop count; wind in m/s
   * (east, north); colour/alpha as lit by the current sky. No allocation.
   */
  update(dt: number, camera: THREE.Camera, amount: number, kind: number, fall: number, windE: number, windN: number, len: number, width: number, alpha: number, color: THREE.Color) {
    const n = Math.round(this.capacity * Math.max(0, Math.min(1, amount)));
    this.geo.instanceCount = n;
    this.drops.visible = n > 0;
    if (n === 0) return;
    const c = camera.position;
    const l = c.length() || 1;
    const ux = c.x / l, uy = c.y / l, uz = c.z / l;
    localFrame(ux, uy, uz, this.east, this.north);
    u.center.value.copy(c);
    u.up.value.set(ux, uy, uz);
    u.east.value.set(this.east[0], this.east[1], this.east[2]);
    u.north.value.set(this.north[0], this.north[1], this.north[2]);
    const box = 2 * u.half.value;
    // World anchoring: the box slides with the camera, the drops don't.
    this.driftE += windE * dt;
    this.driftN += windN * dt;
    const camE = c.x * this.east[0] + c.y * this.east[1] + c.z * this.east[2];
    const camN = c.x * this.north[0] + c.y * this.north[1] + c.z * this.north[2];
    u.offE.value = (this.driftE - camE) / box;
    u.offN.value = (this.driftN - camN) / box;
    u.fallPhase.value = (u.fallPhase.value + (fall * dt) / u.height.value) % 1000;
    // Motion direction: down plus wind.
    const mx = -ux * fall + this.east[0] * windE + this.north[0] * windN;
    const my = -uy * fall + this.east[1] * windE + this.north[1] * windN;
    const mz = -uz * fall + this.east[2] * windE + this.north[2] * windN;
    const ml = Math.hypot(mx, my, mz) || 1;
    u.motion.value.set(mx / ml, my / ml, mz / ml);
    u.dust.value = kind;
    u.len.value = len;
    u.width.value = width;
    u.alpha.value = alpha;
    u.color.value.copy(color);
  }

  /**
   * Build a bolt for a strike in the local sky frame of the camera (azimuth, distance) and show it.
   * The ribbon hangs from ~20° above the horizon to just below it. Deterministic from `seed`.
   */
  strike(camera: THREE.Camera, az: number, distance: number, seed: number) {
    const c = camera.position;
    const l = c.length() || 1;
    const ux = c.x / l, uy = c.y / l, uz = c.z / l;
    const top = skyDir(ux, uy, uz, 0.34 + 0.12 * hash01(seed, 3), az, this.tmp);
    const tx = top[0] * distance, ty = top[1] * distance, tz = top[2] * distance;
    const bot = skyDir(ux, uy, uz, -0.03, az + (hash01(seed, 4) - 0.5) * 0.08, this.tmp);
    const bx = bot[0] * distance, by = bot[1] * distance, bz = bot[2] * distance;
    // Side axis for the ribbon: perpendicular to the bolt and the view direction.
    const dx = bx - tx, dy = by - ty, dz = bz - tz;
    let sx = dy * tz - dz * ty, sy = dz * tx - dx * tz, sz = dx * ty - dy * tx;
    const sl = Math.hypot(sx, sy, sz) || 1;
    sx /= sl; sy /= sl; sz /= sl;
    const w = distance * 0.0035;
    const jag = distance * 0.025;
    let px = tx, py = ty, pz = tz;
    for (let i = 0; i < BOLT_SEGMENTS; i++) {
      const t = (i + 1) / BOLT_SEGMENTS;
      const k = (hash01(seed, 10 + i) - 0.5) * jag * (1 - t * 0.5);
      const nx = tx + dx * t + sx * k, ny = ty + dy * t + sy * k, nz = tz + dz * t + sz * k;
      const width = w * (1 - t * 0.6);
      const o = i * 12;
      const P = this.boltPos;
      P[o] = px - sx * width; P[o + 1] = py - sy * width; P[o + 2] = pz - sz * width;
      P[o + 3] = px + sx * width; P[o + 4] = py + sy * width; P[o + 5] = pz + sz * width;
      P[o + 6] = nx - sx * width; P[o + 7] = ny - sy * width; P[o + 8] = nz - sz * width;
      P[o + 9] = nx + sx * width; P[o + 10] = ny + sy * width; P[o + 11] = nz + sz * width;
      px = nx; py = ny; pz = nz;
    }
    (this.boltGeo.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
    this.bolt.position.copy(c);
    this.boltVisible = true;
  }

  /** Per frame: bolt brightness (0 hides it); keeps it hung in the sky as the camera moves. */
  updateBolt(camera: THREE.Camera, brightness: number) {
    u.bolt.value = brightness;
    const show = this.boltVisible && brightness > 0.01;
    this.bolt.visible = show;
    if (!show) {
      if (brightness <= 0.01) this.boltVisible = false;
      return;
    }
    this.bolt.position.copy(camera.position);
  }

  dispose() {
    this.scene.remove(this.drops, this.bolt);
    this.geo.dispose();
    this.boltGeo.dispose();
    (this.drops.material as THREE.Material).dispose();
    (this.bolt.material as THREE.Material).dispose();
  }
}
