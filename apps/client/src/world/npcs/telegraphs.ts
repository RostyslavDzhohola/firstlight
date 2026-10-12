// Telegraph decals on the ground (content §3.1 language: colour + shape, never colour alone):
// red wedge/line = dodge, amber = ranged lock, teal ring = step out, violet sigil = split curse.
// Each decal is a small terrain-conforming grid (sector, annulus or strip). All decals share ONE
// material: colour, timing (start/end), style and edge emphasis ride on vertex attributes and a shared
// clock uniform drives the fill, so no material is created or compiled during combat. A hidden
// sample decal is kept in the scene so the loading-screen warm-up compiles the pipeline.

import * as THREE from "three/webgpu";
import { abs, attribute, clamp, float, fract, max, mix, sin, smoothstep, step, uniform, uv } from "three/tsl";
import type { Terrain } from "@firstlight/shared";
import { SHAPE_CODE, type NpcAttackMsg } from "@firstlight/shared/content/npcs";

export const TELEGRAPH_COLORS = [0xff3b3b, 0xffb000, 0x2ee6d6, 0xffffff, 0xb45cff];
const LIFT = 0.14;

/** The shared decal material and its clock (seconds since the system started). */
function makeSharedMaterial() {
  const clock = uniform(0);
  const tele = attribute("aTele", "vec4"); // start s, end s, style (0 fill · 1 ring · 2 sigil), edge emphasis
  const col = attribute("aColor", "vec3");
  const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide });
  m.polygonOffset = true;
  m.polygonOffsetFactor = -2;
  m.polygonOffsetUnits = -4;
  const u = uv();
  const radial = u.x;
  const lateral = abs(u.y.mul(2).sub(1));
  const prog = clamp(clock.sub(tele.x).div(max(tele.y.sub(tele.x), 0.001)), 0, 1);
  const rim = max(smoothstep(0.84, 0.97, radial), smoothstep(0.86, 0.99, lateral).mul(tele.w));
  const fill = step(radial, prog).mul(0.32);
  const ringStyle = step(0.5, tele.z).mul(step(tele.z, 1.5));
  const sigilStyle = step(1.5, tele.z);
  const ring = smoothstep(0.55, 0.9, radial).mul(ringStyle).mul(0.3);
  const sigil = step(0.86, fract(u.y.mul(10))).mul(step(0.35, radial)).mul(step(radial, 0.8)).mul(sigilStyle).mul(0.55);
  // Gentle pulse during the wind-up, a bright flash at the moment of impact.
  const pulse = mix(sin(clock.mul(16.6)).mul(0.15).add(0.85), float(1.6), step(tele.y, clock));
  m.colorNode = col.mul(2.2);
  m.opacityNode = float(0.16).add(fill).add(rim.mul(0.7)).add(ring).add(sigil).mul(pulse);
  return { material: m, clock };
}

interface Decal {
  npc: string;
  mesh: THREE.Mesh;
  start: number;
  end: number;
  color: number;
  style: number;
  edge: number;
  /** Tracked player whose position re-centres the decal until lock. */
  track: string | null;
  lastBuild: number;
  build: (centre: THREE.Vector3) => THREE.BufferGeometry;
}

/** Positions on the terrain around `centre` (planet space) offset along tangents. */
class Ground {
  constructor(private terrain: Terrain, private water: number) {}
  place(cx: number, cy: number, cz: number, out: Float32Array, o: number) {
    const R = this.terrain.body.radius;
    const l = Math.hypot(cx, cy, cz);
    const ux = cx / l, uy = cy / l, uz = cz / l;
    const h = Math.max(this.terrain.groundHeight(ux, uy, uz), this.water) + LIFT;
    out[o] = ux * (R + h);
    out[o + 1] = uy * (R + h);
    out[o + 2] = uz * (R + h);
  }
}

function frame(centre: THREE.Vector3, dir: THREE.Vector3) {
  const up = centre.clone().normalize();
  let f = dir.clone().addScaledVector(up, -dir.dot(up));
  if (f.lengthSq() < 1e-6) {
    const ref = Math.abs(up.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
    f = new THREE.Vector3().crossVectors(up, ref);
  }
  f.normalize();
  const side = new THREE.Vector3().crossVectors(up, f);
  return { up, f, side };
}

function sectorGeometry(g: Ground, centre: THREE.Vector3, dir: THREE.Vector3, inner: number, outer: number, angleDeg: number): THREE.BufferGeometry {
  const { f, side } = frame(centre, dir);
  const full = angleDeg >= 359;
  const ang = (Math.min(360, angleDeg) * Math.PI) / 180;
  const rN = outer > 30 ? 10 : 6;
  const aN = Math.max(6, Math.ceil(Math.min(360, angleDeg) / (outer > 30 ? 3 : 10)));
  const pos = new Float32Array((rN + 1) * (aN + 1) * 3);
  const uvs = new Float32Array((rN + 1) * (aN + 1) * 2);
  const idx: number[] = [];
  for (let j = 0; j <= rN; j++) {
    const r = inner + ((outer - inner) * j) / rN;
    for (let i = 0; i <= aN; i++) {
      const th = -ang / 2 + (ang * i) / aN;
      const ox = f.x * Math.cos(th) * r + side.x * Math.sin(th) * r;
      const oy = f.y * Math.cos(th) * r + side.y * Math.sin(th) * r;
      const oz = f.z * Math.cos(th) * r + side.z * Math.sin(th) * r;
      const v = j * (aN + 1) + i;
      g.place(centre.x + ox, centre.y + oy, centre.z + oz, pos, v * 3);
      uvs[v * 2] = (r - inner) / Math.max(1e-3, outer - inner) * (inner > 0 ? 1 : 1);
      uvs[v * 2 + 1] = full ? 0.5 : i / aN;
      if (j < rN && i < aN) {
        const a = v, b = v + 1, c = v + aN + 1, d = v + aN + 2;
        idx.push(a, c, b, b, c, d);
      }
    }
  }
  if (inner > 0) for (let v = 0; v < (rN + 1) * (aN + 1); v++) uvs[v * 2] = 0.3 + 0.7 * uvs[v * 2]!;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  geo.setIndex(idx);
  geo.computeBoundingSphere();
  return geo;
}

function stripGeometry(g: Ground, origin: THREE.Vector3, dir: THREE.Vector3, length: number, width: number): THREE.BufferGeometry {
  const { f, side } = frame(origin, dir);
  const lN = Math.max(2, Math.ceil(length / 1.5));
  const wN = 2;
  const pos = new Float32Array((lN + 1) * (wN + 1) * 3);
  const uvs = new Float32Array((lN + 1) * (wN + 1) * 2);
  const idx: number[] = [];
  for (let j = 0; j <= lN; j++) {
    const a = (length * j) / lN;
    for (let i = 0; i <= wN; i++) {
      const b = -width / 2 + (width * i) / wN;
      const v = j * (wN + 1) + i;
      g.place(origin.x + f.x * a + side.x * b, origin.y + f.y * a + side.y * b, origin.z + f.z * a + side.z * b, pos, v * 3);
      uvs[v * 2] = j / lN;
      uvs[v * 2 + 1] = i / wN;
      if (j < lN && i < wN) {
        const p = v, q = v + 1, r = v + wN + 1, s = v + wN + 2;
        idx.push(p, r, q, q, r, s);
      }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  geo.setIndex(idx);
  geo.computeBoundingSphere();
  return geo;
}

export class Telegraphs {
  readonly group = new THREE.Group();
  private readonly decals: Decal[] = [];
  private readonly ground: Ground;
  private readonly shared = makeSharedMaterial();
  private readonly t0 = performance.now();
  private readonly tmpColor = new THREE.Color();

  constructor(terrain: Terrain, water: number, private readonly playerPos: (id: string) => THREE.Vector3 | null) {
    this.ground = new Ground(terrain, water);
    // Hidden sample for the warm-up pass (warmup() forces hidden meshes visible for one compile).
    const sample = new THREE.BufferGeometry();
    sample.setAttribute("position", new THREE.BufferAttribute(new Float32Array([0, 0, 0, 0.01, 0, 0, 0, 0.01, 0]), 3));
    sample.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(6), 2));
    sample.setAttribute("aTele", new THREE.BufferAttribute(new Float32Array(12), 4));
    sample.setAttribute("aColor", new THREE.BufferAttribute(new Float32Array(9), 3));
    const warm = new THREE.Mesh(sample, this.shared.material);
    warm.visible = false;
    warm.frustumCulled = false;
    this.group.add(warm);
  }

  /** Seconds on the shared decal clock for a performance.now() time. */
  private secs(t: number): number {
    return (t - this.t0) / 1000;
  }

  get count(): number {
    return this.decals.length;
  }

  /** Handle an npcAtk message; returns the telegraph duration (ms) for the model's wind-up pose. */
  add(m: NpcAttackMsg, now: number) {
    if (m.a === -1) {
      this.cancel(m.id);
      return;
    }
    const sh = m.sh;
    const color = TELEGRAPH_COLORS[m.c] ?? TELEGRAPH_COLORS[0]!;
    const origin = new THREE.Vector3(m.x, m.y, m.z);
    const dir = new THREE.Vector3(m.dx, m.dy, m.dz);
    const pts: THREE.Vector3[] = [];
    if (m.pts) for (let i = 0; i + 2 < m.pts.length; i += 3) pts.push(new THREE.Vector3(m.pts[i], m.pts[i + 1], m.pts[i + 2]));
    // A lock message for a tracked attack replaces its reticles.
    if (m.pts && !m.tg) this.cancel(m.id, (d) => d.track !== null);
    const end = now + m.ms;
    const g = this.ground;
    switch (sh) {
      case SHAPE_CODE.arc:
      case SHAPE_CODE.beam:
        this.spawn(m.id, color, now, end, null, 0, m.ang >= 359 ? 0 : 1, () => sectorGeometry(g, origin, dir, 0, m.r, m.ang || 90), origin);
        break;
      case SHAPE_CODE.ring:
        this.spawn(m.id, color, now, end, null, 1, 0, () => sectorGeometry(g, origin, dir, m.w || 0, m.r, 360), origin);
        break;
      case SHAPE_CODE.band:
        this.spawn(m.id, color, now, end, null, 1, 1, () => sectorGeometry(g, origin, dir, m.w, m.r, m.ang || 120), origin);
        break;
      case SHAPE_CODE.line:
      case SHAPE_CODE.charge:
        this.spawn(m.id, color, now, end, null, 0, 1, () => stripGeometry(g, origin, dir, m.l || 6, m.w || m.r * 2 || 1.5), origin);
        break;
      case SHAPE_CODE.split:
        this.spawn(m.id, color, now, end, null, 2, 0, () => sectorGeometry(g, origin, dir, 0, m.r, 360), origin);
        break;
      case SHAPE_CODE.circle:
      case SHAPE_CODE.leap:
      case SHAPE_CODE.field:
      case SHAPE_CODE.pull:
      case SHAPE_CODE.raise: {
        const centres = pts.length ? pts : [origin];
        const style = sh === SHAPE_CODE.pull || sh === SHAPE_CODE.field ? 1 : sh === SHAPE_CODE.raise ? 2 : 0;
        centres.forEach((c, i) => {
          const track = m.tg?.[i] ?? null;
          this.spawn(m.id, color, now, end, track, style, 0, (centre) => sectorGeometry(g, centre, dir, 0, m.r, 360), c);
        });
        break;
      }
      default:
        // bolt / burst / zap / tag: drawn as a lock-on line or a wind-up flash by the renderer.
        break;
    }
  }

  private spawn(npc: string, color: number, start: number, end: number, track: string | null, style: number, edge: number, build: (c: THREE.Vector3) => THREE.BufferGeometry, centre: THREE.Vector3) {
    const d: Decal = { npc, mesh: null as unknown as THREE.Mesh, start, end, color, style, edge, track, lastBuild: start, build };
    const c = track ? (this.playerPos(track) ?? centre) : centre;
    d.mesh = new THREE.Mesh(this.dress(d, build(c)), this.shared.material);
    d.mesh.renderOrder = 2;
    d.mesh.frustumCulled = false;
    this.group.add(d.mesh);
    this.decals.push(d);
  }

  /** Per-vertex colour, timing and style for the shared material. */
  private dress(d: Decal, geo: THREE.BufferGeometry): THREE.BufferGeometry {
    const n = geo.getAttribute("position").count;
    const tele = new Float32Array(n * 4);
    const col = new Float32Array(n * 3);
    const c = this.tmpColor.setHex(d.color);
    const a = this.secs(d.start), b = this.secs(d.end);
    for (let i = 0; i < n; i++) {
      tele[i * 4] = a;
      tele[i * 4 + 1] = b;
      tele[i * 4 + 2] = d.style;
      tele[i * 4 + 3] = d.edge;
      col[i * 3] = c.r;
      col[i * 3 + 1] = c.g;
      col[i * 3 + 2] = c.b;
    }
    geo.setAttribute("aTele", new THREE.BufferAttribute(tele, 4));
    geo.setAttribute("aColor", new THREE.BufferAttribute(col, 3));
    return geo;
  }

  cancel(npc: string, filter: (d: Decal) => boolean = () => true) {
    for (let i = this.decals.length - 1; i >= 0; i--) {
      const d = this.decals[i]!;
      if (d.npc === npc && filter(d)) this.remove(i);
    }
  }

  private remove(i: number) {
    const d = this.decals[i]!;
    d.mesh.removeFromParent();
    d.mesh.geometry.dispose();
    this.decals.splice(i, 1);
  }

  update(now: number) {
    this.shared.clock.value = this.secs(now);
    for (let i = this.decals.length - 1; i >= 0; i--) {
      const d = this.decals[i]!;
      if (now > d.end + 160) {
        this.remove(i);
        continue;
      }
      if (d.track && now - d.lastBuild > 90) {
        const p = this.playerPos(d.track);
        if (p) {
          d.lastBuild = now;
          d.mesh.geometry.dispose();
          d.mesh.geometry = this.dress(d, d.build(p));
        }
      }
    }
  }

  dispose() {
    while (this.decals.length) this.remove(this.decals.length - 1);
    this.group.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
    this.shared.material.dispose();
    this.group.removeFromParent();
  }
}
