// Test helper (imported only by *.test.ts): a WebGPURenderer with three's own managers, render
// objects and node-builder cache but a backend that never touches a GPU, and the two passes the
// character tests draw through it: the shadow pass (three's shadow-material override) and the main
// pass (three's own Renderer._renderObjectDirect, its GPU calls stubbed, recording what each draw's
// per-object uniform buffer holds when three updates it).

import { vi } from "vitest";
import * as THREE from "three/webgpu";
import { vec4 } from "three/tsl";
import { installLeanShadows, type ShadowNodesRenderer } from "./leanShadow.ts";

const fakeCanvas = () =>
  ({ style: {}, width: 800, height: 600, addEventListener() {}, removeEventListener() {}, getContext() { return null; } }) as unknown as HTMLCanvasElement;

/* eslint-disable @typescript-eslint/no-explicit-any */
export type Internals = THREE.WebGPURenderer & ShadowNodesRenderer & {
  _objects: { get(...a: unknown[]): any };
  _nodes: { getForRender(ro: unknown): any; updateForRender(ro: unknown): void };
  _renderContexts: { get(): unknown };
  _handleObjectFunction: (...a: any[]) => void;
  _currentRenderContext: unknown;
  _geometries: { updateForRender(ro: unknown): void };
  _pipelines: { updateForRender(ro: unknown): void; isReady(ro: unknown): boolean };
  _bindings: { updateForRender(ro: unknown): void };
  lighting: { getNode(scene: THREE.Scene, camera: THREE.Camera): unknown };
};

/**
 * A WebGPURenderer with three's managers but a backend that never touches a GPU. Call
 * `vi.unstubAllGlobals()` after each test (three's animation loop needs a stubbed `self`).
 */
export async function headless(backend: "webgpu" | "webgl2", lean: boolean): Promise<Internals> {
  const r = new THREE.WebGPURenderer({ canvas: fakeCanvas(), forceWebGL: backend === "webgl2" }) as Internals;
  r.shadowMap.enabled = true;
  const be = r.backend as any;
  be.init = async (renderer: unknown) => void (be.renderer = renderer);
  if (backend === "webgpu") {
    be.device = { features: new Set<string>(["float32-filterable"]), limits: { maxUniformBufferBindingSize: 65536 } };
  } else {
    be.extensions = { has: () => false, get: () => null };
    be.capabilities = { getUniformBufferLimit: () => 16384, getMaxAnisotropy: () => 8 };
  }
  vi.stubGlobal("self", { requestAnimationFrame: () => 0, cancelAnimationFrame() {} }); // three's animation loop
  if (typeof ImageBitmap === "undefined") vi.stubGlobal("ImageBitmap", class {}); // three's texture node update asks
  await r.init();
  if (lean) installLeanShadows(r);
  return r;
}

/** The real GLBs' layout (int16 position, int8 normal, u16 uv, u8 colour, joints and weights). */
export function riggedGeometry(uv: boolean): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  const n = 3;
  g.setAttribute("position", new THREE.BufferAttribute(new Int16Array(n * 3).fill(100), 3, true));
  g.setAttribute("normal", new THREE.BufferAttribute(new Int8Array(n * 3).fill(60), 3, true));
  if (uv) g.setAttribute("uv", new THREE.BufferAttribute(new Uint16Array(n * 2).fill(100), 2, true));
  g.setAttribute("color", new THREE.BufferAttribute(new Uint8Array(n * 4).fill(100), 4, true));
  g.setAttribute("skinIndex", new THREE.BufferAttribute(new Uint8Array([0, 1, 0, 0, 1, 2, 0, 0, 2, 3, 0, 0]), 4));
  g.setAttribute("skinWeight", new THREE.BufferAttribute(new Uint8Array(n * 4).fill(64), 4, true));
  g.setIndex([0, 1, 2]);
  return g;
}

/** A skinned mesh on its own skeleton of `bones` bones (each avatar and horse has its own). */
export function rigged(geo: THREE.BufferGeometry, bones: number, material: THREE.Material): THREE.SkinnedMesh {
  const list = Array.from({ length: bones }, () => new THREE.Bone());
  for (let i = 1; i < bones; i++) list[0]!.add(list[i]!);
  const mesh = new THREE.SkinnedMesh(geo, material);
  mesh.add(list[0]!);
  mesh.bind(new THREE.Skeleton(list));
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

/** three's shadow-pass override material (ShadowBaseNode's, which three doesn't export). */
function shadowPassMaterial(): THREE.NodeMaterial {
  const m = new THREE.NodeMaterial();
  m.colorNode = vec4(0, 0, 0, 1);
  (m as THREE.NodeMaterial & { isShadowPassMaterial: boolean }).isShadowPassMaterial = true;
  m.name = "ShadowMaterial";
  m.blending = THREE.NoBlending;
  m.fog = false;
  return m;
}

const shadowScenes = new WeakMap<object, { scene: THREE.Scene; camera: THREE.Camera }>();

export interface Drawn {
  object: THREE.Object3D;
  ro: any;
  state: any;
}

/**
 * Draw `meshes` into a shadow map the way three's shadow pass does (Renderer.renderObject with the
 * shadow material as the scene's override), stopping where the backend would draw: each render
 * object and its node-builder state, through three's own caches.
 */
export function shadowPass(r: Internals, meshes: THREE.Object3D[]): Drawn[] {
  let pass = shadowScenes.get(r); // one shadow material per light, as three's shadow node keeps
  if (!pass) {
    pass = { scene: new THREE.Scene(), camera: new THREE.OrthographicCamera() };
    pass.scene.overrideMaterial = shadowPassMaterial();
    shadowScenes.set(r, pass);
  }
  const { scene, camera } = pass;
  const lightsNode = r.lighting.getNode(scene, camera);
  const context = r._renderContexts.get();
  const out: Drawn[] = [];
  const own = r._handleObjectFunction;
  r._handleObjectFunction = (object, material, sc, cam, lights, _group, clipping, passId) => {
    const ro = r._objects.get(object, material, sc, cam, lights, context, clipping, passId);
    out.push({ object, ro, state: r._nodes.getForRender(ro) });
  };
  try {
    for (const m of meshes) {
      const mesh = m as THREE.Mesh;
      r.renderObject(mesh, scene, camera, mesh.geometry, mesh.material as THREE.Material, null, lightsNode as never, null, null);
    }
  } finally {
    r._handleObjectFunction = own;
  }
  return out;
}

/** A per-object uniform buffer of a draw (three's NodeUniformsGroup of a group that isn't shared). */
interface ObjectBuffer {
  buffer: Float32Array;
  uniforms: { isColorUniform?: boolean; offset: number }[];
  update(): boolean;
}

export interface MainDrawn extends Drawn {
  /** The draw's per-object uniform buffers. */
  buffers: ObjectBuffer[];
  /** The colours (linear r, g, b) in them as three wrote them for this draw. */
  colours: [number, number, number][];
}

/** The colour uniforms of per-object buffers, as they hold now. */
export function coloursIn(buffers: readonly ObjectBuffer[]): [number, number, number][] {
  const out: [number, number, number][] = [];
  for (const b of buffers) {
    for (const u of b.uniforms) if (u.isColorUniform) out.push([b.buffer[u.offset]!, b.buffer[u.offset + 1]!, b.buffer[u.offset + 2]!]);
  }
  return out;
}

/**
 * Draw `meshes` in `scene`'s main pass through three's own Renderer._renderObjectDirect: its node
 * updates run as in a frame; geometry upload, pipelines and the draw itself are stubbed, and the
 * bindings update writes each per-object uniform buffer (as three's would) and records what it holds.
 */
export function mainPass(r: Internals, scene: THREE.Scene, meshes: THREE.Object3D[]): MainDrawn[] {
  const camera = new THREE.PerspectiveCamera();
  const lightsNode = r.lighting.getNode(scene, camera);
  const out: MainDrawn[] = [];
  const own = { geo: r._geometries.updateForRender, pipe: r._pipelines.updateForRender, ready: r._pipelines.isReady, bind: r._bindings.updateForRender, ctx: r._currentRenderContext };
  r._currentRenderContext = r._renderContexts.get();
  r._geometries.updateForRender = () => {};
  r._pipelines.updateForRender = () => {};
  r._pipelines.isReady = () => false; // nothing reaches the backend's draw
  r._bindings.updateForRender = (ro: any) => {
    const buffers: ObjectBuffer[] = [];
    for (const group of ro.getBindings()) {
      for (const b of group.bindings) if (b.isNodeUniformsGroup && b.groupNode?.shared !== true) buffers.push(b);
    }
    for (const b of buffers) b.update();
    out.push({ object: ro.object, ro, state: r._nodes.getForRender(ro), buffers, colours: coloursIn(buffers) });
  };
  try {
    for (const m of meshes) {
      const mesh = m as THREE.Mesh;
      r.renderObject(mesh, scene, camera, mesh.geometry, mesh.material as THREE.Material, null, lightsNode as never, null, null);
    }
  } finally {
    Object.assign(r._geometries, { updateForRender: own.geo });
    Object.assign(r._pipelines, { updateForRender: own.pipe, isReady: own.ready });
    Object.assign(r._bindings, { updateForRender: own.bind });
    r._currentRenderContext = own.ctx;
  }
  return out;
}
