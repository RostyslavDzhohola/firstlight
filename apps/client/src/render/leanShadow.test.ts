// Lean shadow casters (#39, D-load-3), headless, through three's own shadow-pass material override,
// render objects and node-builder cache (a renderer whose backend never touches a GPU): the 42 avatar
// (7 looks × 6 palettes) and 6 horse shadow casters share one shadow build per rig; that build's
// fragment reads no texture and no palette; unregistered materials and registered ones with a real
// cutout, mask, depth or position node keep three's own shadow nodes; and two skeletons sharing the
// build still each draw their own pose.

import { afterEach, describe, expect, it, vi } from "vitest";
import * as THREE from "three/webgpu";
import { bool, float, positionLocal, uniform, vec3, vec4 } from "three/tsl";
import { HORSE_COATS } from "@firstlight/shared/content/horse";
import { avatarMaterial, PALETTES } from "./avatars/material.ts";
import type { StarterTextures } from "./avatars/assets.ts";
import { horseMaterial } from "./Horses.ts";
import { castsLeanShadow, installLeanShadows, leanShadow, leanShadowsOn, type ShadowNodesRenderer } from "./leanShadow.ts";
import { applyOccluderFade } from "./occluderFade.ts";

const fakeCanvas = () =>
  ({ style: {}, width: 800, height: 600, addEventListener() {}, removeEventListener() {}, getContext() { return null; } }) as unknown as HTMLCanvasElement;

/* eslint-disable @typescript-eslint/no-explicit-any */
type Internals = THREE.WebGPURenderer & ShadowNodesRenderer & {
  _objects: { get(...a: unknown[]): any };
  _nodes: { getForRender(ro: unknown): any; updateForRender(ro: unknown): void };
  _renderContexts: { get(): unknown };
  _handleObjectFunction: (...a: any[]) => void;
  lighting: { getNode(scene: THREE.Scene, camera: THREE.Camera): unknown };
};

/** A WebGPURenderer with three's managers but a backend that never touches a GPU. */
async function headless(backend: "webgpu" | "webgl2", lean: boolean): Promise<Internals> {
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
  await r.init();
  if (lean) installLeanShadows(r);
  return r;
}

afterEach(() => vi.unstubAllGlobals());

/** The real GLBs' layout (int16 position, int8 normal, u16 uv, u8 colour, joints and weights). */
function riggedGeometry(uv: boolean): THREE.BufferGeometry {
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
function rigged(geo: THREE.BufferGeometry, bones: number, material: THREE.Material): THREE.SkinnedMesh {
  const list = Array.from({ length: bones }, () => new THREE.Bone());
  for (let i = 1; i < bones; i++) list[0]!.add(list[i]!);
  const mesh = new THREE.SkinnedMesh(geo, material);
  mesh.add(list[0]!);
  mesh.bind(new THREE.Skeleton(list));
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

/** Every avatar look × palette and every horse coat, as the game builds them. */
function casters(): THREE.SkinnedMesh[] {
  const out: THREE.SkinnedMesh[] = [];
  const avatarGeo = riggedGeometry(true);
  for (let look = 0; look < 7; look++) {
    const tex = { albedo: new THREE.Texture(), normal: new THREE.Texture() } as StarterTextures; // each look its own
    for (let p = 0; p < PALETTES.length; p++) out.push(rigged(avatarGeo, 65, avatarMaterial(tex, p)));
  }
  const horseGeo = riggedGeometry(false);
  for (let c = 0; c < HORSE_COATS.length; c++) out.push(rigged(horseGeo, 41, horseMaterial(c)));
  return out;
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

interface Drawn {
  object: THREE.Object3D;
  ro: any;
  state: any;
}

/**
 * Draw `meshes` into a shadow map the way three's shadow pass does (Renderer.renderObject with the
 * shadow material as the scene's override), stopping where the backend would draw: each render
 * object and its node-builder state, through three's own caches.
 */
function shadowPass(r: Internals, meshes: THREE.Object3D[]): Drawn[] {
  const scene = new THREE.Scene();
  scene.overrideMaterial = shadowPassMaterial();
  const camera = new THREE.OrthographicCamera();
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

/** Shader text that samples a texture (GLSL texture(), WGSL textureSample*()/textureLoad()). */
const SAMPLES = /\btexture(Sample\w*|Load)?\s*\(/;

for (const backend of ["webgl2", "webgpu"] as const) {
  describe(`lean shadow casters (${backend})`, () => {
    it("all 42 avatar and 6 horse casters share one shadow build per rig (48 without)", async () => {
      for (const lean of [false, true]) {
        const r = await headless(backend, lean);
        let builds = 0;
        r.debug.onNodeBuilderCreated = () => void builds++;
        const drawn = shadowPass(r, casters());
        const keys = new Set(drawn.map((d) => d.ro.initialCacheKey)); // what three's node-builder cache is keyed by
        const states = new Set(drawn.map((d) => d.state));
        expect(drawn).toHaveLength(48);
        expect([keys.size, states.size, builds]).toEqual(lean ? [2, 2, 2] : [48, 48, 48]);
      }
    });

    it("the shared shadow build reads no texture and no palette or coat colour", async () => {
      const r = await headless(backend, true);
      const states = new Set(shadowPass(r, casters()).map((d) => d.state));
      // each colour's linear red, as the shader writes it (the long ones: "1" or "0" would match anything)
      const colours = [...PALETTES.flat(), ...HORSE_COATS.flat()].map((hex) => String(new THREE.Color(hex).r)).filter((c) => c.length > 6);
      expect(colours.length).toBeGreaterThan(20);
      for (const s of states) {
        const fs = s.fragmentShader as string;
        expect(fs).not.toMatch(SAMPLES);
        expect(fs).not.toMatch(/\bmix\s*\(/);
        for (const c of colours) expect(fs).not.toContain(c);
      }
      // without lean shadows the albedo texture and the palette were in every avatar's shadow fragment
      const full = await headless(backend, false);
      const avatar = shadowPass(full, casters().slice(0, 1))[0]!;
      expect(avatar.state.fragmentShader).toMatch(SAMPLES);
      expect(colours.some((c) => (avatar.state.fragmentShader as string).includes(c))).toBe(true);
    });

    it("two skeletons sharing the build each draw their own pose, drawn alternately", async () => {
      const r = await headless(backend, true);
      const tex = { albedo: new THREE.Texture(), normal: new THREE.Texture() } as StarterTextures;
      const geo = riggedGeometry(true);
      const a = rigged(geo, 65, avatarMaterial(tex, 0));
      const b = rigged(geo, 65, avatarMaterial(tex, 3)); // another palette: the same lean shadow build
      b.skeleton.bones[1]!.position.set(0, 2, 0);
      for (const m of [a, b]) m.updateMatrixWorld(true);
      const [da, db] = shadowPass(r, [a, b]);
      expect(da!.state).toBe(db!.state);
      const bones = (da!.state.updateNodes as any[]).find((n) => n.type === "ReferenceNode" && n.property === "skeleton.boneMatrices");
      expect(bones).toBeDefined();
      for (const d of [da!, db!, da!, db!]) {
        r._nodes.updateForRender(d.ro);
        const mesh = d.object as THREE.SkinnedMesh;
        expect(bones.node.value).toBe(mesh.skeleton.boneMatrices);
      }
      expect(Array.from(a.skeleton.boneMatrices!)).not.toEqual(Array.from(b.skeleton.boneMatrices!)); // two poses
    });
  });
}

describe("which materials cast lean shadows", () => {
  it("unregistered materials (weapons, cosmetics) keep three's own shadow nodes", async () => {
    const r = await headless("webgl2", true);
    const proto = THREE.WebGPURenderer.prototype as unknown as Required<ShadowNodesRenderer>;
    const cosmetic = new THREE.MeshStandardNodeMaterial();
    cosmetic.colorNode = vec3(1, 0.5, 0.2);
    expect(castsLeanShadow(cosmetic)).toBe(false);
    const own = proto._getShadowNodes.call(r, cosmetic);
    expect(r._getShadowNodes!(cosmetic)).toBe(own);
    expect(own.colorNode).not.toBeNull();
  });

  it("a registered material casts a lean shadow, the camera fade's keep-all mask included", async () => {
    const r = await headless("webgl2", true);
    const m = leanShadow(applyOccluderFade(new THREE.MeshToonNodeMaterial()));
    m.colorNode = vec3(1, 0, 0);
    expect(castsLeanShadow(m)).toBe(true);
    expect(r._getShadowNodes!(m)).toMatchObject({ colorNode: null, depthNode: null, positionNode: null });
  });

  it("a registered material with a real cutout, mask, depth or position node goes through three's own path", async () => {
    const r = await headless("webgl2", true);
    const proto = THREE.WebGPURenderer.prototype as unknown as Required<ShadowNodesRenderer>;
    const variants: [string, (m: THREE.MeshToonNodeMaterial) => void][] = [
      ["alpha test", (m) => void (m.alphaTest = 0.5)],
      ["texture map", (m) => void (m.map = new THREE.Texture())],
      ["alpha map", (m) => void (m.alphaMap = new THREE.Texture())],
      ["shadow mask", (m) => void (m.maskShadowNode = uniform(1).greaterThan(0.5) as unknown as THREE.Node)],
      ["mask", (m) => void (m.maskNode = bool(true) as unknown as THREE.Node)],
      ["depth", (m) => void (m.depthNode = float(0.5) as unknown as THREE.Node)],
      ["position", (m) => void (m.positionNode = positionLocal.mul(2) as unknown as THREE.Node)],
      ["cast-shadow position", (m) => void ((m as unknown as { castShadowPositionNode: unknown }).castShadowPositionNode = positionLocal)],
      ["cast-shadow colour", (m) => void ((m as unknown as { castShadowNode: unknown }).castShadowNode = vec4(1, 0, 0, 0.5))],
    ];
    for (const [what, set] of variants) {
      const m = leanShadow(new THREE.MeshToonNodeMaterial());
      m.colorNode = vec3(1, 0, 0);
      expect(castsLeanShadow(m), what).toBe(true);
      set(m);
      m.needsUpdate = true;
      expect(castsLeanShadow(m), what).toBe(false);
      expect(r._getShadowNodes!(m), what).toBe(proto._getShadowNodes.call(r, m));
    }
    const moved = leanShadow(new THREE.MeshToonNodeMaterial());
    moved.positionNode = positionLocal.mul(2) as unknown as THREE.Node;
    expect(r._getShadowNodes!(moved).positionNode).toBe(moved.positionNode); // kept
  });

  it("installs once per renderer and does nothing on a renderer without three's method", async () => {
    const r = await headless("webgl2", false);
    expect(leanShadowsOn(r)).toBe(false);
    expect(installLeanShadows(r)).toBe(true);
    const wrapped = r._getShadowNodes;
    expect(installLeanShadows(r)).toBe(true);
    expect(r._getShadowNodes).toBe(wrapped); // not wrapped twice
    expect(leanShadowsOn(r)).toBe(true);
    expect(installLeanShadows({} as ShadowNodesRenderer)).toBe(false);
  });
});
