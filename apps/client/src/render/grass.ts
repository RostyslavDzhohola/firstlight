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
import { PAD_GRASS_RADIUS, padGrassMask } from "../world/palette.ts";
import { atmo } from "./atmosphere.ts";
import { coverScaleNode } from "./occluderFade.ts";
import type { BodyLook } from "./looks.ts";
import type { ResolvedSettings } from "./quality.ts";
import { MEADOW_NEAR, MEADOW_SHARE, meadowCellFields, meadowClumpGeometry, meadowCpuLook, meadowGrassMaterial, meadowKeep } from "./meadow.ts";
import { groundUniforms } from "./terrainMaterial.ts";

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
  /** Meadow clumps only: per-clump data, the far (lite) geometry sharing the instance buffers, and
   *  which of the two the mesh draws (0 near, 1 far). */
  meta: THREE.InstancedBufferAttribute | null;
  geoLite: THREE.InstancedBufferGeometry | null;
  band: 0 | 1;
  /** Instances placed (the mesh draws the first `drawn` of them: far cells thin out, meadow.ts). */
  count: number;
  /** Clumps the cell would hold at full grass weight: a clump's rank is its index over this. */
  target: number;
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
    // Never in the lens or across the view of the player (D-polish-2).
    const height = grassUniforms.height.mul(scale).mul(fade).mul(coverScaleNode(base));
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

const underTmp = new THREE.Color();
let sharedMaterial: THREE.MeshLambertNodeMaterial | null = null;
let sharedMeadow: THREE.MeshLambertNodeMaterial | null = null;
/** One grass material per kind for the app's lifetime (all bodies; values come from shared uniforms):
 *  the single blades (Low, `?nomeadow`) or the meadow clumps (meadow.ts). */
function grassMaterialShared(clumps: boolean): THREE.MeshLambertNodeMaterial {
  if (clumps) return (sharedMeadow ??= meadowGrassMaterial(grassUniforms));
  sharedMaterial ??= grassMaterial();
  return sharedMaterial;
}

export class GrassSystem {
  readonly group = new THREE.Group();
  private material: THREE.MeshLambertNodeMaterial | null = null;
  private blade: THREE.BufferGeometry | null = null;
  private bladeLite: THREE.BufferGeometry | null = null;
  /** 0 single blades, 1 lite clumps everywhere, 2 full clumps near the camera and lite ones beyond (quality.ts). */
  private clumps: 0 | 1 | 2 = 0;
  private segments = 0;
  private cellQuads = 4;
  private density = 16;
  private capacity = 0;
  private enabled = true;
  private receiveShadow = false;
  private readonly cells = new Map<string, Cell>();
  private readonly free: Cell[] = [];
  private readonly cellCorners: number[] = new Array<number>(12).fill(0);
  private readonly cellFields = new Float32Array(12);
  private lastUpdate = 0;
  private readonly lastPos = new THREE.Vector3(1e9, 0, 0);
  private wanted: { key: string; chunk: GrassChunk; ca: number; cb: number; d: number }[] = [];
  /** A chunk arrived or left since the last scan: scan at the next update (D-load-6). */
  private rescan = false;
  /**
   * A hidden cell with no clumps in it, drawn only by warmup() (it shows hidden meshes and draws
   * one instance of an empty one): the tier's grass material is compiled with the cells' attribute
   * layout and shadow flag whatever ground lies round the camera, and three keeps that build while
   * the sample lives, so the first cell to stream in after a tier change, on a pad or over water,
   * compiles nothing in play (planet graphics review, finding 1).
   */
  private sample: Cell | null = null;
  blades = 0;

  /** @param meadow false keeps the single blades whatever the tier.
   *  @param pads landing pads: no blade roots on their stone discs (the per-vertex weight alone
   *  bleeds into the disc through interpolation).
   *  @param mask optional per-blade factor 0..1 at a planet point (the Portus town's paving and
   *  footprints): a blade root survives only where it is above 0.5. */
  constructor(
    private readonly radiusOfBody: number,
    private readonly quadsPerFace: number,
    private readonly pads: readonly Dir[] = [],
    private readonly mask: ((x: number, y: number, z: number) => number) | null = null,
    /** False: single blades whatever the tier (the hub's lawns). */
    private readonly meadow = true,
  ) {
    this.group.name = "grass";
  }

  applySettings(s: ResolvedSettings) {
    this.enabled = s.on.grass;
    this.group.visible = this.enabled;
    const radius = s.grass.radius;
    grassUniforms.radius.value = radius;
    const clumps = s.on.meadow && this.meadow ? s.grass.clumps : 0;
    // A clump covers more ground than a blade: fewer of them (meadow.ts MEADOW_SHARE).
    const density = (s.grass.count * (clumps > 0 ? MEADOW_SHARE : 1)) / (Math.PI * radius * radius);
    // The ground under the grass takes the blades' root colour out to where they thin (terrainMaterial.ts).
    groundUniforms.underReach.value = s.on.grass && clumps > 0 ? radius : 0;
    const look = meadowCpuLook();
    groundUniforms.underAmt.value = clumps > 0 ? look.under : 0;
    groundUniforms.under.value.copy(grassUniforms.root.value).lerp(underTmp.setHex(look.lushRoot), look.pull).multiplyScalar(0.5);
    this.receiveShadow = s.on.shadows && s.shadows.mode === "map";
    // Largest quad (at a face centre, quads are 2R/n wide). Small quads (Portus ~2.3 m) or a large
    // radius → 8×8-quad cells, else 4×4: keeps grass at a few dozen draws.
    const quad = (2 * this.radiusOfBody) / this.quadsPerFace;
    const cellQuads = radius > 45 || quad < 3 ? 8 : 4;
    const capacity = Math.ceil(density * (cellQuads * quad) ** 2 * 1.1);
    if (s.grass.segments !== this.segments || cellQuads !== this.cellQuads || capacity > this.capacity || clumps !== this.clumps) {
      this.density = density;
      this.clumps = clumps;
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
    if (this.sample) this.sample.mesh.receiveShadow = this.receiveShadow;
  }

  /** The warm-up sample of the current tier's grass (null before the first settings). */
  get warmupSample(): THREE.Mesh | null {
    return this.sample?.mesh ?? null;
  }

  private rebuildAll(segments: number, cellQuads: number, capacity: number) {
    for (const c of [...this.cells.values(), ...this.free]) {
      this.group.remove(c.mesh);
      c.geo.dispose();
      c.geoLite?.dispose();
    }
    this.cells.clear();
    this.free.length = 0;
    this.dropSample();
    this.blade?.dispose();
    this.segments = segments;
    this.cellQuads = cellQuads;
    this.capacity = capacity;
    // Clumps: level 1 draws the lite clump in every cell, level 2 the full one near the camera.
    this.blade = this.clumps === 0 ? bladeGeometry(segments) : meadowClumpGeometry(this.clumps === 1);
    this.bladeLite?.dispose();
    this.bladeLite = this.clumps === 2 ? meadowClumpGeometry(true) : null;
    this.material = grassMaterialShared(this.clumps > 0);
    // The full and the lite clump share one attribute layout, so one sample stands for both.
    const sample = this.acquire(1);
    sample.inUse = false;
    sample.mesh.name = "grassSample";
    sample.mesh.visible = false;
    sample.mesh.frustumCulled = false;
    this.sample = sample;
    this.group.add(sample.mesh);
  }

  private dropSample() {
    if (!this.sample) return;
    this.group.remove(this.sample.mesh);
    this.sample.geo.dispose();
    this.sample.geoLite?.dispose();
    this.sample = null;
  }

  /** A cell from the pool, or a new one; `capacity` builds a new one of that size (the warm-up sample). */
  private acquire(capacity?: number): Cell {
    const c = capacity === undefined ? this.free.pop() : undefined;
    if (c) {
      c.inUse = true;
      return c;
    }
    const size = capacity ?? this.capacity;
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = this.blade!.index;
    for (const [name, a] of Object.entries(this.blade!.attributes)) geo.setAttribute(name, a);
    const attr = new THREE.InstancedBufferAttribute(new Float32Array(size * 4), 4);
    geo.setAttribute("iPos", attr);
    geo.instanceCount = 0;
    let meta: THREE.InstancedBufferAttribute | null = null;
    let geoLite: THREE.InstancedBufferGeometry | null = null;
    if (this.clumps > 0) {
      meta = new THREE.InstancedBufferAttribute(new Float32Array(size * 4), 4);
      geo.setAttribute("iMeta", meta);
    }
    if (this.bladeLite && meta) {
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
    return { key: "", mesh, geo, attr, meta, geoLite, band: 0, count: 0, target: 1, center: new THREE.Vector3(), radius: 1, inUse: true };
  }

  private release(c: Cell) {
    this.group.remove(c.mesh);
    c.inUse = false;
    c.geo.instanceCount = 0;
    c.count = 0;
    if (c.geoLite) c.geoLite.instanceCount = 0;
    this.free.push(c);
  }

  /** Stream cells around the camera. Builds at most `budgetMs` of new cells per frame. */
  update(cam: THREE.Vector3, chunks: Iterable<GrassChunk>, now: number, budgetMs = 2) {
    if (!this.enabled || !this.blade) return;
    const radius = grassUniforms.radius.value;
    if (this.rescan || now - this.lastUpdate > 250 || cam.distanceToSquared(this.lastPos) > 4) {
      this.rescan = false;
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
    for (const c of this.cells.values()) n += c.mesh.geometry === c.geoLite ? c.geoLite.instanceCount : c.geo.instanceCount;
    this.blades = n;
  }

  /**
   * A cell at distance `d`. Clumps thin with distance: the shader shrinks away the clumps ranked past
   * the share kept at their distance, so the cell stops drawing that tail (3 m of slack for the
   * camera's movement between scans). Clump level 2: near cells draw the full clumps, far cells the
   * lite ones (same instance data).
   */
  private setBand(c: Cell, d: number) {
    if (c.meta) {
      const keep = meadowKeep(Math.max(0, d - c.radius - 3), grassUniforms.radius.value) + 0.05;
      const drawn = keep >= 1 ? c.count : Math.min(c.count, Math.ceil(c.target * keep));
      c.geo.instanceCount = drawn;
      if (c.geoLite) c.geoLite.instanceCount = drawn;
    }
    if (!c.geoLite) return;
    const band = d < MEADOW_NEAR ? 0 : d > MEADOW_NEAR + 4 || c.band === 1 ? 1 : 0;
    if (band === c.band && c.mesh.geometry === (band ? c.geoLite : c.geo)) return;
    c.band = band;
    c.mesh.geometry = band ? c.geoLite : c.geo;
  }

  /** The streamed chunks changed (one arrived): the next update scans for its cells at once. */
  chunksChanged() {
    this.rescan = true;
  }

  /**
   * Cells round the camera still to fill (D-load-6: the arrival waits for 0 before the loader goes).
   * An unscanned chunk change counts as one: its cells aren't known yet.
   */
  backlog(): number {
    if (!this.enabled || !this.blade) return 0;
    return this.wanted.length + (this.rescan ? 1 : 0);
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
    // The region's slow fields at the cell's corners, once: each clump interpolates them.
    const metaArr = c.meta ? (c.meta.array as Float32Array) : null;
    const F = this.cellFields;
    if (metaArr) {
      const k = this.cellCorners;
      k[0] = P[p00]!; k[1] = P[p00 + 1]!; k[2] = P[p00 + 2]!;
      k[3] = P[p10]!; k[4] = P[p10 + 1]!; k[5] = P[p10 + 2]!;
      k[6] = P[p01]!; k[7] = P[p01 + 1]!; k[8] = P[p01 + 2]!;
      k[9] = P[p11]!; k[10] = P[p11 + 1]!; k[11] = P[p11 + 2]!;
      meadowCellFields(k, F);
    }
    const look = meadowCpuLook();
    const dryBias = look.dryBias, flowerShare = look.flowerShare, flowerBase = look.flowerBase;
    // Pads: tested per blade only in the cells a pad's apron can reach (the test walks every pad).
    const R = this.radiusOfBody;
    let nearPad = false;
    if (this.pads.length) {
      const mx = (P[p00]! + P[p11]!) / 2, my = (P[p00 + 1]! + P[p11 + 1]!) / 2, mz = (P[p00 + 2]! + P[p11 + 2]!) / 2;
      const ml = Math.hypot(mx, my, mz);
      const reach = (PAD_GRASS_RADIUS + 3 + Math.hypot(d1x, d1y, d1z) * 0.75) / R;
      for (const pad of this.pads) {
        const dx = mx / ml - pad[0], dy = my / ml - pad[1], dz = mz / ml - pad[2];
        if (dx * dx + dy * dy + dz * dz < reach * reach) {
          nearPad = true;
          break;
        }
      }
    }
    // Clumps thin out and shorten toward the water: the beach stays sand (terrainMaterial.ts draws it up to ~2 m).
    const shoreR = metaArr && Number.isFinite(atmo.waterLevel.value) ? R + atmo.waterLevel.value : -1;
    const shoreLo = 0.8 * look.shore, shoreHi = 2.3 * look.shore;
    const mask = this.mask;
    const arr = c.attr.array as Float32Array;
    const invTarget = 1 / Math.max(1, target);
    let n = 0;
    let minx = Infinity, miny = Infinity, minz = Infinity, maxx = -Infinity, maxy = -Infinity, maxz = -Infinity;
    for (let k = 0; k < target; k++) {
      const fx = rand() * q, fy = rand() * q;
      const ia = Math.min(q - 1, Math.floor(fx)), ib = Math.min(q - 1, Math.floor(fy));
      const u = fx - ia, v = fy - ib;
      const a = a0 + ia, b = b0 + ib;
      const i00 = vi(a, b), i10 = i00 + 1, i01 = i00 + side, i11 = i01 + 1;
      // Density: bilinear of the 4 corner weights.
      let gw = (G[i00]! * (1 - u) + G[i10]! * u) * (1 - v) + (G[i01]! * (1 - u) + G[i11]! * u) * v;
      const r2 = rand();
      if (r2 >= gw) continue;
      // Position on the rendered triangle (same split as the chunk mesh).
      let wb: number, wc: number, ib2: number, ic2: number;
      if (u >= v) {
        ib2 = i10; ic2 = i11; wb = u - v; wc = v;
      } else {
        ib2 = i11; ic2 = i01; wb = u; wc = v - u;
      }
      const wa = 1 - wb - wc;
      const A = i00 * 3, B = ib2 * 3, C = ic2 * 3;
      const x = P[A]! * wa + P[B]! * wb + P[C]! * wc;
      const y = P[A + 1]! * wa + P[B + 1]! * wb + P[C + 1]! * wc;
      const z = P[A + 2]! * wa + P[B + 2]! * wb + P[C + 2]! * wc;
      let shore = 1;
      if (nearPad || shoreR > 0) {
        const l = Math.sqrt(x * x + y * y + z * z);
        if (nearPad && padGrassMask(this.pads, x / l, y / l, z / l, R) <= 0) continue;
        if (shoreR > 0 && l - shoreR < shoreHi) {
          const t = Math.min(1, Math.max(0, (l - shoreR - shoreLo) / (shoreHi - shoreLo)));
          shore = t * t * (3 - 2 * t);
          if (r2 >= gw * shore) continue;
          gw *= shore;
        }
      }
      if (mask && mask(x, y, z) <= 0.5) continue;
      const scale = (0.55 + rand() * 0.75 * (0.6 + 0.4 * gw)) * (0.6 + 0.4 * shore);
      const o = n * 4;
      arr[o] = x;
      arr[o + 1] = y;
      arr[o + 2] = z;
      arr[o + 3] = Math.round(scale * 100) + Math.min(0.999, rand());
      if (metaArr) {
        // Per-clump data (meadow.ts meadowMeta, in line: this loop is the grass's whole CPU cost).
        const cu = fx / q, cv = fy / q;
        const w00 = (1 - cu) * (1 - cv), w10 = cu * (1 - cv), w01 = (1 - cu) * cv, w11 = cu * cv;
        const r = rand();
        const rs = (r2 / gw) - 0.5; // uniform in ±0.5 given the clump was kept: no third random
        const dry = F[0]! * w00 + F[3]! * w10 + F[6]! * w01 + F[9]! * w11 + dryBias + rs * 0.3;
        const drift = F[2]! * w00 + F[5]! * w10 + F[8]! * w01 + F[11]! * w11;
        let head = 0;
        if (r < drift * flowerShare + flowerBase) {
          const sp = Math.floor((F[1]! * w00 + F[4]! * w10 + F[7]! * w01 + F[10]! * w11) * 4.6 + rs * 0.8);
          head = (sp < 0 ? 0 : sp > 3 ? 3 : sp) + 1;
        }
        metaArr[o] = dry < 0 ? 0 : dry > 1 ? 1 : dry;
        metaArr[o + 1] = head;
        metaArr[o + 2] = rs + 0.5;
        metaArr[o + 3] = n * invTarget;
      }
      n++;
      if (x < minx) minx = x; if (y < miny) miny = y; if (z < minz) minz = z;
      if (x > maxx) maxx = x; if (y > maxy) maxy = y; if (z > maxz) maxz = z;
    }
    c.count = n;
    c.target = target;
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
    if (c.meta) {
      c.meta.clearUpdateRanges();
      c.meta.addUpdateRange(0, Math.max(4, n * 4));
      c.meta.needsUpdate = true;
    }
    if (c.geoLite) {
      c.geoLite.instanceCount = n;
      c.geoLite.boundingSphere!.center.copy(c.center);
      c.geoLite.boundingSphere!.radius = c.radius;
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
    this.dropSample();
    this.blade?.dispose();
    this.bladeLite?.dispose();
    this.group.removeFromParent();
  }
}
