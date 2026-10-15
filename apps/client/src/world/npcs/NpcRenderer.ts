// Client NPC layer: reads room.state.npcs (view-filtered by the server to ~80–100 m), interpolates
// them 100 ms in the past like remote players, and draws procedural models through the instanced
// part batcher, plus telegraph decals, projectiles, lock-on lines, health bars, light-particle
// spawns/deaths, the boss lair props and the boss HUD store. Costs ≈ 10–20 draw calls in total.

import * as THREE from "three/webgpu";
import { BOSS_LINES, playBossLine, type BossId, type BossTrigger } from "../../audio/bossLines.ts";
import { NF, NPC_ANIM, NPC_DEFS, SHAPE_CODE, type BossEventMsg, type NpcAttackMsg, type NpcDef, type NpcShotMsg, type StatusEffect } from "@firstlight/shared/content/npcs";
import { NET } from "@firstlight/shared/net/protocol";
import { flags } from "../../config.ts";
import type { Game } from "../../game/Game.ts";
import { MOVE } from "../../game/PlayerController.ts";
import type { ClientSystem } from "../../game/systems.ts";
import { ArenaView } from "./arena.ts";
import { HealthBars } from "./bars.ts";
import { bossStore, type BossHud } from "./bossStore.ts";
import { LightParticles } from "./fx.ts";
import { buildModels, type ModelDef, type PartDef } from "./models.ts";
import { PartBatcher } from "./parts.ts";
import { TELEGRAPH_COLORS, Telegraphs } from "./telegraphs.ts";
import { creepsHiddenByTown } from "./townCull.ts";

interface Snap {
  t: number;
  x: number;
  y: number;
  z: number;
  fx: number;
  fy: number;
  fz: number;
}

interface PreparedPart {
  def: PartDef;
  base: THREE.Matrix4;
  pos: THREE.Vector3;
  quat: THREE.Quaternion;
  scale: THREE.Vector3;
  pivot: THREE.Vector3 | null;
  r: number;
  g: number;
  b: number;
  glow: boolean;
}

interface PreparedModel {
  model: ModelDef;
  parts: PreparedPart[];
  height: number;
  fx: THREE.Color;
}

interface View {
  id: string;
  kind: number;
  def: NpcDef;
  pm: PreparedModel;
  ref: any;
  buf: Snap[];
  pos: THREE.Vector3;
  fwd: THREE.Vector3;
  up: THREE.Vector3;
  lastPos: THREE.Vector3;
  speed: number;
  walk: number;
  roll: number;
  anim: number;
  animAt: number;
  flags: number;
  born: number;
  dyingAt: number;
  gone: boolean;
  hitAt: number;
  teleAt: number;
  teleMs: number;
  teleColor: number;
  lock: { target: string; until: number; color: number } | null;
  seed: number;
  dist: number;
}

interface Shot {
  x: THREE.Vector3;
  v: THREE.Vector3;
  up: THREE.Vector3;
  g: number;
  t0: number;
  until: number;
  color: THREE.Color;
  size: number;
  tracer: boolean;
}

const DETAIL_DISTANCE = 45;
const _m = new THREE.Matrix4();
const _m2 = new THREE.Matrix4();
const _anim = new THREE.Matrix4();
const _root = new THREE.Matrix4();
const _world = new THREE.Matrix4();
const _bm = new THREE.Matrix4();
const _ba = new THREE.Vector3();
const _bb = new THREE.Vector3();
const _bd = new THREE.Vector3();
const _bq = new THREE.Quaternion();
const _bs = new THREE.Vector3();
const _basis = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _e = new THREE.Euler();
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _s = new THREE.Vector3();
const _right = new THREE.Vector3();
const _c = new THREE.Color();
const Y = new THREE.Vector3(0, 1, 0);

function prepare(model: ModelDef): PreparedModel {
  let height = 0;
  const parts = model.parts.map((p) => {
    const pos = new THREE.Vector3(...p.p);
    const quat = new THREE.Quaternion().setFromEuler(new THREE.Euler(...(p.r ?? [0, 0, 0])));
    const scale = new THREE.Vector3(...p.s);
    const base = new THREE.Matrix4().compose(pos, quat, scale);
    height = Math.max(height, p.p[1] + p.s[1] / 2);
    const c = new THREE.Color(p.c);
    const k = p.m === "glow" ? (p.i ?? 2.2) : 1;
    return { def: p, base, pos, quat, scale, pivot: p.pv ? new THREE.Vector3(...p.pv) : null, r: c.r * k, g: c.g * k, b: c.b * k, glow: p.m === "glow" };
  });
  return { model, parts, height, fx: new THREE.Color(model.fx) };
}

/** NPC boss def ids → recorded voice-line ids. */
const BOSS_AUDIO_ID: Record<string, BossId | undefined> = { tidewrath: "tidewrath", hollow_king: "hollowking", the_receiver: "receiver" };

export class NpcRenderer implements ClientSystem {
  private readonly game: Game;
  private readonly root = new THREE.Group();
  private readonly batch: PartBatcher;
  private readonly particles = new LightParticles();
  private readonly telegraphs: Telegraphs;
  private readonly bars = new HealthBars();
  private readonly arena: ArenaView | null;
  private readonly models: PreparedModel[];
  private readonly views = new Map<string, View>();
  private readonly shots: Shot[] = [];
  private readonly pulls: { c: THREE.Vector3; speed: number; until: number }[] = [];
  private readonly effects: { kind: StatusEffect["kind"]; until: number; amount: number }[] = [];
  private readonly baseMove = { run: MOVE.run, sprint: MOVE.sprint, dodge: MOVE.dodgeDistance };
  private readonly offs: (() => void)[] = [];
  private readonly onState: (state: any) => void;
  private bossEngaged = 0;
  private bossVoice: BossHud["voice"] = null;
  private bossDefeatedAt = 0;
  private bossLast: BossHud | null = null;

  constructor(game: Game) {
    this.game = game;
    const ctx = game.ctx;
    const shadows = !flags.has("noshadows") && ctx.settings.on.shadows && ctx.settings.shadows.mode === "map";
    this.batch = new PartBatcher(shadows);
    this.models = buildModels(game.bodyId).map(prepare);
    const planet = game.planet;
    this.telegraphs = new Telegraphs(planet.terrain, planet.body.waterLevel, (id) => this.playerPos(id));
    this.arena = flags.has("noarena") ? null : new ArenaView(planet.terrain);
    this.particles.enabled = !flags.has("noparticles");
    this.root.add(this.batch.group, this.particles.group, this.telegraphs.group, this.bars.group);
    ctx.scene.add(this.root);

    const room = game.net.room!;
    this.onState = (state: any) => this.readState(state);
    room.onStateChange(this.onState);
    const on = (type: string, fn: (m: any) => void) => {
      const off = room.onMessage(type, fn);
      if (typeof off === "function") this.offs.push(off);
    };
    on("npcAtk", (m: NpcAttackMsg) => this.onAttack(m));
    on("npcShot", (m: NpcShotMsg) => this.onShot(m));
    on("npcFx", (m: { kind: StatusEffect["kind"]; ms: number; amount: number }) => this.effects.push({ kind: m.kind, until: performance.now() + m.ms, amount: m.amount }));
    on("npcPull", (m: { x: number; y: number; z: number; speed: number; ms: number }) => this.pulls.push({ c: new THREE.Vector3(m.x, m.y, m.z), speed: m.speed, until: performance.now() + m.ms }));
    on("npcKill", (m: unknown) => window.dispatchEvent(new CustomEvent("fl:npcKill", { detail: m })));
    on("npcBark", (m: unknown) => window.dispatchEvent(new CustomEvent("fl:npcBark", { detail: m })));
    on("npcEgg", (m: unknown) => window.dispatchEvent(new CustomEvent("fl:npcEgg", { detail: m })));
    on("npcChest", (m: { x: number; y: number; z: number }) => this.particles.burst(new THREE.Vector3(m.x, m.y, m.z), 0xffd23f, 40, { radius: 1.2, height: 0.6, speed: 3 }));
    on("npcInfo", () => {});
    on("npcList", () => {});
    on("bossInfo", () => {});
    on("boss", (m: BossEventMsg) => this.onBoss(m));
    // Ask for the lair snapshot now that our handlers exist (cover broken before we arrived, etc.).
    room.send("npcSync", {});
    on("hit", (m: { target: string; kind: string }) => {
      if (m.kind !== "npc") return;
      const v = this.views.get(m.target);
      if (v) v.hitAt = performance.now();
    });
  }

  // ------------------------------------------------------------------------------------ state

  private readState(state: any) {
    const now = performance.now();
    const seen = new Set<string>();
    state.npcs?.forEach((n: any, id: string) => {
      seen.add(id);
      let v = this.views.get(id);
      if (!v) v = this.addView(id, n, now);
      v.ref = n;
      v.gone = false;
      const last = v.buf[v.buf.length - 1];
      if (!last || last.x !== n.x || last.y !== n.y || last.z !== n.z || last.fx !== n.fx || last.fy !== n.fy || last.fz !== n.fz || now - last.t > 200) {
        v.buf.push({ t: now, x: n.x, y: n.y, z: n.z, fx: n.fx, fy: n.fy, fz: n.fz });
        if (v.buf.length > 24) v.buf.shift();
      }
    });
    for (const [id, v] of this.views) if (!seen.has(id) && !v.gone) v.gone = true;
  }

  private addView(id: string, n: any, now: number): View {
    const kind = n.kind as number;
    const def = NPC_DEFS[kind] ?? NPC_DEFS[0]!;
    const pm = this.models[kind] ?? this.models[0]!;
    const pos = new THREE.Vector3(n.x, n.y, n.z);
    const v: View = {
      id, kind, def, pm, ref: n, buf: [], pos, fwd: new THREE.Vector3(n.fx, n.fy, n.fz), up: pos.clone().normalize(), lastPos: pos.clone(),
      speed: 0, walk: Math.random() * 6, roll: 0, anim: n.anim, animAt: now, flags: n.flags, born: now, dyingAt: 0, gone: false,
      hitAt: 0, teleAt: 0, teleMs: 600, teleColor: 0, lock: null, seed: Math.random() * 100, dist: 0,
    };
    this.views.set(id, v);
    if (n.flags & NF.SPAWNING) this.particles.burst(pos, pm.model.fx, Math.min(80, 12 + Math.round(pm.height * 8)), { pixels: pm.model.pixels, radius: Math.max(0.5, def.radius), height: pm.height, inward: true, life: 0.9 });
    return v;
  }

  private sample(v: View, now: number) {
    const b = v.buf;
    if (b.length === 0) return;
    const t = now - NET.INTERP_DELAY_MS;
    let x: number, y: number, z: number, fx: number, fy: number, fz: number;
    if (t <= b[0]!.t || b.length === 1) ({ x, y, z, fx, fy, fz } = b[0]!);
    else {
      let i = b.length - 1;
      while (i > 0 && b[i - 1]!.t > t) i--;
      const a = b[Math.max(0, i - 1)]!, c = b[i]!;
      const k = Math.min(1, Math.max(0, (t - a.t) / Math.max(1, c.t - a.t)));
      x = a.x + (c.x - a.x) * k;
      y = a.y + (c.y - a.y) * k;
      z = a.z + (c.z - a.z) * k;
      fx = a.fx + (c.fx - a.fx) * k;
      fy = a.fy + (c.fy - a.fy) * k;
      fz = a.fz + (c.fz - a.fz) * k;
    }
    v.pos.set(x, y, z);
    v.up.copy(v.pos).normalize();
    v.fwd.set(fx, fy, fz).addScaledVector(v.up, -(fx * v.up.x + fy * v.up.y + fz * v.up.z));
    if (v.fwd.lengthSq() < 1e-6) v.fwd.set(1, 0, 0).addScaledVector(v.up, -v.up.x);
    v.fwd.normalize();
  }

  // ------------------------------------------------------------------------------------ messages

  private onAttack(m: NpcAttackMsg) {
    const now = performance.now();
    const v = this.views.get(m.id);
    if (m.a === -1) {
      this.telegraphs.cancel(m.id);
      if (v) v.lock = null;
      return;
    }
    this.telegraphs.add(m, now);
    if (!v) return;
    if (m.a >= 0 && m.a < v.def.attacks.length) {
      v.teleAt = now;
      v.teleMs = m.ms;
      v.teleColor = m.c;
    }
    if (m.c === 1 && m.tg?.length && (m.sh === SHAPE_CODE.burst || m.sh === SHAPE_CODE.zap || m.sh === SHAPE_CODE.tag)) v.lock = { target: m.tg[0]!, until: now + m.ms, color: TELEGRAPH_COLORS[1]! };
  }

  private onShot(m: NpcShotMsg) {
    const now = performance.now();
    const pm = this.models[m.k];
    const color = new THREE.Color(pm ? pm.model.fx : 0xffffff).multiplyScalar(3);
    const boss = NPC_DEFS[m.k]?.family === "boss";
    if (m.g < 0) {
      this.shots.push({ x: new THREE.Vector3(m.x, m.y, m.z), v: new THREE.Vector3(m.vx, m.vy, m.vz), up: new THREE.Vector3(), g: 0, t0: now, until: now + m.ms, color, size: 0.05, tracer: true });
      return;
    }
    const x = new THREE.Vector3(m.x, m.y, m.z);
    this.shots.push({ x, v: new THREE.Vector3(m.vx, m.vy, m.vz), up: x.clone().normalize(), g: m.g, t0: now, until: now + m.ms, color, size: boss ? 0.7 : 0.32, tracer: false });
  }

  private onBoss(m: BossEventMsg) {
    const now = performance.now();
    this.arena?.onEvent(m, now);
    bossStore.event(m);
    if (m.engaged !== undefined) this.bossEngaged = m.engaged;
    if (m.type === "voice" && m.line) {
      this.bossVoice = { name: m.name ?? "", line: m.line, at: Date.now() };
      // Recorded line + subtitle (audio/bossLines.ts); the text picks which of the three it is.
      const boss = BOSS_AUDIO_ID[m.boss];
      const trigger = boss && (Object.keys(BOSS_LINES[boss]) as BossTrigger[]).find((t) => BOSS_LINES[boss][t] === m.line);
      if (boss && trigger) void playBossLine(this.game.audio, boss, trigger);
    }
    if (m.type === "defeat") this.bossDefeatedAt = now;
    if (m.type === "respawn" || m.type === "reset") this.bossDefeatedAt = 0;
  }

  private playerPos(id: string): THREE.Vector3 | null {
    const room = this.game.net.room;
    if (!room) return null;
    if (id === room.sessionId) return this.game.player.pos;
    const p = (room.state as any)?.players?.get(id);
    return p ? new THREE.Vector3(p.x, p.y, p.z) : null;
  }

  // ------------------------------------------------------------------------------------ frame

  update(dt: number, now: number) {
    const cam = this.game.ctx.camera;
    const me = this.game.player.pos;
    const myId = this.game.net.room?.sessionId ?? "";
    this.batch.begin();
    this.bars.begin();
    let boss: View | null = null;
    // Portus: inside the town walls (away from the gates, below the wall tops) the creeps outside
    // can't be seen, so none are drawn and the NPC batches stay hidden (townCull.ts).
    const terrain = this.game.planet.terrain;
    const hidden = creepsHiddenByTown(this.game.planet.body, cam.position.x, cam.position.y, cam.position.z, (x, y, z) => terrain.groundHeight(x, y, z));
    for (const [id, v] of this.views) {
      if (v.gone && (!v.dyingAt || now - v.dyingAt > 1100)) {
        if (!v.dyingAt && v.dist < 70) this.particles.burst(v.pos, v.pm.model.fx, 10, { radius: v.def.radius, height: v.pm.height, life: 0.6 });
        this.views.delete(id);
        continue;
      }
      this.sample(v, now);
      const ref = v.ref;
      if (!v.gone) {
        if (ref.anim !== v.anim) {
          v.anim = ref.anim;
          v.animAt = now;
        }
        v.flags = ref.flags;
      }
      if (!v.dyingAt && v.flags & NF.DEAD) {
        v.dyingAt = now;
        const big = v.def.family === "boss";
        this.particles.burst(v.pos, v.pm.model.fx, big ? 260 : Math.min(140, 18 + Math.round(v.pm.height * v.def.radius * 14)), { pixels: v.pm.model.pixels, radius: Math.max(0.4, v.def.radius), height: v.pm.height, speed: big ? 4 : 2.4, life: big ? 1.8 : 1.1 });
      }
      v.dist = v.pos.distanceTo(me);
      const moved = v.pos.distanceTo(v.lastPos);
      v.lastPos.copy(v.pos);
      const inst = dt > 0 ? Math.min(30, moved / dt) : 0;
      v.speed += (inst - v.speed) * Math.min(1, dt * 8);
      v.walk += moved * (v.pm.model.gait ?? 1.5);
      if (v.def.family === "boss" && !v.dyingAt) boss = v;
      if (v.dist > 150 || hidden) continue;
      this.drawView(v, now, dt);
      // Health bar over NPCs being fought (bosses use the HUD bar).
      if (v.def.family !== "boss" && !v.dyingAt && !(v.flags & NF.SPAWNING)) {
        const fighting = now - v.hitAt < 6000 || ref.target === myId || ((v.flags & NF.AGGRO) !== 0 && v.dist < 25);
        if (fighting && v.dist < 60) {
          _v.copy(v.pos).addScaledVector(v.up, v.pm.height * this.scaleOf(v, now) + (v.def.hover ? 0 : 0.35) + 0.25);
          const w = Math.min(2.6, Math.max(0.8, v.def.radius * 1.8));
          this.bars.push(_v, ref.hp / Math.max(1, ref.maxHp), cam, w, v.def.temper === "hostile" || (v.flags & NF.AGGRO) !== 0);
        }
      }
      // Ranged lock-on line (amber).
      if (v.lock) {
        if (now > v.lock.until) v.lock = null;
        else {
          const tp = this.playerPos(v.lock.target);
          if (tp) this.beam(_v.copy(v.pos).addScaledVector(v.up, Math.min(1.6, v.pm.height * 0.7)), _v2.copy(tp).addScaledVector(tp.clone().normalize(), 1.1), 0.03, _c.setHex(v.lock.color).multiplyScalar(3));
        }
      }
    }
    this.drawShots(now);
    this.arena?.draw(this.batch, me, now);
    this.batch.end();
    this.bars.end();
    this.telegraphs.update(now);
    this.particles.update(dt);
    this.applyPulls(dt, now);
    this.applyEffects(now);
    this.updateBoss(boss, me, now);
    (window as unknown as { __npc: unknown }).__npc = { views: this.views.size, draws: this.batch.drawCalls() + this.telegraphs.count + 4, decals: this.telegraphs.count };
  }

  private scaleOf(v: View, now: number): number {
    if (v.dyingAt) return Math.max(0, 1 - (now - v.dyingAt) / 900);
    if (v.flags & NF.SPAWNING) return Math.min(1, Math.max(0.05, (now - v.born) / 1000));
    return 1;
  }

  private drawView(v: View, now: number, dt: number) {
    const pm = v.pm;
    const model = pm.model;
    const t = now / 1000 + v.seed;
    const anim = v.anim;
    const moving = v.speed > 0.4;
    const scale = this.scaleOf(v, now);
    if (scale <= 0.01) return;
    // Root transform: basis (right, up, fwd), style offsets, tilts.
    _right.crossVectors(v.up, v.fwd);
    _basis.makeBasis(_right, v.up, v.fwd);
    _q.setFromRotationMatrix(_basis);
    let lift = 0, pitch = 0, roll = 0, sy = 1, sxz = 1;
    const windup = anim === NPC_ANIM.WINDUP;
    const wk = windup ? Math.min(1, (now - Math.max(v.animAt, v.teleAt)) / Math.max(200, v.teleMs)) : 0;
    switch (model.style) {
      case "hop":
        if (moving) lift = Math.abs(Math.sin(v.walk * 0.5)) * 0.35;
        if (windup) {
          sy = 1 - 0.32 * wk;
          sxz = 1 + 0.14 * wk;
        }
        break;
      case "walk":
        lift = moving ? Math.abs(Math.sin(v.walk)) * 0.05 : 0;
        pitch = moving ? Math.min(0.15, v.speed * 0.02) : 0;
        break;
      case "hover":
        lift = Math.sin(t * 2.2) * 0.15;
        pitch = Math.min(0.3, v.speed * 0.05);
        break;
      case "float":
        lift = Math.sin(t * 1.6) * 0.3;
        roll = Math.sin(t * 1.1) * 0.15;
        break;
      case "heavy":
        lift = moving ? Math.abs(Math.sin(v.walk)) * 0.08 : 0;
        break;
      case "swim":
        lift = Math.sin(t * 0.8) * 0.25;
        roll = Math.sin(t * 0.5) * 0.03;
        break;
      case "roll":
        if (anim === NPC_ANIM.DASH) v.roll += (v.speed * dt) / 1.75;
        else v.roll *= Math.max(0, 1 - dt * 3);
        break;
    }
    if (windup && model.style !== "hop") pitch -= 0.08 * wk;
    if (anim === NPC_ANIM.STRIKE && now - v.animAt < 300) pitch += 0.14;
    if (anim === NPC_ANIM.STUN) roll += Math.sin(t * 10) * 0.12;
    if (anim === NPC_ANIM.KNEEL) {
      lift -= pm.height * 0.12;
      pitch += 0.22;
    }
    if (v.dyingAt) lift += (now - v.dyingAt) / 900;
    _e.set(pitch, 0, roll);
    _q2.setFromEuler(_e);
    _q.multiply(_q2);
    _v.copy(v.pos).addScaledVector(v.up, lift);
    _s.set(scale * sxz, scale * sy, scale * sxz);
    _root.compose(_v, _q, _s);

    // Colour modifiers.
    const sinceHit = now - v.hitAt;
    let flash = sinceHit < 130 ? 0.65 * (1 - sinceHit / 130) : 0;
    if (windup && v.teleColor === 3) flash = Math.max(flash, 0.35 + 0.35 * Math.sin(now / 45));
    if (v.dyingAt) flash = Math.max(flash, Math.min(1, (now - v.dyingAt) / 500));
    const glowBoost = windup ? 1.6 + 0.6 * wk : 1;
    const weakOpen = (v.flags & NF.WEAK_OPEN) !== 0;
    const evading = (v.flags & NF.EVADING) !== 0;
    const detail = v.dist < DETAIL_DISTANCE;
    const segs = v.def.segments ? Math.ceil((v.ref.hp / Math.max(1, v.ref.maxHp)) * v.def.segments) : 99;

    // Per-part animation channels.
    const gait = Math.sin(v.walk);
    const sw = Math.min(1, v.speed / 3) * 0.6;
    let armRaise = 0;
    if (windup) armRaise = -1.7 * wk;
    else if (anim === NPC_ANIM.STRIKE) armRaise = 0.7 * Math.max(0, 1 - (now - v.animAt) / 350);
    else if (anim === NPC_ANIM.CHANNEL) armRaise = -1.2 + Math.sin(t * 6) * 0.15;
    const headPitch = anim === NPC_ANIM.GRAZE ? 0.35 + 0.2 * Math.sin(t * 1.3) : anim === NPC_ANIM.HOWL ? -0.65 : windup && v.def.family !== "boss" ? 0.3 * wk : Math.sin(t * 1.7) * 0.04;
    const jaw = windup ? 0.45 * wk : anim === NPC_ANIM.HOWL ? 0.5 : 0.04 + Math.sin(t * 3) * 0.03;
    const flap = model.style === "hover" ? Math.sin(t * 28) * 0.7 : windup ? 1.1 * wk : 0;

    for (const p of pm.parts) {
      const d = p.def;
      if (d.d && !detail) continue;
      if (d.seg !== undefined && d.seg >= segs) continue;
      if (d.tag === "shield" && !(v.flags & NF.SHIELD)) continue;
      if (d.tag === "aura" && !(v.flags & NF.BUFFED) && v.def.id !== "compliance_officer") continue;
      let local = p.base;
      if (d.a === "pulse") {
        const k = 1 + 0.15 * Math.sin(t * 8);
        _s.copy(p.scale).multiplyScalar(k);
        local = _m2.compose(p.pos, p.quat, _s);
      } else if (d.seg !== undefined) {
        const off = Math.sin(t * 6 - d.seg * 0.9) * (moving ? 0.28 : 0.08);
        local = _m2.makeTranslation(off, 0, 0).multiply(p.base);
      } else if (d.a) {
        let rx = 0, ry = 0, rz = 0;
        switch (d.a) {
          case "legL": rx = gait * sw; break;
          case "legR": rx = -gait * sw; break;
          case "legL2": rx = -gait * sw; break;
          case "legR2": rx = gait * sw; break;
          case "armL": rx = -gait * sw * 0.6 + (v.def.family === "boss" ? armRaise * 0.4 : armRaise * 0.25); break;
          case "armR": rx = gait * sw * 0.6 + armRaise; break;
          case "wingL": rz = flap; break;
          case "wingR": rz = -flap; break;
          case "head": rx = headPitch; break;
          case "jaw": rx = jaw; break;
          case "tail": ry = Math.sin(t * 6) * 0.35; break;
          case "spin": ry = t * 14; break;
          case "roll": rx = v.roll; break;
        }
        const pv = p.pivot ?? p.pos;
        _e.set(rx, ry, rz);
        _q2.setFromEuler(_e);
        _anim.makeRotationFromQuaternion(_q2);
        _m.makeTranslation(pv.x, pv.y, pv.z).multiply(_anim);
        _m.multiply(_m2.makeTranslation(-pv.x, -pv.y, -pv.z));
        local = _m.multiply(p.base);
      }
      const world = _world.multiplyMatrices(_root, local);
      let r = p.r, g = p.g, b = p.b;
      if (p.glow) {
        let k = glowBoost;
        if (d.tag === "weak") k *= weakOpen ? 3.2 + Math.sin(t * 9) : 0.45;
        r *= k;
        g *= k;
        b *= k;
      }
      if (evading) {
        r = r * 0.6 + 0.2;
        g = g * 0.6 + 0.24;
        b = b * 0.6 + 0.32;
      }
      if (flash > 0) {
        const w = p.glow ? 3 : 1;
        r += (w - r) * flash;
        g += (w - g) * flash;
        b += (w - b) * flash;
      }
      this.batch.push(d.g, d.m, world, r, g, b);
    }
  }

  /** A glowing cylinder between two points (lock-on lines, tracers). */
  private beam(a: THREE.Vector3, b: THREE.Vector3, width: number, color: THREE.Color) {
    _ba.copy(a);
    _bb.copy(b);
    _bd.copy(_bb).sub(_ba);
    const len = _bd.length();
    if (len < 0.01) return;
    _bq.setFromUnitVectors(Y, _bd.divideScalar(len));
    _bs.set(width, len, width);
    _bm.compose(_ba.add(_bb).multiplyScalar(0.5), _bq, _bs);
    this.batch.push("cyl", "glow", _bm, color.r, color.g, color.b);
  }

  private drawShots(now: number) {
    for (let i = this.shots.length - 1; i >= 0; i--) {
      const s = this.shots[i]!;
      if (now > s.until) {
        this.shots.splice(i, 1);
        continue;
      }
      if (s.tracer) {
        const k = 1 - (now - s.t0) / Math.max(1, s.until - s.t0);
        this.beam(s.x, s.v, s.size, _c.copy(s.color).multiplyScalar(k));
        continue;
      }
      const t = (now - s.t0) / 1000;
      _v.copy(s.x).addScaledVector(s.v, t).addScaledVector(s.up, -0.5 * s.g * t * t);
      _q.identity();
      _s.setScalar(s.size);
      _root.compose(_v, _q, _s);
      this.batch.push("sph", "glow", _root, s.color.r, s.color.g, s.color.b);
    }
  }

  // ------------------------------------------------------------------------------------ effects on the local player

  private applyPulls(dt: number, now: number) {
    const p = this.game.player.pos;
    for (let i = this.pulls.length - 1; i >= 0; i--) {
      const pull = this.pulls[i]!;
      if (now > pull.until) {
        this.pulls.splice(i, 1);
        continue;
      }
      const up = _v.copy(p).normalize();
      const d = _v2.copy(pull.c).sub(p);
      d.addScaledVector(up, -d.dot(up));
      const l = d.length();
      if (l > 0.3) p.addScaledVector(d.divideScalar(l), Math.min(l, pull.speed * dt));
    }
  }

  private applyEffects(now: number) {
    let slow = 0;
    let noSprint = false;
    for (let i = this.effects.length - 1; i >= 0; i--) {
      const e = this.effects[i]!;
      if (now > e.until) {
        this.effects.splice(i, 1);
        continue;
      }
      if (e.kind === "chill" || e.kind === "slow") slow = Math.max(slow, e.amount);
      if (e.kind === "nosprint") noSprint = true;
    }
    // Prediction of what the server enforces (npc/effects.ts): slower, no sprint, no dodge burst.
    MOVE.run = this.baseMove.run * (1 - slow);
    MOVE.sprint = noSprint ? MOVE.run : this.baseMove.sprint * (1 - slow);
    MOVE.dodgeDistance = noSprint ? 0 : this.baseMove.dodge * (1 - slow);
    MOVE.slow = slow; // riding (game/mount.ts mountedSpeed)
    MOVE.noSprint = noSprint;
  }

  // ------------------------------------------------------------------------------------ boss HUD

  private updateBoss(v: View | null, me: THREE.Vector3, now: number) {
    const a = this.arena?.layout ?? null;
    const atLair = !!a && me.distanceTo(_v.set(...a.centre)) <= a.radius + 30;
    let next: BossHud | null = null;
    if (v) {
      const ref = v.ref;
      next = {
        id: v.id,
        boss: v.def.id,
        name: v.def.name,
        hp: ref.hp,
        maxHp: ref.maxHp,
        phase: ref.phase || 1,
        engaged: this.bossEngaged,
        weak: (v.flags & NF.WEAK_OPEN) !== 0,
        visible: atLair || ((v.flags & NF.ENGAGED) !== 0 && v.dist < 90),
        voice: this.bossVoice,
        defeatedAt: 0,
      };
    } else if (this.bossLast && this.bossDefeatedAt && now - this.bossDefeatedAt < 6000) {
      next = { ...this.bossLast, hp: 0, defeatedAt: Date.now() - (now - this.bossDefeatedAt), voice: this.bossVoice };
    } else if (this.bossVoice && Date.now() - this.bossVoice.at < 6000 && this.bossLast) {
      next = { ...this.bossLast, voice: this.bossVoice };
    }
    if (next && v) this.bossLast = next;
    bossStore.set(next);
  }

  dispose() {
    this.game.net.room?.onStateChange.remove(this.onState);
    for (const off of this.offs) off();
    MOVE.run = this.baseMove.run;
    MOVE.sprint = this.baseMove.sprint;
    MOVE.dodgeDistance = this.baseMove.dodge;
    MOVE.slow = 0;
    MOVE.noSprint = false;
    this.batch.dispose();
    this.particles.dispose();
    this.telegraphs.dispose();
    this.bars.dispose();
    this.root.removeFromParent();
    this.views.clear();
    bossStore.set(null);
  }
}
