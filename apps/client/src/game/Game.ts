// Game orchestration: renderer, current body, local player, network, remote avatars, combat,
// portals, piles, HUD and the main loop.

import * as THREE from "three/webgpu";
import { BODIES, type BodyId } from "@firstlight/shared";
import { flags } from "../config.ts";
import { CLOSE, Net, TravelRedirect } from "../net/Net.ts";
import { AvatarView, preloadAvatars } from "../render/Avatars.ts";
import "../render/avatars/system.ts";
import { createRenderer, type RenderCtx } from "../render/renderer.ts";
import { PerfOverlay } from "../render/PerfOverlay.ts";
import type { Hud } from "../ui/hud.ts";
import { Menu } from "../ui/menu.ts";
import { pickDisplayName } from "../ui/account.ts";
import { getAccountInfo, invalidatePlayToken, isDevGuest } from "../net/auth.ts";
import { PilesView } from "../world/PilesView.ts";
import { Planet } from "../world/Planet.ts";
import { Portals } from "../world/Portals.ts";
import { CombatClient } from "./CombatClient.ts";
import { GameAudio } from "../audio/Audio.ts";
import { Input } from "./input.ts";
import { PlayerController } from "./PlayerController.ts";
import { CLIENT_SYSTEMS, type ClientSystem } from "./systems.ts";
import { installSocial, partyRoomOn, removedFromWorld } from "../social/index.ts";

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
  combat!: CombatClient;
  audio!: GameAudio;
  hud!: Hud;
  menu!: Menu;
  portals: Portals | null = null;
  piles: PilesView | null = null;
  bodyId: BodyId = "portus";
  systems: ClientSystem[] = [];
  private last = performance.now();
  private running = false;
  private travelling = false;
  private portalCooldownUntil = 0;
  private reconnecting = false;

  async start(body: BodyId) {
    setLoading("Starting the renderer…", 0.05);
    const container = document.getElementById("game")!;
    this.ctx = await createRenderer(container);
    void preloadAvatars(); // character GLBs stream in while we connect and build the world
    this.input = new Input(this.ctx.renderer.domElement);
    this.audio = new GameAudio();
    this.audio.resume();
    this.ctx.renderer.domElement.addEventListener("mousedown", () => this.audio.resume());
    window.addEventListener("keydown", () => this.audio.resume(), { once: true });
    this.perf = new PerfOverlay(this.ctx);
    this.combat = new CombatClient(this);
    this.hud = this.combat.hud;
    this.menu = new Menu(this);
    installSocial(this);
    document.getElementById("landing")!.style.display = "none";
    // First visit: choose a starter before entering the world.
    let firstChoice: { starter: number; palette: number } | undefined;
    if (!localStorage.getItem("fl.starter") && !flags.has("autoplay")) {
      hideLoading();
      firstChoice = await this.hud.characterPick();
    }
    // Pick a display name once per account (skipped for dev guests and automated runs).
    if (!isDevGuest() && !flags.has("autoplay")) {
      const info = await getAccountInfo().catch(() => null);
      if (info && !info.displayName) await pickDisplayName({ suggested: info.name, dismissible: true });
    }
    await this.enterBody(body, firstChoice);
    this.running = true;
    this.input.lock();
    this.ctx.renderer.setAnimationLoop(() => this.frame());
  }

  async travel(body: BodyId) {
    if (this.travelling) return;
    this.travelling = true;
    this.audio.play("portal");
    try {
      await this.enterBody(body);
    } finally {
      this.travelling = false;
      this.portalCooldownUntil = performance.now() + 3000;
    }
  }

  /** Rejoin after an unexpected disconnect: backoff 1.5 s → 30 s, then a "lost connection" screen. */
  private async reconnect() {
    if (this.reconnecting) return;
    this.reconnecting = true;
    this.travelling = true;
    let delay = 1500;
    try {
      for (let attempt = 0; attempt < 7; attempt++) {
        setLoading(attempt ? `Reconnecting… (try ${attempt + 1})` : "Reconnecting…", 0.1);
        await new Promise((r) => setTimeout(r, delay));
        try {
          await this.enterBody(this.bodyId);
          return;
        } catch (e) {
          console.warn("rejoin failed", e);
          delay = Math.min(30_000, delay * 2);
        }
      }
      hideLoading();
      this.running = false;
      document.exitPointerLock?.();
      this.menu.showNotice("CONNECTION LOST", "Couldn't reach the server. Your character is safe.", "Try again", () => void this.resume());
    } finally {
      this.reconnecting = false;
      this.travelling = false;
    }
  }

  /** Server closed our room: decide by close code (SPEC §5; server world/hub.ts). */
  private onRoomClosed(code: number) {
    if (this.travelling || !this.running) return;
    if (code === 1000 || code === 4000 || code === CLOSE.LOGGED_OUT) return; // we left, or logged out
    // Kicked, banned or playing elsewhere: the social screens say so; never auto-rejoin.
    if (removedFromWorld(code)) {
      this.running = false;
      document.exitPointerLock?.();
      return;
    }
    if (code === CLOSE.MERGED) invalidatePlayToken(); // saved/signed in: rejoin as the account
    void this.reconnect();
  }

  async loggedOut() {
    this.running = false;
    await this.net.leave();
    document.exitPointerLock?.();
    this.menu.showLoggedOut();
  }

  async resume() {
    this.menu.hideAll();
    this.running = true;
    try {
      await this.enterBody(this.bodyId);
    } catch (e) {
      console.warn("resume failed", e);
      return void this.reconnect();
    }
    this.input.lock();
  }

  async enterBody(body: BodyId, choice?: { starter: number; palette: number }): Promise<void> {
    const name = `${body[0]!.toUpperCase()}${body.slice(1)}`;
    setLoading(`Travelling to ${name}…`, 0.15);
    await this.net.leave();
    for (const s of this.systems) s.dispose();
    this.systems = [];
    for (const a of this.avatars.values()) a.dispose();
    this.avatars.clear();
    this.portals?.dispose();
    this.piles?.dispose();
    this.planet?.dispose();
    this.bodyId = body;
    this.planet = new Planet(this.ctx.scene, body);
    this.player ??= new PlayerController(this.planet.terrain, this.planet.body.waterLevel);
    this.player.setTerrain(this.planet.terrain, this.planet.body.waterLevel);
    this.portals = new Portals(this.ctx.scene, body, this.planet.terrain);
    this.audio.setMusic(body);
    this.piles = new PilesView(this.ctx.scene);

    setLoading("Connecting…", 0.3);
    const stored = { starter: Number(localStorage.getItem("fl.starter") ?? 0), palette: Number(localStorage.getItem("fl.palette") ?? 0) };
    let room;
    try {
      // Party members land in the copy a member is already in (D12 headroom).
      room = await this.net.join(body, { ...(choice ?? stored), partyLeaderRoomId: partyRoomOn(body) });
    } catch (e) {
      // No travel ticket for this body: the character is elsewhere (e.g. logged out on a planet).
      if (e instanceof TravelRedirect && e.body !== body) return this.enterBody(e.body, choice);
      throw e;
    }
    localStorage.setItem("fl.body", body);
    this.combat.attach();
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
    this.net.onLeaveRoom = (code) => this.onRoomClosed(code);
    this.systems = CLIENT_SYSTEMS.map((f) => f(this)).filter((x): x is ClientSystem => !!x);

    const t0 = performance.now();
    for (;;) {
      const p = this.player.pos;
      const pending = this.planet.update(p.x, p.y, p.z, this.ctx.camera, performance.now());
      setLoading("Building the world…", 0.4 + 0.5 * Math.max(0, 1 - pending / 40));
      if (pending === 0 || performance.now() - t0 > 15000) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    setLoading("Loading characters…", 0.92);
    await preloadAvatars(); // resolves null on failure: avatars fall back to capsules
    this.self ??= new AvatarView(choice?.palette ?? stored.palette, choice?.starter ?? stored.starter);
    this.ctx.scene.add(this.self.root);
    this.player.placeCamera(this.ctx.camera);
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
    if (!this.running || this.travelling) {
      this.ctx.render();
      return;
    }

    this.player.update(dt, this.input, this.combat.aiming());
    const p = this.player.pos;
    const f = this.player.facing;
    this.net.sendInput(now, { x: p.x, y: p.y, z: p.z, fx: f.x, fy: f.y, fz: f.z, anim: this.player.anim });
    this.self.set(p.x, p.y, p.z, f.x, f.y, f.z, this.player.anim, dt);

    const state = this.net.room?.state as any;
    for (const [id, view] of this.net.remotes) {
      const s = this.net.sample(view, now);
      if (!s) continue;
      let a = this.avatars.get(id);
      if (!a) {
        const st = state?.players?.get(id);
        a = new AvatarView(st?.palette ?? 0, st?.starter ?? 0);
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
    this.portals?.update(dt, p, this.planet.loadRadius * 0.9);
    this.piles?.update(state, dt);
    this.combat.update(dt, now);
    for (const s of this.systems) s.update(dt, now);
    if (now > this.portalCooldownUntil) {
      const to = this.portals?.check(p);
      if (to && to !== this.bodyId) {
        // The server must authorise portal travel (it records a travel ticket for /api/play).
        this.portalCooldownUntil = now + 1500;
        void this.net.requestTravel(to).then((ok) => {
          if (ok) void this.travel(to);
        });
      }
    }
    this.player.placeCamera(this.ctx.camera);
    this.audio.updateListener(this.ctx.camera);
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
  // Start where the character was last seen (the server redirects if that's stale).
  const wanted = flags.get("body") ?? localStorage.getItem("fl.body") ?? "portus";
  const start: BodyId = wanted in BODIES ? (wanted as BodyId) : "portus";
  await game.start(start);
}

export { THREE };
