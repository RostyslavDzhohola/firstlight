// Game orchestration: renderer, current body, local player, network, remote avatars, main loop.

import * as THREE from "three/webgpu";
import { BODIES, padDirs, type BodyId } from "@firstlight/shared";
import { flags } from "../config.ts";
import { Net } from "../net/Net.ts";
import { AvatarView } from "../render/Avatars.ts";
import { Bench, benchConfig } from "../render/bench.ts";
import { BlobShadows } from "../render/blobShadows.ts";
import { ParticleSystem, type BurstOptions } from "../render/particles.ts";
import { PerfOverlay } from "../render/PerfOverlay.ts";
import { MENU_GRADE } from "../render/post.ts";
import { runProbe } from "../render/probe.ts";
import { createRenderer, type RenderCtx } from "../render/renderer.ts";
import { installShaderMonitor, shaderMonitorFrame, warmup } from "../render/warmup.ts";
import { Planet } from "../world/Planet.ts";
import { Input } from "./input.ts";
import { PlayerController } from "./PlayerController.ts";

const loadingEl = () => document.getElementById("loading")!;
function setLoading(text: string, frac: number) {
  const el = loadingEl();
  el.style.display = "grid";
  document.getElementById("loading-text")!.textContent = text;
  (document.getElementById("loading-bar") as HTMLElement).style.width = `${Math.round(frac * 100)}%`;
}
function hideLoading() {
  loadingEl().style.display = "none";
}

/** ?bench runs without a server unless ?online is also given; ?offline forces it anywhere. */
const OFFLINE = flags.has("offline") || (flags.has("bench") && !flags.has("online"));
const FX_DEMO = flags.has("fxdemo");

export class Game {
  ctx!: RenderCtx;
  planet!: Planet;
  player!: PlayerController;
  input!: Input;
  readonly net = new Net();
  readonly avatars = new Map<string, AvatarView>();
  self!: AvatarView;
  perf!: PerfOverlay;
  particles!: ParticleSystem;
  blobs!: BlobShadows;
  bench: Bench | null = null;
  bodyId: BodyId = "portus";
  private last = performance.now();
  private running = false;
  private probed = false;
  private detailTick = 0;
  private nextFxDemo = 0;

  async start(body: BodyId) {
    setLoading("Starting the renderer…", 0.05);
    const container = document.getElementById("game")!;
    this.ctx = await createRenderer(container);
    installShaderMonitor(this.ctx);
    console.info(`[gfx] backend ${this.ctx.webgpu ? "WebGPU" : "WebGL2"}, tier ${this.ctx.tier}${this.ctx.settings.auto ? " (auto)" : ""}, gpu "${this.ctx.gpuName}"`);
    this.input = new Input(this.ctx.renderer.domElement);
    this.perf = new PerfOverlay(this.ctx);
    this.perf.actions = {
      setTier: (t) => void this.applyGraphics(() => (t === "auto" ? this.ctx.setAutoTier() : this.ctx.setTier(t))),
      setFeature: (f, on) => void this.applyGraphics(() => this.ctx.setFeature(f, on)),
      setScale: (s) => this.ctx.setRenderScale(s),
      reprobe: () => void this.reprobe(),
      reset: () => {
        this.ctx.resetSettings();
        location.reload();
      },
    };
    this.particles = new ParticleSystem(this.ctx.scene);
    this.blobs = new BlobShadows(this.ctx.scene);
    const applyFx = () => {
      this.particles.applySettings(this.ctx.settings);
      this.blobs.applySettings(this.ctx.settings);
      this.applyCharsVisibility();
    };
    applyFx();
    this.ctx.onChange(applyFx);
    document.getElementById("landing")!.style.display = "none";
    await this.enterBody(body);
    this.running = true;
    if (!this.bench) this.input.lock();
    this.ctx.renderer.setAnimationLoop(() => this.frame());
  }

  /** ?fxdemo: a burst every 0.8 s around the focus, cycling colours (particle look check). */
  private fxDemo(now: number, focus: THREE.Vector3) {
    this.nextFxDemo = now + 800;
    const up = focus.clone().normalize();
    const side = new THREE.Vector3(1, 0, 0).cross(up);
    if (side.lengthSq() < 1e-6) side.set(0, 0, 1).cross(up);
    side.normalize().applyAxisAngle(up, (now / 1000) % (Math.PI * 2));
    const p = focus.clone().addScaledVector(side, 3).addScaledVector(up, 1);
    const colors = [0x36f9f6, 0xffb86b, 0xff7edb, 0x9cff6b, 0xffd166];
    this.burst(p, colors[Math.floor(now / 800) % colors.length]!, 80);
  }

  /** Look rule 1: muted grade while a menu/lobby is open, the body's saturated grade otherwise. */
  setMenuMode(on: boolean) {
    this.ctx.setGrade(on || !this.planet ? MENU_GRADE : this.planet.look.grade);
  }

  /** Reusable "digital matter is light" burst for spawns, deaths, loot and teleports. */
  burst(position: THREE.Vector3, color: THREE.ColorRepresentation, count: number, opts?: BurstOptions): number {
    return this.particles.burst(position, color, count, opts);
  }

  private spawnPoint(): THREE.Vector3 {
    const body = this.planet.body;
    const d = padDirs(body)[0]!;
    const h = this.planet.terrain.groundHeight(d[0], d[1], d[2]);
    return new THREE.Vector3(d[0], d[1], d[2]).multiplyScalar(body.radius + h);
  }

  async enterBody(body: BodyId) {
    setLoading(`Travelling to ${body[0]!.toUpperCase()}${body.slice(1)}…`, 0.15);
    await this.net.leave();
    for (const a of this.avatars.values()) a.dispose();
    this.avatars.clear();
    this.planet?.dispose();
    this.bodyId = body;
    this.planet = new Planet(this.ctx, body);
    this.particles.setMoteColor(this.planet.look.mote);
    this.player ??= new PlayerController(this.planet.terrain, this.planet.body.waterLevel);
    this.player.setTerrain(this.planet.terrain, this.planet.body.waterLevel);

    if (OFFLINE) {
      const p = this.spawnPoint();
      this.player.teleport(p.x, p.y, p.z);
    } else {
      setLoading("Connecting…", 0.3);
      const room = await this.net.join(body);
      await new Promise<void>((resolve) => {
        const check = () => {
          const me = (room.state as any).players?.get(room.sessionId);
          if (me) {
            this.player.teleport(me.x, me.y, me.z);
            resolve();
          } else setTimeout(check, 30);
        };
        check();
      });
      this.net.onCorrect = (x, y, z) => this.player.teleport(x, y, z);
    }

    // Stream terrain around the spawn before handing control over.
    const t0 = performance.now();
    for (;;) {
      const p = this.player.pos;
      const pending = this.planet.update(p.x, p.y, p.z, this.ctx.camera, performance.now());
      setLoading("Building the world…", 0.4 + 0.4 * Math.max(0, 1 - pending / 40));
      if (pending === 0 || performance.now() - t0 > 15000) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    if (!this.self) {
      this.self = new AvatarView(0, 0);
      this.self.root.name = "selfAvatar";
    }
    this.ctx.scene.add(this.self.root);
    {
      const p = this.player.pos, f = this.player.facing;
      this.self.set(p.x, p.y, p.z, f.x, f.y, f.z, this.player.anim, 0);
    }
    this.player.placeCamera(this.ctx.camera);
    this.applyCharsVisibility();
    const updateWorld = () => this.updateWorldForWarmup();

    // Quality probe on first visit (SPEC §7.3), then the warm-up protocol (SPEC §4.1).
    const wantProbe = !this.probed && !flags.has("tier") && !flags.has("noprobe") &&
      (flags.has("reprobe") || (this.ctx.needsProbe() && !flags.has("bench")));
    if (wantProbe) {
      this.probed = true;
      setLoading("Tuning graphics for this computer…", 0.82);
      try {
        const r = await runProbe(this.ctx, updateWorld);
        console.info(`[gfx] probe → ${r.tier}${r.valid ? "" : " (not saved)"}`, r);
        this.ctx.setProbedTier(r.tier, { persist: r.valid });
      } catch (e) {
        console.warn("[gfx] probe failed, staying on medium", e);
        this.ctx.setProbedTier("medium", { persist: false });
      }
    }
    // The bench crowd exists before warm-up so its shaders compile behind the loading screen.
    const benchCfg = benchConfig();
    if (benchCfg && !this.bench) {
      const spawn = this.player.pos.clone();
      this.bench = new Bench({
        ctx: this.ctx,
        terrain: this.planet.terrain,
        particles: this.particles,
        spawn,
        stats: () => this.planet.stats(),
        body: this.bodyId,
      }, benchCfg);
      this.player.frozen = true;
      this.applyCharsVisibility();
      this.bench.update(0, performance.now(), this.ctx.camera);
    }
    setLoading("Warming up shaders…", 0.92);
    await warmup(this.ctx, { frames: 4, hooks: [this.warmupHook()], beforeFrame: updateWorld });
    hideLoading();
  }

  private warmupHook() {
    return {
      forceAll: (on: boolean) => {
        this.planet.props.setForceAll(on);
      },
    };
  }

  /** Apply a graphics change, then re-run the warm-up behind the loading screen. */
  async applyGraphics(change: () => void) {
    change();
    if (!this.running) return;
    this.running = false;
    setLoading("Applying graphics settings…", 0.5);
    try {
      await warmup(this.ctx, { frames: 3, hooks: [this.warmupHook()], beforeFrame: () => this.updateWorldForWarmup() });
    } finally {
      hideLoading();
      this.running = true;
      this.last = performance.now();
    }
  }

  private updateWorldForWarmup() {
    const f = this.bench ? this.bench.focus : this.player.pos;
    this.planet.update(f.x, f.y, f.z, this.ctx.camera, performance.now());
    this.particles.update(1 / 60, this.ctx.camera.position, performance.now());
  }

  private async reprobe() {
    this.running = false;
    setLoading("Tuning graphics for this computer…", 0.5);
    try {
      const r = await runProbe(this.ctx);
      console.info(`[gfx] probe → ${r.tier}${r.valid ? "" : " (not saved)"}`, r);
      this.ctx.setProbedTier(r.tier, { persist: r.valid, clearPinned: true });
      await warmup(this.ctx, { frames: 3, hooks: [this.warmupHook()] });
    } finally {
      hideLoading();
      this.running = true;
      this.last = performance.now();
    }
  }

  private applyCharsVisibility() {
    const on = this.ctx.settings.on.chars;
    if (this.self) this.self.root.visible = on && !this.bench;
    for (const a of this.avatars.values()) a.root.visible = on;
    for (const a of this.bench?.crowdViews() ?? []) a.root.visible = on;
  }

  /** Full detail for the nearest N avatars (tier table), reduced beyond. */
  private updateAvatarDetail(now: number) {
    if (now - this.detailTick < 500) return;
    this.detailTick = now;
    const cam = this.ctx.camera.position;
    const all = [...this.avatars.values(), ...(this.bench?.crowdViews() ?? [])];
    all.sort((a, b) => a.root.position.distanceToSquared(cam) - b.root.position.distanceToSquared(cam));
    const n = this.ctx.settings.fullAvatars;
    all.forEach((a, i) => a.setDetail(i < n));
  }

  private frame() {
    const now = performance.now();
    const rawMs = now - this.last;
    const dt = Math.min(0.05, rawMs / 1000);
    this.last = now;
    if (!this.running) return;
    const cpu0 = performance.now();

    let focus: THREE.Vector3;
    if (this.bench) {
      this.bench.update(dt, now, this.ctx.camera);
      focus = this.bench.focus;
    } else {
      this.player.update(dt, this.input, this.input.rmb);
      const p = this.player.pos;
      const f = this.player.facing;
      this.net.sendInput(now, { x: p.x, y: p.y, z: p.z, fx: f.x, fy: f.y, fz: f.z, anim: this.player.anim });
      this.self.set(p.x, p.y, p.z, f.x, f.y, f.z, this.player.anim, dt);
      focus = p;
    }

    // Remote players.
    for (const [id, view] of this.net.remotes) {
      const s = this.net.sample(view, now);
      if (!s) continue;
      let a = this.avatars.get(id);
      if (!a) {
        const st = (this.net.room?.state as any)?.players?.get(id);
        a = new AvatarView(st?.palette ?? (id.charCodeAt(0) % 6), st?.starter ?? 0);
        a.root.visible = this.ctx.settings.on.chars;
        this.avatars.set(id, a);
        this.ctx.scene.add(a.root);
      }
      a.set(s.x, s.y, s.z, s.fx, s.fy, s.fz, s.anim, dt);
    }
    for (const [id, a] of this.avatars) {
      if (!this.net.remotes.has(id)) {
        a.dispose();
        this.avatars.delete(id);
      }
    }
    this.updateAvatarDetail(now);

    this.planet.update(focus.x, focus.y, focus.z, this.ctx.camera, now, dt);
    if (!this.bench) this.player.placeCamera(this.ctx.camera);
    if (FX_DEMO && now >= this.nextFxDemo) this.fxDemo(now, focus);
    this.particles.update(dt, this.ctx.camera.position, now);
    if (this.ctx.settings.on.chars) {
      const blobs: { x: number; y: number; z: number; r: number }[] = [];
      const addBlob = (pos: THREE.Vector3) => {
        const l = pos.length();
        const g = this.planet.terrain.groundHeight(pos.x / l, pos.y / l, pos.z / l) + this.planet.body.radius;
        const lift = l - g;
        if (lift > 6) return;
        const k = g / l;
        blobs.push({ x: pos.x * k, y: pos.y * k, z: pos.z * k, r: 0.55 * (1 - lift / 8) });
      };
      if (!this.bench && this.self) addBlob(this.player.pos);
      for (const a of this.avatars.values()) addBlob(a.root.position);
      if (this.bench) blobs.push(...this.bench.crowdBlobs());
      this.blobs.update(blobs);
    }
    if (this.input.pressed.has("F3")) this.perf.toggle();
    this.ctx.render();
    const cpuMs = performance.now() - cpu0;
    this.ctx.afterFrame(now, rawMs);
    this.bench?.record(rawMs);
    shaderMonitorFrame();
    const st = this.planet.stats();
    this.perf.frame(now, rawMs / 1000, {
      cpuMs,
      chunks: st.chunks,
      visibleChunks: st.visibleChunks,
      water: st.water,
      grass: st.grassBlades,
      props: st.props,
      particles: this.particles.liveCount,
      entities: this.avatars.size + 1 + (this.bench?.crowdViews().length ?? 0),
      ping: this.net.rtt,
      body: this.bodyId,
    });
    this.input.endFrame();
  }
}

let game: Game | null = null;

export async function startGame() {
  if (game) return;
  game = new Game();
  (window as unknown as { __game: Game }).__game = game;
  const want = (flags.get("body") ?? benchConfig()?.body ?? null) as BodyId | null;
  const start = want && want in BODIES ? want : "portus";
  await game.start(start);
}

export { THREE };
