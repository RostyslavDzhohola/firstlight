import { cosmeticWarmupHook } from "../render/Cosmetics.ts";
// Game orchestration: renderer, current body, local player, network, remote avatars, combat,
// portals, piles, HUD and the main loop.

import * as THREE from "three/webgpu";
import { BODIES, padDirs, type BodyId } from "@firstlight/shared";
import { flags } from "../config.ts";
import { Net, TravelRedirect, type Snapshot } from "../net/Net.ts";
import { AvatarView, avatarWarmupHook, preloadAvatars } from "../render/Avatars.ts";
import { HorseView, horseWarmupHook, preloadHorse } from "../render/Horses.ts";
import "../render/avatars/system.ts";
import { Bench, benchConfig } from "../render/bench.ts";
import { BlobShadows } from "../render/blobShadows.ts";
import { ParticleSystem, type BurstOptions } from "../render/particles.ts";
import { PerfOverlay, type PerfExtras } from "../render/PerfOverlay.ts";
import { Environment } from "../render/environment.ts";
import { MENU_GRADE } from "../render/post.ts";
import { runProbe } from "../render/probe.ts";
import { createRenderer, type RenderCtx } from "../render/renderer.ts";
import { installShaderMonitor, shaderMonitorFrame, warmup } from "../render/warmup.ts";
import type { Hud } from "../ui/hud.ts";
import { Menu } from "../ui/menu.ts";
import { bindUi } from "../ui/bind.ts";
import { pickDisplayName } from "../ui/account.ts";
import { hideLoading, setLoading, setLoadingBadge } from "../ui/loading.ts";
import { getAccountInfo, invalidatePlayToken, isDevGuest } from "../net/auth.ts";
import { PilesView } from "../world/PilesView.ts";
import { Planet } from "../world/Planet.ts";
import { Portals } from "../world/Portals.ts";
import { ArrivalWatch, closeAction, ConnectionLost, StorageBackoff, waitFor } from "./arrival.ts";
import { BootGate, RendererUnavailable, shouldKeepReconnecting } from "./boot.ts";
import { CombatClient } from "./CombatClient.ts";
import { GameAudio } from "../audio/Audio.ts";
import { Input } from "./input.ts";
import { PhotoMode } from "./PhotoMode.ts";
import { PlayerController } from "./PlayerController.ts";
import { CLIENT_SYSTEMS, type ClientSystem } from "./systems.ts";
import { installSocial, partyRoomOn, removedFromWorld } from "../social/index.ts";


/** ?bench runs without a server unless ?online is also given; ?offline forces it anywhere. */
const OFFLINE = flags.has("offline") || (flags.has("bench") && !flags.has("online"));
const FX_DEMO = flags.has("fxdemo");
const CPU_SLOW = Math.max(1, Math.min(8, Number(flags.get("cpuslow")) || 1));

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
  /** Day/night cycle and weather (render side). */
  env!: Environment;
  blobs!: BlobShadows;
  bench: Bench | null = null;
  photo!: PhotoMode;
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
  /** Rejoins after "saving failed" closes: bounded, and not reset by a successful join. */
  private readonly storageBackoff = new StorageBackoff();
  /** Logged out, removed or "connection lost" screen: room closes are not ours to act on. */
  private stopped = false;
  /** A graphics re-warm is running (the loop is paused); a room close waits for it to finish. */
  private rewarming = false;
  private pendingClose: number | null = null;
  /** Renderer + UI exist: a retried first boot (S6) only enters the world again. */
  private uiReady = false;
  private firstChoice: { starter: number; palette: number } | undefined;
  private probed = false;
  private nextFxDemo = 0;
  /** Per-frame scratch (the loop allocates nothing in steady state). */
  private readonly inputMsg = { x: 0, y: 0, z: 0, fx: 0, fy: 0, fz: 0, anim: 0 };
  private readonly remoteSnap: Snapshot = { t: 0, x: 0, y: 0, z: 0, fx: 0, fy: 0, fz: 0, anim: 0 };
  private readonly perfExtras: PerfExtras = {};

  async start(body: BodyId) {
    if (this.uiReady) return this.retryArrival(body); // the first attempt failed after the UI was up
    setLoading("Starting the renderer…", 0.05);
    const container = document.getElementById("game")!;
    try {
      this.ctx = await createRenderer(container);
    } catch (e) {
      throw new RendererUnavailable(e); // nothing was attached yet: a retry starts clean
    }
    installShaderMonitor(this.ctx);
    void preloadAvatars(); // character GLBs stream in while we connect and build the world
    void preloadHorse(); // 147 KB: horses are in the warm-up, so they never compile mid-game
    console.info(`[gfx] backend ${this.ctx.webgpu ? "WebGPU" : "WebGL2"}, tier ${this.ctx.tier}${this.ctx.settings.auto ? " (auto)" : ""}, gpu "${this.ctx.gpuName}"`);
    setLoadingBadge(`${this.ctx.webgpu ? "WebGPU" : "WebGL2"} · ${this.ctx.tier}${this.ctx.settings.auto ? " (auto)" : ""}`);
    this.input = new Input(this.ctx.renderer.domElement);
    this.photo = new PhotoMode({
      ctx: this.ctx,
      input: this.input,
      planetGrade: () => this.env.currentGrade(),
      env: () => this.env,
      terrain: () => this.planet.terrain,
      anchor: () => this.player.pos,
    });
    this.audio = new GameAudio();
    this.audio.resume();
    this.ctx.renderer.domElement.addEventListener("mousedown", () => this.audio.resume());
    window.addEventListener("keydown", () => this.audio.resume(), { once: true });
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
    // A ladder floor drop changes the tier mid-game: apply it behind the loading screen + warm-up.
    this.ctx.onTierDrop((_from, _to, apply) => void this.applyGraphics(apply));
    // Look rule 1: muted grade while the mouse is released (menus), the body's grade in play.
    document.addEventListener("pointerlockchange", () => {
      if (this.running && !this.photo.active) this.setMenuMode(!document.pointerLockElement);
    });
    this.particles = new ParticleSystem(this.ctx.scene);
    this.env = new Environment(this.ctx, this.audio, this.particles);
    this.blobs = new BlobShadows(this.ctx.scene);
    const applyFx = () => {
      this.particles.applySettings(this.ctx.settings);
      this.blobs.applySettings(this.ctx.settings);
      this.applyCharsVisibility();
    };
    applyFx();
    this.ctx.onChange(applyFx);
    this.combat = new CombatClient(this);
    this.hud = this.combat.hud;
    this.menu = new Menu(this);
    installSocial(this);
    bindUi(this);
    document.getElementById("landing")!.style.display = "none";
    this.uiReady = true;
    const automated = flags.has("autoplay") || OFFLINE;
    // First visit: choose a starter (and the display name, once per account) before entering the world.
    // Dev guests and automated runs skip the name.
    const info = !isDevGuest() && !automated ? await getAccountInfo().catch(() => null) : null;
    const needsName = !!info && !info.displayName;
    // A saved account signing in on a new browser already has a character: no starter pick.
    if (info?.character && !localStorage.getItem("fl.starter")) {
      localStorage.setItem("fl.starter", String(info.character.starter));
      localStorage.setItem("fl.palette", String(info.character.palette));
    }
    if (!localStorage.getItem("fl.starter") && !automated) {
      hideLoading();
      this.firstChoice = await this.hud.characterPick({ askName: needsName ? { suggested: info!.name } : undefined });
    } else if (needsName) await pickDisplayName({ suggested: info!.name, dismissible: true });
    await this.firstArrival(body);
  }

  /** Retry after a failed first arrival (S6): the renderer and UI are up, enter the world again. */
  private async retryArrival(body: BodyId) {
    document.getElementById("landing")!.style.display = "none"; // Retry may come from the start page
    await this.firstArrival(body);
  }

  private async firstArrival(body: BodyId) {
    try {
      await this.enterBody(body, this.firstChoice);
    } catch (e) {
      // Kicked, banned or playing elsewhere while arriving: stop here; the boot (main.ts runBoot)
      // puts the removal screen up.
      if (e instanceof ConnectionLost && e.action === "removed") this.stop();
      throw e;
    }
    this.handOver();
  }

  /** First arrival done: start the loop and give the player control. */
  private handOver() {
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
    if (this.env) this.env.menu = on;
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

  async travel(body: BodyId) {
    if (this.travelling) return;
    this.travelling = true;
    this.audio.play("portal");
    let failure: unknown = null;
    try {
      await this.enterBody(body);
    } catch (e) {
      console.warn("[travel] arrival failed", e);
      failure = e ?? new Error("travel failed");
    } finally {
      this.travelling = false;
      this.portalCooldownUntil = performance.now() + 3000;
    }
    if (failure) this.arrivalFailed(failure);
  }

  /** Stop acting on the world (logged out, removed, connection given up): menus own the screen. */
  private stop() {
    this.running = false;
    this.stopped = true;
    document.exitPointerLock?.();
  }

  /**
   * An arrival (travel, resume, reconnect) didn't make it (S5): removed → say so and stop; refused at
   * /api/play → its screen is up; otherwise the reconnect path (never a stuck loading screen).
   */
  private arrivalFailed(e: unknown) {
    if (e instanceof ConnectionLost && e.action === "removed") {
      hideLoading();
      removedFromWorld(e.code!);
      this.stop();
      return;
    }
    if (!shouldKeepReconnecting(e)) {
      hideLoading();
      this.stop();
      return;
    }
    if (e instanceof ConnectionLost && e.action === "rejoin-fresh") invalidatePlayToken();
    void this.reconnect();
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
          if ((e instanceof ConnectionLost && e.action === "removed") || !shouldKeepReconnecting(e)) {
            hideLoading();
            if (e instanceof ConnectionLost && e.code !== null) removedFromWorld(e.code);
            this.stop();
            return;
          }
          if (e instanceof ConnectionLost && e.action === "rejoin-fresh") invalidatePlayToken();
          delay = Math.min(30_000, delay * 2);
        }
      }
      hideLoading();
      this.stop();
      this.menu.showNotice("CONNECTION LOST", "Couldn't reach the server. Your character is safe.", "Try again", () => void this.resume());
    } finally {
      this.reconnecting = false;
      this.travelling = false;
    }
  }

  /**
   * Our room closed while playing (SPEC §5; server world/hub.ts). Net only reports rooms we didn't
   * leave; during an arrival the ArrivalWatch handles them instead.
   */
  private onRoomClosed(code: number) {
    if (this.travelling || this.stopped) return;
    if (this.rewarming) {
      this.pendingClose = code; // acted on when the re-warm finishes (never warm into no connection)
      return;
    }
    const action = closeAction(code);
    if (action === "ignore") return; // logged out: that screen is up
    // Kicked, banned or playing elsewhere: the social screens say so; never auto-rejoin.
    if (action === "removed") {
      removedFromWorld(code);
      this.stop();
      return;
    }
    if (action === "storage") {
      // The server couldn't save us (and keeps us out until it can): rejoin later, a few times at most.
      const wait = this.storageBackoff.next(Date.now());
      if (wait === null) {
        this.stop();
        this.menu.showNotice("SAVING TROUBLE", "The server can't save characters right now. Your last save is safe; try again in a few minutes.", "Try again", () => void this.resume());
        return;
      }
      setLoading("The server couldn't save just now. Rejoining shortly…", 0.1);
      setTimeout(() => void this.reconnect(), wait);
      return;
    }
    if (action === "rejoin-fresh") invalidatePlayToken(); // saved/signed in: rejoin as the account
    void this.reconnect();
  }

  /** A re-warm paused the loop; act on a room close that arrived meanwhile. */
  private endRewarm() {
    this.rewarming = false;
    const code = this.pendingClose;
    this.pendingClose = null;
    if (code !== null) this.onRoomClosed(code);
  }

  async loggedOut() {
    this.stop();
    await this.net.leave();
    this.menu.showLoggedOut();
  }

  async resume() {
    this.menu.hideAll();
    this.stopped = false;
    this.travelling = true;
    try {
      await this.enterBody(this.bodyId);
    } catch (e) {
      console.warn("resume failed", e);
      this.travelling = false;
      this.running = true;
      return void this.arrivalFailed(e);
    }
    this.travelling = false;
    this.running = true;
    this.last = performance.now();
    this.input.lock();
  }

  async enterBody(body: BodyId, choice?: { starter: number; palette: number }): Promise<void> {
    setLoading(`Travelling to ${body[0]!.toUpperCase()}${body.slice(1)}…`, 0.15);
    await this.net.leave();
    for (const s of this.systems) s.dispose();
    this.systems = [];
    for (const a of this.avatars.values()) a.dispose();
    this.avatars.clear();
    this.portals?.dispose();
    this.piles?.dispose();
    this.planet?.dispose();
    this.bodyId = body;
    this.planet = new Planet(this.ctx, body);
    this.env.setBody(body, 0, this.planet.look, this.planet.rig);
    this.particles.setMoteColor(this.planet.look.mote);
    this.player ??= new PlayerController(this.planet.terrain, this.planet.body.waterLevel);
    this.player.setTerrain(this.planet.terrain, this.planet.body.waterLevel);
    // The body's structures (Portus' town, a planet's outpost and waystones) block like the server's.
    this.player.setStructures(this.planet.town?.moveColliders ?? null);
    this.portals = new Portals(this.ctx.scene, body, this.planet.terrain);
    this.audio.setMusic(body);
    this.piles = new PilesView(this.ctx.scene);

    const stored = { starter: Number(localStorage.getItem("fl.starter") ?? 0), palette: Number(localStorage.getItem("fl.palette") ?? 0) };
    // S5: from the join until control is handed over, a close of the new room aborts the arrival
    // (ConnectionLost at the next check) instead of hanging or warming into no connection.
    let watch: ArrivalWatch | null = null;
    const alive = (stage: string) => watch?.check(stage);
    if (OFFLINE) {
      const p = this.spawnPoint();
      this.player.teleport(p.x, p.y, p.z);
      // Systems that work without a room (e.g. breakable props) still exist offline and in ?bench.
      this.systems = CLIENT_SYSTEMS.filter((f) => f.offline).map((f) => f(this)).filter((x): x is ClientSystem => !!x);
    } else {
      setLoading("Connecting…", 0.3);
      let room;
      try {
        // Party members land in the copy a member is already in (D12 headroom).
        room = await this.net.join(body, { ...(choice ?? stored), partyLeaderRoomId: partyRoomOn(body) });
      } catch (e) {
        // No travel ticket for this body: the character is elsewhere (e.g. logged out on a planet).
        if (e instanceof TravelRedirect && e.body !== body) return this.enterBody(e.body, choice);
        throw e;
      }
      const w = (watch = new ArrivalWatch());
      this.net.onLeaveRoom = w.onClose; // until the hand-over below
      localStorage.setItem("fl.body", body);
      this.combat.attach();
      const me = await waitFor(() => (room.state as any).players?.get(room.sessionId), { stage: "waiting for our player", timeoutMs: 15_000, watch: w });
      this.player.teleport(me.x, me.y, me.z);
      this.net.onCorrect = (x, y, z) => this.player.correct(x, y, z);
      this.systems = CLIENT_SYSTEMS.map((f) => f(this)).filter((x): x is ClientSystem => !!x);
    }

    // Stream terrain around the spawn before handing control over.
    const t0 = performance.now();
    for (;;) {
      const p = this.player.pos;
      const pending = this.planet.update(p.x, p.y, p.z, this.ctx.camera, performance.now());
      setLoading("Building the world…", 0.4 + 0.4 * Math.max(0, 1 - pending / 40));
      if (pending === 0 || performance.now() - t0 > 15000) break;
      await new Promise((r) => setTimeout(r, 50));
      alive("building the world");
    }
    setLoading("Loading characters…", 0.8);
    await Promise.all([preloadAvatars(), preloadHorse(), this.planet.props.ready]); // resolve null on failure: capsules / box horses
    alive("loading characters");
    if (this.planet.town) {
      // The castle town (Portus) or the pad outpost (a planet) is in the scene before the probe and
      // the warm-up (falls back to plain colliders). Bounded: the download aborts after 15 s and the
      // site shows its stone fallback by 18 s, so the probe and the warm-up always see what will be
      // drawn (no late meshes, no live builds). With the outpost's models the plain pad discs go.
      setLoading(this.planet.body.terrain.kind === "hub" ? "Raising the town…" : "Raising the outpost…", 0.81);
      await this.planet.town.ready;
      alive("raising the town");
      this.portals?.setPadModels(this.planet.town.drawsModels);
    }
    if (!this.self) {
      this.self = new AvatarView(choice?.palette ?? stored.palette, choice?.starter ?? stored.starter);
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
      alive("tuning graphics");
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
      this.env.setBenchMode(this.bodyId, this.planet.look);
      this.bench.update(0, performance.now(), this.ctx.camera);
    }
    setLoading("Warming up shaders…", 0.92);
    await warmup(this.ctx, { frames: 4, hooks: [this.warmupHook()], beforeFrame: updateWorld });
    alive("warming up shaders");
    // Hand-over: from here a close is a mid-game disconnect (no await until the caller resumes play).
    if (watch) this.net.onLeaveRoom = (code) => this.onRoomClosed(code);
    hideLoading();
  }

  private warmupHook() {
    // every palette's skinned toon variant, weapons and LOD proxies compile behind the loading screen
    const cosmetics = cosmeticWarmupHook(this.ctx.scene, () => this.player.pos);
    const avatars = avatarWarmupHook(this.ctx.scene, () => this.player.pos);
    const horses = horseWarmupHook(this.ctx.scene, () => this.player.pos); // the six coat materials
    return {
      forceAll: (on: boolean) => {
        this.planet.props.setForceAll(on);
        this.planet.town?.setForceAll(on);
        avatars.forceAll(on);
        cosmetics.forceAll(on);
        horses.forceAll(on);
      },
    };
  }

  /** Apply a graphics change, then re-run the warm-up behind the loading screen. */
  async applyGraphics(change: () => void) {
    change();
    if (!this.running || this.travelling) return;
    this.running = false;
    this.rewarming = true;
    setLoading("Applying graphics settings…", 0.5);
    try {
      await warmup(this.ctx, { frames: 3, hooks: [this.warmupHook()], beforeFrame: () => this.updateWorldForWarmup() });
    } finally {
      hideLoading();
      this.running = true;
      this.last = performance.now();
      this.endRewarm();
    }
  }

  private updateWorldForWarmup() {
    const f = this.bench ? this.bench.focus : this.player.pos;
    this.env.update(1 / 60);
    this.planet.update(f.x, f.y, f.z, this.ctx.camera, performance.now());
    this.env.afterCamera(this.ctx.camera, 1 / 60);
    this.particles.update(1 / 60, this.ctx.camera.position, performance.now());
  }

  private async reprobe() {
    // Only from live play (F3 panel): leave menus, logged-out and notice screens alone.
    if (!this.running || this.travelling) return;
    this.running = false;
    this.rewarming = true;
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
      this.endRewarm();
    }
  }

  private applyCharsVisibility() {
    const on = this.ctx.settings.on.chars;
    if (this.self) this.self.root.visible = on && !this.bench;
    for (const a of this.avatars.values()) a.root.visible = on;
    for (const a of this.bench?.crowdViews() ?? []) a.root.visible = on;
  }

  private frame() {
    const now = performance.now();
    const rawMs = now - this.last;
    const dt = Math.min(0.05, rawMs / 1000);
    this.last = now;
    if (!this.running || this.travelling) return this.env.silence();
    const cpu0 = performance.now();

    let focus: THREE.Vector3;
    if (this.bench) {
      this.bench.update(dt, now, this.ctx.camera);
      focus = this.bench.focus;
    } else {
      // Photo mode (F9): the body stays put (and can still be hurt) while the camera flies.
      if (this.input.pressed.has("F9")) this.photo.toggle(this.ctx.camera);
      if (!this.photo.active) this.player.update(dt, this.input, this.combat.aiming());
      const p = this.player.pos;
      const f = this.player.facing;
      const m = this.inputMsg;
      m.x = p.x; m.y = p.y; m.z = p.z;
      m.fx = f.x; m.fy = f.y; m.fz = f.z;
      m.anim = this.player.anim;
      this.net.sendInput(now, m);
      this.self.set(p.x, p.y, p.z, f.x, f.y, f.z, this.player.anim, dt);
      focus = this.photo.active ? this.photo.pos : p;
    }

    // Remote players.
    const state = this.net.room?.state as any;
    for (const [id, view] of this.net.remotes) {
      const s = this.net.sample(view, now, undefined, this.remoteSnap);
      if (!s) continue;
      let a = this.avatars.get(id);
      if (!a) {
        const st = state?.players?.get(id);
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

    this.env.update(dt);
    this.planet.update(focus.x, focus.y, focus.z, this.ctx.camera, now, dt);
    this.portals?.update(dt, focus, this.planet.loadRadius * 0.9);
    this.piles?.update(state, dt);
    this.combat.update(dt, now);
    for (const s of this.systems) s.update(dt, now);
    if (!this.bench && now > this.portalCooldownUntil) {
      const to = this.photo.active ? null : this.portals?.check(this.player.pos);
      if (to && to !== this.bodyId) {
        // The server must authorise portal travel (it records a travel ticket for /api/play).
        this.portalCooldownUntil = now + 1500;
        if (OFFLINE) void this.travel(to);
        else
          void this.net.requestTravel(to).then((ok) => {
            if (ok) void this.travel(to);
          });
      }
    }
    if (this.photo.active) this.photo.update(dt, this.ctx.camera);
    else if (!this.bench) this.player.placeCamera(this.ctx.camera);
    this.audio.updateListener(this.ctx.camera);
    if (FX_DEMO && now >= this.nextFxDemo) this.fxDemo(now, focus);
    this.env.afterCamera(this.ctx.camera, dt);
    this.particles.update(dt, this.ctx.camera.position, now);
    if (this.ctx.settings.on.chars) {
      this.blobs.begin();
      if (!this.bench && this.self) this.addBlob(this.player.pos);
      for (const a of this.avatars.values()) this.addBlob(a.root.position);
      for (const h of HorseView.all) if (h.root.parent && h.root.visible) this.addBlob(h.root.position, 1.0);
      if (this.bench) for (const b of this.bench.crowdBlobs()) this.blobs.add(b.x, b.y, b.z, b.r);
      this.blobs.end();
    }
    if (this.input.pressed.has("F3")) this.perf.toggle();
    this.ctx.render();
    let cpuMs = performance.now() - cpu0;
    if (CPU_SLOW > 1) {
      // ?cpuslow=N (F11 weak-laptop profile): emulate an N× slower CPU on the main thread by
      // busy-waiting (N−1)× this frame's CPU time, like DevTools CPU throttling.
      const until = performance.now() + cpuMs * (CPU_SLOW - 1);
      while (performance.now() < until) { /* spin */ }
      cpuMs *= CPU_SLOW;
    }
    this.ctx.afterFrame(now, rawMs);
    this.bench?.record(rawMs);
    shaderMonitorFrame();
    const x = this.perfExtras;
    x.cpuMs = cpuMs;
    if (this.perf.shown) {
      const st = this.planet.stats();
      x.chunks = st.chunks;
      x.visibleChunks = st.visibleChunks;
      x.water = st.water;
      x.grass = st.grassBlades;
      x.props = st.props;
      x.particles = this.particles.liveCount;
      x.entities = this.avatars.size + 1 + (this.bench?.crowdViews().length ?? 0);
      x.ping = this.net.rtt;
      x.body = this.env.describe();
    }
    this.perf.frame(now, rawMs / 1000, x);
    this.input.endFrame();
  }

  /** Contact shadow under a character (or horse, r = 1) standing within 6 m of the ground. */
  private addBlob(pos: THREE.Vector3, r = 0.55) {
    const l = pos.length();
    const g = this.planet.terrain.groundHeight(pos.x / l, pos.y / l, pos.z / l) + this.planet.body.radius;
    const lift = l - g;
    if (lift > 6) return;
    const k = g / l;
    this.blobs.add(pos.x * k, pos.y * k, pos.z * k, r * (1 - lift / 8));
  }
}

let game: Game | null = null;
let boot: BootGate | null = null;

/**
 * Play (and Retry after a failed boot, S6). The Game is created once; its start() is retryable
 * (a failed renderer start attaches nothing, a failed arrival is entered again), and the gate runs
 * it until it succeeds once, sharing an attempt between double clicks.
 */
export async function startGame() {
  if (!game) {
    game = new Game();
    (window as unknown as { __game: Game }).__game = game;
  }
  const g = game;
  boot ??= new BootGate(() => {
    // Start where the character was last seen (the server redirects if that's stale).
    const wanted = flags.get("body") ?? benchConfig()?.body ?? localStorage.getItem("fl.body") ?? "portus";
    return g.start(wanted in BODIES ? (wanted as BodyId) : "portus");
  });
  await boot.start();
}

export { THREE };
