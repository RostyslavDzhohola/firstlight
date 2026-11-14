// Instanced meshes and skinned bodies share their shader programs (D-perf-4).
//
// Below the backend's uniform-buffer limit, three r186 puts an InstancedMesh's matrices and a
// skeleton's bone matrices in a uniform buffer that it names after the node's id and sizes by the
// count (nodes/accessors/Instance.js, Skinning.js; RangeNode.js likewise). The source then differs
// per mesh, and programs are shared by source: every instanced prop kind, its shadow, every skinned
// look and every trial marker compiled its own vertex program though the materials matched (Portus,
// 2026-11-14: 33 of 190 stages). Past the limit, three reads interleaved per-instance attributes and a
// bone texture, both named by position, so one program serves every mesh with that material shape.
// The data and the maths are the same; only where the vertex shader reads the matrices from changes.
// `?uboinstancing` keeps three's choice (A/B runs).

/** The part of a three backend this reads (WebGPUCapabilities and WebGLCapabilities both have it). */
interface Backend {
  capabilities?: { getUniformBufferLimit?: () => number };
}

/** Send every instanced mesh and skeleton down the attribute/texture path (call before the first build). */
export function shareInstancingPrograms(renderer: { backend: unknown }): boolean {
  const caps = (renderer.backend as Backend).capabilities;
  if (!caps?.getUniformBufferLimit) return false;
  caps.getUniformBufferLimit = () => 0;
  return true;
}
