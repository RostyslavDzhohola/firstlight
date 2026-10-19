// Benchmarks (SPEC §7.4). A scripted camera path around the spawn of the current body, recording
// frame times (p50/p95/p99), GPU time, draw calls, triangles and heap, reported to the console as
// JSON and to window.__bench. No pointer lock needed; works with ?autoplay. Phases and the camera
// run on the wall clock; only the crowd simulation uses the clamped frame dt.
//
// Presets (both run offline unless ?online is given):
//   ?bench        renderer bench: the current body, 5 s warm-up, 60 s run, no crowd unless
//                 ?benchcrowd=N (then with bursts).
//   ?bench=g1     the G1 gate workload (SPEC §7.1/§7.4): Portus (unless ?body=…), 40 local dummy
//                 avatars + particle bursts, 180 s warm-up (the Air throttles), 60 s run.
// Overrides: ?benchcrowd=N, ?benchwarm=S, ?benchtime=S.

import * as THREE from "three/webgpu";
import { ANIM } from "@firstlight/shared/net/schema";
import { BODY_IDS, type BodyId, type Terrain } from "@firstlight/shared";
import { flags } from "../config.ts";
import { AvatarView } from "./Avatars.ts";
import type { ParticleSystem } from "./particles.ts";
import type { RenderCtx } from "./renderer.ts";
import { localFrame, type V3 } from "./sunFrame.ts";
import { maxOf, percentile } from "./timing.ts";
import { shaderStats } from "./warmup.ts";

export interface BenchConfig {
  preset: "renderer" | "g1";
  crowd: number;
  bursts: boolean;
  warmSeconds: number;
  runSeconds: number;
  /** Body to load for the bench (null = whatever the game would load). */
  body: BodyId | null;
}

const num = (name: string): number | null => {
  const v = flags.get(name);
  if (v === null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** The bench requested by the URL, or null. */
export function benchConfig(): BenchConfig | null {
  const v = flags.get("bench");
  if (v === null) return null;
  const g1 = v.toLowerCase() === "g1";
  const want = flags.get("body");
  const urlBody = want && (BODY_IDS as readonly string[]).includes(want) ? (want as BodyId) : null;
  const crowd = Math.max(0, Math.min(200, num("benchcrowd") ?? (g1 ? 40 : 0)));
  return {
    preset: g1 ? "g1" : "renderer",
    crowd,
    bursts: g1 || crowd > 0,
    warmSeconds: Math.max(0, num("benchwarm") ?? (g1 ? 180 : 5)),
    runSeconds: Math.max(5, num("benchtime") ?? 60),
    body: urlBody ?? (g1 ? "portus" : null),
  };
}

export interface BenchHost {
  ctx: RenderCtx;
  terrain: Terrain;
  particles: ParticleSystem;
  /** Spawn point on the ground (planet space). */
  spawn: THREE.Vector3;
  stats(): { chunks: number; visibleChunks: number; grassBlades: number; props: number };
  body: string;
}

interface Dummy {
  view: AvatarView;
  dir: THREE.Vector3;
  heading: THREE.Vector3;
  speed: number;
  turn: number;
  pos: THREE.Vector3;
}

const PALETTE_BURST = [0x36f9f6, 0xffb86b, 0xff7edb, 0x9cff6b, 0xffd166, 0xb48cff];

export interface BenchResult {
  v: 1;
  preset: "renderer" | "g1";
  when: string;
  body: string;
  backend: "webgpu" | "webgl2";
  gpu: string;
  tier: string;
  autoTier: boolean;
  devicePixelRatio: number;
  pixelRatio: number;
  canvas: [number, number];
  /** Measured wall-clock length of the recorded run. */
  seconds: number;
  plannedSeconds: number;
  warmSeconds: number;
  frames: number;
  frameMs: { p50: number; p95: number; p99: number; mean: number; max: number };
  /** Frames that took over 1.5× the median interval (a missed display refresh at vsync). */
  slowFrames: number;
  /** Main-thread time of each frame (game update + render submission). */
  cpuMs: { p50: number; p95: number; p99: number };
  fps: { mean: number; p50: number };
  /** three's GPU time (the passes summed: several times the real cost on tile-based GPUs). */
  gpuMs: { p50: number; p95: number } | null;
  /** GPU busy time per frame (WebGPU pass union, D-framerate-2). */
  gpuBusyMs: { p50: number; p95: number; p99: number; n: number } | null;
  draws: { mean: number; max: number };
  triangles: { mean: number; max: number };
  heapMB: { start: number; end: number; max: number } | null;
  crowd: number;
  particles: { mean: number; max: number };
  chunks: number;
  visibleChunks: number;
  grassBlades: number;
  props: number;
  shaderBuildsDuringRun: number;
  flags: string;
  userAgent: string;
}

const r2 = (v: number) => Math.round(v * 100) / 100;

export class Bench {
  readonly duration: number;
  readonly warm: number;
  private readonly startWall = performance.now();
  private runStart = 0;
  private runEnd = 0;
  private phase: "warm" | "run" | "done" = "warm";
  private readonly frames: number[] = [];
  private readonly cpu: number[] = [];
  private readonly gpu: number[] = [];
  private readonly busy: number[] = [];
  private readonly draws: number[] = [];
  private readonly tris: number[] = [];
  private readonly parts: number[] = [];
  private readonly heap: number[] = [];
  private readonly crowd: Dummy[] = [];
  private nextBurst = 0;
  private shaderBuildsAtStart = 0;
  private readonly up = new THREE.Vector3();
  private readonly east = new THREE.Vector3();
  private readonly north = new THREE.Vector3();
  private readonly el: HTMLDivElement;
  readonly focus = new THREE.Vector3();
  result: BenchResult | null = null;

  constructor(private readonly host: BenchHost, readonly config: BenchConfig) {
    this.duration = config.runSeconds;
    this.warm = config.warmSeconds;
    const crowdCount = config.crowd;
    this.up.copy(host.spawn).normalize();
    const e: V3 = [0, 0, 0], n: V3 = [0, 0, 0];
    localFrame(this.up.x, this.up.y, this.up.z, e, n);
    this.east.set(...e);
    this.north.set(...n);
    this.focus.copy(host.spawn);
    for (let i = 0; i < crowdCount; i++) {
      const view = new AvatarView(i % 6, i % 4);
      view.root.name = `benchDummy${i}`;
      host.ctx.scene.add(view.root);
      const a = (i / Math.max(1, crowdCount)) * Math.PI * 2;
      const r = 6 + (i % 7) * 4.5;
      const dir = this.groundDir(Math.cos(a) * r, Math.sin(a) * r);
      const heading = this.east.clone().multiplyScalar(-Math.sin(a)).addScaledVector(this.north, Math.cos(a)).normalize();
      this.crowd.push({ view, dir, heading, speed: 1.4 + (i % 5) * 0.9, turn: (i % 2 ? 1 : -1) * 0.3, pos: new THREE.Vector3() });
    }
    this.el = document.createElement("div");
    this.el.style.cssText =
      "position:fixed;right:8px;top:8px;z-index:60;font:12px/1.4 ui-monospace,monospace;color:#cfe;background:#000b;padding:8px 10px;border-radius:6px;max-width:46vw;max-height:80vh;overflow:auto;white-space:pre-wrap";
    document.body.appendChild(this.el);
    console.info(`[bench] ${config.preset}: warm ${this.warm}s, run ${this.duration}s, crowd ${crowdCount}, bursts ${config.bursts}`);
  }

  /** Direction of the ground point at tangent offset (x east, y north) metres from the spawn. */
  private groundDir(x: number, y: number): THREE.Vector3 {
    const R = this.host.terrain.body.radius;
    return this.up.clone().multiplyScalar(R).addScaledVector(this.east, x).addScaledVector(this.north, y).normalize();
  }

  private groundPoint(x: number, y: number, h: number, out = new THREE.Vector3()): THREE.Vector3 {
    const d = this.groundDir(x, y);
    const g = this.host.terrain.groundHeight(d.x, d.y, d.z) + this.host.terrain.body.radius;
    const wr = this.host.terrain.body.radius + this.host.terrain.body.waterLevel;
    return out.copy(d).multiplyScalar(Math.max(g, wr) + h);
  }

  /** Camera pose at path parameter s in [0, 1). */
  private pose(s: number, camera: THREE.PerspectiveCamera) {
    const TAU = Math.PI * 2;
    const pos = new THREE.Vector3();
    const target = new THREE.Vector3();
    if (s < 1 / 3) {
      // Ground-level loop through the grass and props.
      const a = (s * 3) * TAU;
      const r = 18;
      this.groundPoint(Math.cos(a) * r, Math.sin(a) * r, 2.2, pos);
      const a2 = a + 0.18;
      this.groundPoint(Math.cos(a2) * r, Math.sin(a2) * r, 1.6, target);
    } else if (s < 2 / 3) {
      // Rising orbit looking at the spawn: terrain, sky, sky planets, fog.
      const u = (s - 1 / 3) * 3;
      const a = u * TAU + 0.6;
      const r = 22 + 26 * u;
      this.groundPoint(Math.cos(a) * r, Math.sin(a) * r, 4 + 28 * Math.sin(u * Math.PI * 0.5), pos);
      target.copy(this.host.spawn).addScaledVector(this.up, 1.5);
    } else {
      // Low figure-eight.
      const u = (s - 2 / 3) * 3;
      const a = u * TAU;
      const r = 34;
      const x = Math.sin(a) * r, y = Math.sin(a) * Math.cos(a) * r;
      this.groundPoint(x, y, 3.5, pos);
      const a2 = a + 0.05;
      this.groundPoint(Math.sin(a2) * r, Math.sin(a2) * Math.cos(a2) * r, 2.8, target);
    }
    camera.position.copy(pos);
    camera.up.copy(pos).normalize();
    camera.lookAt(target);
    this.focus.copy(target);
  }

  get running() {
    return this.phase !== "done";
  }

  /** Before rendering: drive the camera (wall clock) and the crowd (clamped dt). */
  update(dt: number, now: number, camera: THREE.PerspectiveCamera) {
    if (this.phase === "done") return;
    const runMs = this.duration * 1000;
    if (this.phase === "warm") {
      const warmed = now - this.startWall;
      // Warm-up flies the same path so the GPU reaches its steady (throttled) state on the load.
      this.pose((warmed / runMs) % 1, camera);
      this.el.textContent = `BENCH ${this.config.preset} warming up ${(warmed / 1000).toFixed(0)} / ${this.warm} s`;
      if (warmed >= this.warm * 1000) {
        this.phase = "run";
        this.runStart = now;
        this.shaderBuildsAtStart = shaderStats().total;
        this.host.ctx.gpu.drainBusy();
        this.recording = false;
        this.pose(0, camera);
      }
    } else {
      this.pose(Math.min(0.9999, (now - this.runStart) / runMs), camera);
    }
    this.updateCrowd(dt, now);
  }

  private recording = false;

  /**
   * After rendering: record this frame. `frameMs` = the unclamped interval since the previous
   * frame, `cpuMs` = this frame's main-thread time; renderer.info still holds this frame's draw
   * calls (it resets at the next loop tick).
   */
  record(frameMs: number, cpuMs = 0) {
    if (this.phase !== "run") return;
    const now = performance.now();
    // Skip the first run frame: its interval straddles the warm/run switch.
    if (!this.recording) {
      this.recording = true;
      this.host.ctx.gpu.drainBusy();
      return;
    }
    const info = this.host.ctx.renderer.info.render;
    this.frames.push(frameMs);
    this.cpu.push(cpuMs);
    this.draws.push(info.drawCalls);
    this.tris.push(info.triangles);
    this.parts.push(this.host.particles.liveCount);
    const g = this.host.ctx.gpu.last;
    if (g !== null) this.gpu.push(g);
    for (const b of this.host.ctx.gpu.drainBusy()) this.busy.push(b); // the timer keeps only its last 600
    const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
    if (mem && this.frames.length % 30 === 0) this.heap.push(mem.usedJSHeapSize / 1048576);
    const elapsed = (now - this.runStart) / 1000;
    if (this.frames.length % 15 === 0) this.el.textContent = `BENCH ${this.config.preset} ${elapsed.toFixed(1)} / ${this.duration} s  ${this.frames.length} frames`;
    if (elapsed >= this.duration) {
      this.runEnd = now;
      this.finish();
    }
  }

  private updateCrowd(dt: number, now: number) {
    const R = this.host.terrain.body.radius;
    for (const d of this.crowd) {
      // Wander: slow turning, steer back towards the spawn beyond 40 m.
      const up = d.dir;
      const toSpawn = this.up.clone().sub(up.clone().multiplyScalar(this.up.dot(up)));
      const dist = Math.acos(Math.max(-1, Math.min(1, up.dot(this.up)))) * R;
      d.heading.applyAxisAngle(up, d.turn * dt * Math.sin(now * 0.0007 + d.speed * 3));
      if (dist > 40 && toSpawn.lengthSq() > 1e-8) d.heading.lerp(toSpawn.normalize(), Math.min(1, dt * 1.5));
      d.heading.addScaledVector(up, -d.heading.dot(up)).normalize();
      d.dir.multiplyScalar(R).addScaledVector(d.heading, d.speed * dt).normalize();
      const g = this.host.terrain.groundHeight(d.dir.x, d.dir.y, d.dir.z);
      const wr = this.host.terrain.body.waterLevel;
      d.pos.copy(d.dir).multiplyScalar(R + Math.max(g, wr - 1.05));
      const anim = g < wr - 1.2 ? ANIM.SWIM : d.speed > 3.5 ? ANIM.RUN : ANIM.WALK;
      d.view.set(d.pos.x, d.pos.y, d.pos.z, d.heading.x, d.heading.y, d.heading.z, anim, dt);
    }
    if (this.config.bursts && this.crowd.length && now >= this.nextBurst) {
      this.nextBurst = now + 350;
      const d = this.crowd[Math.floor(Math.random() * this.crowd.length)]!;
      const p = d.pos.clone().addScaledVector(d.dir, 1.0);
      this.host.particles.burst(p, PALETTE_BURST[Math.floor(Math.random() * PALETTE_BURST.length)]!, 60);
    }
  }

  private readonly blobs: { x: number; y: number; z: number; r: number }[] = [];
  private readonly views: AvatarView[] = [];

  /** Ground positions of the crowd for blob shadows (the same array every call). */
  crowdBlobs(): { x: number; y: number; z: number; r: number }[] {
    for (let i = 0; i < this.crowd.length; i++) {
      const d = this.crowd[i]!;
      const b = (this.blobs[i] ??= { x: 0, y: 0, z: 0, r: 0.55 });
      b.x = d.pos.x;
      b.y = d.pos.y;
      b.z = d.pos.z;
    }
    return this.blobs;
  }

  /** The crowd's avatar views (the same array every call). */
  crowdViews(): AvatarView[] {
    if (this.views.length !== this.crowd.length) {
      this.views.length = 0;
      for (const d of this.crowd) this.views.push(d.view);
    }
    return this.views;
  }

  private finish() {
    this.phase = "done";
    for (const b of this.host.ctx.gpu.drainBusy()) this.busy.push(b);
    const f = this.frames;
    const median = percentile(f, 0.5);
    const mean = f.reduce((a, b) => a + b, 0) / Math.max(1, f.length);
    const ctx = this.host.ctx;
    const st = this.host.stats();
    const avg = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
    const res: BenchResult = {
      v: 1,
      preset: this.config.preset,
      when: new Date().toISOString(),
      body: this.host.body,
      backend: ctx.webgpu ? "webgpu" : "webgl2",
      gpu: ctx.gpuName,
      tier: ctx.tier,
      autoTier: ctx.settings.auto,
      devicePixelRatio: devicePixelRatio,
      pixelRatio: r2(ctx.pixelRatio()),
      canvas: [ctx.renderer.domElement.width, ctx.renderer.domElement.height],
      seconds: r2((this.runEnd - this.runStart) / 1000),
      plannedSeconds: this.duration,
      warmSeconds: this.warm,
      frames: f.length,
      frameMs: { p50: r2(median), p95: r2(percentile(f, 0.95)), p99: r2(percentile(f, 0.99)), mean: r2(mean), max: r2(maxOf(f)) },
      slowFrames: f.filter((v) => v > median * 1.5).length,
      cpuMs: { p50: r2(percentile(this.cpu, 0.5)), p95: r2(percentile(this.cpu, 0.95)), p99: r2(percentile(this.cpu, 0.99)) },
      fps: { mean: r2(1000 / Math.max(0.001, mean)), p50: r2(1000 / Math.max(0.001, percentile(f, 0.5))) },
      gpuMs: this.gpu.length ? { p50: r2(percentile(this.gpu, 0.5)), p95: r2(percentile(this.gpu, 0.95)) } : null,
      gpuBusyMs: this.busy.length ? { p50: r2(percentile(this.busy, 0.5)), p95: r2(percentile(this.busy, 0.95)), p99: r2(percentile(this.busy, 0.99)), n: this.busy.length } : null,
      draws: { mean: r2(avg(this.draws)), max: maxOf(this.draws) },
      triangles: { mean: Math.round(avg(this.tris)), max: maxOf(this.tris) },
      heapMB: this.heap.length ? { start: r2(this.heap[0]!), end: r2(this.heap[this.heap.length - 1]!), max: r2(maxOf(this.heap)) } : null,
      crowd: this.crowd.length,
      particles: { mean: Math.round(avg(this.parts)), max: maxOf(this.parts) },
      chunks: st.chunks,
      visibleChunks: st.visibleChunks,
      grassBlades: st.grassBlades,
      props: st.props,
      shaderBuildsDuringRun: shaderStats().total - this.shaderBuildsAtStart,
      flags: location.search,
      userAgent: navigator.userAgent,
    };
    this.result = res;
    const w = window as unknown as { __bench: BenchResult; __benchDone: boolean };
    w.__bench = res;
    w.__benchDone = true;
    const json = JSON.stringify(res);
    console.log(`[bench] ${json}`);
    this.el.textContent = `BENCH done\n${JSON.stringify(res, null, 2)}`;
    const btn = document.createElement("button");
    btn.textContent = "Copy JSON";
    btn.style.cssText = "display:block;margin-top:6px;font:inherit;cursor:pointer";
    btn.onclick = () => void navigator.clipboard?.writeText(json).catch(() => {});
    this.el.appendChild(btn);
    document.title = "FIRSTLIGHT bench done";
  }
}
