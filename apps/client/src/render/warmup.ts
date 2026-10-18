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
import { castsLeanShadow, leanShadowsOn } from "./leanShadow.ts";
import { glSlowCalls, setGlPhase } from "./glTrace.ts";
import { gpuIdle, guardStatusPolls, warmLink, type PollGL } from "./syncPoll.ts";
import type { FirstDrawBatch, FirstDrawCensus, FirstDrawItem, SlowFrame, WarmupPhase, WarmupReport } from "./warmupReport.ts";
import {
  deferPipelines, FirstDrawPacer, gateFirstDraws, glFence, LONE_COST, newStageCost, OLD_PACER, PACER, pipelineCost,
  type DeferRenderer, type FenceGL, type GateRenderer, type Grant, type Warmth,
} from "./parallelCompile.ts";

export type { FirstDrawBatch, FirstDrawCensus, FirstDrawItem, SlowFrame, WarmupPhase, WarmupReport } from "./warmupReport.ts";

/** 32-bit FNV-1a of a string (diagnostics: two stages with one hash have one source). */
export function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** `?warmdiag`: what a first draw was (material, object, GLSL sizes and hashes, its price, its link), for the batch log. */
function describeFirstDraw(renderObject: unknown, pipeline: object, grant: Grant, link: number | null): FirstDrawItem {
  const r = renderObject as {
    material?: { type?: string; name?: string; isShadowPassMaterial?: boolean };
    object?: { name?: string; type?: string; parent?: { name?: string } | null };
  };
  const p = pipeline as { vertexProgram?: { code?: string }; fragmentProgram?: { code?: string } };
  const o = r.object;
  const own = o?.name || o?.type || "?";
  const vs = p.vertexProgram?.code ?? "";
  const fs = p.fragmentProgram?.code ?? "";
  return {
    material: `${r.material?.type ?? "?"}${r.material?.name ? `:${r.material.name}` : ""}`,
    object: o?.parent?.name ? `${own} in ${o.parent.name}` : own,
    vs: vs.length,
    fs: fs.length,
    vh: fnv1a(vs),
    fh: fnv1a(fs),
    cost: grant.cost,
    newChars: grant.newChars,
    skinned: vs.includes("skinIndex"),
    shadow: r.material?.isShadowPassMaterial === true,
    link: link === null ? null : Math.round(link),
    warm: warmLink(link),
  };
}

/** Main-thread long tasks from now until the returned stop (null there: the browser can't observe them). */
function observeLongTasks(): () => { count: number; max: number; over250: number } | null {
  type Entry = { duration: number };
  type Observer = { observe(o: object): void; disconnect(): void; takeRecords?(): Entry[] };
  const PO = (globalThis as { PerformanceObserver?: { new (cb: (l: { getEntries(): Entry[] }) => void): Observer; supportedEntryTypes?: readonly string[] } }).PerformanceObserver;
  if (!PO?.supportedEntryTypes?.includes("longtask")) return () => null;
  const s = { count: 0, max: 0, over250: 0 };
  const add = (es: Entry[]) => {
    for (const e of es) {
      s.count++;
      s.max = Math.max(s.max, Math.round(e.duration));
      if (e.duration > 250) s.over250++;
    }
  };
  let obs: Observer;
  try {
    obs = new PO((l) => add(l.getEntries()));
    obs.observe({ type: "longtask" });
  } catch {
    return () => null;
  }
  return () => {
    add(obs.takeRecords?.() ?? []);
    obs.disconnect();
    return s;
  };
}

/** `?warmdiag`: the first-drawn pipelines by kind, and how many distinct stage sources they had. */
export function firstDrawCensus(batches: readonly FirstDrawBatch[]): FirstDrawCensus {
  const items = batches.flatMap((b) => b.items);
  const distinct = (xs: FirstDrawItem[], f: (i: FirstDrawItem) => number) => new Set(xs.map(f)).size;
  const skinned = items.filter((i) => i.skinned);
  return {
    pipelines: items.length,
    skinnedShadow: skinned.filter((i) => i.shadow).length,
    skinnedMain: skinned.filter((i) => !i.shadow).length,
    vertexStages: distinct(items, (i) => i.vh),
    fragmentStages: distinct(items, (i) => i.fh),
    skinnedVertexStages: distinct(skinned, (i) => i.vh),
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

/** Seen once per warm-up: a key per counted build. */
function once(seen: Set<string>, key: string): 0 | 1 {
  if (seen.has(key)) return 0;
  seen.add(key);
  return 1;
}

/**
 * Whether a caster's shadow-pass variant will be a new node build: three keys a build by material,
 * geometry layout and context, plus the object itself for instanced meshes and the bone count for
 * skinned ones. `seen` collects the (material, layout) pairs already counted in this warm-up. With
 * lean shadows (`lean`, leanShadow.ts) the skinned casters whose materials cast lean shadows share
 * one build per rig (bone count), side and layout.
 */
export function shadowBuildCost(o: THREE.Object3D, seen: Set<string>, lean = false): 0 | 1 {
  const m = o as THREE.Mesh & { count?: number; isSkinnedMesh?: boolean; skeleton?: THREE.Skeleton };
  const mats = Array.isArray(m.material) ? m.material : [m.material];
  const attrs = m.geometry ? Object.keys(m.geometry.attributes).sort().map((k) => `${k}${m.geometry.attributes[k]!.itemSize}`).join(",") : "";
  const instanced = (m as THREE.InstancedMesh).isInstancedMesh || (m.count ?? 1) > 1;
  const rig = m.isSkinnedMesh ? `|${m.skeleton?.bones.length ?? 0}|${m.receiveShadow}` : "";
  if (lean && m.isSkinnedMesh && !instanced && mats.every((x) => x && castsLeanShadow(x))) {
    const sides = mats.map((x) => x.shadowSide ?? x.side).join("/");
    return once(seen, `lean|${m.skeleton?.bones.length ?? 0}|${sides}|${attrs}|${m.receiveShadow}`);
  }
  if (instanced) return 1;
  let cost: 0 | 1 = 0;
  for (const mat of mats) {
    const key = `${mat?.uuid ?? "-"}|${attrs}${rig}`;
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
export function predictShadowBuilds(scene: THREE.Object3D, lean = false): number {
  const seen = new Set<string>();
  let n = 0;
  for (const o of shadowCasters(scene)) n += shadowBuildCost(o, seen, lean);
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
  batch = SHADOW_BATCH,
  lean = false,
): Promise<number> {
  const casters = shadowCasters(scene);
  const pending = casters.map((o) => forceProperty(o, "castShadow", false));
  const seen = new Set<string>();
  let frames = 0;
  try {
    let i = 0;
    while (i < pending.length) {
      let cost = 0;
      while (i < pending.length && (cost < batch || cost === 0)) {
        cost += shadowBuildCost(casters[i]!, seen, lean);
        pending[i]!();
        pending[i] = () => {};
        i++;
        if (cost >= batch) break;
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

/** What the loader shows: GPU programs ready of those known so far, and the bar's position (0–1). */
export interface WarmupProgress {
  ready: number;
  programs: number;
  frac: number;
}

/**
 * A bar toward a total that is still being discovered (programs turn up as the compile goes). Each
 * step of work covers its share of what is left: exactly done/total when the total is fixed, and
 * when the total grows the steps get smaller instead of the bar freezing or going back.
 */
export class MovingProgress {
  private frac = 0;
  private done = 0;

  update(done: number, total: number): number {
    const d = done - this.done;
    if (d <= 0) return this.frac;
    this.frac = Math.min(1, this.frac + (1 - this.frac) * (d / Math.max(total - this.done, d)));
    this.done = done;
    return this.frac;
  }
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
  opts: { frames?: number; hooks?: WarmupHooks[]; beforeFrame?: () => void; onProgress?: (p: WarmupProgress) => void; label?: string } = {},
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
  const lean = leanShadowsOn(renderer); // characters and horses share a shadow build per rig (#39)
  let items = 0;
  let predicted = 0;
  let loaded = 0;
  let shadowDone = 0;
  let framesDone = 0;
  const bar = new MovingProgress();
  let lastShown = "";
  let compile: WarmupReport["phases"]["compile"] = { ms: 0, builds: 0, items: 0, wait: 0, idle: 0 };
  let compute: WarmupReport["phases"]["compute"] = { ms: 0, builds: 0, nodes: 0 };
  let shadows: WarmupReport["phases"]["shadows"] = { ms: 0, builds: 0, frames: 0, predicted: 0, wait: 0 };
  let realFrames = 0;
  // New programs compile side by side behind the loader instead of one at a time (D-load-2);
  // `?serialcompile` keeps three's own one-by-one compiles for A/B runs.
  // `?linkcap=N` (WebGL2, #39 A/B): at most N programs linking at once; the rest wait for later frames.
  const linkCap = !ctx.webgpu && flags.has("linkcap") ? Math.max(1, Number(flags.get("linkcap")) || 8) : 0;
  const deferred = flags.has("serialcompile") ? null : deferPipelines(renderer as unknown as DeferRenderer, { maxPending: linkCap });
  // WebGL2: a program's first draw builds its Metal pipeline in the GPU process, so first draws go
  // out in batches, one in flight at a time (a fence), priced by the GLSL of stages the GPU hasn't
  // drawn yet at its measured rate (#39); `?oldpacer` prices and paces as D-load-2 did.
  // `?warmdiag` logs every batch in the order sent; `?warmsolo` (diagnostics) sends one pipeline per batch.
  const oldPacer = flags.has("oldpacer");
  const diag = flags.has("warmdiag");
  const solo = flags.has("warmsolo");
  let frameGrants: FirstDrawItem[] = [];
  const batchLog: FirstDrawBatch[] = [];
  let sentBatches = 0;
  // Each program judged by its own link (#39): one that linked quickly was cached, and its first draw is
  // priced at the warm rate; batches hold one class, the ceiling holds cold-priced units.
  const backendData = (renderer as unknown as { backend?: { get?(o: object): { programGPU?: object } | undefined } }).backend;
  const linkMsOf = (p: object): number | null => {
    const prog = syncGuard?.active ? backendData?.get?.(p)?.programGPU : undefined;
    return prog ? syncGuard!.linkMs(prog) : null;
  };
  const classOf = (p: object): Warmth => (warmLink(linkMsOf(p)) ? "warm" : "cold");
  const gated = deferred?.active && !ctx.webgpu
    ? gateFirstDraws(
      renderer as unknown as GateRenderer,
      diag ? (ro, p, g) => frameGrants.push(describeFirstDraw(ro, p, g, linkMsOf(p))) : undefined,
      oldPacer ? pipelineCost : newStageCost,
      oldPacer ? {} : { classOf, price: (u, c) => pacer.price(u, c), loneCost: LONE_COST },
    )
    : null;
  const gate = gated?.active ? gated : null;
  const pacer = new FirstDrawPacer(diag ? (ms, _used, tag) => void ((tag as FirstDrawBatch).ms = Math.round(ms)) : undefined, oldPacer ? OLD_PACER : PACER);
  const gl = (renderer as unknown as { backend?: { gl?: FenceGL } }).backend?.gl ?? null;
  // WebGL2: never ask the GPU process a synchronous question while it is busy (#39): link polls are
  // answered locally until the link's fence has signalled and no first-draw batch is in flight, and the
  // compile starts once what is already queued has run. `?syncpoll` keeps three's own polls.
  const syncGuard = deferred?.active && !ctx.webgpu && !flags.has("syncpoll") ? guardStatusPolls(gl as PollGL | null, () => pacer.inFlight()) : null;
  let frameAt = 0;
  // Progress. The label counts GPU programs that have compiled, of those known so far (without the
  // deferral every build compiles before the next, so builds are programs). The bar blends all the
  // work as weighted units (objects prepared, programs compiled, shadow builds, first draws, frames)
  // through MovingProgress, so it moves with every bit of work and never goes back.
  const emit = (final = false) => {
    const started = deferred?.started() ?? 0;
    const finished = deferred?.finished() ?? 0;
    const programs = deferred?.active ? started : stats.total - builds0;
    const ready = final || !deferred?.active ? programs : finished;
    const total = items + 2 * started + predicted + (gate ? started : 0) + 2 * (frames + 1);
    const done = loaded + 2 * finished + shadowDone + (gate?.granted() ?? 0) + 2 * framesDone;
    const frac = final ? 1 : bar.update(done, total);
    const key = `${ready}/${programs}/${frac}`;
    if (key === lastShown) return;
    lastShown = key;
    opts.onProgress?.({ ready, programs, frac });
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
  let costAt = 0;
  let unitsAt = 0;
  let buildsAt = 0;
  let cpu = 0;
  let allowed = 0;
  let phase: SlowFrame["phase"] = "shadows";
  const slow: SlowFrame[] = [];
  const r1 = (x: number) => Math.round(x * 10) / 10;
  const pendingLinks = () => deferred?.pending() ?? 0;
  /** The longest gap between animation frames in the warm-up (every phase) and those over 250 ms. */
  const gaps = { max: 0, over250: 0 };
  const noteGap = (ms: number) => {
    gaps.max = Math.max(gaps.max, r1(ms));
    if (ms > 250) gaps.over250++;
  };
  const stopLongTasks = observeLongTasks();
  /**
   * The compile phase draws nothing itself, so its frames are sampled: each animation frame over
   * 100 ms is recorded until the returned stop is called.
   */
  const sampleFrames = (): (() => void) => {
    let on = true;
    let last = performance.now();
    let builds = stats.total;
    const sample = () => {
      if (!on) return;
      const now = performance.now();
      noteGap(now - last);
      if (now - last > 100) {
        slow.push({ phase: "compile", t: r1(now), ms: r1(now - last), cpu: 0, builds: stats.total - builds, firstDraws: 0, budget: 0, inFlight: false, batch: null, pending: pendingLinks() });
      }
      last = now;
      builds = stats.total;
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
    return () => void (on = false);
  };
  let stopSampling = () => {};
  const draw = () => {
    grantedAt = gate?.granted() ?? 0;
    costAt = gate?.cost() ?? 0;
    unitsAt = gate?.units() ?? 0;
    buildsAt = stats.total;
    const t = performance.now();
    allowed = solo ? Math.min(1, pacer.allowance()) : pacer.allowance(); // budget 1: the first item alone
    gate?.frame(allowed);
    deferred?.frame();
    frameGrants = [];
    opts.beforeFrame?.();
    beginManualFrame(src);
    ctx.render();
    ctx.gpu.frame(); // keeps three's timestamp query pool drained
    const end = performance.now();
    cpu = end - t;
    if (gate) {
      const used = gate.cost() - costAt;
      const fence = used > 0 ? glFence(gl) : null;
      let tag: FirstDrawBatch | undefined;
      if (fence) {
        sentBatches++;
        if (diag) {
          const sum = (f: (i: FirstDrawItem) => number) => frameGrants.reduce((n, i) => n + f(i), 0);
          tag = {
            seq: sentBatches, t: r1(end), ms: null, used, chars: sum((i) => i.vs + i.fs), newChars: sum((i) => i.newChars),
            n: frameGrants.length, skinnedShadow: sum((i) => (i.skinned && i.shadow ? 1 : 0)), cls: gate.batchClass() ?? "cold",
            pending: pendingLinks(), items: frameGrants,
          };
          batchLog.push(tag);
        }
      }
      pacer.sent(used, end, fence, tag, gate.batchClass() ?? "cold", gate.units() - unitsAt);
    }
  };
  /** After a frame: note its gap (and what it was made of, when slow), and settle the batch in flight. */
  const observe = (now: number, firstDraws: number, cpuMs: number, budget: number) => {
    if (frameAt) noteGap(now - frameAt);
    if (frameAt && now - frameAt > 100) {
      const inFlight = pacer.inFlight(); // the batch whose GPU work this frame waited on
      slow.push({
        phase, t: r1(now), ms: r1(now - frameAt), cpu: r1(cpuMs), builds: stats.total - buildsAt, firstDraws, budget,
        inFlight, batch: inFlight ? sentBatches : null, pending: pendingLinks(),
      });
    }
    if (frameAt) pacer.tick(now, now - frameAt);
    frameAt = now;
  };
  // WebGL2: while a first-draw batch is in flight the warm-up draws nothing and only polls its fence
  // (#39): a frame drawn then waits in the GPU process behind the Metal pipeline build, while with
  // none the compositor keeps presenting the loader. `?busydraw` draws on.
  const holdWhileBusy = !!gate && !flags.has("busydraw");
  const next = async () => {
    await nextFrame();
    observe(performance.now(), (gate?.granted() ?? 0) - grantedAt, cpu, allowed);
    while (holdWhileBusy && pacer.inFlight()) {
      await nextFrame();
      buildsAt = stats.total;
      observe(performance.now(), 0, 0, 0);
    }
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
    if (shadowsOn) predicted = predictShadowBuilds(scene, lean);
    // 2. The scene pass's compile: one render object at a time, yielding between them.
    setGlPhase("compile");
    lap();
    stopSampling = sampleFrames();
    const idle = syncGuard?.active ? await gpuIdle(gl, nextFrame) : 0;
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
    stopSampling();
    compile = { ...lap(), items, wait: compileWait, idle: Math.round(idle * 10) / 10 };
    loaded = items;
    // 3. Compute nodes (WebGPU): none yet, so the phase is empty.
    compute = { ...lap(), nodes: 0 };
    // 4. Shadow-pass variants. compileAsync skips the shadow map, so the first real frame built every
    //    caster's shadow material at once (WebGL links each synchronously: ~1 s with the loading
    //    screen frozen on a travel). Casters join the shadow pass a few per frame instead.
    frameAt = performance.now();
    setGlPhase("shadows");
    if (shadowsOn) {
      // Deferred programs link off the main thread, so a frame takes twice the new shadow builds.
      const n = await warmShadowCasters(scene, draw, next, (cost) => {
        shadowDone += cost;
        emit();
      }, deferred?.active ? SHADOW_BATCH * 2 : SHADOW_BATCH, lean);
      // WebGL2 keeps drawing while its shadow programs compile (the drain below); WebGPU waits here.
      const shadowWait = gate ? 0 : await compiled();
      shadows = { ...lap(), frames: n, predicted, wait: shadowWait };
    }
    shadowDone = Math.max(shadowDone, predicted);
    phase = "frames";
    setGlPhase("frames");
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
    phase = "drain";
    setGlPhase("drain");
    if (gate) {
      while (performance.now() - drainAt < DRAIN_MAX_MS) {
        const compiling = deferred!.pending();
        draw();
        realFrames++;
        drain++;
        await next();
        emit();
        // (with a link cap, also none held back from linking)
        if (compiling === 0 && gate.waiting() === 0 && deferred!.held() === 0 && !pacer.inFlight()) break;
      }
      await deferred!.settle();
      framesWait = ms(drainAt);
    } else {
      framesWait = await compiled();
    }
  } finally {
    stopSampling();
    setGlPhase("play");
    syncGuard?.release();
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
    slow: diag ? slow : [...slow].sort((a, b) => b.ms - a.ms).slice(0, 12),
    gaps,
    longTasks: stopLongTasks(),
    firstDraws: { granted: gate?.granted() ?? 0, ...pacer.batches() },
    ...(diag ? { batches: batchLog, census: firstDrawCensus(batchLog) } : {}),
    ...(flags.has("gltrace") ? { gl: [...glSlowCalls()] } : {}),
    ...(ctx.start?.fallback ? { webgpuFallback: { reason: ctx.start.fallback, lateMs: ctx.start.lateMs, secondChance: ctx.start.secondChance } } : {}),
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
