// Test helper (imported only by *.test.ts): a WebGPURenderer whose real WebGL2 or WebGPU backend runs
// on a recording stand-in for the GPU (fakeGpu.testutil.ts), so three's own managers and backend code
// (node builds, bindings, uniform uploads, bind groups, pipelines, draws) run unchanged in node. Frames
// are real renderer.render() calls; a spy on the backend's draw only tags each recorded draw with the
// render object it draws. Also the shadow pass as three's shadow node draws a caster (the
// shadow-material override), stopped where the backend would draw, for the lean-shadow tests.

import { vi } from "vitest";
import * as THREE from "three/webgpu";
import { vec4 } from "three/tsl";
import { fakeWebGL2, fakeWebGPU, WEBGPU_GLOBALS, type FakeGpu, type GpuBuffer, type GpuDraw } from "./fakeGpu.testutil.ts";
import { installLeanShadows, type ShadowNodesRenderer } from "./leanShadow.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */
export type Internals = THREE.WebGPURenderer & ShadowNodesRenderer & {
  _objects: { get(...a: unknown[]): any };
  _nodes: { getForRender(ro: unknown): any; updateForRender(ro: unknown): void };
  _renderContexts: { get(): unknown };
  _handleObjectFunction: (...a: any[]) => void;
  lighting: { getNode(scene: THREE.Scene, camera: THREE.Camera): unknown };
  /** The recording GPU under the backend. */
  gpu: FakeGpu;
};

/**
 * A WebGPURenderer with three's real `backend` ("webgl2": WebGLBackend, "webgpu": WebGPUBackend) on a
 * recording fake GPU, initialised as three does it. Call `vi.unstubAllGlobals()` after each test
 * (three's animation loop needs a stubbed `self`; WebGPU its usage flags and canvas format).
 */
export async function headless(backend: "webgpu" | "webgl2", lean: boolean): Promise<Internals> {
  vi.stubGlobal("self", { requestAnimationFrame: () => 0, cancelAnimationFrame() {} }); // three's animation loop
  if (typeof ImageBitmap === "undefined") vi.stubGlobal("ImageBitmap", class {}); // three's texture node update asks
  vi.stubGlobal("requestAnimationFrame", (cb: (t: number) => void) => setTimeout(() => cb(performance.now()), 0)); // compileAsync yields
  const canvas = (context: unknown) =>
    ({ style: {}, width: 800, height: 600, addEventListener() {}, removeEventListener() {}, getContext: () => context }) as unknown as HTMLCanvasElement;
  let r: Internals;
  let gpu: FakeGpu;
  if (backend === "webgpu") {
    for (const [k, v] of Object.entries(WEBGPU_GLOBALS)) vi.stubGlobal(k, v);
    const fake = fakeWebGPU();
    r = new THREE.WebGPURenderer({ canvas: canvas(fake.context), device: fake.device } as never) as Internals;
    gpu = fake.gpu;
  } else {
    const fake = fakeWebGL2();
    r = new THREE.WebGPURenderer({ canvas: canvas(fake.gl), forceWebGL: true }) as Internals;
    gpu = fake.gpu;
  }
  r.gpu = gpu;
  r.shadowMap.enabled = true;
  await r.init();
  // Observe, don't replace: tag the GPU's draws with the render object three's backend is drawing.
  const be = r.backend as unknown as { draw(ro: unknown, info: unknown): unknown };
  const draw = be.draw;
  be.draw = function (this: unknown, ro: unknown, info: unknown) {
    gpu.tag = ro;
    try {
      return draw.call(this, ro, info);
    } finally {
      gpu.tag = null;
    }
  };
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

/**
 * Render `n` frames of `scene` from `camera` (the same scene and camera throughout: three keeps its
 * render objects across them), after compiling it as the warm-up does. Returns the GPU's draws of
 * those frames.
 */
export async function frames(r: Internals, scene: THREE.Scene, camera: THREE.Camera, n: number): Promise<GpuDraw[]> {
  await r.compileAsync(scene, camera);
  const from = r.gpu.draws.length;
  for (let i = 0; i < n; i++) {
    r.gpu.frame++;
    r.render(scene, camera);
  }
  return r.gpu.draws.slice(from);
}

/** What one draw of an object read from its own per-object uniform buffer. */
export interface ObjectDraw {
  object: THREE.Object3D;
  /** three's render object for it. */
  ro: any;
  frame: number;
  /** The GPU buffer three made for the render object's per-object uniform group. */
  buffer: GpuBuffer;
  /** WebGPU: the bind group three made for that group (null on WebGL2). */
  group: object | null;
  /** The draw read that buffer (WebGL2: bound to a uniform-block index; WebGPU: through that bind group). */
  selected: boolean;
  /** The colour uniforms in that buffer (linear r, g, b) as the draw read them. */
  colours: [number, number, number][];
  /** The same with each uniform's name in the shaders. */
  named: { name: string; rgb: [number, number, number] }[];
}

/**
 * The draws of `objects` among `draws`, each with its per-object uniform buffer (three's non-shared
 * "object" NodeUniformsGroup of the render object, and the backend's GPU buffer and bind group for it),
 * whether the draw used it, and the colours in it as the GPU read them.
 */
export function objectDraws(r: Internals, draws: readonly GpuDraw[], objects: readonly THREE.Object3D[]): ObjectDraw[] {
  const be = r.backend as unknown as { get(o: object): any; isWebGPUBackend?: boolean };
  const out: ObjectDraw[] = [];
  for (const d of draws) {
    const ro = d.tag as any;
    if (!ro || !objects.includes(ro.object)) continue;
    let binding: any = null;
    let bindGroup: any = null;
    for (const g of ro.getBindings()) {
      for (const b of g.bindings) {
        if (b.isNodeUniformsGroup && b.groupNode?.shared !== true && b.groupNode?.name === "object") [binding, bindGroup] = [b, g];
      }
    }
    if (!binding) throw new Error("no per-object uniform group");
    const buffer: GpuBuffer = be.isWebGPUBackend ? be.get(binding).buffer : be.get(binding).bufferGPU;
    const group: object | null = be.isWebGPUBackend ? be.get(bindGroup).group : null;
    const selected = group
      ? [...d.bound.values()].includes(group) && r.gpu.entriesOf(group).some((e) => e.resource?.buffer === buffer)
      : [...d.bound.values()].includes(buffer);
    const bytes = d.bytes.get(buffer);
    const floats = bytes ? new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >> 2) : new Float32Array(0);
    const named: ObjectDraw["named"] = [];
    for (const u of binding.uniforms as { isColorUniform?: boolean; offset: number; name: string }[]) {
      if (u.isColorUniform) named.push({ name: u.name, rgb: [floats[u.offset] ?? NaN, floats[u.offset + 1] ?? NaN, floats[u.offset + 2] ?? NaN] });
    }
    out.push({ object: ro.object, ro, frame: d.frame, buffer, group, selected, colours: named.map((n) => n.rgb), named });
  }
  return out;
}
