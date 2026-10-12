// Renderer creation, backend detection, quality tiers + settings API, and the post pipeline (TSL
// RenderPipeline). Low/Medium are identical on WebGPU and WebGL2; High/Ultra extras are WebGPU-only
// (SPEC §7.1). Systems subscribe with ctx.onChange() and re-apply when the resolved settings change.

import * as THREE from "three/webgpu";
import { flags } from "../config.ts";
import { buildPost, MENU_GRADE, postUniforms, setGrade, type GradeParams, type PostBuild } from "./post.ts";
import {
  FEATURES, killSwitches, loadStored, resolveSettings, saveStored, TIERS, tierIndex, urlScale, urlTier,
  type Feature, type ResolvedSettings, type StoredGfx, type Tier,
} from "./quality.ts";
import { GpuTimer, ResolutionLadder } from "./timing.ts";

export { TIERS, FEATURES, type Tier, type Feature, type ResolvedSettings };

export type SettingsListener = (s: ResolvedSettings, prev: ResolvedSettings | null) => void;

export interface RenderCtx {
  renderer: THREE.WebGPURenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  pipeline: THREE.RenderPipeline;
  webgpu: boolean;
  /** GPU adapter / WebGL renderer string (best effort, may be empty). */
  gpuName: string;
  /** Current resolved settings. */
  readonly settings: ResolvedSettings;
  readonly tier: Tier;
  readonly ladder: ResolutionLadder;
  readonly gpu: GpuTimer;
  /** Pin a tier (persisted unless `persist: false`). */
  setTier(t: Tier, opts?: { persist?: boolean; auto?: boolean }): void;
  /** Return to the automatic (probed) tier. */
  setAutoTier(): void;
  /** Record a probe result (persisted as the automatic tier). */
  setProbedTier(t: Tier): void;
  setFeature(f: Feature, on: boolean | null): void;
  /** User render scale on top of the tier (null = tier default). */
  setRenderScale(s: number | null): void;
  setGrade(g: GradeParams): void;
  /** Photo mode: add depth of field to the post pipeline (rebuilds it). */
  setPhotoPost(on: boolean): void;
  setPhotoParams(p: { focus: number; aperture: number; bokeh: number }): void;
  onChange(cb: SettingsListener): () => void;
  /** Effective pixel ratio after DPR cap × render scale × ladder. */
  pixelRatio(): number;
  resize(): void;
  render(): void;
  /** Per-frame bookkeeping after render (GPU timer, ladder). */
  afterFrame(now: number, frameMs: number): void;
  stored(): StoredGfx;
}

function detectGpuName(renderer: THREE.WebGPURenderer, webgpu: boolean): string {
  try {
    const b = renderer.backend as unknown as {
      adapter?: { info?: { vendor?: string; architecture?: string; description?: string; device?: string; isFallbackAdapter?: boolean } };
      gl?: WebGL2RenderingContext;
    };
    if (webgpu) {
      const i = b.adapter?.info;
      if (!i) return "";
      return [i.vendor, i.architecture, i.device, i.description, i.isFallbackAdapter ? "fallback-adapter" : ""].filter(Boolean).join(" ");
    }
    const gl = b.gl;
    if (!gl) return "";
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    return String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
  } catch {
    return "";
  }
}

/** Software rasterisers and blocklisted adapters go straight to Low (replaces detect-gpu, see report). */
export function isSoftwareRenderer(name: string): boolean {
  return /swiftshader|llvmpipe|softpipe|software|basic render|microsoft basic|mesa offscreen|fallback-adapter|lavapipe/i.test(name);
}

export async function createRenderer(container: HTMLElement): Promise<RenderCtx> {
  const renderer = new THREE.WebGPURenderer({
    antialias: false,
    forceWebGL: flags.has("webgl"),
    powerPreference: "high-performance",
    trackTimestamp: !flags.has("notimer"),
  } as ConstructorParameters<typeof THREE.WebGPURenderer>[0]);
  await renderer.init();
  const webgpu = !!(renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend;
  const tm = flags.get("tonemap");
  renderer.toneMapping = tm === "agx" ? THREE.AgXToneMapping : tm === "aces" ? THREE.ACESFilmicToneMapping : THREE.NeutralToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(75, innerWidth / innerHeight, 0.3, 6000);
  const pipeline = new THREE.RenderPipeline(renderer);
  pipeline.outputColorTransform = false;
  const gpuName = detectGpuName(renderer, webgpu);

  let stored = loadStored();
  const kills = killSwitches();
  const forcedTier = urlTier();
  const forcedScale = urlScale();
  const listeners = new Set<SettingsListener>();
  const ladder = new ResolutionLadder();
  ladder.enabled = !flags.has("noladder") && !flags.has("bench");
  const gpu = new GpuTimer(renderer);

  let tier: Tier = forcedTier ?? stored.tier ?? stored.autoTier ?? "medium";
  let auto = !forcedTier && !stored.tier;
  let settings = resolveSettings(tier, auto, webgpu, stored, kills);
  let post: PostBuild | null = null;
  let postKey = "";
  let photo = false;

  const postKeyOf = (s: ResolvedSettings) =>
    [s.on.bloom, s.on.ao, s.on.traa, s.on.fxaa, s.on.grade, s.on.grain, s.on.vignette, s.post.ao, s.post.bloomScale, photo].join(",");

  function rebuildPost() {
    const key = postKeyOf(settings);
    if (post && key === postKey) return;
    post?.dispose();
    post = buildPost(scene, camera, settings, photo);
    postKey = key;
    pipeline.outputNode = post.outputNode;
    pipeline.needsUpdate = true;
  }

  function apply() {
    const prev = settings;
    settings = resolveSettings(tier, auto, webgpu, stored, kills);
    renderer.shadowMap.enabled = settings.on.shadows && settings.shadows.mode === "map";
    rebuildPost();
    ctx.resize();
    for (const l of listeners) {
      try {
        l(settings, prev);
      } catch (e) {
        console.error("[gfx] settings listener failed", e);
      }
    }
  }

  const ctx: RenderCtx = {
    renderer,
    scene,
    camera,
    pipeline,
    webgpu,
    gpuName,
    get settings() {
      return settings;
    },
    get tier() {
      return tier;
    },
    ladder,
    gpu,
    setTier(t, opts = {}) {
      if (!TIERS.includes(t)) return;
      tier = t;
      auto = opts.auto ?? false;
      if (opts.persist !== false && !auto) {
        stored = { ...stored, tier: t };
        saveStored(stored);
      }
      ladder.reset();
      apply();
    },
    setAutoTier() {
      stored = { ...stored, tier: null };
      saveStored(stored);
      tier = forcedTier ?? stored.autoTier ?? "medium";
      auto = !forcedTier;
      ladder.reset();
      apply();
    },
    setProbedTier(t) {
      stored = { ...stored, autoTier: t };
      saveStored(stored);
      // The probe switches tiers while measuring; always land on the effective choice.
      tier = forcedTier ?? stored.tier ?? t;
      auto = !forcedTier && !stored.tier;
      ladder.reset();
      apply();
    },
    setFeature(f, on) {
      const features = { ...stored.features };
      if (on === null) delete features[f];
      else features[f] = on;
      stored = { ...stored, features };
      saveStored(stored);
      apply();
    },
    setRenderScale(s) {
      stored = { ...stored, renderScale: s };
      saveStored(stored);
      apply();
    },
    setGrade(g) {
      setGrade(g);
    },
    setPhotoPost(on) {
      photo = on;
      rebuildPost();
    },
    setPhotoParams(p) {
      postUniforms.dofFocus.value = p.focus;
      postUniforms.dofFocal.value = p.aperture;
      postUniforms.dofBokeh.value = p.bokeh;
    },
    onChange(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    pixelRatio() {
      const scale = forcedScale ?? settings.userScale ?? settings.renderScale;
      return Math.min(devicePixelRatio, settings.dprCap) * scale * ladder.scale;
    },
    resize() {
      renderer.setPixelRatio(ctx.pixelRatio());
      renderer.setSize(innerWidth, innerHeight, false);
      renderer.domElement.style.width = "100%";
      renderer.domElement.style.height = "100%";
      camera.aspect = innerWidth / innerHeight;
      camera.updateProjectionMatrix();
    },
    render() {
      pipeline.render();
    },
    afterFrame(now, frameMs) {
      gpu.frame();
      ladder.sample(now, frameMs, gpu.p50(), settings.gpuTargetMs);
    },
    stored() {
      return stored;
    },
  };

  ladder.onChange = () => ctx.resize();
  ladder.onFloor = () => {
    // At the ladder floor drop a tier, but only when the tier is automatic.
    if (!auto || tierIndex(tier) === 0) return;
    const lower = TIERS[tierIndex(tier) - 1]!;
    console.info(`[gfx] resolution ladder at floor, dropping tier ${tier} → ${lower}`);
    tier = lower;
    ladder.reset();
    apply();
  };

  setGrade(MENU_GRADE);
  rebuildPost();
  renderer.shadowMap.enabled = settings.on.shadows && settings.shadows.mode === "map";
  ctx.resize();
  addEventListener("resize", () => ctx.resize());
  return ctx;
}
