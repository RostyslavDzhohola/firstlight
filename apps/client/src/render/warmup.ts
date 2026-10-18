// Shader warm-up protocol (SPEC §4.1, tech-facts §2). compileAsync() alone frustum-culls, compiles
// only active LODs, skips shadow maps and post passes (three #34681), so:
//   1. make every mesh visible, disable frustum culling, force every LOD / instanced mesh to draw;
//   2. await ctx.compileScene(): compileAsync for the post pipeline's scene pass context
//      (compilePass.ts; the canvas context compileAsync picks by itself is a variant no frame uses);
//   3. (WebGPU only) compileComputeAsync for compute nodes — none yet;
//   4. render a few real frames of the full RenderPipeline (shadows + post) behind the loading screen;
//   5. restore, then watch renderer.debug.onNodeBuilderCreated: any shader built during the next
//      120 frames is logged (and counted in window.__shaders) — the target is zero.
// Each run is timed per phase (compile, compute, shadows, frames) with the shaders built in it, kept in
// window.__shaders.warmups for the e2e hook (D-load-1), and reports done/total work units to the loader.

import * as THREE from "three/webgpu";
import type { RenderCtx } from "./renderer.ts";
import { flags } from "../config.ts";
import { beginManualFrame, type TimestampSource } from "./timing.ts";
import { deferPipelines, FIRST_DRAWS_START, gateFirstDraws, nextDrawBudget, type DeferRenderer, type GateRenderer } from "./parallelCompile.ts";

/** One warm-up phase: how long it took and how many node builds (shaders) it made. */
export interface WarmupPhase {
  ms: number;
  builds: number;
}

/** A finished warm-up, per phase (D-load-1). Times are performance.now() milliseconds. */
export interface WarmupReport {
  /** Who ran it: "arrival", "probe", "graphics", … ("" when the caller didn't say). */
  label: string;
  backend: "webgpu" | "webgl2";
  tier: string | null;
  start: number;
  end: number;
  ms: number;
  /** Node builds during this warm-up, and the session's total after it (the overlay's "shaders"). */
  builds: number;
  shaders: number;
  /** New GPU shader stages (vertex + fragment programs; three shares one per distinct source). */
  stages: number;
  phases: {
    /** compileAsync for the scene pass's context; `items`: the render objects it prepared. */
    compile: WarmupPhase & { items: number; wait: number };
    /** compileComputeAsync (WebGPU): no compute nodes yet. */
    compute: WarmupPhase & { nodes: number };
    /** Shadow casters joining a few per frame; `predicted`: the builds expected (predictShadowBuilds). */
    shadows: WarmupPhase & { frames: number; predicted: number; wait: number };
    /** Real frames behind the loader, the settle frame after the restore included; `drain`: the
     *  extra frames until every program was compiled and drawn once, `wait` their ms. */
    frames: WarmupPhase & { frames: number; wait: number; drain: number };
  };
}

export interface ShaderStats {
  total: number;
  /** Builds seen while armed (after the last warm-up). */
  afterWarmup: number;
  /** Frames left in the current watch window. */
  watching: number;
  recent: { name: string; material: string; frame: number }[];
  /** The last few warm-ups, oldest first (D-load-1). */
  warmups: WarmupReport[];
}

const stats: ShaderStats = { total: 0, afterWarmup: 0, watching: 0, recent: [], warmups: [] };
const installed = new WeakSet<object>();
let frame = 0;

export function shaderStats(): ShaderStats {
  return stats;
}

/** The most recent warm-up's report, or null before the first. */
export function lastWarmup(): WarmupReport | null {
  return stats.warmups.at(-1) ?? null;
}

/** Hook each renderer once; counts every node build and reports the ones after warm-up. */
export function installShaderMonitor(ctx: RenderCtx) {
  if (installed.has(ctx.renderer)) return;
  installed.add(ctx.renderer);
  (window as unknown as { __shaders: ShaderStats }).__shaders = stats;
  ctx.renderer.debug.onNodeBuilderCreated = (_builder: unknown, ro: unknown) => {
    stats.total++;
    if (stats.watching <= 0) return;
    const r = ro as { object?: THREE.Object3D; material?: THREE.Material } | null;
    const obj = r?.object ?? (ro as THREE.Object3D | null);
    const own = (obj && (obj.name || obj.type)) || "?";
    const name = obj?.parent?.name ? `${own} in ${obj.parent.name}` : own; // e.g. "Mesh in weapon:sunbrand"
    const material = r?.material ? `${r.material.type}${r.material.name ? ":" + r.material.name : ""}` : "compute";
    stats.afterWarmup++;
    stats.recent.push({ name, material, frame });
    if (stats.recent.length > 50) stats.recent.shift();
    const msg = `[shaders] new node build ${stats.watching} frames into the post-warm-up window: ${name} (${material})`;
    if (flags.has("shadercheck")) console.warn(msg);
    else console.debug(msg);
  };
}

/** Call once per rendered frame. */
export function shaderMonitorFrame() {
  frame++;
  if (stats.watching > 0) {
    stats.watching--;
    if (stats.watching === 0 && flags.has("shadercheck")) {
      console.info(`[shaders] post-warm-up window closed: ${stats.afterWarmup} new builds (target 0)`, stats.recent);
    }
  }
}

/**
 * Hidden sample meshes for looks that only show up mid-game (shots, explosions, loot piles).
 * warmup() shows hidden meshes, so these compile behind the loading screen; and while they live
 * (never dispose them), three keeps their node build and pipeline cached — it frees a build when
 * its last render object goes — so the first shot or pile of a session doesn't hitch.
 * Colour and opacity aren't part of the cache key; transparency, blending and the geometry's
 * attribute layout are, so one sample per (material settings, layout) is enough.
 */
export function warmupSamples(name: string, looks: readonly (readonly [THREE.BufferGeometry, THREE.Material])[]): THREE.Group {
  const g = new THREE.Group();
  g.name = name;
  g.visible = false;
  for (const [geo, mat] of looks) {
    const m = new THREE.Mesh(geo, mat);
    m.name = `${name}:${mat.name || mat.type}`;
    m.frustumCulled = false;
    g.add(m);
  }
  return g;
}

const kept = new Map<string, THREE.Group>();

/**
 * Warm-up samples kept for the session (T9): `build` runs once, on the first warm-up that can build
 * them (null = not yet), and the same hidden group comes back every time after (without `build`:
 * the group if it exists). A warm-up hook adds
 * it to the scene while forced on (warmup() shows hidden objects) and takes it out again after, so
 * it costs nothing per frame. Three frees a node build, its shadow variant and its pipeline with the
 * last render object that uses them; render objects live until their object, material or geometry is
 * disposed, not when they leave the scene. So keeping the samples (never disposing them) keeps those
 * builds, and the first horse, NPC or other player of each coat or palette doesn't compile in play.
 */
export function keptSamples(name: string, build?: () => readonly THREE.Object3D[] | null): THREE.Group | null {
  let g = kept.get(name);
  if (!g) {
    const parts = build?.() ?? null;
    if (!parts) return null;
    g = new THREE.Group();
    g.name = name;
    g.visible = false;
    for (const p of parts) g.add(p);
    kept.set(name, g);
  }
  return g;
}

export interface WarmupHooks {
  /** Force every LOD / hidden variant on (true) or back to normal (false). */
  forceAll(on: boolean): void;
}

const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));

/**
 * Temporarily force `obj[prop]` to `value` for rendering. Writes made by other systems during the
 * force window are recorded, and the restore applies the last written value (or the original).
 * So a grass cell filled during warm-up keeps its new blade count and visibility afterwards.
 */
export function forceProperty<T extends object, K extends keyof T>(obj: T, prop: K, value: T[K]): () => void {
  const original = obj[prop];
  let written = false;
  let last = original;
  Object.defineProperty(obj, prop, {
    configurable: true,
    enumerable: true,
    get: () => value,
    set: (v: T[K]) => {
      written = true;
      last = v;
    },
  });
  return () => {
    delete (obj as Record<PropertyKey, unknown>)[prop as PropertyKey];
    (obj as T)[prop] = written ? last : original;
  };
}

/** Predicted new shadow-pass builds per warm-up frame in the batched phase (warmShadowCasters). */
export const SHADOW_BATCH = 4;

/**
 * Whether a caster's shadow-pass variant will be a new node build: three keys a build by material,
 * geometry layout and context, plus the object itself for instanced (and skinned: own bone count)
 * meshes. `seen` collects the (material, layout) pairs already counted in this warm-up.
 */
export function shadowBuildCost(o: THREE.Object3D, seen: Set<string>): 0 | 1 {
  const m = o as THREE.Mesh & { count?: number; isSkinnedMesh?: boolean };
  if ((m as THREE.InstancedMesh).isInstancedMesh || (m.count ?? 1) > 1 || m.isSkinnedMesh) return 1;
  const mats = Array.isArray(m.material) ? m.material : [m.material];
  const attrs = m.geometry ? Object.keys(m.geometry.attributes).sort().map((k) => `${k}${m.geometry.attributes[k]!.itemSize}`).join(",") : "";
  let cost: 0 | 1 = 0;
  for (const mat of mats) {
    const key = `${mat?.uuid ?? "-"}|${attrs}`;
    if (!seen.has(key)) {
      seen.add(key);
      cost = 1;
    }
  }
  return cost;
}

function shadowCasters(scene: THREE.Object3D): THREE.Object3D[] {
  const casters: THREE.Object3D[] = [];
  scene.traverse((o) => {
    if ((o as THREE.Mesh).isMesh && o.castShadow) casters.push(o);
  });
  return casters;
}

/** The new shadow-pass builds warmShadowCasters expects for this scene (the loader's progress total). */
export function predictShadowBuilds(scene: THREE.Object3D): number {
  const seen = new Set<string>();
  let n = 0;
  for (const o of shadowCasters(scene)) n += shadowBuildCost(o, seen);
  return n;
}

/**
 * Turn the scene's shadow casters off, then back on in batches of about SHADOW_BATCH predicted new
 * builds, rendering a frame after each batch, so their shadow-pass node builds and programs spread
 * over frames instead of piling into one. Casters that share a build ride along for free. Every
 * caster is back to its own `castShadow` when this returns, even if a frame throws.
 */
export async function warmShadowCasters(
  scene: THREE.Object3D,
  renderFrame: () => void,
  nextFrameFn: () => Promise<void> = nextFrame,
  onBatch?: (predictedBuilds: number) => void,
): Promise<number> {
  const casters = shadowCasters(scene);
  const pending = casters.map((o) => forceProperty(o, "castShadow", false));
  const seen = new Set<string>();
  let frames = 0;
  try {
    let i = 0;
    while (i < pending.length) {
      let cost = 0;
      while (i < pending.length && (cost < SHADOW_BATCH || cost === 0)) {
        cost += shadowBuildCost(casters[i]!, seen);
        pending[i]!();
        pending[i] = () => {};
        i++;
        if (cost >= SHADOW_BATCH) break;
      }
      renderFrame();
      frames++;
      onBatch?.(cost);
      await nextFrameFn();
    }
  } finally {
    for (const r of pending) r();
  }
  return frames;
}

/** The longest the warm-up keeps rendering for programs still compiling (a safety valve). */
const DRAIN_MAX_MS = 60_000;

/**
 * Run the protocol. `beforeFrame` lets the caller update systems between the real frames
 * (e.g. stream grass cells) so instance buffers are filled. Always restores the scene, even if a
 * frame throws. `onProgress(done, total)` counts work units: the compile's render objects, the
 * predicted shadow builds and the real frames; it never goes backwards and ends at total/total.
 */
export async function warmup(
  ctx: RenderCtx,
  opts: { frames?: number; hooks?: WarmupHooks[]; beforeFrame?: () => void; onProgress?: (done: number, total: number) => void; label?: string } = {},
): Promise<WarmupReport> {
  const { scene, camera, renderer } = ctx;
  const restore: (() => void)[] = [];
  const t0 = performance.now();
  const builds0 = stats.total;
  // Builds during a warm-up are the point of it, not post-warm-up hitches: e.g. the first-visit
  // probe's warm-up opens a window and the full warm-up right after compiles what it didn't draw.
  stats.watching = 0;
  const src = renderer as unknown as TimestampSource;

  // Per-phase clock: each lap() closes the running phase.
  let mark = t0;
  let markBuilds = builds0;
  const lap = (): WarmupPhase => {
    const now = performance.now();
    const p = { ms: Math.round((now - mark) * 10) / 10, builds: stats.total - markBuilds };
    mark = now;
    markBuilds = stats.total;
    return p;
  };
  const frames = opts.frames ?? 4;
  const shadowsOn = !!(ctx.settings?.on.shadows && ctx.settings.shadows.mode === "map");
  let items = 0;
  let predicted = 0;
  let loaded = 0;
  let shadowDone = 0;
  let framesDone = 0;
  let shown = 0;
  let lastShown = "";
  let compile: WarmupReport["phases"]["compile"] = { ms: 0, builds: 0, items: 0, wait: 0 };
  let compute: WarmupReport["phases"]["compute"] = { ms: 0, builds: 0, nodes: 0 };
  let shadows: WarmupReport["phases"]["shadows"] = { ms: 0, builds: 0, frames: 0, predicted: 0, wait: 0 };
  let realFrames = 0;
  // New programs compile side by side behind the loader instead of one at a time (D-load-2);
  // `?serialcompile` keeps three's own one-by-one compiles for A/B runs.
  const deferred = flags.has("serialcompile") ? null : deferPipelines(renderer as unknown as DeferRenderer);
  // WebGL2: a program's first draw builds its Metal pipeline in the GPU process, so first draws are
  // spread over frames (a budget per frame that follows the frame times).
  const gated = deferred?.active && !ctx.webgpu ? gateFirstDraws(renderer as unknown as GateRenderer) : null;
  const gate = gated?.active ? gated : null;
  let budget = FIRST_DRAWS_START;
  let frameAt = 0;
  // Progress: work units known so far (compile objects, predicted shadow builds, frames, and the
  // pipelines and first draws as they appear); never backwards, total/total at the end.
  const total = () => items + predicted + frames + 1 + (deferred?.started() ?? 0) + (gate ? gate.granted() + gate.waiting() : 0);
  const emit = (final = false) => {
    const t = total();
    const d = final ? t : loaded + shadowDone + framesDone + (deferred?.finished() ?? 0) + (gate?.granted() ?? 0);
    shown = Math.max(shown, Math.min(d, t));
    const key = `${shown}/${t}`;
    if (key === lastShown) return;
    lastShown = key;
    opts.onProgress?.(shown, t);
  };
  const ms = (since: number) => Math.round((performance.now() - since) * 10) / 10;
  /** Wait (polling each frame, nothing drawn) until the deferred programs have compiled. */
  const compiled = async () => {
    const t = performance.now();
    while (deferred && deferred.pending() > 0) {
      await nextFrame();
      emit();
    }
    await deferred?.settle();
    return ms(t);
  };
  let grantedAt = 0;
  const draw = () => {
    grantedAt = gate?.granted() ?? 0;
    gate?.frame(budget);
    opts.beforeFrame?.();
    beginManualFrame(src);
    ctx.render();
    ctx.gpu.frame(); // keeps three's timestamp query pool drained
  };
  const next = async () => {
    await nextFrame();
    const now = performance.now();
    if (frameAt) budget = nextDrawBudget(budget, now - frameAt, (gate?.granted() ?? 0) - grantedAt);
    frameAt = now;
  };
  const programs = () => (renderer.info as unknown as { memory?: { programs?: number } }).memory?.programs ?? 0;
  const stages0 = programs();
  let framesWait = 0;
  let drain = 0;
  try {
    for (const h of opts.hooks ?? []) h.forceAll(true);
    scene.traverse((o) => {
      if (o.frustumCulled) restore.push(forceProperty(o, "frustumCulled", false));
      if (!o.visible && !o.userData.noWarmup) restore.push(forceProperty(o, "visible", true));
      const im = o as THREE.InstancedMesh;
      if (im.isInstancedMesh && im.count === 0) restore.push(forceProperty(im, "count", 1));
      const mesh = o as THREE.Mesh;
      const g = mesh.isMesh ? (mesh.geometry as THREE.InstancedBufferGeometry) : null;
      if (g && (g as { isInstancedBufferGeometry?: boolean }).isInstancedBufferGeometry && g.instanceCount === 0) {
        restore.push(forceProperty(g, "instanceCount", 1));
      }
    });
    opts.beforeFrame?.();
    if (shadowsOn) predicted = predictShadowBuilds(scene);
    // 2. The scene pass's compile: one render object at a time, yielding between them.
    lap();
    const onCompile = (e: { loaded: number; total: number }) => {
      items = e.total;
      loaded = e.loaded;
      emit();
    };
    try {
      await (ctx.compileScene ? ctx.compileScene(onCompile) : renderer.compileAsync(scene, camera, null, onCompile as (e: ProgressEvent) => void));
    } catch (e) {
      console.warn("[warmup] compileAsync failed (continuing with real frames)", e);
    }
    const compileWait = await compiled();
    compile = { ...lap(), items, wait: compileWait };
    loaded = items;
    // 3. Compute nodes (WebGPU): none yet, so the phase is empty.
    compute = { ...lap(), nodes: 0 };
    // 4. Shadow-pass variants. compileAsync skips the shadow map, so the first real frame built every
    //    caster's shadow material at once (WebGL links each synchronously: ~1 s with the loading
    //    screen frozen on a travel). Casters join the shadow pass a few per frame instead.
    frameAt = performance.now();
    if (shadowsOn) {
      const n = await warmShadowCasters(scene, draw, next, (cost) => {
        shadowDone += cost;
        emit();
      });
      // WebGL2 keeps drawing while its shadow programs compile (the drain below); WebGPU waits here.
      const shadowWait = gate ? 0 : await compiled();
      shadows = { ...lap(), frames: n, predicted, wait: shadowWait };
    }
    shadowDone = predicted;
    for (let i = 0; i < frames; i++) {
      draw();
      realFrames++;
      await next();
      framesDone++;
      emit();
    }
    // 5. Until every program has compiled and, on WebGL2, been drawn once: stop after a frame that
    //    began with nothing compiling and turned no first draw away.
    const drainAt = performance.now();
    if (gate) {
      while (performance.now() - drainAt < DRAIN_MAX_MS) {
        const compiling = deferred!.pending();
        draw();
        realFrames++;
        drain++;
        await next();
        emit();
        if (compiling === 0 && gate.waiting() === 0) break;
      }
      await deferred!.settle();
      framesWait = ms(drainAt);
    } else {
      framesWait = await compiled();
    }
  } finally {
    // The settle frame below renders the way play does: every program it needs is ready and drawn.
    gate?.release();
    deferred?.release();
    for (const r of restore.reverse()) {
      try {
        r();
      } catch (e) {
        console.warn("[warmup] restore failed", e);
      }
    }
    for (const h of opts.hooks ?? []) {
      try {
        h.forceAll(false);
      } catch (e) {
        console.warn("[warmup] hook restore failed", e);
      }
    }
  }
  // One more real frame in the normal state (restored counts can differ, e.g. LOD splits).
  opts.beforeFrame?.();
  beginManualFrame(src);
  ctx.render();
  ctx.gpu.frame();
  realFrames++;
  await nextFrame();
  ctx.gpu.drain();
  const framesPhase = { ...lap(), frames: realFrames, wait: framesWait, drain };
  const end = mark;
  const report: WarmupReport = {
    label: opts.label ?? "",
    backend: ctx.webgpu ? "webgpu" : "webgl2",
    tier: ctx.tier ?? null,
    start: t0,
    end,
    ms: Math.round((end - t0) * 10) / 10,
    builds: stats.total - builds0,
    shaders: stats.total,
    stages: programs() - stages0,
    phases: { compile, compute, shadows, frames: framesPhase },
  };
  stats.warmups.push(report);
  if (stats.warmups.length > 8) stats.warmups.shift();
  emit(true);
  stats.watching = 120;
  stats.afterWarmup = 0;
  stats.recent = [];
  const p = report.phases;
  console.info(
    `[warmup] ${report.label || "warm-up"} ${report.backend} ${report.ms.toFixed(0)} ms, ${report.builds} builds (${report.shaders} total), ${report.stages} new shader stages: ` +
      `compile ${p.compile.ms.toFixed(0)} ms/${p.compile.items} items/${p.compile.builds} builds, shadows ${p.shadows.ms.toFixed(0)} ms/${p.shadows.frames} frames/${p.shadows.builds} builds, ` +
      `frames ${p.frames.ms.toFixed(0)} ms/${p.frames.frames} (${p.frames.drain} until compiled and drawn)/${p.frames.builds} builds`,
  );
  return report;
}
