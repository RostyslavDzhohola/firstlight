// Client side of combat: weapon input, local predicted visuals, server events → effects and HUD,
// inventory keys, pickups, death and rebirth.

import * as THREE from "three/webgpu";
import { isBlocked, partyState } from "../social/store.ts";
import { WEAPONS, WEAPON_BY_ID, type WeaponDef } from "@firstlight/shared/content/weapons";
import { PHRASES } from "@firstlight/shared/net/protocol";
import { PF } from "@firstlight/shared/net/schema";
import { Effects, weaponColor } from "../render/effects.ts";
import { Hud, type YouPlus } from "../ui/hud.ts";
import { PhraseWheel } from "../ui/phraseWheel.ts";
import type { Game } from "./Game.ts";
import { showSavePrompt } from "../ui/account.ts";
import { getPlayToken, isDevGuest, readClaims } from "../net/auth.ts";

const _v = new THREE.Vector3();

/** Why the server refused a `use` (Patchkit, Prism Bubble), as player-facing text. */
const USE_DENIED: Record<string, string> = {
  cooldown: "Not ready yet",
  busy: "Already patching",
  "out of reach": "Too far — get within 4 m",
  "no target": "Nobody to patch there",
  "no line of sight": "Something's in the way",
};

export class CombatClient {
  readonly effects: Effects;
  readonly hud: Hud;
  private lastFire = 0;
  private chargeStart = 0;
  private wasRmb = false;
  private blocking = false;
  private scoped = false;
  /** Unzoomed field of view (Settings → Field of view). */
  baseFov = 75;
  deadUntilRespawn = false;
  private readonly wheel: PhraseWheel;

  constructor(private readonly game: Game) {
    this.effects = new Effects(game.ctx.scene);
    this.hud = new Hud();
    this.wheel = new PhraseWheel((id) => this.game.net.room?.send("phrase", { id }));
  }

  /** Attach room message handlers (call after each join). */
  attach() {
    const room = this.game.net.room!;
    const me = room.sessionId;
    room.onMessage("you", (m: YouPlus) => {
      const prevLevel = this.hud.you?.level ?? m.level;
      this.hud.setYou(m);
      if (m.level > prevLevel && m.level >= 2 && !isDevGuest()) void this.maybeOfferSave();
      if (!m.dead) this.deadUntilRespawn = false;
    });
    room.onMessage("toast", (m: { text: string; kind: string }) => {
      this.hud.toast(m.text, m.kind);
      this.game.audio.play(m.kind === "xp" ? "levelUp" : m.kind === "coins" ? "coins" : "ui");
    });
    room.onMessage("denied", (m: { action: string; reason: string }) => {
      if (m.reason === "level gate") this.hud.toast("Your level is too low to use that tier", "warn");
      else if (m.action === "logout") this.hud.toast("Can't log out in combat — wait 10 s", "warn");
      else if (m.action === "use" && USE_DENIED[m.reason]) this.hud.toast(USE_DENIED[m.reason]!, "warn");
    });
    // Support items: Patchkit channel (server-timed; damage interrupts it) and Prism Bubbles.
    room.onMessage("channel", (m: { kind: string; ms: number; target: string }) => {
      const who = m.target === me ? "" : ` ${(room.state as any).players?.get(m.target)?.name ?? "an ally"}`;
      this.hud.toast(`Patching up${who}…`, "info");
      this.game.self?.trigger("attack");
    });
    room.onMessage("channelEnd", (m: { ok: boolean; reason?: string }) => {
      if (!m.ok) this.hud.toast(m.reason === "interrupted" ? "Patchkit interrupted — kit kept" : m.reason === "out of sight" ? "Lost sight of them — kit kept" : "Patchkit cancelled — kit kept", "warn");
    });
    room.onMessage("bubble", (m: { id: number; x: number; y: number; z: number; r: number; ms: number }) => {
      const at = new THREE.Vector3(m.x, m.y, m.z);
      this.effects.bubble(m.id, at, m.r, m.ms);
      this.game.audio.play("ui", at);
    });
    room.onMessage("bubblePop", (m: { id: number }) => this.effects.popBubble(m.id));
    // Bubbles deployed before we arrived (late join, reconnect): ask now that the handlers exist.
    room.send("supportSync", {});
    room.onMessage("hit", (m: { attacker: string; target: string; amount: number; weak: boolean; x: number; y: number; z: number; kb?: number; kx?: number; ky?: number; kz?: number }) => {
      if (m.attacker === me && m.target !== me) {
        this.hud.hit(m.weak);
        this.game.audio.play("hitmark", null, m.weak ? 1.3 : 1, m.weak ? 1.3 : 1);
        const s = this.toScreen(_v.set(m.x, m.y, m.z), 1.9);
        if (s) this.hud.damageNumber(s.x, s.y, m.amount, m.weak);
      }
      if (m.target === me) {
        if (m.kb && (m.kx || m.ky || m.kz)) this.game.player.knockback(new THREE.Vector3(m.kx, m.ky, m.kz), m.kb);
        this.hud.hurt();
        this.game.audio.play("hurt");
      } else this.game.audio.play("impact", new THREE.Vector3(m.x, m.y, m.z), 0.7);
    });
    room.onMessage("shot", (m: { by: string; weapon: number; ox: number; oy: number; oz: number; dx: number; dy: number; dz: number; hit?: [number, number, number]; chain?: [number, number, number][] }) => {
      if (m.by === me) return; // drawn locally already
      const shooter = (room.state as any).players?.get(m.by);
      const from = shooter ? this.muzzleOf(shooter) : new THREE.Vector3(m.ox, m.oy, m.oz);
      const to = m.hit ? new THREE.Vector3(...m.hit) : new THREE.Vector3(m.ox + m.dx * 60, m.oy + m.dy * 60, m.oz + m.dz * 60);
      const color = weaponColor(m.weapon);
      this.game.audio.play(this.game.audio.weaponSound(m.weapon), from);
      this.effects.tracer(from, to, color);
      if (m.chain) for (let i = 1; i < m.chain.length; i++) this.effects.tracer(new THREE.Vector3(...m.chain[i - 1]!), new THREE.Vector3(...m.chain[i]!), color, 1.5);
      this.effects.flash(from, color, 0.3);
    });
    room.onMessage("projectile", (m: { id: number; by: string; weapon: number; x: number; y: number; z: number; vx: number; vy: number; vz: number; g: number }) => {
      this.effects.spawnProjectile(m.id, m.weapon, new THREE.Vector3(m.x, m.y, m.z), new THREE.Vector3(m.vx, m.vy, m.vz), m.g);
      this.game.audio.play(this.game.audio.weaponSound(m.weapon), m.by === me ? null : new THREE.Vector3(m.x, m.y, m.z));
    });
    room.onMessage("explode", (m: { id: number; x: number; y: number; z: number; radius: number; weapon: number }) => {
      if (m.id) this.effects.endProjectile(m.id);
      const at = new THREE.Vector3(m.x, m.y, m.z);
      if (m.radius > 0) {
        this.effects.explosion(at, m.radius, weaponColor(m.weapon));
        this.game.audio.play("explosion", at);
      } else {
        this.effects.impact(at, weaponColor(m.weapon));
        this.game.audio.play("impact", at, 0.6);
      }
    });
    room.onMessage("swing", (m: { by: string; weapon: number }) => {
      if (m.by === me) return;
      const p = (room.state as any).players?.get(m.by);
      if (!p) return;
      const pos = new THREE.Vector3(p.x, p.y, p.z);
      this.effects.arc(pos, new THREE.Vector3(p.fx, p.fy, p.fz), pos.clone().normalize(), WEAPONS[m.weapon]?.range ?? 2, weaponColor(m.weapon));
      this.game.audio.play("swing", pos);
    });
    room.onMessage("phrase", (m: { by: string; id: number }) => {
      if (m.by !== me && isBlocked(m.by)) return; // no speech bubbles from blocked players
      const p = m.by === me ? this.game.player.pos : (() => { const s = (room.state as any).players?.get(m.by); return s ? new THREE.Vector3(s.x, s.y, s.z) : null; })();
      if (!p) return;
      const s = this.toScreen(p.clone(), 2.3);
      if (!s) return;
      // Others' bubbles carry their name; party members also their slot (colour + number).
      const speaker = m.by === me ? null : (room.state as any).players?.get(m.by);
      const slot = partyState().members.findIndex((x) => x.sessionId === m.by) + 1;
      this.hud.bubble(s.x, s.y, PHRASES[m.id] ?? "", { name: speaker?.name, slot: slot > 0 && slot <= 4 ? (slot as 1 | 2 | 3 | 4) : undefined });
    });
    room.onMessage("death", async (m: { victim: string; killer: string | null; killerName: string; aliveMs: number; level: number; pileId: string }) => {
      if (m.victim !== me || this.deadUntilRespawn) return;
      this.deadUntilRespawn = true;
      this.game.photo?.exit(this.game.ctx.camera);
      this.game.player.frozen = true;
      this.game.audio.play("death");
      const k = m.killer ? (room.state as any).players?.get(m.killer) : null;
      const choice = await this.hud.death({ ...m, body: this.game.bodyId, killerStarter: k?.starter, killerLevel: k?.level });
      room.send("respawn", choice);
    });
    room.onMessage("reborn", () => {
      this.game.player.frozen = false;
      void this.game.travel("portus");
    });
    room.onMessage("loggedOut", () => {
      void this.game.loggedOut();
    });
    room.onMessage("announce", (m: { text: string }) => this.hud.toast(m.text, "medal"));
    room.onMessage("updating", () => this.hud.toast("Server updating — reconnecting in a moment…", "warn"));
  }

  private offeredSave = false;
  /** After the first level-up, guests get a non-blocking "Save your character" card. */
  async maybeOfferSave() {
    if (this.offeredSave) return;
    const claims = readClaims(await getPlayToken().catch(() => ""));
    if (!claims?.guest) return;
    this.offeredSave = true;
    void showSavePrompt({ name: claims.name, level: this.hud.you?.level });
  }

  private muzzleOf(p: { x: number; y: number; z: number; fx: number; fy: number; fz: number }): THREE.Vector3 {
    const pos = new THREE.Vector3(p.x, p.y, p.z);
    const up = pos.clone().normalize();
    const f = new THREE.Vector3(p.fx, p.fy, p.fz);
    const right = new THREE.Vector3().crossVectors(f, up).normalize();
    return pos.addScaledVector(up, 1.35).addScaledVector(f, 0.5).addScaledVector(right, 0.25);
  }

  private toScreen(world: THREE.Vector3, upOffset = 0): { x: number; y: number } | null {
    const p = world.clone().addScaledVector(world.clone().normalize(), upOffset).project(this.game.ctx.camera);
    if (p.z > 1) return null;
    return { x: (p.x * 0.5 + 0.5) * innerWidth, y: (-p.y * 0.5 + 0.5) * innerHeight };
  }

  currentWeapon(): { def: WeaponDef; tier: number } {
    const you = this.hud.you;
    const item = you?.hotbar[you.selected];
    const def = (item && WEAPON_BY_ID.get(item.id)) || WEAPONS[0]!;
    return { def, tier: item?.tier ?? 1 };
  }

  aiming(): boolean {
    const { def } = this.currentWeapon();
    return this.game.input.rmb && def.delivery !== "melee";
  }

  update(dt: number, now: number) {
    const g = this.game;
    const room = g.net.room;
    const input = g.input;
    this.effects.update(dt, now);
    if (!room) return;
    const meState = (room.state as any).players?.get(room.sessionId);
    if (meState) {
      g.hud.setHp(meState.hp, meState.maxHp);
      g.hud.setIdentity(meState.name, meState.starter, meState.palette);
      g.hud.setSafe(!!(meState.flags & PF.SAFE));
      g.hud.setLogout(g.hud.you?.logoutEndsAt ?? null, Date.now() + g.net.serverOffset);
    }
    this.updatePickupPrompt();
    // Photo mode owns the keys (G cycles its filters there), and the body takes no actions.
    if (g.photo?.active) return;
    // The phrase wheel (G) owns the mouse and number keys while it is open: drop block/scope and any
    // charge, so nothing fires or stays raised when it closes.
    if (this.wheel.update(input, now, !this.deadUntilRespawn)) {
      if (this.blocking) room.send("block", { on: false });
      if (this.scoped) room.send("scope", { on: false });
      g.self?.setLocalFlags(0);
      if (this.wasRmb) room.send("charge", { on: false }); // a charge or draw in progress is cancelled
      this.blocking = this.scoped = this.wasRmb = false;
      return;
    }
    if (this.deadUntilRespawn || !input.locked) return;

    // Hotbar and utility keys.
    for (let i = 0; i < 4; i++) if (input.pressed.has(`Digit${i + 1}`)) room.send("equip", { slot: i });
    if (input.pressed.has("KeyR")) room.send("reload", { slot: g.hud.you?.selected ?? 0 });
    if (input.pressed.has("KeyE")) this.tryPickup();

    const { def, tier } = this.currentWeapon();
    const t = def.tiers[tier - 1]!;
    const rmb = input.rmb;

    // Right mouse: block (blades/staff), charge (axe/hammer), draw (bow), aim/scope (guns).
    if (def.delivery === "melee") {
      const heavyCapable = t.heavy !== undefined;
      if (!heavyCapable && t.block && rmb !== this.blocking) {
        this.blocking = rmb;
        room.send("block", { on: rmb });
      }
      if (heavyCapable) {
        // The server times the charge from this message (heavy without it is refused).
        if (rmb && !this.wasRmb) {
          this.chargeStart = now;
          room.send("charge", { on: true });
        }
        if (!rmb && this.wasRmb) {
          if (now - this.chargeStart >= (t.heavyTime ?? 0.8) * 1000) {
            room.send("melee", { slot: g.hud.you?.selected ?? 0, t: Date.now(), heavy: true });
            g.self?.trigger("heavy"); // own avatar animates now; remote views follow the server's swing
            this.lastFire = now;
          } else room.send("charge", { on: false });
        }
      }
    } else {
      const wantScope = rmb && (def.id === "stillshot" || def.id === "longbow" || def.delivery === "hitscan" || def.delivery === "pellets");
      if (wantScope !== this.scoped) {
        this.scoped = wantScope;
        room.send("scope", { on: wantScope });
      }
      if (def.delivery === "arrow" && rmb && !this.wasRmb) {
        this.chargeStart = now;
        room.send("charge", { on: true }); // the server times the draw
      }
      // Patchkit: right mouse patches yourself (left mouse: the ally in the crosshair).
      if (def.id === "patchkit" && rmb && !this.wasRmb) room.send("use", { slot: g.hud.you?.selected ?? 0 });
    }
    this.wasRmb = rmb;
    // Own avatar: hold the guard / aim pose from local input instead of waiting for the server flags.
    g.self?.setLocalFlags((this.blocking ? PF.BLOCKING : 0) | (this.scoped || this.aiming() ? PF.SCOPED : 0));
    const zoom = this.scoped ? (t.zoom ?? 1.35) : 1;
    const cam = g.ctx.camera;
    const targetFov = this.baseFov / zoom;
    if (Math.abs(cam.fov - targetFov) > 0.1) {
      cam.fov += (targetFov - cam.fov) * Math.min(1, dt * 14);
      cam.updateProjectionMatrix();
    }

    // Left mouse: attack.
    if (!input.lmb && !input.lmbPressed) return;
    if (meState && meState.flags & PF.SAFE) {
      if (input.lmbPressed) g.hud.toast("Weapons are holstered in safe zones", "warn");
      return;
    }
    const semi = def.delivery !== "hitscan" || def.id === "stillshot";
    if (semi && !input.lmbPressed) return;
    if (now - this.lastFire < t.rate * 1000) return;
    this.lastFire = now;
    const slot = g.hud.you?.selected ?? 0;
    // own avatar: swing / shot / cast / throw picked from the held item, without the round trip
    if (def.delivery !== "none") g.self?.trigger("attack");
    if (def.delivery === "melee") {
      room.send("melee", { slot, t: Date.now(), heavy: false });
      g.audio.play("swing");
      const up = g.player.up();
      this.effects.arc(g.player.pos, g.player.facing, up, def.range, weaponColor(WEAPONS.indexOf(def)));
      return;
    }
    if (def.id === "patchkit") {
      const ally = this.allyInCrosshair(def.range);
      if (ally) room.send("use", { slot, targetId: ally });
      else g.hud.toast("No ally in reach — right-click to patch yourself", "info");
      return;
    }
    if (def.delivery === "heal" || def.delivery === "bubble" || def.delivery === "none") {
      room.send("use", { slot });
      return;
    }
    const origin = cam.getWorldPosition(new THREE.Vector3());
    const dir = cam.getWorldDirection(new THREE.Vector3());
    const charge = def.delivery === "arrow" ? Math.min(1, (now - this.chargeStart) / ((t.draw ?? 1) * 1000)) : 1;
    room.send("fire", { slot, ox: origin.x, oy: origin.y, oz: origin.z, dx: dir.x, dy: dir.y, dz: dir.z, t: Date.now(), charge });
    if (def.delivery === "arrow" && rmb) {
      // Still holding the draw: the server's timer restarts after each shot, so restart ours too.
      this.chargeStart = now;
      room.send("charge", { on: true });
    }
    // Local predicted tracer for hitscan weapons.
    if (def.delivery === "hitscan" || def.delivery === "pellets" || def.delivery === "chain") {
      const hitT = this.rayTerrain(origin, dir, def.falloffTo ?? def.range);
      const to = origin.clone().addScaledVector(dir, hitT);
      const muzzle = g.player.pos.clone().addScaledVector(g.player.up(), 1.35).addScaledVector(g.player.facing, 0.5);
      const color = weaponColor(WEAPONS.indexOf(def));
      this.effects.tracer(muzzle, to, color, def.delivery === "chain" ? 1.6 : 1);
      g.audio.play(def.id in { carbine: 1, scatterpipe: 1, stillshot: 1, stormcoil: 1 } ? def.id : "carbine");
      this.effects.flash(muzzle, color, 0.3);
    }
  }

  /** The live player nearest the crosshair ray within `range` metres of us (Patchkit target), or null. */
  private allyInCrosshair(range: number): string | null {
    const room = this.game.net.room;
    if (!room) return null;
    const cam = this.game.ctx.camera;
    const o = cam.getWorldPosition(new THREE.Vector3());
    const d = cam.getWorldDirection(new THREE.Vector3());
    const mine = this.game.player.pos;
    const chest = new THREE.Vector3();
    let best: string | null = null;
    let bestOff = 1.0;
    (room.state as any).players?.forEach((p: any, id: string) => {
      if (id === room.sessionId || p.flags & PF.DEAD) return;
      chest.set(p.x, p.y, p.z);
      if (chest.distanceTo(mine) > range + 0.5) return;
      chest.addScaledVector(_v.copy(chest).normalize(), 1.0);
      // Not through the ground (the server also checks cover).
      const myChest = mine.clone().addScaledVector(mine.clone().normalize(), 1.0);
      const to = chest.clone().sub(myChest);
      const len = to.length();
      if (len > 0.01 && this.rayTerrain(myChest, to.divideScalar(len), len) < len) return;
      chest.sub(o);
      const t = chest.dot(d);
      if (t <= 0) return;
      const off = chest.addScaledVector(d, -t).length();
      if (off < bestOff) {
        bestOff = off;
        best = id;
      }
    });
    return best;
  }

  private rayTerrain(o: THREE.Vector3, d: THREE.Vector3, max: number): number {
    const terrain = this.game.planet.terrain;
    const R = terrain.body.radius;
    for (let t = 0; t <= max; t += 1.5) {
      _v.copy(o).addScaledVector(d, t);
      const l = _v.length();
      if (l < R + terrain.groundHeight(_v.x / l, _v.y / l, _v.z / l)) return t;
    }
    return max;
  }

  private nearestPile(): { id: string; owner: string; dist: number } | null {
    const room = this.game.net.room;
    if (!room) return null;
    let best: { id: string; owner: string; dist: number } | null = null;
    (room.state as any).piles?.forEach((p: any, id: string) => {
      const d = this.game.player.pos.distanceTo(_v.set(p.x, p.y, p.z));
      if (d <= 3.2 && (!best || d < best.dist)) best = { id, owner: p.owner, dist: d };
    });
    return best;
  }

  private updatePickupPrompt() {
    const p = this.nearestPile();
    this.game.hud.setPrompt(p ? `E — take everything from ${p.owner}'s pile` : null);
  }

  private tryPickup() {
    const p = this.nearestPile();
    if (p) this.game.net.room?.send("pickup", { pileId: p.id });
  }

  dispose() {
    this.effects.dispose();
    this.wheel.dispose();
  }
}
