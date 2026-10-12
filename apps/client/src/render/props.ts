// Trees, rocks, reeds, spires (SPEC §7.3 trees/rocks row): one InstancedMesh per kind per LOD for
// the whole planet, refilled a few times a second from the props of the loaded chunks (placed by
// the shared, deterministic chunkProps in the worker). LOD0 (full mesh, casts shadows) up to the
// tier's "full mesh to" distance, LOD1 (low poly, no shadow) to the draw distance.
// Draws: ≤ 2 per kind present on the body, +1 shadow draw per kind.

import * as THREE from "three/webgpu";
import { hash01, PROP_KINDS, PROP_STRIDE, PROP_STYLES, type BodyId, type PropKind } from "@firstlight/shared";
import { float, materialColor, mix } from "three/tsl";
import { atmo } from "./atmosphere.ts";
import { propGeometry } from "./propGeometry.ts";
import type { ResolvedSettings } from "./quality.ts";

interface ChunkProps {
  key: string;
  /** Unique per registration (instance identity for upload signatures). */
  serial: number;
  center: THREE.Vector3;
  radius: number;
  /** Per kind: precomputed instance matrices (16 floats each) and colours (3 floats each). */
  byKind: Map<number, { matrices: Float32Array; colors: Float32Array; positions: Float32Array; count: number }>;
}

interface KindMeshes {
  kind: PropKind;
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

  constructor(body: BodyId) {
    this.group.name = "props";
    const material = propMaterial();
    const kinds = new Set(PROP_STYLES[body].map((r) => r.kind));
    for (const kind of kinds) {
      const k = PROP_KINDS.indexOf(kind);
      const capacity = CAPACITY[kind] ?? 2500;
      const mk = (lod: 0 | 1) => {
        const m = new THREE.InstancedMesh(propGeometry(body, kind, lod), material, capacity);
        m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3).fill(1), 3);
        m.count = 0;
        m.frustumCulled = false;
        m.receiveShadow = true;
        m.castShadow = lod === 0;
        m.name = `prop:${kind}:L${lod}`;
        this.group.add(m);
        return m;
      };
      this.kinds.set(k, { kind, lod0: mk(0), lod1: mk(1), capacity });
    }
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
    this.forceAll = on;
    this.dirty = true;
  }

  /** Register a chunk's packed props (from the worker). */
  addChunk(key: string, packed: Float32Array, center: THREE.Vector3, radius: number) {
    const count = packed.length / PROP_STRIDE;
    const byKindCount = new Map<number, number>();
    for (let i = 0; i < count; i++) {
      const k = packed[i * PROP_STRIDE]!;
      if (this.kinds.has(k)) byKindCount.set(k, (byKindCount.get(k) ?? 0) + 1);
    }
    const byKind: ChunkProps["byKind"] = new Map();
    for (const [k, n] of byKindCount) {
      byKind.set(k, { matrices: new Float32Array(n * 16), colors: new Float32Array(n * 3), positions: new Float32Array(n * 3), count: 0 });
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
      const k = packed[o]!;
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
      // Order-dependent signature of the selected instances: upload only when it changes.
      let sig0 = 0x9e3779b9, sig1 = 0x85ebca6b;
      const a0 = km.lod0.instanceMatrix.array as Float32Array;
      const a1 = km.lod1.instanceMatrix.array as Float32Array;
      const c0 = km.lod0.instanceColor!.array as Float32Array;
      const c1 = km.lod1.instanceColor!.array as Float32Array;
      for (const ch of this.chunks.values()) {
        const e = ch.byKind.get(k);
        if (!e || e.count === 0) continue;
        if (ch.center.distanceTo(cam) - ch.radius > this.lodTo) continue;
        const M = e.matrices, C = e.colors, P = e.positions;
        for (let i = 0; i < e.count; i++) {
          const dx = P[i * 3]! - cam.x, dy = P[i * 3 + 1]! - cam.y, dz = P[i * 3 + 2]! - cam.z;
          const d2 = dx * dx + dy * dy + dz * dz;
          const id = ch.serial * 4096 + i;
          if (d2 < full2 && n0 < km.capacity) {
            for (let j = 0; j < 16; j++) a0[n0 * 16 + j] = M[i * 16 + j]!;
            c0[n0 * 3] = C[i * 3]!; c0[n0 * 3 + 1] = C[i * 3 + 1]!; c0[n0 * 3 + 2] = C[i * 3 + 2]!;
            sig0 = Math.imul(sig0 ^ id, 0x27d4eb2d);
            n0++;
          }
          if ((d2 >= full2 || this.forceAll) && d2 < lod2 && n1 < km.capacity) {
            for (let j = 0; j < 16; j++) a1[n1 * 16 + j] = M[i * 16 + j]!;
            c1[n1 * 3] = C[i * 3]!; c1[n1 * 3 + 1] = C[i * 3 + 1]!; c1[n1 * 3 + 2] = C[i * 3 + 2]!;
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
    mesh.instanceMatrix.clearUpdateRanges();
    mesh.instanceMatrix.addUpdateRange(0, n * 16);
    mesh.instanceMatrix.needsUpdate = true;
    mesh.instanceColor!.clearUpdateRanges();
    mesh.instanceColor!.addUpdateRange(0, n * 3);
    mesh.instanceColor!.needsUpdate = true;
  }

  dispose() {
    for (const k of this.kinds.values()) {
      for (const m of [k.lod0, k.lod1]) {
        m.geometry.dispose();
        m.dispose();
      }
    }
    this.kinds.clear();
    this.chunks.clear();
    this.group.removeFromParent();
  }
}
