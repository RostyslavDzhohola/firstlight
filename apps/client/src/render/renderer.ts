// Renderer creation, backend detection, quality tier and the post pipeline (TSL RenderPipeline).
// Low/Medium are identical on WebGPU and WebGL2; High/Ultra extras are WebGPU-only (SPEC §7.1).

import * as THREE from "three/webgpu";
import { pass, renderOutput, uniform } from "three/tsl";
import { bloom } from "three/addons/tsl/display/BloomNode.js";
import { fxaa } from "three/addons/tsl/display/FXAANode.js";
import { flags } from "../config.ts";

export type Tier = "low" | "medium" | "high" | "ultra";
export const TIERS: readonly Tier[] = ["low", "medium", "high", "ultra"];

export interface TierSettings {
  dprCap: number;
  renderScale: number;
  bloomStrength: number;
  shadows: "blob" | "single" | "cascades";
  shadowMapSize: number;
  grass: number;
  grassRadius: number;
  particles: number;
  fullAvatars: number;
  fxaa: boolean;
}

export const TIER_SETTINGS: Record<Tier, TierSettings> = {
  low: { dprCap: 1, renderScale: 0.67, bloomStrength: 0.35, shadows: "blob", shadowMapSize: 0, grass: 25_000, grassRadius: 25, particles: 2_000, fullAvatars: 8, fxaa: false },
  medium: { dprCap: 1.25, renderScale: 0.85, bloomStrength: 0.4, shadows: "single", shadowMapSize: 1024, grass: 80_000, grassRadius: 40, particles: 5_000, fullAvatars: 16, fxaa: true },
  high: { dprCap: 1.5, renderScale: 1, bloomStrength: 0.45, shadows: "cascades", shadowMapSize: 1024, grass: 200_000, grassRadius: 60, particles: 15_000, fullAvatars: 24, fxaa: true },
  ultra: { dprCap: 2, renderScale: 1, bloomStrength: 0.5, shadows: "cascades", shadowMapSize: 2048, grass: 500_000, grassRadius: 85, particles: 30_000, fullAvatars: 40, fxaa: true },
};

export interface RenderCtx {
  renderer: THREE.WebGPURenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  pipeline: THREE.RenderPipeline;
  webgpu: boolean;
  tier: Tier;
  settings: TierSettings;
  bloomStrength: { value: number };
  setTier(t: Tier): void;
  resize(): void;
  render(): void;
}

export async function createRenderer(container: HTMLElement): Promise<RenderCtx> {
  const renderer = new THREE.WebGPURenderer({ antialias: false, forceWebGL: flags.has("webgl"), powerPreference: "high-performance" });
  await renderer.init();
  const webgpu = !!(renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend;
  renderer.toneMapping = THREE.AgXToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = !flags.has("noshadows");
  renderer.shadowMap.type = THREE.PCFShadowMap;
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(75, innerWidth / innerHeight, 0.3, 6000);

  const bloomStrength = uniform(0.4);
  const pipeline = new THREE.RenderPipeline(renderer);
  const scenePass = pass(scene, camera);
  const color = scenePass.getTextureNode("output");
  let graded: THREE.Node = color;
  if (!flags.has("nobloom") && !flags.has("nopost")) {
    const b = bloom(color, 0.4, 0.35, 0.92);
    b.strength = bloomStrength;
    graded = color.add(b);
  }
  pipeline.outputColorTransform = false;
  const out = renderOutput(graded);

  const ctx: RenderCtx = {
    renderer,
    scene,
    camera,
    pipeline,
    webgpu,
    tier: "medium",
    settings: TIER_SETTINGS.medium,
    bloomStrength,
    setTier(t) {
      ctx.tier = t;
      ctx.settings = TIER_SETTINGS[t];
      bloomStrength.value = ctx.settings.bloomStrength;
      pipeline.outputNode = ctx.settings.fxaa && !flags.has("nopost") ? fxaa(out) : out;
      pipeline.needsUpdate = true;
      ctx.resize();
    },
    resize() {
      const dpr = Math.min(devicePixelRatio, ctx.settings.dprCap) * ctx.settings.renderScale;
      renderer.setPixelRatio(dpr);
      renderer.setSize(innerWidth, innerHeight, false);
      renderer.domElement.style.width = "100%";
      renderer.domElement.style.height = "100%";
      camera.aspect = innerWidth / innerHeight;
      camera.updateProjectionMatrix();
    },
    render() {
      pipeline.render();
    },
  };
  const forced = flags.get("tier") as Tier | null;
  ctx.setTier(forced && TIERS.includes(forced) ? forced : "medium");
  addEventListener("resize", () => ctx.resize());
  return ctx;
}
