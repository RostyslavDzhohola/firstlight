// Game orchestration: renderer, current body, local player, network, remote avatars, main loop.

import * as THREE from "three/webgpu";
import type { BodyId } from "@firstlight/shared";
import { flags } from "../config.ts";
import { Net } from "../net/Net.ts";
import { AvatarView } from "../render/Avatars.ts";
import { createRenderer, type RenderCtx } from "../render/renderer.ts";
import { PerfOverlay } from "../render/PerfOverlay.ts";
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

export class Game {
  ctx!: RenderCtx;
  planet!: Planet;
  player!: PlayerController;
  input!: Input;
  readonly net = new Net();
  readonly avatars = new Map<string, AvatarView>();
  self!: AvatarView;
  perf!: PerfOverlay;
  bodyId: BodyId = "portus";
  private last = performance.now();
  private running = false;

  async start(body: BodyId) {
    setLoading("Starting the renderer…", 0.05);
    const container = document.getElementById("game")!;
    this.ctx = await createRenderer(container);
    this.input = new Input(this.ctx.renderer.domElement);
    this.perf = new PerfOverlay(this.ctx);
    document.getElementById("landing")!.style.display = "none";
    await this.enterBody(body);
    this.running = true;
    this.input.lock();
    this.ctx.renderer.setAnimationLoop(() => this.frame());
  }

  async enterBody(body: BodyId) {
    setLoading(`Travelling to ${body[0]!.toUpperCase()}${body.slice(1)}…`, 0.15);
    await this.net.leave();
    for (const a of this.avatars.values()) a.dispose();
    this.avatars.clear();
    this.planet?.dispose();
    this.bodyId = body;
    this.planet = new Planet(this.ctx.scene, body);
    this.player ??= new PlayerController(this.planet.terrain, this.planet.body.waterLevel);
    this.player.setTerrain(this.planet.terrain, this.planet.body.waterLevel);

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

    // Stream terrain around the spawn before handing control over.
    const t0 = performance.now();
    for (;;) {
      const p = this.player.pos;
      const pending = this.planet.update(p.x, p.y, p.z, this.ctx.camera, performance.now());
      setLoading("Building the world…", 0.4 + 0.5 * Math.max(0, 1 - pending / 40));
      if (pending === 0 || performance.now() - t0 > 15000) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    this.self ??= new AvatarView(0, 0);
    this.ctx.scene.add(this.self.root);
    this.player.placeCamera(this.ctx.camera);
    // Warm up shaders with real frames behind the loading screen (SPEC §4.1).
    setLoading("Warming up shaders…", 0.95);
    for (let i = 0; i < 4; i++) {
      this.ctx.render();
      await new Promise((r) => requestAnimationFrame(r));
    }
    hideLoading();
  }

  private frame() {
    const now = performance.now();
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    if (!this.running) return;

    this.player.update(dt, this.input, this.input.rmb);
    const p = this.player.pos;
    const f = this.player.facing;
    this.net.sendInput(now, { x: p.x, y: p.y, z: p.z, fx: f.x, fy: f.y, fz: f.z, anim: this.player.anim });
    this.self.set(p.x, p.y, p.z, f.x, f.y, f.z, this.player.anim, dt);

    // Remote players.
    for (const [id, view] of this.net.remotes) {
      const s = this.net.sample(view, now);
      if (!s) continue;
      let a = this.avatars.get(id);
      if (!a) {
        const st = (this.net.room?.state as any)?.players?.get(id);
        a = new AvatarView(st?.palette ?? (id.charCodeAt(0) % 6), st?.starter ?? 0);
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

    this.planet.update(p.x, p.y, p.z, this.ctx.camera, now);
    this.player.placeCamera(this.ctx.camera);
    if (this.input.pressed.has("F3")) this.perf.toggle();
    this.ctx.render();
    this.perf.frame(now, dt);
    this.input.endFrame();
  }
}

let game: Game | null = null;

export async function startGame() {
  if (game) return;
  game = new Game();
  (window as unknown as { __game: Game }).__game = game;
  const start = (flags.get("body") as BodyId | null) ?? "portus";
  await game.start(start);
}

export { THREE };
