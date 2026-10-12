// Test helper (imported only by *.test.ts): the parts of a mesh that decide whether three's
// WebGPURenderer needs a new node build / pipeline for it (RenderObject.getMaterialCacheKey +
// getGeometryCacheKey + the pipeline's blend/depth state). Colour and opacity don't count.

import type * as THREE from "three/webgpu";

export function lookKey(o: THREE.Object3D): string {
  const m = o as THREE.Mesh;
  const mat = m.material as THREE.Material;
  const g = m.geometry;
  const attrs = Object.keys(g.attributes).sort().map((n) => `${n}:${g.attributes[n]!.itemSize}`).join(",");
  return [mat.type, mat.transparent, mat.depthWrite, mat.depthTest, mat.blending, mat.side, attrs, !!g.index].join("|");
}
