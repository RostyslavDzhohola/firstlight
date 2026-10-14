// Headless shader-generation check: builds every render material variant into WGSL (WebGPU backend)
// and GLSL (WebGL2 fallback backend) with three's node builders, without a GPU or a browser.
// It can't prove the shaders look right, but it catches TSL graph/type errors that would otherwise
// only show up at runtime as a black material.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as THREE from "three/webgpu";
import { mrt, output, velocity } from "three/tsl";
import { emptyStored, TIER_TABLE, resolveSettings, type StoredGfx, type Tier } from "./quality.ts";
import { radialFogNode, skyBackgroundNode } from "./atmosphere.ts";
import { terrainMaterialFor } from "./terrainMaterial.ts";
import { waterMaterialFor } from "./water.ts";
import { GrassSystem } from "./grass.ts";
import { PropSystem } from "./props.ts";
import { ParticleSystem } from "./particles.ts";
import { BlobShadows } from "./blobShadows.ts";
import { SkyPlanets } from "./skyPlanets.ts";
import { LOOKS } from "./looks.ts";
import { buildPost } from "./post.ts";
import { WeatherFx } from "./weather.ts";
import { stripTexture } from "./townAssets.ts";
import { townMaterial } from "./townMaterial.ts";
import { SunLight } from "three/addons/lights/SunLight.js";
import { SunLightNode } from "three/addons/lights/SunLightNode.js";

const fakeCanvas = () =>
  ({ style: {}, width: 800, height: 600, addEventListener() {}, removeEventListener() {}, getContext() { return null; } }) as unknown as HTMLCanvasElement;

const stored: StoredGfx = emptyStored();
const settingsFor = (t: Tier, webgpu = true) => resolveSettings(t, false, webgpu, stored, new Set());

interface Built {
  vertex: string;
  fragment: string;
}

function build(renderer: THREE.WebGPURenderer, scene: THREE.Scene, camera: THREE.Camera, mesh: THREE.Object3D): Built {
  const backend = renderer.backend as unknown as { createNodeBuilder(o: THREE.Object3D, r: THREE.WebGPURenderer): any };
  const material = (mesh as THREE.Mesh).material as THREE.Material;
  const b = backend.createNodeBuilder(mesh, renderer);
  b.scene = scene;
  b.material = material;
  b.camera = camera;
  b.context.material = material;
  // The renderer normally collects lights from the render list; do it here so lighting and
  // shadow-receiving code is generated too.
  const lights: THREE.Light[] = [];
  scene.traverse((o) => {
    if ((o as THREE.Light).isLight) lights.push(o as THREE.Light);
  });
  b.lightsNode = (renderer as any).lighting.getNode(scene, camera);
  b.lightsNode.setLights(lights);
  b.fogNode = scene.fogNode ?? null;
  b.environmentNode = null;
  b.build();
  return { vertex: b.vertexShader, fragment: b.fragmentShader };
}

/**
 * Derivatives (dpdx/dpdy/fwidth) inside if/else/loops are undefined in divergent quads (three turns
 * the WGSL uniformity error off on Chrome/Safari, so it would compile but shimmer). Returns offending lines.
 */
function derivativesInBranches(wgsl: string): string[] {
  const bad: string[] = [];
  const stack: boolean[] = []; // true = control-flow block
  for (const raw of wgsl.split("\n")) {
    const line = raw.trim();
    const opens = (line.match(/{/g) ?? []).length;
    const closes = (line.match(/}/g) ?? []).length;
    for (let i = 0; i < closes; i++) stack.pop();
    const inBranch = stack.some(Boolean);
    if (inBranch && /\b(dpdx|dpdy|fwidth|dpdxFine|dpdyFine|dpdxCoarse|dpdyCoarse)\s*\(/.test(line)) bad.push(line);
    const isFlow = /^(}\s*else|if\s*\(|else\b|for\s*\(|loop\b|while\b|switch\b)/.test(line);
    for (let i = 0; i < opens; i++) stack.push(isFlow);
  }
  return bad;
}

const errors: string[] = [];
beforeEach(() => {
  errors.length = 0;
  for (const k of ["error", "warn"] as const) {
    vi.spyOn(console, k).mockImplementation((...a: unknown[]) => {
      errors.push(a.map(String).join(" "));
    });
  }
});
afterEach(() => vi.restoreAllMocks());

function sceneWithLights() {
  const scene = new THREE.Scene();
  const sun = new THREE.DirectionalLight(0xffffff, 3);
  sun.castShadow = true;
  scene.add(sun, sun.target, new THREE.HemisphereLight(0x8899ff, 0x443322, 1));
  scene.fogNode = radialFogNode();
  return scene;
}

function terrainGeometry() {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(9).fill(1), 3));
  g.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(9).fill(0.5), 3));
  g.setAttribute("color", new THREE.BufferAttribute(new Float32Array(9).fill(0.5), 3));
  g.setAttribute("bake", new THREE.BufferAttribute(new Float32Array(6).fill(1), 2));
  return g;
}

for (const backendName of ["webgpu", "webgl2"] as const) {
  describe(`shader generation (${backendName})`, () => {
    const renderer = new THREE.WebGPURenderer({ canvas: fakeCanvas(), forceWebGL: backendName === "webgl2" });
    // Minimal stand-ins for what init() would provide (no GPU here): feature queries and limits.
    renderer.shadowMap.enabled = true;
    const be = renderer.backend as any;
    (renderer as any)._initialized = true;
    if (backendName === "webgpu") {
      be.device = { features: new Set<string>(["float32-filterable"]), limits: { maxUniformBufferBindingSize: 65536 } };
    } else {
      be.extensions = { has: () => false, get: () => null };
      be.capabilities = { getUniformBufferLimit: () => 16384, getMaxAnisotropy: () => 8 };
    }
    const camera = new THREE.PerspectiveCamera(75, 1, 0.3, 6000);

    const expectClean = (b: Built, checkUniformity = true) => {
      expect(b.vertex.length).toBeGreaterThan(50);
      expect(b.fragment.length).toBeGreaterThan(50);
      expect(errors.filter((e) => /TSL|NodeBuilder|not found|undefined/i.test(e))).toEqual([]);
      if (checkUniformity && backendName === "webgpu") expect(derivativesInBranches(b.fragment)).toEqual([]);
    };

    it("terrain: every tier variant, with fog and shadows", () => {
      for (const t of ["low", "medium", "high", "ultra"] as const) {
        const scene = sceneWithLights();
        const mesh = new THREE.Mesh(terrainGeometry(), terrainMaterialFor(settingsFor(t)));
        mesh.receiveShadow = true;
        scene.add(mesh);
        expectClean(build(renderer, scene, camera, mesh));
      }
    });

    it("terrain lit by the cascaded SunLight (High/Ultra opt-in)", () => {
      const scene = new THREE.Scene();
      (renderer as any).library.addLight(SunLightNode, SunLight);
      const sun = new SunLight(0xffffff, 3);
      sun.castShadow = true;
      sun.position.set(0.3, 0.8, 0.2);
      scene.add(sun, new THREE.HemisphereLight(0x8899ff, 0x443322, 1));
      scene.fogNode = radialFogNode();
      const mesh = new THREE.Mesh(terrainGeometry(), terrainMaterialFor(settingsFor("high")));
      mesh.receiveShadow = true;
      scene.add(mesh);
      expectClean(build(renderer, scene, camera, mesh));
    });

    it("water: levels 0–3", () => {
      for (let l = 0; l <= 3; l++) {
        const scene = sceneWithLights();
        const g = new THREE.BufferGeometry();
        g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(9).fill(1), 3));
        g.setAttribute("depth", new THREE.BufferAttribute(new Float32Array(3).fill(1), 1));
        const mesh = new THREE.Mesh(g, waterMaterialFor(l));
        scene.add(mesh);
        expectClean(build(renderer, scene, camera, mesh));
      }
    });

    it("grass cells", () => {
      const scene = sceneWithLights();
      const grass = new GrassSystem(500, 256);
      grass.applySettings(settingsFor("medium"));
      const cell = (grass as any).acquire();
      cell.mesh.receiveShadow = true;
      scene.add(cell.mesh);
      expectClean(build(renderer, scene, camera, cell.mesh));
    });

    it("props (instanced, both LODs)", () => {
      const scene = sceneWithLights();
      const props = new PropSystem("arcadia");
      for (const m of props.group.children) {
        (m as THREE.InstancedMesh).count = 1;
        expectClean(build(renderer, scene, camera, m));
      }
    });

    it("Portus town: opaque and cutout, with and without normal maps, casting and receiving shadows", () => {
      const layers = 16;
      const color = stripTexture(new Uint8Array(4 * layers).fill(200), 1, layers, true);
      const normal = stripTexture(new Uint8Array(4 * layers).fill(128), 1, layers, false);
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(new Float32Array([0, 150, 0, 1, 150, 0, 0, 150, 1]), 3));
      g.setAttribute("normal", new THREE.BufferAttribute(new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0]), 3));
      g.setAttribute("uv", new THREE.BufferAttribute(new Float32Array([0, 0, 2, 0, 0, 2]), 2));
      g.setAttribute("color", new THREE.BufferAttribute(new Uint8Array(12).fill(255), 4, true));
      g.setAttribute("townMat", new THREE.BufferAttribute(new Uint8Array([3, 200, 0, 2, 3, 200, 0, 2, 3, 200, 0, 2]), 4, true));
      g.setIndex([0, 1, 2]);
      for (const kind of ["opaque", "cutout"] as const) {
        for (const normals of [true, false]) {
          const scene = sceneWithLights();
          const mesh = new THREE.Mesh(g, townMaterial(kind, normals, color, normal));
          mesh.receiveShadow = true;
          mesh.castShadow = true;
          scene.add(mesh);
          const b = build(renderer, scene, camera, mesh);
          expectClean(b);
          // Both kit-texture lookups go through the layer arrays.
          expect(b.fragment).toMatch(backendName === "webgpu" ? /texture_2d_array/ : /sampler2DArray/);
        }
      }
    });

    it("particles and blob shadows", () => {
      const scene = sceneWithLights();
      const p = new ParticleSystem(scene);
      p.applySettings(settingsFor("medium"));
      expectClean(build(renderer, scene, camera, p.mesh));
      const blobs = new BlobShadows(scene);
      expectClean(build(renderer, scene, camera, blobs.mesh));
    });

    it("weather: rain/dust box and lightning bolt", () => {
      const scene = sceneWithLights();
      const fx = new WeatherFx(scene);
      fx.setCapacity(64);
      expectClean(build(renderer, scene, camera, fx.drops));
      expectClean(build(renderer, scene, camera, fx.bolt));
    });

    it("sky planets, halos and the sky background", () => {
      const scene = sceneWithLights();
      const sp = new SkyPlanets(scene, LOOKS.portus.skyPlanets);
      expectClean(build(renderer, scene, camera, sp.planets));
      expectClean(build(renderer, scene, camera, sp.halos));
      const bgMat = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide, fog: false });
      bgMat.colorNode = skyBackgroundNode() as any;
      const bg = new THREE.Mesh(new THREE.SphereGeometry(1, 8, 8), bgMat);
      expectClean(build(renderer, scene, camera, bg));
    });

    it("materials with the TRAA velocity MRT", () => {
      const scene = sceneWithLights();
      renderer.setMRT(mrt({ output, velocity }));
      try {
        const grass = new GrassSystem(500, 256);
        grass.applySettings(settingsFor("high"));
        const cell = (grass as any).acquire();
        expectClean(build(renderer, scene, camera, cell.mesh));
        const mesh = new THREE.Mesh(terrainGeometry(), terrainMaterialFor(settingsFor("high")));
        expectClean(build(renderer, scene, camera, mesh));
      } finally {
        renderer.setMRT(null);
      }
    });

    it("post pipeline output for every tier", () => {
      for (const t of ["low", "medium", "high", "ultra"] as const) {
        const s = settingsFor(t, backendName === "webgpu");
        const scene = sceneWithLights();
        const post = buildPost(scene, camera, s);
        const mat = new THREE.NodeMaterial();
        mat.fragmentNode = post.outputNode;
        const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
        // three's own FXAA samples with a bias inside branches by design: skip the uniformity check.
        expectClean(build(renderer, new THREE.Scene(), camera, quad), false);
        post.dispose();
      }
    });

    it("photo mode post (depth of field) for every tier", () => {
      for (const t of ["low", "medium", "high", "ultra"] as const) {
        const s = settingsFor(t, backendName === "webgpu");
        const post = buildPost(sceneWithLights(), camera, s, true);
        const mat = new THREE.NodeMaterial();
        mat.fragmentNode = post.outputNode;
        const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
        expectClean(build(renderer, new THREE.Scene(), camera, quad), false);
        post.dispose();
      }
    });
  });
}

describe("tier table", () => {
  it("matches SPEC §7.3 headline numbers", () => {
    expect(TIER_TABLE.low.grass).toMatchObject({ count: 25_000, radius: 25 });
    expect(TIER_TABLE.medium.grass).toMatchObject({ count: 80_000, radius: 40 });
    expect(TIER_TABLE.high.grass).toMatchObject({ count: 200_000, radius: 60 });
    expect(TIER_TABLE.ultra.grass.count).toBe(500_000);
    expect([TIER_TABLE.low.dprCap, TIER_TABLE.low.renderScale]).toEqual([1, 0.67]);
    expect([TIER_TABLE.medium.dprCap, TIER_TABLE.medium.renderScale]).toEqual([1.25, 0.85]);
    expect([TIER_TABLE.high.dprCap, TIER_TABLE.high.renderScale]).toEqual([1.5, 1]);
    expect([TIER_TABLE.ultra.dprCap, TIER_TABLE.ultra.renderScale]).toEqual([2, 1]);
    expect([TIER_TABLE.low.particles, TIER_TABLE.medium.particles, TIER_TABLE.high.particles, TIER_TABLE.ultra.particles]).toEqual([2000, 5000, 15000, 30000]);
    expect([TIER_TABLE.low.fullAvatars, TIER_TABLE.medium.fullAvatars, TIER_TABLE.high.fullAvatars, TIER_TABLE.ultra.fullAvatars]).toEqual([8, 16, 24, 40]);
    expect([TIER_TABLE.low.props.fullTo, TIER_TABLE.medium.props.fullTo, TIER_TABLE.high.props.fullTo, TIER_TABLE.ultra.props.fullTo]).toEqual([15, 25, 40, 60]);
  });

  it("never enables WebGPU-only extras on the WebGL2 fallback", () => {
    for (const t of ["low", "medium", "high", "ultra"] as const) {
      const s = resolveSettings(t, false, false, { ...stored, features: { traa: true, ao: true } }, new Set());
      expect(s.on.ao).toBe(false);
      expect(s.on.traa).toBe(false);
    }
    const hi = resolveSettings("high", false, true, stored, new Set());
    expect(hi.on.ao).toBe(true);
    expect(hi.on.traa).toBe(false); // opt-in until verified
  });

  it("kill switches win over user toggles", () => {
    const s = resolveSettings("medium", false, true, { ...stored, features: { bloom: true } }, new Set(["bloom", "post"]));
    expect(s.on.bloom).toBe(false);
    expect(s.on.fxaa).toBe(false);
  });
});
