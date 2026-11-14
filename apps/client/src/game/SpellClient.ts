// The spellbook on the client (content §2.7): the cast keys (Q / F / X / Z), what the crosshair is
// on for Wishfall, the HUD's spell bar and aether, and the effects and sounds of every `spell`
// event near us. The server decides everything (server/world/spells): a press sends `cast`, the
// HUD shows it at once, and a refusal takes it back.

import * as THREE from "three/webgpu";
import { SPELL_INDEX, SPELLS, WISHFALL, type SpellDef, type SpellId } from "@firstlight/shared/content/spells";
import type { CastMsg, SpellEvent, YouState } from "@firstlight/shared/net/protocol";
import { PF } from "@firstlight/shared/net/schema";
import { blastTrauma, CameraShake } from "../render/cameraShake.ts";
import { SpellFx } from "../render/spellFx.ts";
import { uiSettings } from "../ui/uiSettings.ts";
import { SpellBar } from "../ui/spellBar.ts";
import type { Game } from "./Game.ts";
import { blockText, castDeniedText, SpellBook } from "./spellBook.ts";
import type { ClientSystem } from "./systems.ts";
import { crosshairQueryOf, crosshairTarget } from "./crosshairTarget.ts";

const _o = new THREE.Vector3();
const _d = new THREE.Vector3();
const _v = new THREE.Vector3();
const _w = new THREE.Vector3();

interface Posed {
  x: number;
  y: number;
  z: number;
  flags?: number;
  hp?: number;
}
interface RoomState {
  players?: { get(id: string): Posed | undefined; forEach(cb: (p: Posed, id: string) => void): void };
  npcs?: { get(id: string): Posed | undefined; forEach(cb: (n: Posed, id: string) => void): void };
}

export class SpellClient implements ClientSystem {
  readonly book = new SpellBook();
  readonly fx: SpellFx;
  private readonly bar: SpellBar;
  private readonly game: Game;
  private readonly offs: (() => void)[] = [];
  /** The spell last sent, for the refusal that answers it. */
  private lastCast: SpellDef | null = null;
  /** Notices already shown lately (text → when), so a held or mashed key says a thing once. */
  private readonly said = new Map<string, number>();
  /** Who is frosted (Frostbloom's slow) and until when (performance.now ms). */
  private readonly chilled = new Map<string, number>();
  private chillAt = 0;
  /** Where each warded player's shell is drawn (smoothed between state patches). */
  private readonly wardPos = new Map<string, THREE.Vector3>();
  /** Our velocity last frame: a blink keeps it (the server's `correct` stops the body). */
  private readonly vel = new THREE.Vector3();
  /** Screen shake from a star landing near us (content §0's trauma model; the settings toggle turns it off). */
  readonly shake = new CameraShake();

  constructor(game: Game) {
    this.game = game;
    this.fx = new SpellFx(game.ctx.scene, () => game.planet.terrain, (at, color, count, opts) => void game.burst(at, color, count, opts));
    this.bar = new SpellBar(game.hud.spellSlot, game.hud.aetherSlot);
    const you = game.hud.you;
    if (you) this.book.setYou(you.spells, you.level);
    this.bar.setNumbers(you?.level ?? 1, game.hud.starterIndex);
    const room = game.net.room;
    if (!room) return; // offline: the bar shows a full book; nothing to cast at
    const on = (type: string, cb: (m: never) => void) => {
      const off = room.onMessage(type, cb as (m: unknown) => void) as unknown;
      if (typeof off === "function") this.offs.push(off as () => void);
    };
    on("you", (m: YouState & { level: number }) => {
      this.book.setYou(m.spells, m.level);
      this.bar.setNumbers(m.level, this.game.hud.starterIndex);
    });
    on("denied", (m: { action: string; reason: string; req?: number }) => {
      if (m.action !== "cast") return;
      // The refusal names its cast (`req`): that prediction goes, any other in flight stays.
      const id = this.book.refused(this.serverNow(), m.req);
      const s = id ? SPELLS[SPELL_INDEX.get(id)!]! : this.lastCast;
      if (s) this.bar.pulse(SPELL_INDEX.get(s.id)!, "deny");
      this.say(castDeniedText(m.reason, s ?? undefined));
    });
    on("spell", (m: SpellEvent) => this.onSpell(m));
    // Wards that were up before we arrived (late join, reconnect): ask now that the handlers exist.
    room.send("spellSync", {});
  }

  private serverNow(): number {
    return Date.now() + this.game.net.serverOffset;
  }

  private state(): RoomState | null {
    return (this.game.net.room?.state as RoomState | undefined) ?? null;
  }

  private say(text: string | null) {
    if (!text) return;
    const now = performance.now();
    if (now - (this.said.get(text) ?? -1e9) < 1500) return;
    this.said.set(text, now);
    this.game.hud.toast(text, "warn");
    this.game.audio.play("denied");
  }

  // ------------------------------------------------------------------------------------ casting

  /**
   * Cast `id` the way its key does: checks what the client can see (level, cooldown, aether, safe
   * zone, saddle), then sends `cast` with the camera's aim. `target`: Wishfall's ground point
   * (default: what the crosshair is on). Returns why nothing was sent, or null when it was.
   */
  castSpell(id: SpellId, target?: readonly [number, number, number]): string | null {
    const g = this.game;
    const room = g.net.room;
    const index = SPELL_INDEX.get(id);
    if (!room || index === undefined) return "no room";
    const s = SPELLS[index]!;
    const now = this.serverNow();
    const deny = (why: string, text: string) => {
      this.bar.pulse(index, "deny");
      this.say(text);
      return why;
    };
    const why = this.book.block(id, now);
    if (why) return deny(why, blockText(s, why));
    const me = this.state()?.players?.get(room.sessionId);
    if (me && (me.flags ?? 0) & PF.SAFE) return deny("safe zone", castDeniedText("safe zone", s)!);
    if (g.player.saddleLocked) return deny("mounted", castDeniedText("mounted", s)!);
    const cam = g.ctx.camera;
    const d = cam.getWorldDirection(_d);
    const msg: CastMsg = { spell: id, dx: d.x, dy: d.y, dz: d.z };
    if (id === "wishfall") {
      const t = target ?? this.crosshairPoint(WISHFALL.rangeM).toArray();
      msg.tx = t[0];
      msg.ty = t[1];
      msg.tz = t[2];
    }
    msg.req = this.book.predict(id, now);
    room.send("cast", msg);
    this.lastCast = s;
    this.bar.pulse(index, "cast");
    g.self?.trigger("cast");
    return null;
  }

  /**
   * What the crosshair is on within `range` metres of us: the feet of the creature or player nearest
   * the camera ray, else where the ray meets the ground or something solid, else the point at range
   * (the server puts it on the ground and checks the line from our head itself).
   */
  crosshairPoint(range: number): THREE.Vector3 {
    return crosshairTarget(crosshairQueryOf(this.game), range).point;
  }

  // ------------------------------------------------------------------------------------ events

  private posOf(id: string): THREE.Vector3 | null {
    const room = this.game.net.room;
    if (id === room?.sessionId) return this.game.player.pos;
    const st = this.state();
    const p = st?.players?.get(id) ?? st?.npcs?.get(id);
    return p ? _v.set(p.x, p.y, p.z) : null;
  }

  private onSpell(m: SpellEvent) {
    const g = this.game;
    const me = g.net.room?.sessionId;
    const mine = m.by === me;
    const at = new THREE.Vector3(m.x, m.y, m.z);
    const heard = mine ? null : at;
    switch (m.spell) {
      case "skipstep": {
        const to = new THREE.Vector3(m.tx ?? m.x, m.ty ?? m.y, m.tz ?? m.z);
        this.fx.blink(at, to);
        g.audio.play("skipstep", mine ? null : to);
        if (mine) {
          // The server moved us (its `correct` came first and stopped the body): keep running, and
          // keep a jump that was still rising (#78: the hop was cut off and the body dropped where it
          // landed). The body blinked, it didn't arrive: no rez-in, no speed spike from the 10 m.
          const up = _w.copy(g.player.pos).normalize();
          const rise = Math.max(0, this.vel.dot(up));
          g.player.vel.copy(this.vel).addScaledVector(up, rise - this.vel.dot(up));
          if (rise > 0) g.player.onGround = false;
          g.self?.blinked();
        }
        break;
      }
      case "frostbloom": {
        this.fx.frost(at, m.r ?? 5, m.ms ?? 3000);
        g.audio.play("frostbloom", heard);
        const until = performance.now() + (m.ms ?? 3000);
        for (const id of m.hit ?? []) this.chilled.set(id, until);
        break;
      }
      case "wishfall":
        if (m.phase === "cast") {
          this.fx.starFall(m.id ?? 0, at, m.r ?? WISHFALL.radiusM, m.ms ?? WISHFALL.telegraphS * 1000);
          g.audio.play("wishfallCast", heard);
        } else if (m.phase === "impact") {
          this.fx.starImpact(m.id ?? 0, at, m.r ?? WISHFALL.radiusM);
          g.audio.play("wishfall", at);
          g.audio.play("explosion", at, 0.55);
          // The ground jumps: most inside the blast, nothing past 40 m.
          this.shake.add(blastTrauma(at.distanceTo(g.player.pos), m.r ?? WISHFALL.radiusM));
        }
        break;
      case "glasswing":
        if (m.phase === "cast") {
          const key = m.by;
          this.wardPos.set(key, at.clone());
          // `late`: it was up before we arrived (the answer to our `spellSync`): drawn, not announced.
          this.fx.ward(key, () => this.wardPos.get(key) ?? null, m.ms ?? 4000, !!m.late);
          if (!m.late) g.audio.play("ward", heard);
        } else if (m.phase === "absorb") {
          this.fx.wardHit(m.by);
          g.audio.play("wardHit", heard);
          if (m.from === me && !mine) {
            // Our hit went into their shell: say so where a damage number would be.
            g.audio.play("hitmark");
            const p = at.clone().addScaledVector(at.clone().normalize(), 1.9).project(g.ctx.camera);
            if (p.z <= 1) g.hud.damageNumber((p.x * 0.5 + 0.5) * innerWidth, (-p.y * 0.5 + 0.5) * innerHeight, m.amount ?? 0, false, "shield");
          }
        } else if (m.phase === "end") {
          this.fx.wardEnd(m.by, !!m.broke);
          this.wardPos.delete(m.by);
          if (m.broke) g.audio.play("shatter", heard, 0.8, 1.5);
        }
        break;
    }
  }

  // ------------------------------------------------------------------------------------ frame

  update(dt: number, now: number) {
    const g = this.game;
    // Shells follow their owners: ours exactly, the others eased between state patches.
    for (const [id, p] of this.wardPos) {
      const to = this.posOf(id);
      if (!to) this.wardPos.delete(id);
      else if (id === g.net.room?.sessionId) p.copy(to);
      else p.lerp(to, 1 - Math.exp(-dt * 16));
    }
    this.fx.update(dt);
    // After the controller has placed the camera for this frame (and never in photo mode: its camera is the player's to hold still).
    const turn = this.shake.step(dt, uiSettings.get().shake && !g.photo?.active);
    if (turn.roll !== 0 || turn.pitch !== 0 || turn.yaw !== 0) {
      const cam = g.ctx.camera;
      cam.rotateX(turn.pitch);
      cam.rotateY(turn.yaw);
      cam.rotateZ(turn.roll);
    }
    if (this.chilled.size && now >= this.chillAt) {
      this.chillAt = now + 110;
      for (const [id, until] of this.chilled) {
        const p = now < until ? this.posOf(id) : null;
        if (!p) this.chilled.delete(id);
        else this.fx.chill(_o.copy(p).addScaledVector(_w.copy(p).normalize(), 0.3 + Math.random() * 1.2));
      }
    }
    this.bar.update(this.book.view(this.serverNow()));
    this.vel.copy(g.player.vel);
    // Photo mode owns the keys; the dead and the paused cast nothing. Keys work in the "Click to
    // look around" state too (Input.inPlay, D-controls-4), like the hotbar's.
    if (!g.net.room || g.photo?.active || g.combat.deadUntilRespawn || !g.input.inPlay) return;
    for (const s of SPELLS) if (g.input.pressed.has(s.code)) this.castSpell(s.id);
  }

  dispose() {
    for (const off of this.offs) off();
    this.fx.dispose();
    this.bar.dispose();
    this.chilled.clear();
    this.wardPos.clear();
  }
}

/** CLIENT_SYSTEMS entry. Also runs offline (the HUD bar and the warmed effects; nothing casts without a server). */
export function createSpellClient(game: Game): ClientSystem {
  return new SpellClient(game);
}
createSpellClient.offline = true;
