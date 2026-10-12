// Client side of horses (SPEC §6.14 #2; rules in @firstlight/shared/content/horse). Draws every
// summoned horse from the room state, under its rider while ridden, and sits the rider on the saddle
// socket; drives the local player's riding mode (speed, camera) from the server's PF.MOUNTED flag;
// H whistles, E gets on and off; corpuscle bursts and a whistle on horse events.
//
// Two client systems share one instance: `horseClientSystem` runs first (so nameplates and cosmetics
// see riders already in the saddle) and `horseInputSystem` runs after the quests client (so piles
// and world objects keep E when they are in reach).

import * as THREE from "three/webgpu";
import { HORSE, HORSE_COATS } from "@firstlight/shared/content/horse";
import { ANIM, PF } from "@firstlight/shared/net/schema";
import { HorseView } from "../render/Horses.ts";
import type { AvatarView } from "../render/Avatars.ts";
import type { Game } from "./Game.ts";
import { MountState, horseKeys, rideBlockedByWater } from "./mount.ts";
import type { ClientSystem } from "./systems.ts";

const _pos = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _up = new THREE.Vector3();
const _seat = new THREE.Vector3();
const _v = new THREE.Vector3();

interface Shown {
  view: HorseView;
  /** Displayed feet position (eases to the server's spot after a dismount). */
  pos: THREE.Vector3;
  fwd: THREE.Vector3;
}

interface HorseMsg {
  owner: string;
  event: "summon" | "mount" | "dismount" | "thrown" | "leave";
  x: number;
  y: number;
  z: number;
}

let current: HorseClient | null = null;

export class HorseClient {
  private readonly game: Game;
  private readonly shown = new Map<string, Shown>();
  readonly mount = new MountState();
  private readonly offs: (() => void)[] = [];

  constructor(game: Game) {
    this.game = game;
    const room = game.net.room!;
    const off = room.onMessage("horse", (m: HorseMsg) => this.onEvent(m)) as unknown;
    if (typeof off === "function") this.offs.push(off as () => void);
  }

  /** Rendering half: horses, riders, the local riding mode. */
  update(dt: number) {
    const g = this.game;
    const room = g.net.room;
    if (!room) return;
    const state = room.state as any;
    const me = room.sessionId;
    const meState = state.players?.get(me);

    // Local riding mode follows the server; deep water ahead throws us off at once (and tells it).
    this.mount.sync(!!meState && (meState.flags & PF.MOUNTED) !== 0 && !g.combat.deadUntilRespawn);
    if (this.mount.riding) {
      const p = g.player.pos;
      const l = p.length();
      if (rideBlockedByWater(g.planet.terrain.groundHeight(p.x / l, p.y / l, p.z / l), g.planet.body.waterLevel)) {
        this.mount.slideOff();
        room.send("horse", { action: "dismount" });
      }
    }
    this.mount.step(dt);
    g.player.mounted = this.mount.riding;
    g.player.rideBlend = this.mount.blend;

    const visible = g.ctx.settings.on.chars;
    const seen = new Set<string>();
    state.horses?.forEach((h: any, owner: string) => {
      seen.add(owner);
      let s = this.shown.get(owner);
      if (!s) {
        s = { view: new HorseView(h.coat ?? 0), pos: new THREE.Vector3(h.x, h.y, h.z), fwd: new THREE.Vector3(h.fx, h.fy, h.fz) };
        g.ctx.scene.add(s.view.root);
        this.shown.set(owner, s);
      }
      s.view.root.visible = visible;
      const rider: AvatarView | undefined = owner === me ? g.self : g.avatars.get(owner);
      const ridden = owner === me ? this.mount.riding : !!h.ridden;
      let speed = 0;
      let airborne = false;
      if (ridden && rider) {
        if (owner === me) {
          _pos.copy(g.player.pos);
          _fwd.copy(g.player.facing);
          _up.copy(_pos).normalize();
          speed = _v.copy(g.player.vel).addScaledVector(_up, -g.player.vel.dot(_up)).length();
          airborne = !g.player.onGround && !g.player.swimming;
        } else {
          _pos.copy(rider.root.position); // this frame's interpolated sample (Game.frame set it)
          _fwd.set(0, 0, 1).applyQuaternion(rider.root.quaternion);
          speed = rider.groundSpeed;
          const anim = state.players?.get(owner)?.anim;
          airborne = anim === ANIM.JUMP || anim === ANIM.FALL;
        }
        s.pos.copy(_pos);
        s.fwd.copy(_fwd);
      } else {
        // Standing: ease to the server's spot (a dismount moves it a step aside).
        const before = _v.copy(s.pos);
        s.pos.lerp(_pos.set(h.x, h.y, h.z), Math.min(1, dt * 6));
        speed = dt > 0 ? before.distanceTo(s.pos) / dt : 0;
        s.fwd.set(h.fx, h.fy, h.fz);
      }
      s.view.set(s.pos.x, s.pos.y, s.pos.z, s.fwd.x, s.fwd.y, s.fwd.z, speed, airborne, dt);
      if (ridden && rider) {
        // Into the saddle: the rider's feet go seatDrop() below the socket, along local up.
        s.view.seat(_seat);
        _up.copy(_seat).normalize();
        rider.root.position.copy(_seat).addScaledVector(_up, -rider.seatDrop());
      }
    });
    for (const [owner, s] of this.shown) {
      if (seen.has(owner)) continue;
      s.view.dispose();
      this.shown.delete(owner);
    }
    HorseView.updateLod(g.ctx.camera);
  }

  /** Input half: H whistles (or gets on/off), E gets on/off when nothing else claimed the prompt. */
  input() {
    const g = this.game;
    const room = g.net.room;
    if (!room || g.photo?.active || g.combat.deadUntilRespawn || !g.input.locked) return;
    const state = room.state as any;
    const own = state.horses?.get(room.sessionId);
    const near = !!own && g.player.pos.distanceTo(_v.set(own.x, own.y, own.z)) <= HORSE.mountRange;
    _up.copy(g.player.pos).normalize();
    const moving = _v.copy(g.player.vel).addScaledVector(_up, -g.player.vel.dot(_up)).length() > 1;
    const k = horseKeys({ riding: this.mount.riding, haveHorse: !!own, near, moving });
    const free = !g.hud.promptShown;
    if (free && k.prompt) g.hud.setPrompt(k.prompt);
    if (g.input.pressed.has("KeyH")) room.send("horse", { action: "whistle" });
    else if (free && k.e && g.input.pressed.has("KeyE")) room.send("horse", { action: k.e });
  }

  private onEvent(m: HorseMsg) {
    const g = this.game;
    const at = new THREE.Vector3(m.x, m.y, m.z);
    const mine = m.owner === g.net.room?.sessionId;
    const coat = (g.net.room?.state as any)?.horses?.get(m.owner)?.coat ?? this.shown.get(m.owner)?.view.coat ?? 0;
    const tint = HORSE_COATS[coat % HORSE_COATS.length]![2];
    const lift = at.clone().addScaledVector(at.clone().normalize(), 1.1);
    switch (m.event) {
      case "summon":
        g.burst(lift, tint, 70); // digital matter is light (look rule 4)
        g.audio.play("whistle", mine ? null : at);
        break;
      case "leave":
        g.burst(lift, tint, 50);
        break;
      case "thrown":
        g.burst(lift, 0xffffff, 24);
        if (mine) g.audio.play("hurt");
        break;
      case "mount":
      case "dismount":
        if (mine) g.audio.play("ui");
        break;
    }
  }

  dispose() {
    for (const off of this.offs) off();
    for (const s of this.shown.values()) s.view.dispose();
    this.shown.clear();
    this.game.player.mounted = false;
    this.game.player.rideBlend = 0;
    if (current === this) current = null;
  }
}

/** Created per body (first in CLIENT_SYSTEMS). */
export function horseClientSystem(game: Game): ClientSystem | null {
  if (!game.net.room) return null;
  const c = new HorseClient(game);
  current = c;
  return { update: (dt) => c.update(dt), dispose: () => c.dispose() };
}

/** Runs after the quests client; no state of its own. */
export function horseInputSystem(): ClientSystem | null {
  return {
    update: () => current?.input(),
    dispose: () => {},
  };
}
