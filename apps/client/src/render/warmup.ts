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

export interface WarmupHooks {
  /** Force every LOD / hidden variant on (true) or back to normal (false). */
  forceAll(on: boolean): void;
}

const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));

/**
 * Run the protocol. `beforeFrame` lets the caller update systems between the real frames
 * (e.g. stream grass cells) so instance buffers are filled.
 */
export async function warmup(
  ctx: RenderCtx,
  opts: { frames?: number; hooks?: WarmupHooks[]; beforeFrame?: () => void; onProgress?: (f: number) => void } = {},
) {
  const { scene, camera, renderer } = ctx;
  const restore: (() => void)[] = [];
  const t0 = performance.now();
  for (const h of opts.hooks ?? []) h.forceAll(true);
  scene.traverse((o) => {
    if (o.frustumCulled) {
      o.frustumCulled = false;
      restore.push(() => (o.frustumCulled = true));
    }
    if (!o.visible && !o.userData.noWarmup) {
      o.visible = true;
      restore.push(() => (o.visible = false));
    }
    const im = o as THREE.InstancedMesh;
    if (im.isInstancedMesh && im.count === 0) {
      im.count = 1;
      restore.push(() => (im.count = 0));
    }
    const mesh = o as THREE.Mesh;
    const g = mesh.isMesh ? (mesh.geometry as THREE.InstancedBufferGeometry) : null;
    if (g && (g as { isInstancedBufferGeometry?: boolean }).isInstancedBufferGeometry && g.instanceCount === 0) {
      g.instanceCount = 1;
      restore.push(() => (g.instanceCount = 0));
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
    ctx.render();
    await nextFrame();
    opts.onProgress?.(0.5 + (0.5 * (i + 1)) / frames);
  }
  for (const r of restore.reverse()) r();
  for (const h of opts.hooks ?? []) h.forceAll(false);
  // One more real frame in the normal state (restored counts can differ, e.g. LOD splits).
  opts.beforeFrame?.();
  ctx.render();
  await nextFrame();
  stats.watching = 120;
  stats.afterWarmup = 0;
  stats.recent = [];
  if (flags.has("shadercheck")) console.info(`[warmup] done in ${(performance.now() - t0).toFixed(0)} ms, ${stats.total} node builds so far`);
}
