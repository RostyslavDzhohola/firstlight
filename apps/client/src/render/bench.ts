// ?bench (SPEC §7.4): a scripted camera path around the spawn of the current body for 60 s,
// recording frame times (p50/p95/p99), GPU time, draw calls, triangles and heap, reported to the
// console as JSON and to window.__bench. ?benchcrowd=N spawns N local dummy avatars walking near
// the path (no server needed) and periodic particle bursts, to emulate the busiest scene.
// Options: ?benchtime=S (default 60), ?benchwarm=S warm-up before recording (default 5).
// No pointer lock needed; works with ?autoplay.

import * as THREE from "three/webgpu";
import { ANIM } from "@firstlight/shared/net/schema";
import type { Terrain } from "@firstlight/shared";
import { flags } from "../config.ts";
import { AvatarView } from "./Avatars.ts";
import type { ParticleSystem } from "./particles.ts";
import type { RenderCtx } from "./renderer.ts";
import { localFrame, type V3 } from "./sunFrame.ts";
import { percentile } from "./timing.ts";
import { shaderStats } from "./warmup.ts";

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
  when: string;
  body: string;
  backend: "webgpu" | "webgl2";
  gpu: string;
  tier: string;
  autoTier: boolean;
  devicePixelRatio: number;
  pixelRatio: number;
  canvas: [number, number];
  seconds: number;
  frames: number;
  frameMs: { p50: number; p95: number; p99: number; mean: number; max: number };
  fps: { mean: number; p50: number };
  gpuMs: { p50: number; p95: number } | null;
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
  readonly duration = Math.max(5, Number(flags.get("benchtime")) || 60);
  readonly warm = Math.max(0, Number(flags.get("benchwarm") ?? 5) || 0);
  private t = 0;
  private phase: "warm" | "run" | "done" = "warm";
  private readonly frames: number[] = [];
  private readonly gpu: number[] = [];
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

  constructor(private readonly host: BenchHost, crowdCount: number) {
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
    console.info(`[bench] start: warm ${this.warm}s, run ${this.duration}s, crowd ${crowdCount}`);
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

  /** Before rendering: drive the camera and the crowd. */
  update(dt: number, now: number, camera: THREE.PerspectiveCamera) {
    if (this.phase === "done") return;
    this.t += dt;
    const s = this.phase === "warm" ? (this.t / Math.max(this.warm, 1)) * 0.05 : this.t / this.duration;
    this.pose(Math.min(0.9999, s % 1), camera);
    this.updateCrowd(dt, now);
    if (this.phase === "warm") {
      this.el.textContent = `BENCH warming up ${this.t.toFixed(1)} / ${this.warm}s`;
      if (this.t >= Math.max(this.warm, 0.001)) {
        this.phase = "run";
        this.t = 0;
        this.shaderBuildsAtStart = shaderStats().total;
        this.recording = false;
      }
    }
  }

  private recording = false;

  /**
   * After rendering: record this frame. `frameMs` = the unclamped interval since the previous
   * frame; renderer.info still holds this frame's draw calls (it resets at the next loop tick).
   */
  record(frameMs: number) {
    if (this.phase !== "run") return;
    // Skip the first run frame: its interval straddles the warm/run switch.
    if (!this.recording) {
      this.recording = true;
      return;
    }
    const info = this.host.ctx.renderer.info.render;
    this.frames.push(frameMs);
    this.draws.push(info.drawCalls);
    this.tris.push(info.triangles);
    this.parts.push(this.host.particles.liveCount);
    const g = this.host.ctx.gpu.last;
    if (g !== null) this.gpu.push(g);
    const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
    if (mem && this.frames.length % 30 === 0) this.heap.push(mem.usedJSHeapSize / 1048576);
    if (this.frames.length % 15 === 0) this.el.textContent = `BENCH ${this.t.toFixed(1)} / ${this.duration}s  ${this.frames.length} frames`;
    if (this.t >= this.duration) this.finish();
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
    if (this.crowd.length && now >= this.nextBurst) {
      this.nextBurst = now + 350;
      const d = this.crowd[Math.floor(Math.random() * this.crowd.length)]!;
      const p = d.pos.clone().addScaledVector(d.dir, 1.0);
      this.host.particles.burst(p, PALETTE_BURST[Math.floor(Math.random() * PALETTE_BURST.length)]!, 60);
    }
  }

  /** Ground positions of the crowd for blob shadows. */
  crowdBlobs(): { x: number; y: number; z: number; r: number }[] {
    return this.crowd.map((d) => ({ x: d.pos.x, y: d.pos.y, z: d.pos.z, r: 0.55 }));
  }

  crowdViews(): AvatarView[] {
    return this.crowd.map((d) => d.view);
  }

  private finish() {
    this.phase = "done";
    const f = this.frames;
    const mean = f.reduce((a, b) => a + b, 0) / Math.max(1, f.length);
    const ctx = this.host.ctx;
    const st = this.host.stats();
    const avg = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
    const res: BenchResult = {
      v: 1,
      when: new Date().toISOString(),
      body: this.host.body,
      backend: ctx.webgpu ? "webgpu" : "webgl2",
      gpu: ctx.gpuName,
      tier: ctx.tier,
      autoTier: ctx.settings.auto,
      devicePixelRatio: devicePixelRatio,
      pixelRatio: r2(ctx.pixelRatio()),
      canvas: [ctx.renderer.domElement.width, ctx.renderer.domElement.height],
      seconds: this.duration,
      frames: f.length,
      frameMs: { p50: r2(percentile(f, 0.5)), p95: r2(percentile(f, 0.95)), p99: r2(percentile(f, 0.99)), mean: r2(mean), max: r2(Math.max(0, ...f)) },
      fps: { mean: r2(1000 / Math.max(0.001, mean)), p50: r2(1000 / Math.max(0.001, percentile(f, 0.5))) },
      gpuMs: this.gpu.length ? { p50: r2(percentile(this.gpu, 0.5)), p95: r2(percentile(this.gpu, 0.95)) } : null,
      draws: { mean: r2(avg(this.draws)), max: Math.max(0, ...this.draws) },
      triangles: { mean: Math.round(avg(this.tris)), max: Math.max(0, ...this.tris) },
      heapMB: this.heap.length ? { start: r2(this.heap[0]!), end: r2(this.heap[this.heap.length - 1]!), max: r2(Math.max(...this.heap)) } : null,
      crowd: this.crowd.length,
      particles: { mean: Math.round(avg(this.parts)), max: Math.max(0, ...this.parts) },
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
