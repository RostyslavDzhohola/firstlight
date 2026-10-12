// Low-tier contact shadows (SPEC §7.1 "Low blob + baked vertex AO"): one instanced draw of soft
// dark discs under characters, aligned to local up. Only shown when shadow maps are off.

import * as THREE from "three/webgpu";
import { abs, attribute, cross, float, length, normalize, positionGeometry, select, smoothstep, vec3 } from "three/tsl";
import type { ResolvedSettings } from "./quality.ts";

const MAX = 128;

export class BlobShadows {
  readonly mesh: THREE.Mesh;
  private readonly geo: THREE.InstancedBufferGeometry;
  private readonly attr: THREE.InstancedBufferAttribute;
  private enabled = false;

  constructor(private readonly scene: THREE.Scene) {
    const quad = new THREE.PlaneGeometry(2, 2);
    this.geo = new THREE.InstancedBufferGeometry();
    this.geo.index = quad.index;
    this.geo.setAttribute("position", quad.getAttribute("position"));
    this.attr = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 4), 4);
    this.attr.setUsage(THREE.DynamicDrawUsage);
    this.geo.setAttribute("iBlob", this.attr);
    this.geo.instanceCount = 0;
    this.geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    m.name = "blobShadow";
    const ib = attribute("iBlob", "vec4");
    const up = normalize(ib.xyz);
    const ref = select(abs(up.y).lessThan(0.95), vec3(0, 1, 0), vec3(1, 0, 0));
    const t0 = normalize(cross(ref, up));
    const t1 = cross(up, t0);
    const c = positionGeometry.xy;
    m.positionNode = ib.xyz.add(up.mul(0.06)).add(t0.mul(c.x.mul(ib.w))).add(t1.mul(c.y.mul(ib.w)));
    m.colorNode = vec3(0.02, 0.02, 0.04);
    const r = length(c);
    m.opacityNode = smoothstep(1.0, 0.2, r).mul(float(0.5));
    this.mesh = new THREE.Mesh(this.geo, m);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
    this.mesh.name = "blobShadows";
    scene.add(this.mesh);
  }

  applySettings(s: ResolvedSettings) {
    this.enabled = s.on.chars && !(s.on.shadows && s.shadows.mode === "map");
    this.mesh.visible = this.enabled;
  }

  /** Ground positions (planet space) and radii of the blobs this frame. */
  update(items: readonly { x: number; y: number; z: number; r: number }[]) {
    if (!this.enabled) return;
    const a = this.attr.array as Float32Array;
    const n = Math.min(MAX, items.length);
    for (let i = 0; i < n; i++) {
      const it = items[i]!;
      a[i * 4] = it.x;
      a[i * 4 + 1] = it.y;
      a[i * 4 + 2] = it.z;
      a[i * 4 + 3] = it.r;
    }
    this.geo.instanceCount = n;
    if (n > 0) {
      this.attr.clearUpdateRanges();
      this.attr.addUpdateRange(0, n * 4);
      this.attr.needsUpdate = true;
    }
  }

  dispose() {
    this.scene.remove(this.mesh);
    this.geo.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}
