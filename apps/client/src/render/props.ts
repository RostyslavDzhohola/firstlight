// Trees, rocks, plants and spires: one InstancedMesh per model variant per LOD for
// the whole planet, refilled a few times a second from the props of the loaded chunks (placed by
// the shared, deterministic chunkProps in the worker). LOD0 (full mesh, casts shadows) up to the
// tier's "full mesh to" distance, LOD1 (low poly, no shadow) to the draw distance.
// One draw per deterministic model variant/LOD, plus nearby LOD0 shadow draws.

import * as THREE from "three/webgpu";
import { hash01, PROP_KINDS, PROP_STRIDE, PROP_STYLES, type BodyId, type PropKind } from "@firstlight/shared";
import { float, materialColor, mix } from "three/tsl";
import { atmo } from "./atmosphere.ts";
import { propGeometry } from "./propGeometry.ts";
import { preloadVegetation, validateVegetationAssets, vegetationMaterial, type VegetationAssets } from "./vegetationAssets.ts";
import { vegetationModels, vegetationVariant } from "./vegetationModels.ts";
import { keptSamples } from "./warmup.ts";
import type { ResolvedSettings } from "./quality.ts";

interface ChunkProps {
  key: string;
  /** Unique per registration (instance identity for upload signatures). */
  serial: number;
  center: THREE.Vector3;
  radius: number;
  /** Per kind: precomputed instance matrices (16 floats each) and colours (3 floats each). */
  byKind: Map<number, { matrices: Float32Array; colors: Float32Array; positions: Float32Array; count: number; winds: Float32Array }>;
}

interface KindMeshes {
  kind: PropKind;
  variant: number;
  lod0: THREE.InstancedMesh;
  lod1: THREE.InstancedMesh;
  capacity: number;
}

const CAPACITY: Partial<Record<PropKind, number>> = { reed: 6000, oak: 4000, scrub: 4000 };

let sharedMaterial: THREE.MeshStandardNodeMaterial | null = null;
function propMaterial(): THREE.MeshStandardNodeMaterial {
  if (!sharedMaterial) {
    sharedMaterial = new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.86, metalness: 0 });
    sharedMaterial.name = "props";
    // Rain: bark, leaves and rocks darken and get a sheen (vertex/instance colours still multiply in).
    sharedMaterial.colorNode = materialColor.mul(mix(float(1), float(0.78), atmo.wet));
    sharedMaterial.roughnessNode = mix(float(0.86), float(0.4), atmo.wet);
  }
  return sharedMaterial;
}

export class PropSystem {
  readonly group = new THREE.Group();
  private readonly kinds = new Map<number, KindMeshes>();
  private readonly chunks = new Map<string, ChunkProps>();
  private fullTo = 25;
  private lodTo = 180;
  private enabled = true;
  private castShadow = true;
  private dirty = true;
  private lastUpdate = 0;
  private readonly lastPos = new THREE.Vector3(1e9, 0, 0);
  /** Forces both LODs to draw everything in range (shader warm-up). */
  forceAll = false;
  instances = 0;
  private serial = 0;

  readonly ready: Promise<void>;
  private samples: THREE.Group | null = null;

  constructor(private readonly body: BodyId, assets?: VegetationAssets) {
    this.group.name = "props";
    const material = propMaterial();
    const kinds = new Set(PROP_STYLES[body].map((r) => r.kind));
    for (const kind of kinds) {
      for (let variant = 0; variant < vegetationModels(body, kind).length; variant++) {
        const k = PROP_KINDS.indexOf(kind);
        const capacity = CAPACITY[kind] ?? 2500;
        const mk = (lod: 0 | 1) => {
          const m = new THREE.InstancedMesh(propGeometry(body, kind, lod), material, capacity);
          m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3).fill(1), 3);
          m.count = 0;
          m.frustumCulled = false;
          m.receiveShadow = true;
          m.castShadow = lod === 0;
          m.name = `prop:${kind}:${variant}:L${lod}`;
          this.group.add(m);
          return m;
        };
        this.kinds.set(k * 8 + variant, { kind, variant, lod0: mk(0), lod1: mk(1), capacity });
      }
    }
    this.ready = (assets ? Promise.resolve(assets) : preloadVegetation())
      .then((assets) => { if (assets) this.installAssets(assets); })
      .catch((err: unknown) => { console.warn("[vegetation] assets failed to install; using procedural props", err); });
  }

  private disposed = false;

  private installAssets(assets: VegetationAssets) {
    if (this.disposed) return;
    validateVegetationAssets(assets);
    const replacements: { mesh: THREE.InstancedMesh; geometry: THREE.BufferGeometry; material: THREE.Material }[] = [];
    try {
      for (const km of this.kinds.values()) {
        const name = vegetationModels(this.body, km.kind)[km.variant];
        if (!name) continue;
        for (const lod of [0, 1] as const) {
          const mesh = lod === 0 ? km.lod0 : km.lod1;
          const geometry = assets.geometry.get(`${name}_L${lod}`)!.clone();
          // Track ownership before preparing so a preparation failure also disposes this clone.
          const replacement = { mesh, geometry, material: mesh.material as THREE.Material };
          replacements.push(replacement);
          if (km.kind === "boulder") geometry.scale(2.3 / 0.9, 2.3 / 0.9, 2.3 / 0.9);
          if (km.kind === "blossom") geometry.scale(5.2 / 6.2, 5.2 / 6.2, 5.2 / 6.2);
          geometry.setAttribute("iWind", new THREE.InstancedBufferAttribute(new Float32Array(km.capacity), 1));
          const impostor = lod === 1 && ["oak", "pine", "deadtree", "blossom"].includes(km.kind);
          replacement.material = vegetationMaterial(this.body, km.kind, impostor ? assets.impostors! : assets.atlas, impostor);
        }
      }
    } catch (err) {
      for (const r of replacements) r.geometry.dispose();
      throw err;
    }
    // All validation and preparation succeeded. Only now replace the complete procedural set.
    const old = replacements.map((r) => r.mesh.geometry);
    for (const r of replacements) {
      r.mesh.geometry = r.geometry;
      r.mesh.material = r.material;
    }
    for (const geometry of old) geometry.dispose();
    this.dirty = true;
  }

  applySettings(s: ResolvedSettings) {
    this.enabled = s.on.trees;
    this.group.visible = this.enabled;
    this.fullTo = s.props.fullTo;
    this.lodTo = s.props.lodTo;
    this.castShadow = s.on.shadows && s.shadows.mode === "map";
    for (const k of this.kinds.values()) k.lod0.castShadow = this.castShadow;
    this.dirty = true;
  }

  /** Warm-up: draw every instance in range with both LODs (so both shaders compile). */
  setForceAll(on: boolean) {
    if (on) {
      this.samples ??= keptSamples(`vegetation:${this.body}`, () => [...this.kinds.values()].flatMap((km) =>
        [km.lod0, km.lod1].map((source) => {
          const mesh = new THREE.InstancedMesh(source.geometry, source.material, source.instanceMatrix.count);
          mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(source.instanceMatrix.count * 3).fill(1), 3);
          mesh.count = 1;
          mesh.setMatrixAt(0, new THREE.Matrix4());
          mesh.frustumCulled = false;
          mesh.castShadow = source === km.lod0;
          mesh.receiveShadow = true;
          mesh.name = `warm:${source.name}`;
          return mesh;
        })));
      if (this.samples) {
        // Put samples inside the camera-local shadow map as well as the colour scene.
        const p = this.lastPos.length() < 1e8 ? this.lastPos : new THREE.Vector3(0, 1, 0);
        const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), p.clone().normalize());
        const matrix = new THREE.Matrix4().compose(p, q, new THREE.Vector3(1, 1, 1));
        for (const o of this.samples.children) {
          const mesh = o as THREE.InstancedMesh;
          mesh.setMatrixAt(0, matrix);
          mesh.instanceMatrix.needsUpdate = true;
        }
        this.group.add(this.samples);
      }
    } else {
      this.samples?.removeFromParent();
    }
    this.forceAll = on;
    this.dirty = true;
  }

  /** Register a chunk's packed props (from the worker). */
  addChunk(key: string, packed: Float32Array, center: THREE.Vector3, radius: number) {
    const count = packed.length / PROP_STRIDE;
    const byKindCount = new Map<number, number>();
    for (let i = 0; i < count; i++) {
      const o = i * PROP_STRIDE;
      const kind = PROP_KINDS[packed[o]!]!;
      const k = packed[o]! * 8 + vegetationVariant(this.body, kind, packed[o + 5]!);
      if (this.kinds.has(k)) byKindCount.set(k, (byKindCount.get(k) ?? 0) + 1);
    }
    const byKind: ChunkProps["byKind"] = new Map();
    for (const [k, n] of byKindCount) {
      byKind.set(k, { matrices: new Float32Array(n * 16), colors: new Float32Array(n * 3), positions: new Float32Array(n * 3), winds: new Float32Array(n), count: 0 });
    }
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const qYaw = new THREE.Quaternion();
    const pos = new THREE.Vector3();
    const up = new THREE.Vector3();
    const scl = new THREE.Vector3();
    const Y = new THREE.Vector3(0, 1, 0);
    const c = new THREE.Color();
    for (let i = 0; i < count; i++) {
      const o = i * PROP_STRIDE;
      const kind = PROP_KINDS[packed[o]!]!;
      const k = packed[o]! * 8 + vegetationVariant(this.body, kind, packed[o + 5]!);
      const e = byKind.get(k);
      if (!e) continue;
      pos.set(packed[o + 1]!, packed[o + 2]!, packed[o + 3]!);
      const s = packed[o + 4]!;
      const yaw = packed[o + 5]!;
      up.copy(pos).normalize();
      q.setFromUnitVectors(Y, up);
      qYaw.setFromAxisAngle(Y, yaw);
      q.multiply(qYaw);
      // Sink a little so bases never float on slopes.
      pos.addScaledVector(up, -0.12 * s);
      scl.setScalar(s);
      m.compose(pos, q, scl);
      m.toArray(e.matrices, e.count * 16);
      const v = 0.86 + hash01(Math.floor(yaw * 1e4), k, 3) * 0.26;
      const hueShift = (hash01(Math.floor(yaw * 1e4), k, 4) - 0.5) * 0.06;
      c.setRGB(v * (1 + hueShift), v, v * (1 - hueShift));
      c.toArray(e.colors, e.count * 3);
      e.positions[e.count * 3] = pos.x;
      e.positions[e.count * 3 + 1] = pos.y;
      e.positions[e.count * 3 + 2] = pos.z;
      e.winds[e.count] = yaw * 17;
      e.count++;
    }
    this.chunks.set(key, { key, serial: ++this.serial, center: center.clone(), radius, byKind });
    this.dirty = true;
  }

  removeChunk(key: string) {
    if (this.chunks.delete(key)) this.dirty = true;
  }

  update(cam: THREE.Vector3, now: number) {
    if (!this.enabled) return;
    if (!this.dirty && now - this.lastUpdate < 400 && cam.distanceToSquared(this.lastPos) < 4) return;
    this.dirty = false;
    this.lastUpdate = now;
    this.lastPos.copy(cam);
    const full2 = this.forceAll ? Infinity : this.fullTo * this.fullTo;
    const lod2 = this.lodTo * this.lodTo;
    let total = 0;
    for (const [k, km] of this.kinds) {
      let n0 = 0, n1 = 0;
      const small = ["bush", "fern", "flower", "mushroom", "scrub", "reed"].includes(km.kind);
      const kindLod2 = small && !this.forceAll ? Math.min(this.lodTo, 65) ** 2 : lod2;
      // Order-dependent signature of the selected instances: upload only when it changes.
      let sig0 = 0x9e3779b9, sig1 = 0x85ebca6b;
      const a0 = km.lod0.instanceMatrix.array as Float32Array;
      const a1 = km.lod1.instanceMatrix.array as Float32Array;
      const c0 = km.lod0.instanceColor!.array as Float32Array;
      const c1 = km.lod1.instanceColor!.array as Float32Array;
      const w0 = km.lod0.geometry.getAttribute("iWind")?.array as Float32Array | undefined;
      const w1 = km.lod1.geometry.getAttribute("iWind")?.array as Float32Array | undefined;
      for (const ch of this.chunks.values()) {
        const e = ch.byKind.get(k);
        if (!e || e.count === 0) continue;
        if (ch.center.distanceTo(cam) - ch.radius > this.lodTo) continue;
        const M = e.matrices, C = e.colors, P = e.positions;
        for (let i = 0; i < e.count; i++) {
          const dx = P[i * 3]! - cam.x, dy = P[i * 3 + 1]! - cam.y, dz = P[i * 3 + 2]! - cam.z;
          const d2 = dx * dx + dy * dy + dz * dz;
          const id = ch.serial * 4096 + i;
          if (d2 < full2 && d2 < kindLod2 && n0 < km.capacity) {
            for (let j = 0; j < 16; j++) a0[n0 * 16 + j] = M[i * 16 + j]!;
            c0[n0 * 3] = C[i * 3]!; c0[n0 * 3 + 1] = C[i * 3 + 1]!; c0[n0 * 3 + 2] = C[i * 3 + 2]!;
            if (w0) w0[n0] = e.winds[i]!;
            sig0 = Math.imul(sig0 ^ id, 0x27d4eb2d);
            n0++;
          }
          if ((d2 >= full2 || this.forceAll) && d2 < kindLod2 && n1 < km.capacity) {
            for (let j = 0; j < 16; j++) a1[n1 * 16 + j] = M[i * 16 + j]!;
            c1[n1 * 3] = C[i * 3]!; c1[n1 * 3 + 1] = C[i * 3 + 1]!; c1[n1 * 3 + 2] = C[i * 3 + 2]!;
            if (w1) w1[n1] = e.winds[i]!;
            sig1 = Math.imul(sig1 ^ id, 0x27d4eb2d);
            n1++;
          }
        }
      }
      this.commit(km.lod0, n0, sig0);
      this.commit(km.lod1, n1, sig1);
      total += n0 + n1;
    }
    this.instances = total;
  }

  private readonly signatures = new WeakMap<THREE.InstancedMesh, number>();

  private commit(mesh: THREE.InstancedMesh, n: number, sig: number) {
    const key = (sig ^ Math.imul(n, 0x165667b1)) >>> 0;
    const changed = this.signatures.get(mesh) !== key || mesh.count !== n;
    mesh.count = n;
    if (!changed || n === 0) return;
    this.signatures.set(mesh, key);
    const wind = mesh.geometry.getAttribute("iWind") as THREE.InstancedBufferAttribute | undefined;
    if (wind) {
      wind.clearUpdateRanges();
      wind.addUpdateRange(0, n);
      wind.needsUpdate = true;
    }
    mesh.instanceMatrix.clearUpdateRanges();
    mesh.instanceMatrix.addUpdateRange(0, n * 16);
    mesh.instanceMatrix.needsUpdate = true;
    mesh.instanceColor!.clearUpdateRanges();
    mesh.instanceColor!.addUpdateRange(0, n * 3);
    mesh.instanceColor!.needsUpdate = true;
  }

  dispose() {
    this.disposed = true;
    for (const k of this.kinds.values()) {
      for (const m of [k.lod0, k.lod1]) {
        const retained = this.samples?.children.some((o) => (o as THREE.Mesh).geometry === m.geometry);
        if (!retained) m.geometry.dispose();
        m.dispose();
      }
    }
    this.kinds.clear();
    this.chunks.clear();
    this.group.removeFromParent();
  }
}
