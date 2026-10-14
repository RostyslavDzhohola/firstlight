// Shader warm-up protocol (SPEC §4.1, tech-facts §2). compileAsync() alone frustum-culls, compiles
// only active LODs, skips shadow maps and post passes (three #34681), so:
//   1. make every mesh visible, disable frustum culling, force every LOD / instanced mesh to draw;
//   2. await renderer.compileAsync(scene, camera);
//   3. (WebGPU only) compileComputeAsync for compute nodes — none yet;
//   4. render a few real frames of the full RenderPipeline (shadows + post) behind the loading screen;
//   5. restore, then watch renderer.debug.onNodeBuilderCreated: any shader built during the next
//      120 frames is logged (and counted in window.__shaders) — the target is zero.

import * as THREE from "three/webgpu";
import type { RenderCtx } from "./renderer.ts";
import { flags } from "../config.ts";
import { beginManualFrame, type TimestampSource } from "./timing.ts";

export interface ShaderStats {
  total: number;
  /** Builds seen while armed (after the last warm-up). */
  afterWarmup: number;
  /** Frames left in the current watch window. */
  watching: number;
  recent: { name: string; material: string; frame: number }[];
}

const stats: ShaderStats = { total: 0, afterWarmup: 0, watching: 0, recent: [] };
let installed = false;
let frame = 0;

export function shaderStats(): ShaderStats {
  return stats;
}

/** Hook the renderer once; counts every node build and reports the ones after warm-up. */
export function installShaderMonitor(ctx: RenderCtx) {
  if (installed) return;
  installed = true;
  (window as unknown as { __shaders: ShaderStats }).__shaders = stats;
  ctx.renderer.debug.onNodeBuilderCreated = (_builder: unknown, ro: unknown) => {
    stats.total++;
    if (stats.watching <= 0) return;
    const r = ro as { object?: THREE.Object3D; material?: THREE.Material } | null;
    const obj = r?.object ?? (ro as THREE.Object3D | null);
    const name = (obj && (obj.name || obj.type)) || "?";
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

/**
 * Run the protocol. `beforeFrame` lets the caller update systems between the real frames
 * (e.g. stream grass cells) so instance buffers are filled. Always restores the scene, even if a
 * frame throws.
 */
export async function warmup(
  ctx: RenderCtx,
  opts: { frames?: number; hooks?: WarmupHooks[]; beforeFrame?: () => void; onProgress?: (f: number) => void } = {},
) {
  const { scene, camera, renderer } = ctx;
  const restore: (() => void)[] = [];
  const t0 = performance.now();
  // Builds during a warm-up are the point of it, not post-warm-up hitches: e.g. the first-visit
  // probe's warm-up opens a window and the full warm-up right after compiles what it didn't draw.
  stats.watching = 0;
  const src = renderer as unknown as TimestampSource;
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
    try {
      await renderer.compileAsync(scene, camera);
    } catch (e) {
      console.warn("[warmup] compileAsync failed (continuing with real frames)", e);
    }
    opts.onProgress?.(0.5);
    const frames = opts.frames ?? 4;
    for (let i = 0; i < frames; i++) {
      opts.beforeFrame?.();
      beginManualFrame(src);
      ctx.render();
      ctx.gpu.frame(); // keeps three's timestamp query pool drained
      await nextFrame();
      opts.onProgress?.(0.5 + (0.5 * (i + 1)) / frames);
    }
  } finally {
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
  await nextFrame();
  ctx.gpu.drain();
  stats.watching = 120;
  stats.afterWarmup = 0;
  stats.recent = [];
  if (flags.has("shadercheck")) console.info(`[warmup] done in ${(performance.now() - t0).toFixed(0)} ms, ${stats.total} node builds so far`);
}
