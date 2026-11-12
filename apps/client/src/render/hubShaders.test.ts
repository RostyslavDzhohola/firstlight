// Headless shader generation for the hub lane's materials (D-gfx-hub): the rez light, the portal
// vortex and pad beam, the sky traffic and aurora, the light pools; WGSL (WebGPU) and GLSL (WebGL2
// fallback) through three's node builders, as shaders.test.ts does for the rest. Catches TSL graph
// and type errors that would otherwise show up in play as a black or missing effect.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as THREE from "three/webgpu";
import { createTerrain } from "@firstlight/shared";
import { radialFogNode } from "./atmosphere.ts";
import { LOOKS } from "./looks.ts";
import { rezFxMesh } from "./rez.ts";
import { SkyLife } from "./skyLife.ts";
import { lightPoolGeometry, lightPoolMaterial, portusLightPools } from "../world/lightPools.ts";
import { BEAM_HEIGHT, beamMaterial, vortexMaterial } from "../world/portalVortex.ts";

const fakeCanvas = () =>
  ({ style: {}, width: 800, height: 600, addEventListener() {}, removeEventListener() {}, getContext() { return null; } }) as unknown as HTMLCanvasElement;

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
  b.lightsNode = (renderer as any).lighting.getNode(scene, camera);
  b.lightsNode.setLights([]);
  b.fogNode = scene.fogNode ?? null;
  b.environmentNode = null;
  b.build();
  return { vertex: b.vertexShader, fragment: b.fragmentShader };
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

for (const backendName of ["webgpu", "webgl2"] as const) {
  describe(`hub lane shader generation (${backendName})`, () => {
    const renderer = new THREE.WebGPURenderer({ canvas: fakeCanvas(), forceWebGL: backendName === "webgl2" });
    const be = renderer.backend as any;
    (renderer as any)._initialized = true;
    if (backendName === "webgpu") {
      be.device = { features: new Set<string>(["float32-filterable"]), limits: { maxUniformBufferBindingSize: 65536 } };
    } else {
      be.extensions = { has: () => false, get: () => null };
      be.capabilities = { getUniformBufferLimit: () => 16384, getMaxAnisotropy: () => 8 };
    }
    const camera = new THREE.PerspectiveCamera(75, 1, 0.3, 6000);
    const scene = new THREE.Scene();
    scene.fogNode = radialFogNode();

    const clean = (b: Built) => {
      expect(b.vertex.length).toBeGreaterThan(50);
      expect(b.fragment.length).toBeGreaterThan(50);
      expect(errors.filter((e) => /TSL|NodeBuilder|not found|undefined/i.test(e))).toEqual([]);
    };
    /** The custom vertex attributes a built shader reads. */
    const reads = (b: Built, ...names: string[]) => {
      for (const n of names) expect(b.vertex + b.fragment).toContain(n);
    };

    it("the rez light: one material for the column, glyph, scan disc, shards and motes", () => {
      const b = build(renderer, scene, camera, rezFxMesh().mesh);
      clean(b);
      reads(b, "aFx", "aCenter");
    });

    it("the portal vortex (arch and ring) and the pad beam", () => {
      const arch = new THREE.Mesh(new THREE.PlaneGeometry(4, 7), vortexMaterial("arcadia", 0x36f9f6, { kind: "arch", base: 0.14, spring: 5, half: 1.93 }).material);
      clean(build(renderer, scene, camera, arch));
      const disc = new THREE.Mesh(new THREE.CircleGeometry(2.05, 40), vortexMaterial("portus", 0xffd8a8, { kind: "disc", radius: 2.05 }).material);
      clean(build(renderer, scene, camera, disc));
      const beam = new THREE.Mesh(new THREE.CylinderGeometry(1.5, 0.55, BEAM_HEIGHT, 12, 1, true), beamMaterial(0x72f1b8));
      clean(build(renderer, scene, camera, beam));
    });

    it("sky traffic (lanes and shooting stars) and the aurora", () => {
      const sky = new SkyLife(scene, LOOKS.portus.skyPlanets, "portus");
      const t = build(renderer, scene, camera, sky.traffic);
      clean(t);
      reads(t, "aLane");
      clean(build(renderer, scene, camera, sky.aurora));
      sky.dispose();
    });

    it("the light pools read their colour, radius and strength per vertex", async () => {
      const geometry = lightPoolGeometry(portusLightPools(), createTerrain("portus"));
      for (const layer of ["tint", "glow"] as const) {
        const b = build(renderer, scene, camera, new THREE.Mesh(geometry, lightPoolMaterial(layer)));
        clean(b);
        reads(b, "aPool");
      }
    });
  });
}
