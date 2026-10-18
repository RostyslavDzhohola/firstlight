// Renderer creation, backend detection, quality tiers + settings API, and the post pipeline (TSL
// RenderPipeline). Low/Medium are identical on WebGPU and WebGL2; High/Ultra extras are WebGPU-only
// (SPEC §7.1). Systems subscribe with ctx.onChange() and re-apply when the resolved settings change.

import * as THREE from "three/webgpu";
import { flags } from "../config.ts";
import { buildPost, MENU_GRADE, postUniforms, setGrade, type GradeParams, type PostBuild } from "./post.ts";
import {
  clearStored, emptyStored, FEATURES, killSwitches, loadStored, resolveSettings, saveStored, TIERS, tierIndex,
  urlScale, urlTier, validAutoTier, type Feature, type ResolvedSettings, type StoredGfx, type Tier,
} from "./quality.ts";
import { FrameSize } from "./frameSize.ts";
import { startRenderer } from "./rendererStart.ts";
import { GpuTimer, ResolutionLadder } from "./timing.ts";
import { compileForPass, passCallDepth, saveRenderState, type GuardedRenderer, type PassCompileRenderer } from "./compilePass.ts";

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
  /**
   * Apply a probe result. `persist: false` (invalid probe) uses it for this session only;
   * `clearPinned` also drops a user-pinned tier (F3 "re-probe"). Applies settings once.
   */
  setProbedTier(t: Tier, opts?: { persist?: boolean; clearPinned?: boolean }): void;
  /** True when no tier is pinned and no saved probe result matches this backend + GPU. */
  needsProbe(): boolean;
  /**
   * The ladder wants to drop a tier (auto mode, resolution at the floor). Listeners get the
   * change as a function and should run it behind the loading overlay + warm-up
   * (Game.applyGraphics). With no listener it's applied immediately (may hitch).
   */
  onTierDrop(cb: (from: Tier, to: Tier, apply: () => void) => void): () => void;
  /** GPU device lost. With no listener a reload prompt is shown. */
  onDeviceLost(cb: (info: { api: string; message: string; reason: string | null }) => void): () => void;
  /** Forget all saved graphics settings (tolerates disabled storage). Caller reloads. */
  resetSettings(): void;
  setFeature(f: Feature, on: boolean | null): void;
  /** User render scale on top of the tier (null = tier default). */
  setRenderScale(s: number | null): void;
  setGrade(g: GradeParams): void;
  /** Photo mode: add depth of field to the post pipeline (rebuilds it). */
  setPhotoPost(on: boolean): void;
  setPhotoParams(p: { focus: number; aperture: number; bokeh: number }): void;
  onChange(cb: SettingsListener): () => void;
  /** Effective pixel ratio after DPR cap × render scale × ladder, never above devicePixelRatio. */
  pixelRatio(): number;
  /** Ask for the drawing-buffer size to follow the window and pixel ratio: applied right before the next draw (D-view-3). */
  resize(): void;
  /** Draw a frame: a pending size first, then the post pipeline. */
  render(): void;
  /** Compile the scene for the context its frames use (the post pipeline's scene pass): warm-up. */
  compileScene(): Promise<unknown>;
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
  // WebGPU gets a deadline; past it (or on a rejected init) a fresh WebGL2 renderer starts instead.
  const { renderer } = await startRenderer({
    // A new options object per renderer: three writes its WebGL fallback hook into it.
    create: (forceWebGL) =>
      new THREE.WebGPURenderer({
        antialias: false,
        forceWebGL,
        powerPreference: "high-performance",
        trackTimestamp: !flags.has("notimer"),
      } as ConstructorParameters<typeof THREE.WebGPURenderer>[0]),
    forceWebGL: flags.has("webgl"),
  });
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
  const gpu = new GpuTimer(renderer as unknown as ConstructorParameters<typeof GpuTimer>[0]);
  ladder.hasGpuTimer = gpu.available;
  const backendName = webgpu ? "webgpu" : "webgl2";
  const tierDropListeners = new Set<(from: Tier, to: Tier, apply: () => void) => void>();
  const deviceLostListeners = new Set<(info: { api: string; message: string; reason: string | null }) => void>();

  let tier: Tier = forcedTier ?? stored.tier ?? validAutoTier(stored, backendName, gpuName) ?? "medium";
  let auto = !forcedTier && !stored.tier;
  let settings = resolveSettings(tier, auto, webgpu, stored, kills);
  let post: PostBuild | null = null;
  /** Call depth of the current post build's scene pass (compilePass.ts), learned on first use. */
  let passDepth: number | null = null;
  /** The scene-pass probe render failed once: plain compileAsync for the rest of the session. */
  let passCompileOff = false;
  let postKey = "";
  let photo = false;

  const postKeyOf = (s: ResolvedSettings) =>
    [s.on.bloom, s.on.ao, s.on.traa, s.on.fxaa, s.on.grade, s.on.grain, s.on.vignette, s.post.ao, s.post.bloomScale, photo].join(",");

  /** Build the post pipeline for the current settings (`force`: also when they haven't changed). */
  function rebuildPost(force = false) {
    const key = postKeyOf(settings);
    if (post && key === postKey && !force) return;
    post?.dispose();
    post = buildPost(scene, camera, settings, photo);
    passDepth = null;
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
      tier = forcedTier ?? validAutoTier(stored, backendName, gpuName) ?? "medium";
      auto = !forcedTier;
      ladder.reset();
      apply();
    },
    setProbedTier(t, opts = {}) {
      if (opts.clearPinned) stored = { ...stored, tier: null };
      if (opts.persist !== false) stored = { ...stored, autoTier: t, autoBackend: backendName, autoGpu: gpuName };
      if (opts.clearPinned || opts.persist !== false) saveStored(stored);
      // The probe switches tiers while measuring; always land on the effective choice.
      tier = forcedTier ?? stored.tier ?? t;
      auto = !forcedTier && !stored.tier;
      ladder.reset();
      apply();
    },
    needsProbe() {
      return !forcedTier && !stored.tier && validAutoTier(stored, backendName, gpuName) === null;
    },
    onTierDrop(cb) {
      tierDropListeners.add(cb);
      return () => tierDropListeners.delete(cb);
    },
    onDeviceLost(cb) {
      deviceLostListeners.add(cb);
      return () => deviceLostListeners.delete(cb);
    },
    resetSettings() {
      clearStored();
      stored = emptyStored();
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
      const dpr = devicePixelRatio || 1;
      return Math.min(dpr, Math.min(dpr, settings.dprCap) * scale * ladder.scale);
    },
    resize() {
      size.request();
    },
    render() {
      size.draw(() => pipeline.render());
    },
    compileScene() {
      if (passCompileOff) return renderer.compileAsync(scene, camera);
      const r = renderer as unknown as PassCompileRenderer;
      const sp = post?.scenePass ?? null;
      if (sp && passDepth === null) {
        // Learn the scene pass's call depth from one render with the scene hidden (background and
        // post quads only); it depends on the pipeline's render-to-texture steps (FXAA, TRAA, …).
        // three restores its renderer state only when that render doesn't throw: save and restore it
        // here, and after a failure stop trusting this pipeline (rebuilt, compiled the old way).
        const state = saveRenderState(renderer as unknown as GuardedRenderer, scene, camera);
        let failed = false;
        try {
          passDepth = passCallDepth(r, sp.renderTarget, () =>
            size.draw(() => {
              scene.visible = false;
              pipeline.render();
            }),
          );
        } catch (e) {
          failed = true;
          console.warn("[warmup] the scene-pass probe render failed; compiling without the pass context this session", e);
        } finally {
          state.restore(failed);
        }
        if (failed) {
          passCompileOff = true;
          rebuildPost(true);
          return renderer.compileAsync(scene, camera);
        }
      }
      return compileForPass(r, scene, camera, sp, passDepth);
    },
    afterFrame(now, frameMs) {
      gpu.frame();
      ladder.sample(now, frameMs, gpu.takeSamples(), settings.gpuTargetMs);
    },
    stored() {
      return stored;
    },
  };

  // The one owner of the drawing-buffer size (D-view-3): ladder steps (from afterFrame, after the
  // frame's draw), the window's resize event and settings changes only ask; draws apply it first.
  const size = new FrameSize(renderer, camera, () => ({ width: innerWidth, height: innerHeight, pixelRatio: ctx.pixelRatio() }));
  ladder.onChange = () => ctx.resize();
  ladder.onFloor = () => {
    // At the ladder floor drop a tier, but only when the tier is automatic. The drop is saved
    // as the automatic tier, so the next session starts there instead of walking down again.
    if (!auto || tierIndex(tier) === 0) return;
    const from = tier;
    const lower = TIERS[tierIndex(tier) - 1]!;
    let done = false;
    const change = () => {
      if (done || tier !== from || !auto) return;
      done = true;
      console.info(`[gfx] resolution ladder at floor, dropping tier ${from} → ${lower}`);
      ctx.setProbedTier(lower);
    };
    if (tierDropListeners.size === 0) change();
    else for (const l of tierDropListeners) l(from, lower, change);
  };

  // Device lost (macOS sleep, driver reset): tell listeners, else offer a reload.
  (renderer as unknown as { onDeviceLost: (info: { api: string; message: string; reason: string | null }) => void }).onDeviceLost = (info) => {
    console.error("[gfx] GPU device lost", info);
    if (deviceLostListeners.size) {
      for (const l of deviceLostListeners) l(info);
      return;
    }
    showReloadPrompt();
  };

  setGrade(MENU_GRADE);
  rebuildPost();
  renderer.shadowMap.enabled = settings.on.shadows && settings.shadows.mode === "map";
  renderer.domElement.style.width = "100%";
  renderer.domElement.style.height = "100%";
  size.apply(); // nothing drawn yet: the warm-up compiles at the real size
  addEventListener("resize", () => ctx.resize());
  return ctx;
}

function showReloadPrompt() {
  if (document.getElementById("gfx-lost")) return;
  const el = document.createElement("div");
  el.id = "gfx-lost";
  el.style.cssText =
    "position:fixed;inset:0;z-index:100;display:grid;place-items:center;background:#07060dcc;color:#ece8f6;font:16px ui-sans-serif,system-ui,sans-serif;text-align:center";
  el.innerHTML = `<div><p>The graphics device was reset (this can happen after the computer sleeps).</p><button style="font:inherit;padding:10px 28px;border-radius:999px;cursor:pointer">Reload</button></div>`;
  el.querySelector("button")!.addEventListener("click", () => location.reload());
  document.body.appendChild(el);
}
