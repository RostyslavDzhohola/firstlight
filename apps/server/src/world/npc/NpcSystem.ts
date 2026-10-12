// The NPC system of one body room: spawn points that wake up near players, the AI tick for every
// enemy, critter and beast, the boss of the body, kill rewards, and an admin `npc` message for tests
// and staged scenes. Registered in SYSTEM_FACTORIES (../systems.ts).

import { bossArena, type ArenaLayout } from "@firstlight/shared/content/arenas";
import {
  AI_CAPS, BOSS_BY_BODY, NF, NPC_ANIM, NPC_DEFS, NPC_INDEX, NPC_RULES,
  aiHitCap, npcMaxHp, npcShieldHp, type PlanetId, type StatusEffect,
} from "@firstlight/shared/content/npcs";
import { PF } from "@firstlight/shared/net/schema";
import { actorPos, type NpcActor, type PlayerActor } from "../actors.ts";
import { dealDamage } from "../combat.ts";
import { loadCopy, saveCopy } from "../copyState.ts";
import type { V3 } from "../geometry.ts";
import type { RoomSystem } from "../systems.ts";
import { chest, stepNpcProjectiles, type NpcProjectile } from "./attacks.ts";
import { BossController } from "./boss.ts";
import { onNpcHurt, think } from "./brain.ts";
import { NPC_COPY_SYSTEM, restoreNpcCopy, snapshotNpcCopy, type NpcCopyState } from "./persist.ts";
import { MODE, MODE_NAME, type Mode, type Npc } from "./npc.ts";
import { pruneRewardMaps, rewardKill } from "./rewards.ts";
import { activePull, applyMoveEffect, applyPull } from "./effects.ts";
import { buildSpawnPoints, type SpawnPoint } from "./spawns.ts";
import { makeGround, placeOnGround, type Ground } from "./steer.ts";
import { NPC_TUNING } from "./tuning.ts";
import { dist, dist2, dot, flatDist, len, stableTangentAt, tangentDir, tangentize, up } from "./vec.ts";
import { walk } from "@firstlight/shared/content/arenas";
import type { NpcWorld } from "./world.ts";

export interface LivePlayer {
  a: PlayerActor;
  pos: V3;
  /** Inside a safe zone or under spawn protection: NPCs ignore them. */
  untouchable: boolean;
}

interface GroupState {
  point: SpawnPoint;
  active: boolean;
  members: (Npc | null)[];
  dead: boolean[];
  cleared: boolean;
  respawnLeft: number;
  lastNearAt: number;
}

interface TokenBook {
  melee: { npc: string; until: number }[];
  ranged: { npc: string; until: number }[];
  lastRelease: number;
}

/** Gunfire/explosion noise heard within NPC_RULES.noiseRadius. */
interface Noise {
  pos: V3;
  by: string;
  at: number;
  explosion: boolean;
}

/** Egg NPC timers (tests shorten them): a Golden Hopbit that was popped or ran into its burrow stays away this long. */
export const EGG_NPC = { goldenBackMs: 15 * 60_000 };

export class NpcSystem implements RoomSystem {
  readonly world: NpcWorld;
  readonly ground: Ground;
  readonly planet: PlanetId | null;
  readonly arena: ArenaLayout | null;
  readonly points: SpawnPoint[];
  readonly groups: GroupState[];
  readonly npcs = new Map<string, Npc>();
  readonly boss: BossController | null;
  readonly projectiles: NpcProjectile[] = [];
  live: LivePlayer[] = [];
  noises: Noise[] = [];
  ambientOn = NPC_TUNING.ambient;
  now = 0;
  tickNo = 0;
  /** Measured AI cost (ms) of the last tick and an exponential average. */
  lastTickMs = 0;
  avgTickMs = 0;
  private seq = 0;
  private lastScan = 0;
  private lastPrune = 0;
  private readonly tokens = new Map<string, TokenBook>();
  private readonly recentHits = new Map<string, { t: number; amt: number }[]>();
  readonly tagged = new Map<string, number>();
  readonly repeatKills = new Map<string, number[]>();
  readonly cosmeticPity = new Map<string, { life: number; kills: number; at: number }>();
  /** Spawn point id → when its Golden Hopbit may come back (it doesn't return with every pack respawn). */
  readonly goldenBack = new Map<number, number>();
  private grid = new Map<number, Npc[]>();
  private readonly restore: (() => void)[] = [];
  /** Copy state (boss timer, cleared groups) changed since the last save (persist.ts). */
  copyDirty = false;
  private lastCopySave = 0;

  constructor(world: NpcWorld) {
    this.world = world;
    this.ground = makeGround(world.terrain);
    this.planet = world.body.terrain.kind === "hub" ? null : (world.body.id as PlanetId);
    this.arena = this.planet ? bossArena(world.terrain) : null;
    this.points = this.planet ? buildSpawnPoints(world.terrain, this.arena) : [];
    this.groups = this.points.map((p) => ({ point: p, active: false, members: p.members.map(() => null), dead: p.members.map(() => false), cleared: false, respawnLeft: 0, lastNearAt: 0 }));
    const bd = BOSS_BY_BODY[world.body.id];
    this.boss = bd && this.arena ? new BossController(this, bd, this.arena) : null;
    // A fresh room on a copy that was emptied or restarted keeps its dead boss and cleared groups (F12 B2).
    if (world.copyKey) restoreNpcCopy(this, loadCopy<NpcCopyState>(world.copyKey, NPC_COPY_SYSTEM), world.now());
    this.hookNoise();
    world.onMessage("npc", (sid, msg) => this.admin(sid, msg));
    world.onMessage("phrase", (sid, msg) => this.onPhrase(sid, msg));
    // The client's NPC layer asks for the lair state once its handlers exist (late joiners).
    world.onMessage("npcSync", (sid) => this.boss?.sendSnapshot(sid));
  }

  // ------------------------------------------------------------------------------------ lifecycle

  tick(dtMs: number, now: number) {
    const t0 = performance.now();
    this.now = now;
    this.tickNo++;
    const dt = dtMs / 1000;
    this.refreshLive(now);
    this.stepPulls(now, dt);
    if (this.noises.length) this.noises = this.noises.filter((n) => now - n.at < 400);
    if (now - this.lastScan >= NPC_TUNING.scanMs) {
      const sdt = this.lastScan ? (now - this.lastScan) / 1000 : 0;
      this.lastScan = now;
      this.scan(now, sdt);
      this.auras();
    }
    if (now - this.lastPrune >= 60_000) {
      this.lastPrune = now;
      pruneRewardMaps(this, now);
    }
    this.boss?.tick(now, dt);
    this.buildGrid();
    for (const n of this.npcs.values()) {
      if (n.removeAt && now >= n.removeAt) {
        this.despawnNpc(n);
        continue;
      }
      if (n.expiresAt && now >= n.expiresAt && !n.dead) {
        this.dissolve(n, now);
        continue;
      }
      n.nearD = this.nearestLive(n.pos);
      const calm = n.mode === MODE.IDLE || n.mode === MODE.WANDER || n.mode === MODE.RETURN;
      if (calm && n.nearD > 70 && (this.tickNo + n.lod) % 4 !== 0) continue;
      const step = Math.min(0.25, n.lastUpdate ? (now - n.lastUpdate) / 1000 : dt);
      n.lastUpdate = now;
      if (n.boss && this.boss) this.boss.think(n, now, step);
      else think(this, n, now, step);
      this.sync(n);
    }
    stepNpcProjectiles(this, now, dt);
    if (this.copyDirty && now - this.lastCopySave >= 1000) this.saveCopyState(now);
    this.lastTickMs = performance.now() - t0;
    this.avgTickMs = this.avgTickMs * 0.95 + this.lastTickMs * 0.05;
  }

  onPlayerLeave(sessionId: string) {
    this.tokens.delete(sessionId);
    this.recentHits.delete(sessionId);
    for (const n of this.npcs.values()) if (n.target?.id === sessionId) n.target = null;
    this.boss?.forget(sessionId);
  }

  dispose() {
    for (const r of this.restore) r();
    this.restore.length = 0;
    this.boss?.dispose();
    this.saveCopyState(this.world.now());
  }

  /** Remember the boss timer and group state for the next room on this copy (copyState.ts). */
  saveCopyState(now: number) {
    this.copyDirty = false;
    this.lastCopySave = now;
    if (this.world.copyKey) saveCopy(this.world.copyKey, NPC_COPY_SYSTEM, snapshotNpcCopy(this, now));
  }

  private refreshLive(now: number) {
    const out: LivePlayer[] = [];
    for (const a of this.world.players()) {
      if (a.dead || a.state.hp <= 0) continue;
      out.push({ a, pos: actorPos(a), untouchable: (a.state.flags & PF.SAFE) !== 0 || a.protectedUntil > now });
    }
    this.live = out;
  }

  nearestLive(p: V3): number {
    let best = Infinity;
    for (const l of this.live) {
      const d = dist2(p, l.pos);
      if (d < best) best = d;
    }
    return Math.sqrt(best);
  }

  // ------------------------------------------------------------------------------------ spawn points

  private scan(now: number, sdt: number) {
    const act = NPC_TUNING.activateRadius;
    // Wake at most this many NPCs per scan so a crowd arriving doesn't spike one tick.
    let budget = NPC_TUNING.spawnBudget;
    for (const g of this.groups) {
      const near = this.nearestLiveAny(g.point.pos);
      // Wake within activateRadius; stay awake while anyone is within the (larger) despawn radius.
      if (near <= (g.active ? NPC_TUNING.despawnRadius : act)) g.lastNearAt = now;
      if (g.cleared) {
        const slow = near <= NPC_RULES.respawnSlowRadius;
        g.respawnLeft -= sdt * (slow ? 0.5 : 1);
        // A slowed countdown drifts from wall time: checkpoint it (≤ 1/s) so a crash can't respawn it early.
        if (slow && sdt > 0) this.copyDirty = true;
        if (g.respawnLeft <= 0) {
          g.cleared = false;
          g.dead.fill(false);
          this.copyDirty = true;
        }
      }
      // A Golden Hopbit whose own timer ran out comes back to its pack while the pack is still out.
      const back = this.goldenBack.get(g.point.id);
      if (back !== undefined && now >= back && g.active && !g.cleared) this.returnGolden(g, now);
      if (!g.active && !g.cleared && this.ambientOn && near <= act && budget > 0) {
        this.spawnGroup(g, now);
        budget -= g.point.members.length;
      }
      else if (g.active && now - g.lastNearAt > NPC_TUNING.despawnAfterMs && !g.members.some((m) => m && m.target)) this.despawnGroup(g);
    }
  }

  /** Nearest player of any kind (alive, connected or lingering) — spawning only needs presence. */
  private nearestLiveAny(p: V3): number {
    return this.nearestLive(p);
  }

  private spawnGroup(g: GroupState, now: number) {
    g.active = true;
    const pt = g.point;
    for (let i = 0; i < pt.members.length; i++) {
      if (g.dead[i] || g.members[i]) continue;
      const m = pt.members[i]!;
      if (m.golden && now < (this.goldenBack.get(pt.id) ?? 0)) {
        g.dead[i] = true; // still away: the pack comes back without it
        continue;
      }
      const def = NPC_DEFS[m.def]!;
      const d = walk(pt.dir, pt.t1, m.a, pt.t2, m.b, this.ground.R);
      const R = this.ground.R;
      let pos = placeOnGround(this.ground, [d[0] * R, d[1] * R, d[2] * R], def.locomotion, def.hover ?? 0);
      if (def.locomotion !== "hover" && len(pos) - R < this.ground.water - 0.6 && def.locomotion === "ground") pos = placeOnGround(this.ground, pt.pos, def.locomotion, def.hover ?? 0);
      const n = this.createNpc(m.def, m.level, pos, now, { point: pt, member: i, roam: pt.roam });
      if (m.golden) n.state.flags |= NF.GOLDEN;
      if (def.id === "ticket_000" || def.id === "crypt_sentinel" && pt.kind === "single") n.facing = stableTangentAt(pos);
      g.members[i] = n;
    }
  }

  private returnGolden(g: GroupState, now: number) {
    this.goldenBack.delete(g.point.id);
    this.copyDirty = true;
    const i = g.point.members.findIndex((m) => m.golden);
    if (i < 0 || !g.dead[i] || g.members[i]) return;
    g.dead[i] = false;
    this.spawnGroup(g, now);
  }

  private despawnGroup(g: GroupState) {
    g.active = false;
    for (let i = 0; i < g.members.length; i++) {
      const n = g.members[i];
      if (n) this.despawnNpc(n);
      g.members[i] = null;
    }
  }

  private groupOf(n: Npc): GroupState | null {
    return n.point ? this.groups[n.point.id] ?? null : null;
  }

  /** Create and register an NPC (ambient member, summon, admin spawn or boss). */
  createNpc(
    defIndex: number,
    level: number,
    pos: V3,
    now: number,
    opts: { point?: SpawnPoint | null; member?: number; roam?: number; boss?: boolean; summoner?: string; instant?: boolean; spawned?: Npc["spawned"]; ttlMs?: number } = {},
  ): Npc {
    const def = NPC_DEFS[defIndex]!;
    const state = this.world.newNpcState();
    const hp = npcMaxHp(def, level);
    state.kind = defIndex;
    state.level = level;
    state.maxHp = hp;
    state.hp = hp;
    state.x = pos[0];
    state.y = pos[1];
    state.z = pos[2];
    const facing = stableTangentAt(pos);
    state.fx = facing[0];
    state.fy = facing[1];
    state.fz = facing[2];
    state.anim = opts.instant ? NPC_ANIM.IDLE : NPC_ANIM.SPAWN;
    state.flags = (opts.instant ? 0 : NF.SPAWNING | NF.INVULN) | (def.tier === "elite" ? NF.ELITE : 0);
    const shield = npcShieldHp(def, level);
    if (shield > 0) state.flags |= NF.SHIELD;
    const id = `${opts.boss ? "b" : "n"}${(++this.seq).toString(36)}`;
    const n: Npc = {
      kind: "npc",
      id,
      state,
      history: [],
      radius: def.radius,
      height: def.height,
      boss: !!opts.boss,
      def,
      defIndex,
      level,
      point: opts.point ?? null,
      member: opts.member ?? -1,
      pos: [pos[0], pos[1], pos[2]],
      home: [pos[0], pos[1], pos[2]],
      anchor: [pos[0], pos[1], pos[2]],
      roam: opts.roam ?? 8,
      facing,
      mode: opts.instant ? MODE.IDLE : MODE.SPAWN,
      modeAt: now,
      modeUntil: now + NPC_RULES.spawnSeconds * 1000,
      target: null,
      lastSeenAt: 0,
      lastLosAt: 0,
      damage: new Map(),
      attack: null,
      cooldowns: def.attacks.map(() => now + 500 + Math.random() * 1000),
      token: null,
      goal: null,
      nextThink: now + Math.random() * 400,
      stunUntil: 0,
      shieldHp: shield,
      shieldMax: shield,
      scatterUntil: 0,
      removeAt: 0,
      raiseNext: now + (def.raise ? def.raise.every * 1000 : 0),
      raised: new Set(),
      summoner: opts.summoner ?? null,
      howled: false,
      fleeFrom: null,
      regroupAt: 0,
      nearD: Infinity,
      lod: this.seq & 3,
      lastUpdate: 0,
      hpAcc: 0,
      gridAxis: -1,
      strafeSign: this.seq & 1 ? 1 : -1,
      spawned: opts.spawned ?? null,
      expiresAt: opts.ttlMs ? now + opts.ttlMs : 0,
      dead: false,
    };
    n.onDamaged = (amount, by) => this.onDamaged(n, amount, by);
    n.onKilled = (by) => this.onKilled(n, by);
    n.mitigate = (amount, weak, fromDir, attacker) => this.mitigate(n, amount, weak, fromDir, attacker);
    this.npcs.set(id, n);
    this.world.addNpc(n);
    return n;
  }

  /** Live NPCs raised by egg penalties or staged scenes in this room, or only those one account raised. */
  spawnedCount(reason: "egg" | "stage", userId?: string): number {
    let k = 0;
    for (const n of this.npcs.values()) if (n.spawned?.reason === reason && !n.dead && (userId === undefined || n.spawned.userId === userId)) k++;
    return k;
  }

  /** Remove an NPC without rewards (despawn, egg exit, reset). */
  despawnNpc(n: Npc) {
    if (!this.npcs.has(n.id)) return;
    this.releaseToken(n);
    n.attack = null;
    this.npcs.delete(n.id);
    this.world.removeNpc(n.id);
    const g = this.groupOf(n);
    if (g && g.members[n.member] === n) g.members[n.member] = null;
    if (n.summoner) this.npcs.get(n.summoner)?.raised.delete(n.id);
    this.dissolveChildren(n);
  }

  /** Raised helpers (Cantor's Bonewalkers) crumble with their summoner. */
  private dissolveChildren(n: Npc) {
    if (!n.raised.size) return;
    const now = this.world.now();
    for (const id of [...n.raised]) {
      const c = this.npcs.get(id);
      if (c) this.dissolve(c, now);
    }
    n.raised.clear();
  }

  /** Dissolve into light without rewards (the client plays the death effect). */
  dissolve(c: Npc, now: number) {
    if (c.dead) return;
    c.dead = true;
    c.attack = null;
    this.releaseToken(c);
    this.setMode(c, MODE.DEAD, now);
    c.state.flags = (c.state.flags | NF.DEAD) & ~(NF.TELEGRAPH | NF.AGGRO);
    c.state.anim = NPC_ANIM.DEAD;
    c.state.target = "";
    c.removeAt = now + 1200;
    this.dissolveChildren(c);
  }

  /** Remove an NPC as if it died, without rewards (egg exits, Ticket #000 vanishing). */
  retire(n: Npc) {
    if (n.dead) return;
    n.dead = true;
    if (n.def.id === "golden_hopbit" && n.point) {
      this.goldenBack.set(n.point.id, this.world.now() + EGG_NPC.goldenBackMs);
      this.copyDirty = true; // the return time outlives the room (persist.ts)
    }
    const g = this.groupOf(n);
    if (g) {
      g.dead[n.member] = true;
      if (g.dead.every((d) => d)) {
        g.cleared = true;
        g.active = false;
        g.respawnLeft = g.point.respawnSec * NPC_TUNING.respawnScale;
      }
      this.copyDirty = true;
    }
    this.despawnNpc(n);
  }

  // ------------------------------------------------------------------------------------ damage hooks

  private mitigate(n: Npc, amount: number, weak: boolean, fromDir?: V3, attacker?: PlayerActor | NpcActor | null): number {
    if (n.dead || n.state.flags & NF.INVULN) return 0;
    if (n.boss && this.boss) return this.boss.mitigate(n, amount, weak, attacker);
    if (n.shieldHp > 0 && fromDir) {
      const f = tangentize(n.pos, fromDir);
      if (dot(f, n.facing) > 0.25) {
        n.shieldHp = Math.max(0, n.shieldHp - amount);
        if (n.shieldHp <= n.shieldMax / 2) n.state.flags |= NF.SHIELD_CRACKED;
        if (n.shieldHp <= 0) n.state.flags &= ~(NF.SHIELD | NF.SHIELD_CRACKED);
        return 0;
      }
    }
    return amount * (n.def.armour ?? 1);
  }

  /** `amount` is HP actually removed (combat caps it by the HP before the hit). */
  private onDamaged(n: Npc, amount: number, by: string) {
    const p = by ? this.world.playerById(by) : undefined;
    if (p && amount > 0) {
      const uid = p.identity.userId;
      const e = n.damage.get(uid);
      if (e) {
        e.amount += amount;
        e.sid = p.id;
      } else n.damage.set(uid, { amount, userId: uid, sid: p.id, name: p.identity.name });
    }
    if (n.boss && this.boss) {
      this.boss.onDamaged(n, amount, p ?? null);
      return;
    }
    onNpcHurt(this, n, p ?? null, this.now || this.world.now());
  }

  private onKilled(n: Npc, by: string | null) {
    if (n.dead) return;
    const now = this.world.now();
    n.dead = true;
    n.attack = null;
    this.releaseToken(n);
    this.setMode(n, MODE.DEAD, now);
    n.state.flags = (n.state.flags | NF.DEAD) & ~(NF.TELEGRAPH | NF.AGGRO);
    n.state.anim = NPC_ANIM.DEAD;
    n.state.target = "";
    n.removeAt = now + (n.boss ? 2500 : 1200);
    if (n.boss && this.boss) {
      this.boss.onKilled(n, by, now);
      this.copyDirty = true;
      return;
    }
    const g = this.groupOf(n);
    if (g) {
      g.dead[n.member] = true;
      if (g.dead.every((d) => d)) {
        g.cleared = true;
        g.active = false;
        g.respawnLeft = g.point.respawnSec * NPC_TUNING.respawnScale;
      }
      this.copyDirty = true;
    }
    if (n.summoner) this.npcs.get(n.summoner)?.raised.delete(n.id);
    this.dissolveChildren(n);
    if (n.def.family === "egg") return; // eggs pay through their own rules (brain.ts)
    rewardKill(this, n, by, now);
  }

  // ------------------------------------------------------------------------------------ helpers for the brain

  setMode(n: Npc, mode: Mode, now: number, until = 0) {
    n.mode = mode;
    n.modeAt = now;
    n.modeUntil = until;
  }

  /**
   * Damage a player from an NPC with the AI caps (content §0), buffs and status effects. `src` is
   * where a ranged hit comes from (rounds, lobbed splash): a Prism Bubble shell between it and the
   * player's chest takes the hit instead. Melee passes no `src`; true damage ignores bubbles.
   */
  hitPlayer(n: Npc | null, p: PlayerActor, amount: number, opts: { fromDir?: V3; knockback?: number; effect?: StatusEffect; trueDamage?: boolean; src?: V3 } = {}): number {
    const now = this.world.now();
    if (p.dead) return 0;
    if (opts.src && !opts.trueDamage && this.world.host.bubbles) {
      const shell = this.world.host.bubbles.between(opts.src, chest(actorPos(p)));
      if (shell) {
        this.world.host.bubbles.absorb(shell, amount);
        return 0;
      }
    }
    // Contact: an NPC that just struck its target can reach it (brain.ts unreachable timer).
    if (n && n.target === p) n.unreachSince = undefined;
    let dmg = amount;
    if (n && !opts.trueDamage) {
      if (n.state.flags & NF.BUFFED) dmg *= 1.15;
      if (n.def.family === "oversight" || n.def.id === "the_receiver") {
        const tag = this.tagged.get(p.id);
        if (tag && tag > now) dmg *= 1.25;
      }
      const maxHp = p.state.maxHp;
      dmg = Math.min(dmg, aiHitCap(n.def.tier, maxHp));
      const list = this.recentHits.get(p.id) ?? [];
      const recent = list.filter((h) => now - h.t < AI_CAPS.sequenceMs);
      const used = recent.reduce((s, h) => s + h.amt, 0);
      dmg = Math.min(dmg, AI_CAPS.sequence * maxHp - used);
      if (dmg < 0.5) return 0;
      recent.push({ t: now, amt: dmg });
      this.recentHits.set(p.id, recent);
    }
    const before = p.state.hp;
    dealDamage(this.world.host, n, p, dmg, false, opts.trueDamage ? undefined : opts.fromDir, opts.knockback);
    const dealt = before - p.state.hp;
    if (dealt > 0 && opts.effect) this.applyEffect(p, opts.effect, n);
    return dealt;
  }

  /** Status effect on a player: the server enforces movement effects (effects.ts); the client predicts them. */
  applyEffect(p: PlayerActor, e: StatusEffect, by: Npc | null) {
    const now = this.world.now();
    if (e.kind === "tag") this.tagged.set(p.id, now + e.seconds * 1000);
    else applyMoveEffect(p, e, now);
    this.world.send(p, "npcFx", { kind: e.kind, ms: e.seconds * 1000, amount: e.amount, by: by?.id ?? "" });
  }

  /** Undertow: start or extend a pull on a player (server-simulated in stepPulls, predicted by the client). */
  pullPlayer(p: PlayerActor, c: V3, speed: number, ms: number) {
    applyPull(p, c, speed, ms, this.world.now());
    this.world.send(p, "npcPull", { x: c[0], y: c[1], z: c[2], speed, ms });
  }

  /**
   * Drag pulled players' authoritative positions toward the whirlpool each tick. Their next input is
   * validated from the dragged position, so a client that ignores the pull spends its movement
   * budget walking back out (it can't out-run the pull faster than an honest player could).
   */
  private stepPulls(now: number, dt: number) {
    for (const a of this.world.players()) {
      if (a.dead) continue;
      const pull = activePull(a, now);
      if (!pull) continue;
      const pos = actorPos(a);
      const t = tangentDir(pos, pull.c);
      const d = Math.min(flatDist(pos, pull.c), pull.speed * dt);
      if (d < 0.01 || dot(t, t) < 0.5) continue;
      const g = this.world.snapToGround([pos[0] + t[0] * d, pos[1] + t[1] * d, pos[2] + t[2] * d]);
      a.state.x = a.lastX = g[0];
      a.state.y = a.lastY = g[1];
      a.state.z = a.lastZ = g[2];
    }
  }

  /** Compliance Officer aura: Oversight units within 15 m deal +15% (shown as NF.BUFFED). */
  private auras() {
    const officers: Npc[] = [];
    for (const n of this.npcs.values()) if (n.def.aura && !n.dead) officers.push(n);
    for (const n of this.npcs.values()) {
      if (n.def.family !== "oversight" || n.def.aura) continue;
      const buffed = officers.some((o) => dist2(o.pos, n.pos) <= o.def.aura!.radius * o.def.aura!.radius);
      if (buffed) n.state.flags |= NF.BUFFED;
      else if (n.state.flags & NF.BUFFED) n.state.flags &= ~NF.BUFFED;
    }
  }

  /** Send to connected players within `radius` m of a point (the host's area broadcast, like player combat). */
  sendNear(pos: V3, radius: number, type: string, msg: unknown) {
    this.world.host.broadcastNear(type, msg, pos, radius);
  }

  /** Attack tokens: at most 2 melee + 2 ranged (3 on Meridian) NPCs attacking one player at once. */
  acquireToken(n: Npc, targetId: string, ranged: boolean): boolean {
    if (n.boss || n.def.tier === "beast" || n.def.tier === "critter") return true;
    const now = this.world.now();
    if (n.token && n.token.target === targetId && n.token.ranged === ranged) {
      n.token.until = now + NPC_RULES.tokenHoldSeconds * 1000;
      return true;
    }
    this.releaseToken(n);
    let b = this.tokens.get(targetId);
    if (!b) {
      b = { melee: [], ranged: [], lastRelease: 0 };
      this.tokens.set(targetId, b);
    }
    const list = ranged ? b.ranged : b.melee;
    for (let i = list.length - 1; i >= 0; i--) {
      const h = list[i]!;
      if (h.until < now || !this.npcs.has(h.npc)) {
        list.splice(i, 1);
        b.lastRelease = now;
      }
    }
    const cap = ranged ? (this.planet === "meridian" ? NPC_RULES.rangedTokensMeridian : NPC_RULES.rangedTokens) : NPC_RULES.meleeTokens;
    if (list.length >= cap) return false;
    if (now - b.lastRelease < NPC_RULES.tokenStaggerSeconds * 1000 && list.length > 0) return false;
    const until = now + NPC_RULES.tokenHoldSeconds * 1000;
    list.push({ npc: n.id, until });
    n.token = { target: targetId, ranged, until };
    return true;
  }

  releaseToken(n: Npc) {
    if (!n.token) return;
    const b = this.tokens.get(n.token.target);
    if (b) {
      const list = n.token.ranged ? b.ranged : b.melee;
      const i = list.findIndex((h) => h.npc === n.id);
      if (i >= 0) {
        list.splice(i, 1);
        b.lastRelease = this.world.now();
      }
    }
    n.token = null;
  }

  /** Same-group NPCs (pack mates). */
  mates(n: Npc): Npc[] {
    const g = this.groupOf(n);
    if (!g) return [];
    const out: Npc[] = [];
    for (const m of g.members) if (m && m !== n && !m.dead) out.push(m);
    return out;
  }

  /** Neighbours within `r` metres (spatial hash built once per tick). */
  neighbours(n: Npc, r: number): Npc[] {
    const out: Npc[] = [];
    const c = 6;
    const ix = Math.floor(n.pos[0] / c), iy = Math.floor(n.pos[1] / c), iz = Math.floor(n.pos[2] / c);
    const r2 = r * r;
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (let dz = -1; dz <= 1; dz++) {
          const cell = this.grid.get(cellKey(ix + dx, iy + dy, iz + dz));
          if (!cell) continue;
          for (const m of cell) if (m !== n && dist2(m.pos, n.pos) <= r2) out.push(m);
        }
    return out;
  }

  private buildGrid() {
    this.grid.clear();
    const c = 6;
    for (const n of this.npcs.values()) {
      if (n.dead) continue;
      const k = cellKey(Math.floor(n.pos[0] / c), Math.floor(n.pos[1] / c), Math.floor(n.pos[2] / c));
      let cell = this.grid.get(k);
      if (!cell) {
        cell = [];
        this.grid.set(k, cell);
      }
      cell.push(n);
    }
  }

  /** Copy AI state into the replicated NpcState, writing only what changed. */
  sync(n: Npc) {
    const s = n.state;
    if (s.x !== n.pos[0]) s.x = n.pos[0];
    if (s.y !== n.pos[1]) s.y = n.pos[1];
    if (s.z !== n.pos[2]) s.z = n.pos[2];
    if (Math.abs(s.fx - n.facing[0]) > 2e-3 || Math.abs(s.fy - n.facing[1]) > 2e-3 || Math.abs(s.fz - n.facing[2]) > 2e-3) {
      s.fx = n.facing[0];
      s.fy = n.facing[1];
      s.fz = n.facing[2];
    }
    const tgt = n.target?.id ?? "";
    if (s.target !== tgt && !(s.flags & NF.TELEGRAPH)) s.target = tgt;
  }

  setAnim(n: Npc, anim: number) {
    if (n.state.anim !== anim) n.state.anim = anim;
  }

  // ------------------------------------------------------------------------------------ noise & phrases

  /** Gunfire and explosions are noise events (30 m): listen to the combat host's event fan-out. */
  private hookNoise() {
    const host = this.world.host;
    const hear = (type: string, msg: unknown) => {
      if (type !== "shot" && type !== "explode") return;
      const m = msg as { by?: string; ox?: number; oy?: number; oz?: number; x?: number; y?: number; z?: number; radius?: number };
      if (type === "shot" && m.ox !== undefined) this.noises.push({ pos: [m.ox, m.oy!, m.oz!], by: m.by ?? "", at: this.world.now(), explosion: false });
      if (type === "explode" && m.x !== undefined && (m.radius ?? 0) > 0) this.noises.push({ pos: [m.x, m.y!, m.z!], by: "", at: this.world.now(), explosion: true });
    };
    const origAll = host.broadcast;
    const origNear = host.broadcastNear;
    host.broadcast = (type, msg, except) => {
      hear(type, msg);
      origAll(type, msg, except);
    };
    host.broadcastNear = (type, msg, at, radius, always) => {
      hear(type, msg);
      origNear(type, msg, at, radius, always);
    };
    this.restore.push(() => {
      host.broadcast = origAll;
      host.broadcastNear = origNear;
    });
  }

  private onPhrase(sid: string, msg: unknown) {
    const id = (msg as { id?: number })?.id;
    if (id !== 0) return; // "Truce?"
    const p = this.world.playerById(sid);
    if (!p || p.dead) return;
    const pos = actorPos(p);
    for (const n of this.npcs.values()) {
      if (n.def.id === "ticket_000" && !n.dead && n.mode !== MODE.SCRIPT && dist(n.pos, pos) <= 5) {
        const away = tangentDir(n.pos, n.home);
        n.egg = { follower: null, since: 0, walker: sid, walkFrom: [...n.pos] as V3, walkDir: dot(away, away) > 0 ? away : [-n.facing[0], -n.facing[1], -n.facing[2]] };
        this.setMode(n, MODE.SCRIPT, this.world.now());
      }
    }
  }

  // ------------------------------------------------------------------------------------ admin (tests, staged scenes)

  private admin(sid: string, raw: unknown) {
    const p = this.world.playerById(sid);
    if (!p || !p.identity.admin) return;
    const msg = (raw ?? {}) as Record<string, unknown>;
    const num = (k: string, d = 0) => (typeof msg[k] === "number" ? (msg[k] as number) : d);
    const str = (k: string) => (typeof msg[k] === "string" ? (msg[k] as string) : "");
    const now = this.world.now();
    switch (str("cmd")) {
      case "spawn": {
        const idx = NPC_INDEX.get(str("kind"));
        if (idx === undefined) return;
        const def = NPC_DEFS[idx]!;
        // Finite and near the surface, else at the admin's feet (no NaN positions).
        const R = this.ground.R;
        const want: V3 = [num("x", NaN), num("y", NaN), num("z", NaN)];
        const ok = want.every(Number.isFinite) && Math.abs(len(want) - R) < 300;
        const at = placeOnGround(this.ground, ok ? want : actorPos(p), def.locomotion, def.hover ?? 0);
        const level = Math.max(1, Math.min(20, Math.round(Number.isFinite(num("level")) ? num("level", def.levels[0]) : def.levels[0])));
        const roam = Math.max(0, Math.min(60, Number.isFinite(num("roam", 6)) ? num("roam", 6) : 6));
        const n = this.createNpc(idx, level, at, now, { roam, instant: msg.instant === true });
        const f = msg.facing;
        if (Array.isArray(f) && f.length === 3 && f.every((v) => typeof v === "number" && Number.isFinite(v))) {
          const t = tangentize(n.pos, f as V3);
          if (dot(t, t) > 0.5) n.facing = t;
        }
        this.world.send(p, "npcInfo", { id: n.id, req: msg.req ?? null });
        break;
      }
      case "fx": {
        // Apply an NPC status effect to a player (tests and staged scenes): slow/chill/nosprint/pull.
        const t = str("target") ? this.world.playerById(str("target")) : p;
        if (!t) return;
        const ms = Math.max(0, Math.min(30_000, num("ms", 3000)));
        const kind = str("kind");
        if (kind === "pull") {
          const c: V3 = [num("x", NaN), num("y", NaN), num("z", NaN)];
          if (c.every(Number.isFinite)) this.pullPlayer(t, c, Math.max(0, Math.min(10, num("speed", 2))), ms);
        } else if (kind === "slow" || kind === "chill" || kind === "nosprint" || kind === "tag") {
          this.applyEffect(t, { kind, seconds: ms / 1000, amount: Math.max(0, Math.min(1, num("amount", 0.5))) }, null);
        }
        break;
      }
      case "hurt": {
        const n = this.npcs.get(str("id"));
        if (!n) return;
        const by = str("as") ? this.world.playerById(str("as")) ?? null : null;
        const from = by ? ([actorPos(by)[0] - n.pos[0], actorPos(by)[1] - n.pos[1], actorPos(by)[2] - n.pos[2]] as V3) : undefined;
        dealDamage(this.world.host, by, n, num("amount", 10), msg.weak === true, from);
        break;
      }
      case "list": {
        const out = [...this.npcs.values()].map((n) => ({
          id: n.id, kind: n.defIndex, def: n.def.id, level: n.level, x: n.pos[0], y: n.pos[1], z: n.pos[2], hx: n.home[0], hy: n.home[1], hz: n.home[2],
          hp: n.state.hp, maxHp: n.state.maxHp, mode: MODE_NAME[n.mode], flags: n.state.flags, target: n.target?.id ?? "", area: n.point?.area ?? null, boss: !!n.boss,
        }));
        this.world.send(p, "npcList", { npcs: out, req: msg.req ?? null, points: this.points.length, active: this.groups.filter((g) => g.active).length, tickMs: this.avgTickMs });
        break;
      }
      case "ambient": {
        this.ambientOn = msg.on === true;
        if (!this.ambientOn) for (const g of this.groups) if (g.active) this.despawnGroup(g);
        break;
      }
      case "clear": {
        for (const n of [...this.npcs.values()]) if (!n.boss) this.despawnNpc(n);
        for (const g of this.groups) g.active = false;
        break;
      }
      case "boss": {
        if (!this.boss) return;
        const action = str("action");
        if (action === "spawn") this.boss.forceSpawn(now);
        if (action === "reset") this.boss.reset(now);
        this.world.send(p, "bossInfo", { ...this.boss.info(), req: msg.req ?? null });
        break;
      }
    }
  }
}

function cellKey(x: number, y: number, z: number): number {
  return ((x & 1023) << 20) | ((y & 1023) << 10) | (z & 1023);
}
