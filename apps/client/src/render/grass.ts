// Instanced grass near the camera (SPEC §7.3 grass row, r2-15 §3). Blades live in cells of 4×4 or
// 8×8 terrain quads; each cell is one Mesh + InstancedBufferGeometry (sharing the blade geometry and
// one material), so three frustum-culls whole cells and every cell reuses the same shader (a plain
// InstancedMesh would put its uuid in the shader cache key). Blade roots are interpolated on the CPU
// from the streamed chunk mesh + the worker's grass-density weights, so they sit exactly on the
// rendered ground. Wind, the distance fade and the local-up alignment happen in the vertex shader.
// Same path on WebGPU and the WebGL2 fallback (no compute).

import * as THREE from "three/webgpu";
import {
  abs, attribute, cameraPosition, cameraViewMatrix, cos, cross, distance, float, floor, fract, Fn, hash, mix,
  mx_noise_float, normalize, positionGeometry, positionPrevious, pow, select, sin, smoothstep, time,
  transformDirection, uniform, vec3, varying, renderGroup,
} from "three/tsl";
import { CHUNK_QUADS, hash4, mulberry32, type Dir, type Face } from "@firstlight/shared";
import { padGrassMask } from "../world/palette.ts";
import { atmo } from "./atmosphere.ts";
import type { BodyLook } from "./looks.ts";
import type { ResolvedSettings } from "./quality.ts";
import { MEADOW_NEAR, meadowClumpGeometry, meadowGrassMaterial, meadowMeta, meadowOn } from "./meadow.ts";

export const grassUniforms = {
  radius: uniform(40).setGroup(renderGroup),
  height: uniform(0.45).setGroup(renderGroup),
  width: uniform(0.07).setGroup(renderGroup),
  windDir: uniform(new THREE.Vector3(1, 0, 0)).setGroup(renderGroup),
  windStrength: uniform(0.55).setGroup(renderGroup),
  root: uniform(new THREE.Color(0x2c7a34)).setGroup(renderGroup),
  tip: uniform(new THREE.Color(0x9fdc58)).setGroup(renderGroup),
};

export function applyGrassLook(look: BodyLook) {
  grassUniforms.root.value.setHex(look.grassRoot);
  grassUniforms.tip.value.setHex(look.grassTip);
  grassUniforms.height.value = look.grassHeight;
}

/** What the planet hands over for each loaded chunk. */
export interface GrassChunk {
  key: string;
  face: Face;
  cx: number;
  cy: number;
  /** Grid positions first ((q+1)² vertices), planet space. */
  positions: Float32Array;
  grass: Float32Array;
  /** Chunk centre (planet space) and bounding radius. */
  center: THREE.Vector3;
  radius: number;
}

interface Cell {
  key: string;
  mesh: THREE.Mesh;
  geo: THREE.InstancedBufferGeometry;
  attr: THREE.InstancedBufferAttribute;
  /** `?meadow` only: per-clump data, the far (lite) geometry sharing the instance buffers, and
   *  which of the two the mesh draws (0 near, 1 far). */
  meta: THREE.InstancedBufferAttribute | null;
  geoLite: THREE.InstancedBufferGeometry | null;
  band: 0 | 1;
  center: THREE.Vector3;
  radius: number;
  inUse: boolean;
}

function bladeGeometry(segments: number): THREE.BufferGeometry {
  // A tapered blade in blade space: x across (±0.5), y up (0..1). Shaped in the vertex shader.
  const pos: number[] = [];
  const idx: number[] = [];
  for (let s = 0; s < segments; s++) {
    const y = s / segments;
    const w = 1 - Math.pow(y, 1.4);
    pos.push(-0.5 * w, y, 0, 0.5 * w, y, 0);
  }
  pos.push(0, 1, 0);
  for (let s = 0; s < segments - 1; s++) {
    const a = s * 2;
    idx.push(a, a + 1, a + 3, a, a + 3, a + 2);
  }
  const top = segments * 2;
  const a = (segments - 1) * 2;
  idx.push(a, a + 1, top);
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  return g;
}

function grassMaterial(): THREE.MeshLambertNodeMaterial {
  const m = new THREE.MeshLambertNodeMaterial({ side: THREE.DoubleSide });
  m.name = "grass";
  const ip = attribute("iPos", "vec4");
  const base = ip.xyz;
  const w = ip.w;
  const scale = floor(w).mul(0.01);
  const yaw = fract(w).mul(Math.PI * 2);
  const up = normalize(base);
  const ref = select(abs(up.y).lessThan(0.95), vec3(0, 1, 0), vec3(1, 0, 0));
  const t0 = normalize(cross(ref, up));
  const t1 = cross(up, t0);
  const side = t0.mul(cos(yaw)).add(t1.mul(sin(yaw)));
  const facing = cross(side, up);
  const hf = positionGeometry.y;
  const seed = hash(w.mul(13.7));

  m.positionNode = Fn((builder: any) => {
    const dist = distance(base, cameraPosition);
    const fade = smoothstep(grassUniforms.radius, grassUniforms.radius.mul(0.72), dist);
    const height = grassUniforms.height.mul(scale).mul(fade);
    const gust = mx_noise_float(base.mul(0.045).add(grassUniforms.windDir.mul(time.mul(0.9)))).mul(0.5).add(0.5);
    const flutter = sin(time.mul(2.3).add(seed.mul(6.283))).mul(0.12);
    const bend = gust.mul(grassUniforms.windStrength).add(flutter).mul(hf.mul(hf));
    const lean = hf.mul(hf).mul(seed.mul(0.25).add(0.08));
    const p = base
      .add(side.mul(positionGeometry.x.mul(grassUniforms.width).mul(fade.mul(0.5).add(0.5))))
      .add(up.mul(hf.mul(height)))
      .add(grassUniforms.windDir.mul(bend).add(facing.mul(lean)).mul(height));
    if (builder?.needsPreviousData?.()) positionPrevious.assign(p);
    return p;
  })();
  // Lit mostly like the ground under it, so blades blend into the terrain colour.
  const nW = varying(normalize(up.mul(0.8).add(facing.mul(0.2))), "vGrassN");
  m.normalNode = transformDirection(nW, cameraViewMatrix);
  const variation = seed.mul(0.3).add(0.85);
  m.colorNode = mix(grassUniforms.root, grassUniforms.tip, pow(hf, 0.9)).mul(variation).mul(mix(float(1), float(0.8), atmo.wet));
  return m;
}

let sharedMaterial: THREE.MeshLambertNodeMaterial | null = null;
/** One grass material for the app's lifetime (all bodies; values come from shared uniforms).
 *  `?meadow` (graphics-uplift prototype, off by default) swaps in clumps with wildflowers. */
function grassMaterialShared(): THREE.MeshLambertNodeMaterial {
  sharedMaterial ??= meadowOn.grass ? meadowGrassMaterial(grassUniforms) : grassMaterial();
  return sharedMaterial;
}

export class GrassSystem {
  readonly group = new THREE.Group();
  private material: THREE.MeshLambertNodeMaterial | null = null;
  private blade: THREE.BufferGeometry | null = null;
  private bladeLite: THREE.BufferGeometry | null = null;
  private segments = 0;
  private cellQuads = 4;
  private density = 16;
  private capacity = 0;
  private enabled = true;
  private receiveShadow = false;
  private readonly cells = new Map<string, Cell>();
  private readonly free: Cell[] = [];
  private lastUpdate = 0;
  private readonly lastPos = new THREE.Vector3(1e9, 0, 0);
  private wanted: { key: string; chunk: GrassChunk; ca: number; cb: number; d: number }[] = [];
  blades = 0;

  /** @param pads landing pads: no blade roots on their stone discs (the per-vertex weight alone
   *  bleeds into the disc through interpolation).
   *  @param mask optional per-blade factor 0..1 at a planet point (the Portus town's paving and
   *  footprints): a blade root survives only where it is above 0.5. */
  constructor(
    private readonly radiusOfBody: number,
    private readonly quadsPerFace: number,
    private readonly pads: readonly Dir[] = [],
    private readonly mask: ((x: number, y: number, z: number) => number) | null = null,
  ) {
    this.group.name = "grass";
  }

  applySettings(s: ResolvedSettings) {
    this.enabled = s.on.grass;
    this.group.visible = this.enabled;
    const radius = s.grass.radius;
    grassUniforms.radius.value = radius;
    const density = s.grass.count / (Math.PI * radius * radius);
    this.receiveShadow = s.on.shadows && s.shadows.mode === "map";
    // Largest quad (at a face centre, quads are 2R/n wide). Small quads (Portus ~2.3 m) or a large
    // radius → 8×8-quad cells, else 4×4: keeps grass at a few dozen draws.
    const quad = (2 * this.radiusOfBody) / this.quadsPerFace;
    const cellQuads = radius > 45 || quad < 3 ? 8 : 4;
    const capacity = Math.ceil(density * (cellQuads * quad) ** 2 * 1.1);
    if (s.grass.segments !== this.segments || cellQuads !== this.cellQuads || capacity > this.capacity) {
      this.density = density;
      this.rebuildAll(s.grass.segments, cellQuads, capacity);
      this.lastPos.set(1e9, 0, 0);
    } else if (Math.abs(density - this.density) > 1e-6) {
      // Same layout, new density: regenerate the blades, keep the pooled cells.
      this.density = density;
      for (const c of this.cells.values()) this.release(c);
      this.cells.clear();
      this.lastPos.set(1e9, 0, 0);
    }
    for (const c of [...this.cells.values(), ...this.free]) c.mesh.receiveShadow = this.receiveShadow;
  }

  private rebuildAll(segments: number, cellQuads: number, capacity: number) {
    for (const c of [...this.cells.values(), ...this.free]) {
      this.group.remove(c.mesh);
      c.geo.dispose();
      c.geoLite?.dispose();
    }
    this.cells.clear();
    this.free.length = 0;
    this.blade?.dispose();
    this.segments = segments;
    this.cellQuads = cellQuads;
    this.capacity = capacity;
    this.blade = meadowOn.grass ? meadowClumpGeometry(false) : bladeGeometry(segments);
    this.bladeLite?.dispose();
    this.bladeLite = meadowOn.grass ? meadowClumpGeometry(true) : null;
    this.material = grassMaterialShared();
  }

  private acquire(): Cell {
    const c = this.free.pop();
    if (c) {
      c.inUse = true;
      return c;
    }
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = this.blade!.index;
    for (const [name, a] of Object.entries(this.blade!.attributes)) geo.setAttribute(name, a);
    const attr = new THREE.InstancedBufferAttribute(new Float32Array(this.capacity * 4), 4);
    geo.setAttribute("iPos", attr);
    geo.instanceCount = 0;
    let meta: THREE.InstancedBufferAttribute | null = null;
    let geoLite: THREE.InstancedBufferGeometry | null = null;
    if (this.bladeLite) {
      meta = new THREE.InstancedBufferAttribute(new Float32Array(this.capacity * 4), 4);
      geo.setAttribute("iMeta", meta);
      geoLite = new THREE.InstancedBufferGeometry();
      geoLite.index = this.bladeLite.index;
      for (const [name, a] of Object.entries(this.bladeLite.attributes)) geoLite.setAttribute(name, a);
      geoLite.setAttribute("iPos", attr);
      geoLite.setAttribute("iMeta", meta);
      geoLite.instanceCount = 0;
      geoLite.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1);
    }
    const mesh = new THREE.Mesh(geo, this.material!);
    mesh.matrixAutoUpdate = false;
    mesh.castShadow = false;
    mesh.receiveShadow = this.receiveShadow;
    mesh.name = "grassCell";
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1);
    return { key: "", mesh, geo, attr, meta, geoLite, band: 0, center: new THREE.Vector3(), radius: 1, inUse: true };
  }

  private release(c: Cell) {
    this.group.remove(c.mesh);
    c.inUse = false;
    c.geo.instanceCount = 0;
    if (c.geoLite) c.geoLite.instanceCount = 0;
    this.free.push(c);
  }

  /** Stream cells around the camera. Builds at most `budgetMs` of new cells per frame. */
  update(cam: THREE.Vector3, chunks: Iterable<GrassChunk>, now: number, budgetMs = 2) {
    if (!this.enabled || !this.blade) return;
    const radius = grassUniforms.radius.value;
    if (now - this.lastUpdate > 250 || cam.distanceToSquared(this.lastPos) > 4) {
      this.lastUpdate = now;
      this.lastPos.copy(cam);
      const keep = new Set<string>();
      this.wanted = [];
      const per = CHUNK_QUADS / this.cellQuads;
      const side = CHUNK_QUADS + 1;
      for (const ch of chunks) {
        if (ch.center.distanceTo(cam) > radius + ch.radius + 10) continue;
        for (let cb = 0; cb < per; cb++) {
          for (let ca = 0; ca < per; ca++) {
            // Cell centre = average of its 4 corner grid vertices.
            const a0 = ca * this.cellQuads, b0 = cb * this.cellQuads, a1 = a0 + this.cellQuads, b1 = b0 + this.cellQuads;
            let x = 0, y = 0, z = 0;
            for (const [a, b] of [[a0, b0], [a1, b0], [a0, b1], [a1, b1]] as const) {
              const v = (b * side + a) * 3;
              x += ch.positions[v]!; y += ch.positions[v + 1]!; z += ch.positions[v + 2]!;
            }
            x /= 4; y /= 4; z /= 4;
            const dx = x - cam.x, dy = y - cam.y, dz = z - cam.z;
            const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
            const key = `${ch.key}:${ca}:${cb}`;
            const reach = radius + this.cellQuads * 3.2;
            if (d < reach) {
              keep.add(key);
              const have = this.cells.get(key);
              if (!have) this.wanted.push({ key, chunk: ch, ca, cb, d });
              else this.setBand(have, d);
            } else if (d < reach + 12 && this.cells.has(key)) {
              keep.add(key); // hysteresis
            }
          }
        }
      }
      for (const [k, c] of this.cells) {
        if (!keep.has(k)) {
          this.release(c);
          this.cells.delete(k);
        }
      }
      this.wanted.sort((a, b) => a.d - b.d);
    }
    const t0 = performance.now();
    while (this.wanted.length && performance.now() - t0 < budgetMs) {
      const w = this.wanted.shift()!;
      if (this.cells.has(w.key)) continue;
      const c = this.acquire();
      c.key = w.key;
      this.fill(c, w.chunk, w.ca, w.cb);
      this.setBand(c, w.d);
      this.cells.set(w.key, c);
      this.group.add(c.mesh);
    }
    let n = 0;
    for (const c of this.cells.values()) n += c.geo.instanceCount;
    this.blades = n;
  }

  /** `?meadow`: near cells draw the full clumps, far cells the lite ones (same instance data). */
  private setBand(c: Cell, d: number) {
    if (!c.geoLite) return;
    const band = d < MEADOW_NEAR ? 0 : d > MEADOW_NEAR + 4 || c.band === 1 ? 1 : 0;
    if (band === c.band && c.mesh.geometry === (band ? c.geoLite : c.geo)) return;
    c.band = band;
    c.mesh.geometry = band ? c.geoLite : c.geo;
  }

  /** Forget cells that belong to a chunk that was unloaded. */
  dropChunk(chunkKey: string) {
    for (const [k, c] of this.cells) {
      if (k.startsWith(chunkKey + ":")) {
        this.release(c);
        this.cells.delete(k);
      }
    }
    this.wanted = this.wanted.filter((w) => w.chunk.key !== chunkKey);
  }

  private fill(c: Cell, ch: GrassChunk, ca: number, cb: number) {
    const q = this.cellQuads;
    const side = CHUNK_QUADS + 1;
    const P = ch.positions;
    const G = ch.grass;
    const a0 = ca * q, b0 = cb * q;
    const vi = (a: number, b: number) => b * side + a;
    const p00 = vi(a0, b0) * 3, p10 = vi(a0 + q, b0) * 3, p01 = vi(a0, b0 + q) * 3, p11 = vi(a0 + q, b0 + q) * 3;
    // Area from the diagonals.
    const d1x = P[p11]! - P[p00]!, d1y = P[p11 + 1]! - P[p00 + 1]!, d1z = P[p11 + 2]! - P[p00 + 2]!;
    const d2x = P[p01]! - P[p10]!, d2y = P[p01 + 1]! - P[p10 + 1]!, d2z = P[p01 + 2]! - P[p10 + 2]!;
    const cxp = d1y * d2z - d1z * d2y, cyp = d1z * d2x - d1x * d2z, czp = d1x * d2y - d1y * d2x;
    const area = 0.5 * Math.sqrt(cxp * cxp + cyp * cyp + czp * czp);
    const target = Math.min(this.capacity, Math.round(this.density * area));
    const rand = mulberry32(hash4(ch.face * 4096 + ch.cx * 64 + ch.cy, ca, cb, 0x9a55));
    const arr = c.attr.array as Float32Array;
    let n = 0;
    let minx = Infinity, miny = Infinity, minz = Infinity, maxx = -Infinity, maxy = -Infinity, maxz = -Infinity;
    for (let k = 0; k < target; k++) {
      const fx = rand() * q, fy = rand() * q;
      const ia = Math.min(q - 1, Math.floor(fx)), ib = Math.min(q - 1, Math.floor(fy));
      const u = fx - ia, v = fy - ib;
      const a = a0 + ia, b = b0 + ib;
      const i00 = vi(a, b), i10 = vi(a + 1, b), i11 = vi(a + 1, b + 1), i01 = vi(a, b + 1);
      // Density: bilinear of the 4 corner weights.
      const gw = (G[i00]! * (1 - u) + G[i10]! * u) * (1 - v) + (G[i01]! * (1 - u) + G[i11]! * u) * v;
      const r2 = rand();
      if (r2 >= gw) continue;
      // Position on the rendered triangle (same split as the chunk mesh).
      let wa: number, wb: number, wc: number, ib2: number, ic2: number;
      if (u >= v) {
        ib2 = i10; ic2 = i11; wb = u - v; wc = v;
      } else {
        ib2 = i11; ic2 = i01; wb = u; wc = v - u;
      }
      wa = 1 - wb - wc;
      const A = i00 * 3, B = ib2 * 3, C = ic2 * 3;
      const x = P[A]! * wa + P[B]! * wb + P[C]! * wc;
      const y = P[A + 1]! * wa + P[B + 1]! * wb + P[C + 1]! * wc;
      const z = P[A + 2]! * wa + P[B + 2]! * wb + P[C + 2]! * wc;
      if (this.pads.length) {
        const l = Math.hypot(x, y, z);
        if (padGrassMask(this.pads, x / l, y / l, z / l, this.radiusOfBody) <= 0) continue;
      }
      if (this.mask && this.mask(x, y, z) <= 0.5) continue;
      const scale = 0.55 + rand() * 0.75 * (0.6 + 0.4 * gw);
      const o = n * 4;
      arr[o] = x;
      arr[o + 1] = y;
      arr[o + 2] = z;
      arr[o + 3] = Math.round(scale * 100) + Math.min(0.999, rand());
      if (c.meta) meadowMeta(x, y, z, rand(), rand(), c.meta.array as Float32Array, o);
      n++;
      if (x < minx) minx = x; if (y < miny) miny = y; if (z < minz) minz = z;
      if (x > maxx) maxx = x; if (y > maxy) maxy = y; if (z > maxz) maxz = z;
    }
    c.geo.instanceCount = n;
    c.attr.clearUpdateRanges();
    c.attr.addUpdateRange(0, Math.max(4, n * 4));
    c.attr.needsUpdate = true;
    if (n > 0) {
      c.center.set((minx + maxx) / 2, (miny + maxy) / 2, (minz + maxz) / 2);
      c.radius = Math.hypot(maxx - minx, maxy - miny, maxz - minz) / 2 + 1.5;
    } else {
      c.center.set(P[p00]!, P[p00 + 1]!, P[p00 + 2]!);
      c.radius = 1;
    }
    c.geo.boundingSphere!.center.copy(c.center);
    c.geo.boundingSphere!.radius = c.radius;
    if (c.geoLite && c.meta) {
      c.geoLite.instanceCount = n;
      c.geoLite.boundingSphere!.center.copy(c.center);
      c.geoLite.boundingSphere!.radius = c.radius;
      c.meta.clearUpdateRanges();
      c.meta.addUpdateRange(0, Math.max(4, n * 4));
      c.meta.needsUpdate = true;
    }
    c.mesh.visible = n > 0;
  }

  /** Wind blows along the local east of the player (tangent), set per frame. */
  setWind(east: THREE.Vector3) {
    grassUniforms.windDir.value.copy(east);
  }

  dispose() {
    for (const c of [...this.cells.values(), ...this.free]) {
      this.group.remove(c.mesh);
      c.geo.dispose();
      c.geoLite?.dispose();
    }
    this.cells.clear();
    this.free.length = 0;
    this.blade?.dispose();
    this.bladeLite?.dispose();
    this.group.removeFromParent();
  }
}
