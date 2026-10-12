// Instanced part batcher: every NPC, projectile and arena prop is drawn from a handful of shared
// unit primitives × three shared materials, one InstancedMesh per (primitive, material) pair.
// Each frame: begin() → push(...) per part → end(). Unused batches are hidden (no draw call), so the
// whole NPC layer costs ≈ 10–14 draws plus their shadow pass.

import * as THREE from "three/webgpu";

export type GeoKey = "box" | "sph" | "cyl" | "cone" | "tor" | "arc";
export type MatKey = "std" | "metal" | "glow";

const GEO_KEYS: GeoKey[] = ["box", "sph", "cyl", "cone", "tor", "arc"];
const MAT_KEYS: MatKey[] = ["std", "metal", "glow"];
/** Instance capacity per (primitive, material): ~150 NPCs in view at ~25 parts each, plus props. */
const CAPACITY: Record<MatKey, Record<GeoKey, number>> = {
  std: { box: 4000, sph: 1500, cyl: 1500, cone: 800, tor: 300, arc: 100 },
  metal: { box: 1500, sph: 600, cyl: 800, cone: 100, tor: 100, arc: 32 },
  glow: { box: 3000, sph: 1500, cyl: 1000, cone: 300, tor: 300, arc: 32 },
};

function makeGeos(): Record<GeoKey, THREE.BufferGeometry> {
  return {
    box: new THREE.BoxGeometry(1, 1, 1),
    sph: new THREE.IcosahedronGeometry(0.5, 1),
    cyl: new THREE.CylinderGeometry(0.5, 0.5, 1, 8),
    cone: new THREE.ConeGeometry(0.5, 1, 8),
    tor: new THREE.TorusGeometry(0.5, 0.07, 5, 18),
    arc: new THREE.TorusGeometry(0.5, 0.05, 4, 10, Math.PI),
  };
}

interface Batch {
  mesh: THREE.InstancedMesh;
  count: number;
  cap: number;
  colors: Float32Array;
}

export class PartBatcher {
  readonly group = new THREE.Group();
  private readonly batches = new Map<string, Batch>();
  private readonly geos = makeGeos();
  readonly materials: Record<MatKey, THREE.Material>;

  constructor(shadows: boolean) {
    const std = new THREE.MeshStandardNodeMaterial({ roughness: 0.62, metalness: 0.05 });
    const metal = new THREE.MeshStandardNodeMaterial({ roughness: 0.24, metalness: 0.85 });
    const glow = new THREE.MeshBasicNodeMaterial({ color: 0xffffff });
    this.materials = { std, metal, glow };
    for (const g of GEO_KEYS) {
      for (const m of MAT_KEYS) {
        const cap = CAPACITY[m][g];
        const mesh = new THREE.InstancedMesh(this.geos[g], this.materials[m], cap);
        mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        const colors = new Float32Array(cap * 3);
        mesh.instanceColor = new THREE.InstancedBufferAttribute(colors, 3);
        mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
        mesh.count = 0;
        mesh.visible = false;
        mesh.frustumCulled = false;
        mesh.castShadow = shadows && m !== "glow";
        mesh.receiveShadow = m !== "glow";
        this.group.add(mesh);
        this.batches.set(`${g}:${m}`, { mesh, count: 0, cap, colors });
      }
    }
  }

  begin() {
    for (const b of this.batches.values()) b.count = 0;
  }

  /** Add one instance; colour is linear RGB (glow parts may exceed 1 for bloom). */
  push(g: GeoKey, m: MatKey, matrix: THREE.Matrix4, r: number, gr: number, b: number) {
    const batch = this.batches.get(`${g}:${m}`)!;
    if (batch.count >= batch.cap) return;
    const i = batch.count++;
    matrix.toArray(batch.mesh.instanceMatrix.array as Float32Array, i * 16);
    batch.colors[i * 3] = r;
    batch.colors[i * 3 + 1] = gr;
    batch.colors[i * 3 + 2] = b;
  }

  end() {
    for (const b of this.batches.values()) {
      const m = b.mesh;
      m.count = b.count;
      m.visible = b.count > 0;
      if (b.count === 0) continue;
      m.instanceMatrix.clearUpdateRanges();
      m.instanceMatrix.addUpdateRange(0, b.count * 16);
      m.instanceMatrix.needsUpdate = true;
      const c = m.instanceColor!;
      c.clearUpdateRanges();
      c.addUpdateRange(0, b.count * 3);
      c.needsUpdate = true;
    }
  }

  /** Draw calls this frame (excluding the shadow pass). */
  drawCalls(): number {
    let n = 0;
    for (const b of this.batches.values()) if (b.count > 0) n++;
    return n;
  }

  dispose() {
    this.group.removeFromParent();
    for (const b of this.batches.values()) b.mesh.dispose();
    for (const g of Object.values(this.geos)) g.dispose();
    for (const m of Object.values(this.materials)) m.dispose();
  }
}
