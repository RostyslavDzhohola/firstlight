// One boss per planet copy (content §4): spawns at its lair when players come near; HP = HP₂ ×
// (1 + 0.35 × extra players inside the arena or hitting it from just outside in the last 10 s),
// recounted on every entry/exit with the percentage kept; hits from outside count only within 10 m of
// the edge and only while someone is inside; the 30 s reset goes by who is inside;
// phases by HP; co-op mechanics with no hints:
// - plates (Tidewrath's Tide Stones, The Receiver's Override Consoles): two bodies held 3 s together
//   open an 8 s weak window (armour off, weak point ×1.5), then the plates go dark;
//   anti-solo regeneration when no window opened in the last 45 s;
// - split circles (Royal Judgement, Foreclosure): true damage split among players inside, the full
//   amount to everyone in the arena when nobody stands in it;
// - timed attacks (Tide Surge, Court Summons, Collector Drones), breakable cover (Coral Pillars block
//   spit/vents/surge, containers block the Sweep Laser, Nave pillars topple onto the King, crane arms
//   drop onto the Receiver). Everyone who contributed gets personal loot; 10-minute respawn per copy.

import type { ArenaCover, ArenaLayout } from "@firstlight/shared/content/arenas";
import {
  NF, NPC_ANIM, NPC_INDEX, SHAPE_CODE, attackDamage, bossMaxHp, npcDef, splitTotal,
  type AttackDef, type BossDef, type BossEventMsg, type NpcAttackMsg, type NpcDef,
} from "@firstlight/shared/content/npcs";
import { partyOf } from "../../social/parties.ts";
import { actorPos, type NpcActor, type PlayerActor } from "../actors.ts";
import { dealDamage, type BreakableHost } from "../combat.ts";
import type { V3 } from "../geometry.ts";
import { cancelAttack, chest, playersInCircle, playersInLine, startAttack, updateAttack } from "./attacks.ts";
import { aggro } from "./brain.ts";
import type { LivePlayer, NpcSystem } from "./NpcSystem.ts";
import { MODE, type ActiveAttack, type Npc } from "./npc.ts";
import { bossLoot } from "./rewards.ts";
import { step } from "./steer.ts";
import { NPC_TUNING, emitNpcEvent } from "./tuning.ts";
import { add, cross, dist, dot, flatDist, len, normalize, rotateAboutUp, sub, tangentDir, up } from "./vec.ts";

interface CoverState {
  def: ArenaCover;
  hp: number;
  broken: boolean;
}

/**
 * An engaged fight as kept across room instances of the copy (persist.ts, Codex S3): it resumes
 * if the boss comes back before the 30 s vacancy reset would have run, else the boss is fresh.
 */
export interface BossFight {
  id: string;
  /** Since when nobody has been inside the arena (the save time if someone still was). */
  vacantSince: number;
  /** HP as a fraction of max (max is recounted from the players present). */
  frac: number;
  phase: number;
  /** Per cover index: HP and broken (1/0). */
  cover: [number, number][];
  /** Damage credit by account: [userId, name, amount]. */
  damage: [string, string, number][];
  plates: string[];
  soakers: string[];
}

interface Mech {
  kind: "split" | "band" | "raise" | "topple";
  atk: AttackDef | null;
  at: number;
  centre: V3;
  points: V3[];
  dir: V3;
  radius: number;
  length: number;
  width: number;
  cover: CoverState | null;
  /** Split circles: everyone in the arena when the stamp fell (account ids, so a new session can't shed it), held through detonation. */
  participants?: string[];
  /** The telegraph clients were sent (replayed to late arrivals with the remaining time). */
  msg?: NpcAttackMsg;
}

const BOSS_MSG_RADIUS = 220;
const NO_FOOTING = { top: 0, inside: false };
/** Live summons per boss at most (Court Summons / Collector Drones stop when the cap is reached). */
const MAX_SUMMONS = 4;
/** Lair-state snapshots go to players who come within this distance of the arena (and on request). */
const SNAPSHOT_RADIUS = 260;
/** Players who hit the boss this recently count for its HP and can be targeted, wherever they stand. */
const RECENT_HIT_MS = 10_000;
/** Hits from players farther than this beyond the arena edge do nothing (no sniping from outside). */
const OUTSIDE_REACH = 10;
/** Arena cover shows up in combat's prop raycasts as index COVER_INDEX + cover index. */
const COVER_INDEX = 1 << 20;

/** Weak-point volumes in the boss's local frame (x right, y up, z forward), exposed only in their window. */
const WEAK_VOLUMES: Record<string, { c: V3; r: number }> = {
  tidewrath: { c: [0, 2.1, 3.3], r: 1.4 }, // chest vent, open while Moored
  the_receiver: { c: [0, 9.6, -1.5], r: 1.9 }, // rear reactor hatch, open while kneeling (Asset Freeze / crane arm)
  hollow_king: { c: [0, 2.75, 0.3], r: 0.9 }, // rib cage, open 3 s after a pillar lands on him
};

export class BossController {
  readonly sys: NpcSystem;
  readonly def: BossDef;
  readonly arena: ArenaLayout;
  readonly npcDef: NpcDef;
  readonly defIndex: number;
  npc: Npc | null = null;
  status: "dormant" | "alive" | "dead" = "dormant";
  respawnAt = 0;
  engaged = false;
  count = 0;
  inArena: LivePlayer[] = [];
  /** Inside the arena or hit the boss in the last RECENT_HIT_MS: HP scaling and targeting. */
  fighters: LivePlayer[] = [];
  /** Session id → last time that player damaged the boss. */
  private readonly recentHits = new Map<string, number>();
  /** A fight restored from the copy state, applied when the boss next spawns (if still in time). */
  pendingFight: BossFight | null = null;
  phase = 1;
  windowUntil = 0;
  darkUntil = 0;
  lastWindowAt = 0;
  weakUntil = 0;
  staggerUntil = 0;
  held = [false, false];
  holdMs = 0;
  /** Account ids credited for holding a plate as a window opened / standing in a split circle. */
  readonly plateHolders = new Set<string>();
  readonly soakers = new Set<string>();
  /** Sessions that already got the lair snapshot (cleared when they move away or leave). */
  private readonly synced = new Set<string>();
  private lastSyncScan = 0;
  readonly cover: CoverState[];
  readonly summons = new Set<string>();
  private emptySince: number | null = null;
  private lastNearAt = 0;
  private nextTimed = new Map<string, number>();
  private mechs: Mech[] = [];
  private nextAttackAt = 0;
  private regenAcc = 0;
  private wasOpen = false;
  private platesKey = "";
  private propHook: ((point: V3, power: "light" | "heavy", amount: number) => void) | null = null;
  private propPrev: ((point: V3, power: "light" | "heavy", amount: number) => void) | undefined;
  private coverHost: BreakableHost | null = null;
  private coverPrev: BreakableHost | undefined;
  private readonly coverRayHit = { i: -1, t: Infinity };

  constructor(sys: NpcSystem, def: BossDef, arena: ArenaLayout) {
    this.sys = sys;
    this.def = def;
    this.arena = arena;
    this.npcDef = npcDef(def.id);
    this.defIndex = NPC_INDEX.get(def.id)!;
    this.cover = arena.cover.map((c) => ({ def: c, hp: c.hp, broken: false }));
  }

  // ------------------------------------------------------------------------------------ lifecycle

  tick(now: number, dt: number) {
    this.hookProps();
    this.hookCover();
    if (!NPC_TUNING.bosses) {
      if (this.npc) this.despawn();
      return;
    }
    const near = this.sys.nearestLive(this.arena.centre);
    if (near <= NPC_TUNING.bossSpawnRadius) this.lastNearAt = now;
    if (now - this.lastSyncScan >= 500) {
      this.lastSyncScan = now;
      this.syncNewcomers();
    }
    if (this.status === "dead") {
      if (now >= this.respawnAt) {
        this.status = "dormant";
        this.rebuildCover();
        this.event({ type: "respawn" });
      } else return;
    }
    if (this.status === "dormant") {
      if (near <= NPC_TUNING.bossSpawnRadius) this.spawn(now);
      return;
    }
    const n = this.npc;
    if (!n || !this.sys.npcs.has(n.id)) {
      this.npc = null;
      this.status = "dormant";
      return;
    }
    if (n.dead) return;
    if (!this.engaged && now - this.lastNearAt > NPC_TUNING.despawnAfterMs) {
      this.despawn();
      return;
    }
    this.engagement(n, now);
    if (!this.engaged) return;
    this.plates(n, now, dt);
    this.regen(n, now, dt);
    this.phases(n, now);
    this.timed(n, now);
    this.runMechs(n, now);
  }

  forceSpawn(now: number) {
    if (this.status !== "alive") this.spawn(now);
  }

  private spawn(now: number) {
    const n = this.sys.createNpc(this.defIndex, this.def.level, this.arena.home, now, { boss: true, roam: this.arena.roam });
    n.facing = this.arena.homeFacing;
    // Boss-specific weak point and multiplier (content §4), not the generic headshot rule.
    n.weakPoint = (o, d, t) => this.weakPoint(n, o, d, t);
    n.weakMult = this.def.plates?.weakMult ?? 1.5;
    this.npc = n;
    this.status = "alive";
    this.resetState(n, now);
    const f = this.pendingFight;
    this.pendingFight = null;
    if (f && f.id === this.def.id && now - f.vacantSince < NPC_TUNING.bossResetMs) this.resumeFight(n, f, now);
  }

  /** The engaged fight worth keeping across room instances, or null (persist.ts). */
  fightState(now: number): BossFight | null {
    const n = this.npc;
    if (this.status !== "alive" || !this.engaged || !n || n.dead) return null;
    return {
      id: this.def.id,
      vacantSince: this.inArena.length > 0 ? now : (this.emptySince ?? now),
      frac: n.state.hp / n.state.maxHp,
      phase: this.phase,
      cover: this.cover.map((c) => [c.hp, c.broken ? 1 : 0]),
      damage: [...n.damage.values()].map((e) => [e.userId, e.name, e.amount]),
      plates: [...this.plateHolders],
      soakers: [...this.soakers],
    };
  }

  /** Pick a kept fight back up: HP share, phase, cover, credit; the vacancy clock keeps running. */
  private resumeFight(n: Npc, f: BossFight, now: number) {
    n.state.hp = Math.max(1, Math.min(n.state.maxHp, Math.round(n.state.maxHp * f.frac)));
    this.phase = Math.max(1, Math.min(3, f.phase | 0));
    n.state.phase = this.phase;
    f.cover.forEach(([hp, broken], i) => {
      const c = this.cover[i];
      if (!c) return;
      c.hp = Math.max(0, Math.min(c.def.hp, hp));
      c.broken = broken === 1 || c.hp <= 0;
    });
    for (const [userId, name, amount] of f.damage) n.damage.set(userId, { userId, name, amount, sid: "" });
    for (const u of f.plates) this.plateHolders.add(u);
    for (const u of f.soakers) this.soakers.add(u);
    this.engaged = true;
    this.emptySince = f.vacantSince;
    this.nextAttackAt = now + 1500;
    n.state.flags |= NF.ENGAGED;
  }

  private despawn() {
    if (this.npc) this.sys.despawnNpc(this.npc);
    this.clearSummons();
    this.npc = null;
    this.status = "dormant";
    this.engaged = false;
  }

  private resetState(n: Npc, now: number) {
    this.engaged = false;
    this.count = 0;
    this.phase = 1;
    this.windowUntil = 0;
    this.darkUntil = 0;
    this.lastWindowAt = now;
    this.weakUntil = 0;
    this.staggerUntil = 0;
    this.held = [false, false];
    this.holdMs = 0;
    this.plateHolders.clear();
    this.soakers.clear();
    this.mechs = [];
    this.nextTimed.clear();
    this.emptySince = null;
    this.regenAcc = 0;
    this.wasOpen = false;
    this.recentHits.clear();
    n.state.maxHp = this.def.id === n.def.id ? n.def.hp : n.state.maxHp;
    n.state.hp = n.state.maxHp;
    n.state.phase = 1;
    n.damage.clear();
    this.rebuildCover();
  }

  /** No player in the arena for 30 s → full HP, cover rebuilds. */
  reset(now: number) {
    const n = this.npc;
    if (!n) return;
    cancelAttack(this.sys, n);
    this.clearSummons();
    this.resetState(n, now);
    this.sys.copyDirty = true;
    n.state.flags &= ~(NF.ENGAGED | NF.WEAK_OPEN | NF.STUNNED);
    n.pos = [this.arena.home[0], this.arena.home[1], this.arena.home[2]];
    n.facing = this.arena.homeFacing;
    this.sys.setMode(n, MODE.IDLE, now);
    this.event({ type: "reset", hp: n.state.hp, maxHp: n.state.maxHp });
  }

  info() {
    const n = this.npc;
    const now = this.sys.world.now();
    return {
      id: n?.id ?? "",
      boss: this.def.id,
      status: this.status,
      hp: n?.state.hp ?? 0,
      maxHp: n?.state.maxHp ?? 0,
      phase: this.phase,
      engaged: this.engaged,
      count: this.count,
      window: now < this.windowUntil,
      dark: Math.max(0, this.darkUntil - now),
      respawnIn: this.status === "dead" ? Math.max(0, this.respawnAt - now) : 0,
      centre: this.arena.centre,
      home: this.arena.home,
      radius: this.arena.radius,
      plates: this.arena.plates,
      plateRadius: this.arena.plateRadius,
      cover: this.cover.map((c) => ({ id: c.def.id, kind: c.def.kind, hp: c.hp, broken: c.broken })),
      summons: [...this.summons],
    };
  }

  private event(e: Omit<BossEventMsg, "boss" | "id">) {
    this.sys.sendNear(this.arena.centre, BOSS_MSG_RADIUS, "boss", { boss: this.def.id, id: this.npc?.id ?? "", ...e } satisfies BossEventMsg);
  }

  private voice(line: string) {
    // Heard within 120 m of the boss (content §4.1); subtitles as "NAME: line" on the client.
    const at = this.npc?.pos ?? this.arena.centre;
    this.sys.sendNear(at, 120 + this.arena.radius, "boss", { type: "voice", boss: this.def.id, id: this.npc?.id ?? "", name: this.npcDef.name, line } satisfies BossEventMsg);
  }

  // ------------------------------------------------------------------------------------ late joiners

  /** Players who come near the lair (or just joined) get the current lair state once. */
  private syncNewcomers() {
    for (const p of this.sys.world.connected()) {
      const d = dist(actorPos(p), this.arena.centre);
      if (d <= SNAPSHOT_RADIUS && !this.synced.has(p.id)) this.sendSnapshot(p.id);
      else if (d > SNAPSHOT_RADIUS + 60) this.synced.delete(p.id);
    }
  }

  /** Lair snapshot: broken cover, plate state, weak window, phase and HP scaling. */
  sendSnapshot(sessionId: string) {
    const p = this.sys.world.playerById(sessionId);
    if (!p) return;
    this.synced.add(sessionId);
    const now = this.sys.world.now();
    const n = this.npc;
    const open = now < this.windowUntil;
    this.sys.world.send(p, "boss", {
      type: "snapshot",
      boss: this.def.id,
      id: n?.id ?? "",
      phase: this.phase,
      engaged: this.count,
      hp: n?.state.hp ?? 0,
      maxHp: n?.state.maxHp ?? 0,
      broken: this.cover.filter((c) => c.broken).map((c) => c.def.id),
      windowMs: open ? this.windowUntil - now : 0,
      held: this.held.map((h) => +h),
      progress: this.def.plates ? Math.min(1, this.holdMs / (this.def.plates.hold * 1000)) : 0,
      dark: !open && now < this.darkUntil ? Math.ceil((this.darkUntil - now) / 1000) : 0,
      pts: this.arena.plates.flat(),
    } satisfies BossEventMsg);
    // Mechanics already counting down (split circles, surges, summons, toppling cover).
    for (const m of this.mechs) if (m.msg && m.at > now) this.sys.world.send(p, "npcAtk", { ...m.msg, ms: Math.round(m.at - now) });
  }

  forget(sessionId: string) {
    this.synced.delete(sessionId);
  }

  // ------------------------------------------------------------------------------------ engagement, HP, phases

  private engagement(n: Npc, now: number) {
    const inArena: LivePlayer[] = [];
    const fighters: LivePlayer[] = [];
    for (const [id, at] of this.recentHits) if (now - at > RECENT_HIT_MS) this.recentHits.delete(id);
    for (const lp of this.sys.live) {
      const inside = flatDist(this.arena.centre, lp.pos) <= this.arena.radius;
      if (inside) inArena.push(lp);
      if (inside || this.recentHits.has(lp.a.id)) fighters.push(lp);
    }
    this.inArena = inArena;
    this.fighters = fighters;
    const count = fighters.length;
    if (count !== this.count) {
      const oldMax = n.state.maxHp;
      const newMax = bossMaxHp(this.npcDef.hp, count, this.def.hpPerExtra, this.def.maxCounted);
      if (newMax !== oldMax) {
        n.state.hp = Math.max(1, Math.round((n.state.hp * newMax) / oldMax));
        n.state.maxHp = newMax;
      }
      this.count = count;
      this.event({ type: "hp", engaged: count, hp: n.state.hp, maxHp: n.state.maxHp });
    }
    // Engagement and the 30 s vacancy reset go by who is actually in the arena: hitters at the edge
    // count for HP and targeting only (Codex B1).
    if (inArena.length > 0) {
      this.emptySince = null;
      if (!this.engaged) this.engage(n, now);
    } else if (this.engaged) {
      if (this.emptySince === null) {
        this.emptySince = now;
        this.sys.copyDirty = true; // keep the vacancy start for a room that comes back (persist.ts)
      }
      if (now - this.emptySince >= NPC_TUNING.bossResetMs) this.reset(now);
    }
  }

  private engage(n: Npc, now: number) {
    this.engaged = true;
    this.lastWindowAt = now;
    this.nextTimed.clear();
    this.nextAttackAt = now + 1500;
    n.state.flags |= NF.ENGAGED;
    this.event({ type: "engage", phase: this.phase, engaged: this.count, hp: n.state.hp, maxHp: n.state.maxHp });
    this.voice(this.def.voice.engage);
  }

  private phases(n: Npc, now: number) {
    const f = n.state.hp / n.state.maxHp;
    const p = f < this.def.phases[1] ? 3 : f < this.def.phases[0] ? 2 : 1;
    if (p <= this.phase) return;
    this.phase = p;
    n.state.phase = p;
    this.event({ type: "phase", phase: p });
    if (p === 2) this.voice(this.def.voice.phase2);
    for (const a of this.npcDef.attacks) {
      if (!a.timed || !a.every) continue;
      const every = (a.every[p - 1] ?? 0) * 1000 * NPC_TUNING.bossEveryScale;
      if (every <= 0) this.nextTimed.delete(a.id);
      else if (!this.nextTimed.has(a.id) || (a.every[p - 2] ?? 0) <= 0) this.nextTimed.set(a.id, now + (NPC_TUNING.firstMechanicMs ?? every));
    }
  }

  cooldownScale(): number {
    return this.def.id === "tidewrath" && this.phase === 3 ? 0.75 : 1;
  }

  private regen(n: Npc, now: number, dt: number) {
    const r = this.def.regen;
    if (!r || n.state.hp >= n.state.maxHp) return;
    const after = NPC_TUNING.regenAfterMs ?? r.after * 1000;
    if (now - this.lastWindowAt < after || now < this.windowUntil) return;
    this.regenAcc += n.state.maxHp * r.perSecond * dt;
    if (this.regenAcc >= 1) {
      const add = Math.floor(this.regenAcc);
      this.regenAcc -= add;
      n.state.hp = Math.min(n.state.maxHp, n.state.hp + add);
    }
  }

  // ------------------------------------------------------------------------------------ plates

  private plates(n: Npc, now: number, dt: number) {
    const pd = this.def.plates;
    if (!pd || this.arena.plates.length < 2) return;
    const reach = this.arena.plateRadius + 0.9;
    const holders: string[][] = this.arena.plates.map((pl) => this.inArena.filter((lp) => flatDist(pl, lp.pos) <= reach && Math.abs(len(pl) - len(lp.pos)) < 2.5).map((lp) => lp.a.id));
    this.held = holders.map((h) => h.length > 0);
    const open = now < this.windowUntil;
    if (this.wasOpen && !open) {
      n.state.flags &= ~NF.WEAK_OPEN;
      this.event({ type: "window", mech: pd.spacing === 30 ? "moored" : "freeze", ms: 0 });
    }
    this.wasOpen = open;
    if (open || now < this.darkUntil) this.holdMs = 0;
    else if (this.held[0] && this.held[1]) {
      this.holdMs += dt * 1000;
      if (this.holdMs >= pd.hold * 1000) {
        for (const h of holders) for (const id of h) {
          const p = this.sys.world.playerById(id);
          if (p) this.plateHolders.add(p.identity.userId);
        }
        this.openWindow(n, now, pd.window * 1000, true);
      }
    } else this.holdMs = 0;
    const progress = Math.min(1, this.holdMs / (pd.hold * 1000));
    const dark = now < this.darkUntil && !open ? Math.ceil((this.darkUntil - now) / 1000) : 0;
    const key = `${+this.held[0]!}${+this.held[1]!}|${Math.floor(progress * 6)}|${dark > 0}|${open}`;
    if (key !== this.platesKey) {
      this.platesKey = key;
      this.event({ type: "plates", held: this.held.map((h) => +h), progress, dark, pts: this.arena.plates.flat() });
    }
  }

  /** Weak window: armour off, weak point ×1.5, the boss kneels and can't act. */
  private openWindow(n: Npc, now: number, ms: number, fromPlates: boolean) {
    this.windowUntil = Math.max(this.windowUntil, now + ms);
    if (fromPlates) {
      this.darkUntil = this.windowUntil + (this.def.plates?.cooldown ?? 12) * 1000;
      this.lastWindowAt = now;
    }
    this.holdMs = 0;
    this.wasOpen = true;
    cancelAttack(this.sys, n);
    n.state.flags |= NF.WEAK_OPEN;
    this.sys.setMode(n, MODE.STUN, now, this.windowUntil);
    this.sys.setAnim(n, NPC_ANIM.KNEEL);
    this.event({ type: "window", mech: this.def.id === "tidewrath" ? "moored" : "freeze", ms: this.windowUntil - now });
  }

  // ------------------------------------------------------------------------------------ damage

  /**
   * Armour outside the weak window; weak-point hits are already multiplied by combat (weakMult).
   * Players outside the arena deal nothing beyond its edge + OUTSIDE_REACH (F12: a sniper 75 m
   * out), and nothing at all while nobody is inside (Codex B1: no chipping from the edge).
   */
  mitigate(n: Npc, amount: number, _weak: boolean, attacker?: PlayerActor | NpcActor | null): number {
    if (n.dead || n.state.flags & NF.INVULN) return 0;
    if (attacker?.kind === "player") {
      const d = flatDist(this.arena.centre, actorPos(attacker));
      if (d > this.arena.radius + OUTSIDE_REACH || (d > this.arena.radius && !this.occupied())) return 0;
    }
    const open = this.sys.world.now() < this.windowUntil;
    return amount * (open ? 1 : (this.npcDef.armour ?? 1));
  }

  /** Is anyone alive inside the arena right now (positions as of this moment, not the last tick)? */
  private occupied(): boolean {
    for (const p of this.sys.world.players()) if (!p.dead && p.state.hp > 0 && flatDist(this.arena.centre, actorPos(p)) <= this.arena.radius) return true;
    return false;
  }

  /**
   * Does a ray that hit the boss's capsule at distance `t` pass through its exposed weak point
   * (chest vent / rib cage / reactor hatch)? The capsule is coarse, so the ray is tested against the
   * weak-point sphere itself, near the capsule entry (not through the whole body).
   */
  weakPoint(n: Npc, o: V3, d: V3, t: number): boolean {
    const now = this.sys.world.now();
    const exposed = this.def.id === "hollow_king" ? now < this.weakUntil : now < this.windowUntil;
    const v = WEAK_VOLUMES[this.def.id];
    if (!exposed || !v) return false;
    const u = up(n.pos);
    const f = n.facing;
    const r = cross(u, f);
    const c: V3 = add(add(add(n.pos, r, v.c[0]), u, v.c[1]), f, v.c[2]);
    const s = dot(sub(c, o), d); // closest approach along the ray
    if (s < t - 1 || s > t + n.radius * 2) return false;
    const q = add(o, d, s);
    return dot(sub(q, c), sub(q, c)) <= v.r * v.r;
  }

  onDamaged(n: Npc, amount: number, by: PlayerActor | null) {
    // Contribution is tracked in n.damage by the system. A hit from just outside the arena engages
    // too and counts the hitter as a fighter for RECENT_HIT_MS (HP scaling, targeting).
    if (by && amount > 0) this.recentHits.set(by.id, this.sys.world.now());
    this.sys.copyDirty = true; // the fight's HP is worth keeping (persist.ts; saved at most once a second)
    if (!this.engaged && by && this.status === "alive") this.engage(n, this.sys.world.now());
  }

  onKilled(n: Npc, _by: string | null, now: number) {
    this.status = "dead";
    this.respawnAt = now + NPC_TUNING.bossRespawnMs;
    this.engaged = false;
    this.mechs = [];
    this.clearSummons();
    // Contributors by account: ≥ 50% of an equal damage share, held a plate as a window opened, or
    // stood in a split circle; then their parties (partyOf), so a fallen contributor's party still earns.
    const share = n.state.maxHp / Math.max(1, this.count);
    const contributors = new Set<string>([...this.plateHolders, ...this.soakers]);
    for (const e of n.damage.values()) if (e.amount >= 0.5 * share) contributors.add(e.userId);
    const credited = new Set<string>();
    for (const uid of contributors) for (const m of partyOf(uid)) credited.add(m);
    // Recipients: connected, alive, inside the arena boundary right now.
    const winners: PlayerActor[] = [];
    for (const p of this.sys.world.connected()) {
      if (p.dead || p.state.hp <= 0) continue;
      if (flatDist(this.arena.centre, actorPos(p)) > this.arena.radius) continue;
      if (credited.has(p.identity.userId)) winners.push(p);
    }
    for (const p of winners) {
      const loot = bossLoot(this.sys, this.def, p);
      this.sys.world.send(p, "npcKill", { id: n.id, kind: n.defIndex, xp: loot.xp, coins: loot.coins });
      this.sys.world.send(p, "toast", { text: `${this.npcDef.name} defeated: +${loot.coins} coins, +${loot.items.length} items`, kind: "coins" });
    }
    this.event({ type: "defeat", hp: 0, maxHp: n.state.maxHp, engaged: winners.length });
    this.voice(this.def.voice.defeat);
    emitNpcEvent({ kind: "bossKill", body: this.sys.world.body.id, boss: this.def.id, sessionIds: winners.map((p) => p.id), userIds: winners.map((p) => p.identity.userId), names: winners.map((p) => p.identity.name) });
  }

  // ------------------------------------------------------------------------------------ AI

  think(n: Npc, now: number, dt: number) {
    if (n.dead) return;
    if (n.mode === MODE.SPAWN) {
      if (now >= n.modeUntil) {
        n.state.flags &= ~(NF.SPAWNING | NF.INVULN);
        this.sys.setMode(n, MODE.IDLE, now);
        this.sys.setAnim(n, NPC_ANIM.IDLE);
      }
      return;
    }
    if (n.attack) {
      updateAttack(this.sys, n, now, dt);
      return;
    }
    if (now < this.windowUntil || now < this.staggerUntil) {
      this.sys.setAnim(n, NPC_ANIM.KNEEL);
      return;
    }
    if (n.state.flags & NF.STUNNED) n.state.flags &= ~NF.STUNNED;
    if (n.mode === MODE.STUN || n.mode === MODE.RECOVER) {
      if (now < n.modeUntil) return;
      this.sys.setMode(n, MODE.CHASE, now);
    }
    if (!this.engaged) {
      n.target = null;
      if (flatDist(n.pos, this.arena.home) > 1.5) this.move(n, tangentDir(n.pos, this.arena.home), n.def.speed, dt);
      else {
        n.facing = this.arena.homeFacing;
        this.sys.setAnim(n, NPC_ANIM.IDLE);
      }
      return;
    }
    const t = this.pickTarget(n);
    n.target = t?.a ?? null;
    if (!t) {
      this.sys.setAnim(n, NPC_ANIM.IDLE);
      return;
    }
    const toward = tangentDir(n.pos, t.pos);
    if (dot(toward, toward) > 0.5) n.facing = toward;
    const d = flatDist(n.pos, t.pos);
    if (NPC_TUNING.bossAttacks && now >= this.nextAttackAt) {
      const i = this.chooseAttack(n, d, now);
      if (i >= 0) {
        startAttack(this.sys, n, i, t.a, now);
        this.nextAttackAt = now + (1200 + Math.random() * 1200) * this.cooldownScale();
        return;
      }
    }
    // Movement by boss style.
    if (this.def.id === "tidewrath") {
      // Patrol the shallows facing the shore: slide along the shore toward the target.
      const side = cross(up(this.arena.home), this.arena.homeFacing);
      const lateral = dot(sub(t.pos, n.pos), side);
      if (Math.abs(lateral) > 3) this.move(n, lateral > 0 ? side : [-side[0], -side[1], -side[2]], n.def.speed, dt);
      else this.sys.setAnim(n, NPC_ANIM.IDLE);
    } else {
      const keep = this.def.id === "the_receiver" ? 7 : 4;
      if (d > keep) this.move(n, toward, n.def.runSpeed, dt);
      else this.sys.setAnim(n, NPC_ANIM.IDLE);
    }
    n.facing = dot(toward, toward) > 0.5 ? toward : n.facing;
  }

  private move(n: Npc, dir: V3, speed: number, dt: number) {
    if (dot(dir, dir) < 0.5) return;
    const out: V3 = [0, 0, 0];
    const used = step(this.sys.ground, n.pos, dir, speed * dt, n.def.locomotion, n.def.hover ?? 0, n.radius, out);
    if (used < 0 || flatDist(out, this.arena.home) > this.arena.roam) {
      this.sys.setAnim(n, NPC_ANIM.IDLE);
      return;
    }
    n.pos = out;
    this.sys.setAnim(n, speed > n.def.speed ? NPC_ANIM.RUN : NPC_ANIM.WALK);
  }

  private pickTarget(n: Npc): LivePlayer | null {
    let best: LivePlayer | null = null;
    let bd = Infinity;
    for (const lp of this.fighters) {
      if (lp.untouchable) continue;
      const d = flatDist(n.pos, lp.pos) - (n.target === lp.a ? 4 : 0);
      if (d < bd) {
        bd = d;
        best = lp;
      }
    }
    return best;
  }

  private chooseAttack(n: Npc, d: number, now: number): number {
    const options: number[] = [];
    this.npcDef.attacks.forEach((a, i) => {
      if (a.timed || now < n.cooldowns[i]!) return;
      if (a.phases && !a.phases.includes(this.phase)) return;
      if (d > a.range || d < (a.minRange ?? 0)) return;
      options.push(i);
    });
    if (!options.length) return -1;
    // Close-range attacks first when someone is in reach.
    const close = options.filter((i) => (this.npcDef.attacks[i]!.range ?? 0) <= 10);
    const pool = close.length && Math.random() < 0.7 ? close : options;
    return pool[Math.floor(Math.random() * pool.length)]!;
  }

  // ------------------------------------------------------------------------------------ specials in the rotation

  resolveSpecial(n: Npc, at: ActiveAttack, now: number) {
    const a = at.def;
    if (a.shape === "pull") {
      at.ticksLeft = a.ticks ?? 8;
      at.nextTickAt = now;
      at.activeUntil = now + (a.ticks ?? 8) * (a.interval ?? 0.5) * 1000 + 10;
    } else if (a.shape === "beam") {
      at.travelled = 0;
      at.hitIds.clear();
      at.activeUntil = now + (a.interval ?? 2) * 1000;
      this.sys.setAnim(n, NPC_ANIM.DASH);
    }
  }

  runActive(n: Npc, at: ActiveAttack, now: number, _dt: number) {
    const a = at.def;
    if (a.shape === "pull") {
      const c = at.points[0] ?? n.pos;
      while (at.ticksLeft > 0 && now >= at.nextTickAt) {
        at.ticksLeft--;
        at.nextTickAt += (a.interval ?? 0.5) * 1000;
        for (const lp of playersInCircle(this.sys, c, a.radius ?? 8, 0, 6)) {
          this.sys.hitPlayer(n, lp.a, attackDamage(a, n.level), { fromDir: sub(c, lp.pos) });
          this.sys.pullPlayer(lp.a, c, a.speed ?? 2, (a.interval ?? 0.5) * 1000 + 100);
        }
      }
    } else if (a.shape === "beam") {
      const dur = (a.interval ?? 2) * 1000;
      const k = Math.min(1, (now - (at.activeUntil - dur)) / dur);
      const sweep = a.angle ?? 90;
      const beam = rotateAboutUp(n.pos, at.dir, -sweep / 2 + sweep * k);
      const cosTol = Math.cos((5 * Math.PI) / 180);
      for (const c of this.cover) {
        if (c.broken || c.def.kind !== "container" || at.hitIds.has(`c${c.def.id}`)) continue;
        const t = tangentDir(n.pos, c.def.pos);
        if (dot(t, beam) >= cosTol && flatDist(n.pos, c.def.pos) <= (a.radius ?? 40)) {
          at.hitIds.add(`c${c.def.id}`);
          this.damageCover(c, 300, now);
        }
      }
      for (const lp of this.sys.live) {
        if (lp.untouchable || at.hitIds.has(lp.a.id)) continue;
        if (flatDist(n.pos, lp.pos) > (a.radius ?? 40)) continue;
        if (dot(tangentDir(n.pos, lp.pos), beam) < cosTol) continue;
        if (this.blocked(n.pos, lp.pos, a)) continue;
        at.hitIds.add(lp.a.id);
        // The beam comes from the Receiver's body: a Prism Bubble shell in between takes it.
        this.sys.hitPlayer(n, lp.a, attackDamage(a, n.level), { fromDir: sub(n.pos, lp.pos), src: chest(n.pos, 2) });
      }
    }
  }

  /** Is the line from the boss to a player covered by intact arena cover (for the attacks cover blocks)? */
  blocked(from: V3, to: V3, a: AttackDef): boolean {
    const kinds = this.def.id === "tidewrath" ? (["brine_spit", "steam_vents", "tide_surge"].includes(a.id) ? ["coral"] : null) : this.def.id === "the_receiver" ? (a.id === "sweep_laser" ? ["container"] : null) : null;
    if (!kinds) return false;
    const seg = sub(to, from);
    const l2 = dot(seg, seg);
    for (const c of this.cover) {
      if (c.broken || !kinds.includes(c.def.kind)) continue;
      const t = l2 > 0 ? dot(sub(c.def.pos, from), seg) / l2 : 0;
      if (t <= 0.02 || t >= 0.995) continue;
      const closest = add(from, seg, t);
      if (flatDist(closest, c.def.pos) <= c.def.radius + 0.35) return true;
    }
    return false;
  }

  // ------------------------------------------------------------------------------------ timed mechanics

  private timed(n: Npc, now: number) {
    const filter = NPC_TUNING.bossMechanics;
    for (const a of this.npcDef.attacks) {
      if (!a.timed || !a.every) continue;
      if (filter && !filter.includes(a.id)) continue;
      const every = (a.every[this.phase - 1] ?? 0) * 1000 * NPC_TUNING.bossEveryScale;
      if (every <= 0) continue;
      const next = this.nextTimed.get(a.id);
      if (next === undefined) {
        this.nextTimed.set(a.id, now + (NPC_TUNING.firstMechanicMs ?? every));
        continue;
      }
      if (now < next) continue;
      if (now < this.windowUntil && a.shape !== "split") {
        this.nextTimed.set(a.id, this.windowUntil + 1000);
        continue;
      }
      if (this.startMech(n, a, now)) this.nextTimed.set(a.id, now + every);
      else this.nextTimed.set(a.id, now + 1000);
    }
  }

  private startMech(n: Npc, a: AttackDef, now: number): boolean {
    const ms = a.telegraph * 1000;
    const base: Omit<Mech, "kind" | "centre"> = { atk: a, at: now + ms, points: [], dir: n.facing, radius: a.radius ?? 4, length: 0, width: 0, cover: null };
    if (a.shape === "split") {
      const pool = this.inArena.filter((lp) => !lp.untouchable);
      if (!pool.length) return false;
      const victim = pool[Math.floor(Math.random() * pool.length)]!;
      const c = this.groundAt(victim.pos);
      this.mechs.push({ ...base, kind: "split", centre: c, participants: this.inArena.map((lp) => lp.a.identity.userId) });
      this.sendTelegraph(n, a, c, n.facing, ms, { r: a.radius ?? 4 });
      this.event({ type: "mechanic", mech: a.id, pts: [...c], r: a.radius, ms });
      return true;
    }
    if (a.shape === "band" && this.arena.lake) {
      const lake = this.arena.lake;
      const out = tangentDir(lake.centre, this.arena.centre);
      const span = Math.min(170, ((this.arena.radius + 20) / lake.shore) * (180 / Math.PI) * 2);
      this.mechs.push({ ...base, kind: "band", centre: lake.centre, dir: out, radius: lake.shore + (a.radius ?? 20), width: lake.shore - 8 });
      this.sendTelegraph(n, a, lake.centre, out, ms, { r: lake.shore + (a.radius ?? 20), w: lake.shore - 8, ang: span });
      this.event({ type: "mechanic", mech: a.id, pts: [...lake.centre], r: lake.shore + (a.radius ?? 20), ms });
      this.sys.setAnim(n, NPC_ANIM.HOWL);
      return true;
    }
    if (a.shape === "raise") {
      const spots = [...this.arena.summons].sort(() => Math.random() - 0.5).slice(0, a.count ?? 2);
      if (!spots.length) spots.push(add(n.pos, n.facing, 6));
      this.mechs.push({ ...base, kind: "raise", centre: spots[0]!, points: spots });
      this.sendTelegraph(n, a, spots[0]!, n.facing, ms, { r: 2, pts: spots.flat() });
      this.event({ type: "mechanic", mech: a.id, pts: spots.flat(), ms });
      return true;
    }
    return false;
  }

  private sendTelegraph(n: Npc, a: AttackDef, c: V3, dir: V3, ms: number, extra: Partial<NpcAttackMsg>) {
    const msg: NpcAttackMsg = { id: n.id, a: this.npcDef.attacks.indexOf(a), sh: SHAPE_CODE[a.shape], ms: Math.round(ms), x: c[0], y: c[1], z: c[2], dx: dir[0], dy: dir[1], dz: dir[2], r: a.radius ?? 4, w: 0, l: 0, ang: 0, c: a.shape === "split" || a.shape === "raise" ? 4 : 2, ...extra };
    this.sys.sendNear(this.arena.centre, BOSS_MSG_RADIUS, "npcAtk", msg);
    const last = this.mechs[this.mechs.length - 1];
    if (last && !last.msg) last.msg = msg;
  }

  private runMechs(n: Npc, now: number) {
    if (!this.mechs.length) return;
    const due = this.mechs.filter((m) => now >= m.at);
    if (!due.length) return;
    this.mechs = this.mechs.filter((m) => now < m.at);
    for (const m of due) this.resolveMech(n, m, now);
  }

  private resolveMech(n: Npc, m: Mech, now: number) {
    const a = m.atk;
    switch (m.kind) {
      case "split": {
        const inside = playersInCircle(this.sys, m.centre, m.radius, 0, 4);
        let victims: PlayerActor[];
        if (inside.length) victims = inside.map((lp) => lp.a);
        else {
          // Empty circle: everyone who was in the arena when it was stamped takes it, wherever they
          // went (running out, closing the tab or swapping sessions doesn't dodge the curse), plus anyone in the arena now.
          const ids = new Set([...(m.participants ?? []), ...this.inArena.filter((lp) => !lp.untouchable).map((lp) => lp.a.identity.userId)]);
          victims = [...this.sys.world.players()].filter((p) => ids.has(p.identity.userId) && !p.dead);
        }
        // 120% of the sturdiest victim's max HP (never less than listed): lethal solo at any level.
        const total = a ? splitTotal(attackDamage(a, n.level), victims.map((p) => p.state.maxHp)) : 0;
        const each = inside.length ? total / inside.length : total;
        for (const lp of inside) this.soakers.add(lp.a.identity.userId);
        for (const p of victims) this.sys.hitPlayer(n, p, each, { trueDamage: true });
        this.event({ type: "mechanicEnd", mech: a?.id ?? "split", pts: [...m.centre], r: m.radius, engaged: inside.length });
        break;
      }
      case "band": {
        if (!a || !this.arena.lake) break;
        const lake = this.arena.lake;
        const water = this.sys.ground.water;
        for (const lp of this.inArena) {
          if (lp.untouchable) continue;
          const d = flatDist(lake.centre, lp.pos);
          if (d < lake.shore - 8 || d > lake.shore + (a.radius ?? 20)) continue;
          if (len(lp.pos) - this.sys.ground.R > water + 6) continue; // high rocks protect
          if (this.blocked(n.pos, lp.pos, a)) continue;
          this.sys.hitPlayer(n, lp.a, attackDamage(a, n.level), { fromDir: sub(lake.centre, lp.pos), knockback: a.knockback });
        }
        if (this.phase === 3) {
          // Each P3 surge smashes the Coral Pillar nearest the boss.
          const intact = this.cover.filter((c) => !c.broken && c.def.kind === "coral").sort((x, y) => dist(x.def.pos, n.pos) - dist(y.def.pos, n.pos));
          if (intact[0]) this.breakCover(intact[0], now);
        }
        this.event({ type: "mechanicEnd", mech: a.id });
        this.sys.setAnim(n, NPC_ANIM.IDLE);
        break;
      }
      case "raise": {
        if (!a?.summon) break;
        const idx = NPC_INDEX.get(a.summon)!;
        for (const id of [...this.summons]) if (!this.sys.npcs.has(id) || this.sys.npcs.get(id)!.dead) this.summons.delete(id);
        for (const p of m.points) {
          if (this.summons.size >= MAX_SUMMONS) break;
          const s = this.sys.createNpc(idx, a.summonLevel ?? n.level, p, now, { roam: this.arena.radius, summoner: n.id });
          s.anchor = this.arena.centre;
          this.summons.add(s.id);
          const target = this.inArena.find((lp) => !lp.untouchable);
          if (target) aggro(this.sys, s, target.a, now, false);
        }
        this.event({ type: "mechanicEnd", mech: a.id, pts: m.points.flat() });
        break;
      }
      case "topple": {
        const dmgPlayers = m.cover?.def.kind === "crane" ? 120 : 80;
        for (const lp of playersInLine(this.sys, m.centre, m.dir, m.length, m.width, 6)) this.sys.hitPlayer(null, lp.a, dmgPlayers, { fromDir: sub(m.centre, lp.pos) });
        // Did it land on the boss?
        const rel = sub(n.pos, m.centre);
        const along = dot(rel, m.dir);
        const lat = Math.abs(dot(rel, cross(up(m.centre), m.dir)));
        if (along >= -n.radius && along <= m.length + n.radius && lat <= m.width / 2 + n.radius) {
          if (m.cover?.def.kind === "crane") {
            this.openWindow(n, now, 3000, false);
            dealDamage(this.sys.world.host, null, n, 2000, false);
          } else {
            dealDamage(this.sys.world.host, null, n, 1000, false);
            this.staggerUntil = now + 3000;
            this.weakUntil = now + 3000;
            cancelAttack(this.sys, n);
            n.state.flags |= NF.STUNNED;
            this.sys.setMode(n, MODE.STUN, now, this.staggerUntil);
          }
        }
        this.event({ type: "mechanicEnd", mech: "topple", pts: [...m.centre] });
        break;
      }
    }
  }

  private clearSummons() {
    for (const id of this.summons) {
      const s = this.sys.npcs.get(id);
      if (s) this.sys.despawnNpc(s);
    }
    this.summons.clear();
  }

  private groundAt(p: V3): V3 {
    const l = len(p);
    const u: V3 = [p[0] / l, p[1] / l, p[2] / l];
    const r = this.sys.ground.R + Math.max(this.sys.ground.terrain.groundHeight(u[0], u[1], u[2]), this.sys.ground.water - 0.3);
    return [u[0] * r, u[1] * r, u[2] * r];
  }

  // ------------------------------------------------------------------------------------ cover

  /** Chain onto the combat host's prop hook so heavy hits near arena cover damage it. */
  private hookProps() {
    const host = this.sys.world.host;
    if (this.propHook && host.onPropHit === this.propHook) return;
    this.propPrev = host.onPropHit;
    const prev = this.propPrev;
    this.propHook = (point, power, amount) => {
      this.coverHit(point, power, amount);
      prev?.(point, power, amount);
    };
    host.onPropHit = this.propHook;
  }

  /**
   * Intact arena cover stops shots like a breakable prop (F12: a rocket aimed mid-pillar flew
   * through): wrap the combat host's prop raycast so hitscan, chain bolts, projectiles and NPC line
   * of sight stop at the first cover cylinder. The cover itself takes damage where the shot ends,
   * through onPropHit (coverHit), so `damage` on a cover index does nothing here.
   */
  private hookCover() {
    const host = this.sys.world.host;
    if (this.coverHost && host.props === this.coverHost) return;
    const inner = host.props;
    this.coverPrev = inner;
    const hit = { index: -1, t: 0 };
    this.coverHost = {
      raycast: (o, d, maxT) => {
        const h = inner?.raycast(o, d, maxT) ?? null;
        const propT = h ? h.t : Infinity;
        const propIdx = h ? h.index : -1;
        const c = this.coverRay(o, d, Math.min(maxT, propT));
        if (c.i < 0 && propIdx < 0) return null;
        hit.index = c.i >= 0 ? COVER_INDEX + c.i : propIdx;
        hit.t = c.i >= 0 ? c.t : propT;
        return hit;
      },
      damage: (index, ...rest) => {
        if (index < COVER_INDEX) inner?.damage(index, ...rest);
      },
      splash: (...args) => inner?.splash(...args),
      arc: (...args) => inner?.arc(...args),
      // Shots still reach a player standing inside a prop or a cover cylinder (F12), and movement
      // footing stays the destruction system's.
      contains: (index, p) => (index < COVER_INDEX ? !!inner?.contains?.(index, p) : this.coverContains(index - COVER_INDEX, p)),
      footing: (x, y, z, step) => inner?.footing?.(x, y, z, step) ?? NO_FOOTING,
    };
    host.props = this.coverHost;
  }

  /** Is `p` inside intact cover cylinder `i`? */
  private coverContains(i: number, p: V3): boolean {
    const c = this.cover[i];
    if (!c || c.broken) return false;
    const h = len(p) - len(c.def.pos);
    return h >= 0 && h <= c.def.height && flatDist(c.def.pos, p) < c.def.radius;
  }

  /** First intact cover cylinder along a ray within maxT: its index and distance (i = −1: none; reused object). */
  coverRay(o: V3, d: V3, maxT: number): { i: number; t: number } {
    const out = this.coverRayHit;
    out.i = -1;
    out.t = Infinity;
    let lim = maxT;
    for (let i = 0; i < this.cover.length; i++) {
      const c = this.cover[i]!;
      if (c.broken) continue;
      // Cheap reject: the whole cylinder is farther from the origin than the ray reaches.
      const p = c.def.pos, reach = lim + c.def.radius + c.def.height;
      const dx = p[0] - o[0], dy = p[1] - o[1], dz = p[2] - o[2];
      if (dx * dx + dy * dy + dz * dz > reach * reach) continue;
      const t = rayCylinder(o, d, lim, p, c.def.radius, c.def.height);
      if (t === Infinity) continue;
      out.i = i;
      out.t = lim = t;
    }
    return out;
  }

  /** Unhook from the combat host (the room is going away). */
  dispose() {
    const host = this.sys.world.host;
    if (this.coverHost && host.props === this.coverHost) host.props = this.coverPrev;
    if (this.propHook && host.onPropHit === this.propHook) host.onPropHit = this.propPrev;
    this.coverHost = null;
    this.propHook = null;
  }

  coverHit(point: V3, power: "light" | "heavy", amount: number) {
    if (this.status !== "alive") return;
    const now = this.sys.world.now();
    for (const c of this.cover) {
      if (c.broken) continue;
      if (c.def.heavyOnly && power !== "heavy") continue;
      if (flatDist(c.def.pos, point) > c.def.radius + 1.5) continue;
      const h = len(point) - len(c.def.pos);
      if (h < -1 || h > c.def.height + 1) continue;
      this.damageCover(c, amount, now);
    }
  }

  private damageCover(c: CoverState, amount: number, now: number) {
    if (c.broken) return;
    c.hp -= amount;
    if (c.hp <= 0) this.breakCover(c, now);
  }

  private breakCover(c: CoverState, now: number) {
    c.broken = true;
    c.hp = 0;
    this.event({ type: "mechanic", mech: "cover", pts: [c.def.id, ...c.def.pos] });
    const n = this.npc;
    if (!n || (c.def.kind !== "pillar" && c.def.kind !== "crane")) return;
    // Pillars topple (1.0 s creak + dust line) toward the King if he's close, else toward the nave;
    // a crane leg drops its arm (1.2 s groan + shadow line) across the yard.
    const toBoss = dist(c.def.pos, n.pos) <= c.def.height + 2;
    const dir = normalize(tangentDir(c.def.pos, toBoss ? n.pos : this.arena.centre));
    const crane = c.def.kind === "crane";
    const length = crane ? 28 : c.def.height;
    const width = crane ? 3 : 2.5;
    const ms = crane ? 1200 : 1000;
    const msg: NpcAttackMsg = { id: n.id, a: -2, sh: SHAPE_CODE.line, ms, x: c.def.pos[0], y: c.def.pos[1], z: c.def.pos[2], dx: dir[0], dy: dir[1], dz: dir[2], r: width / 2, w: width, l: length, ang: 0, c: 0 };
    this.mechs.push({ kind: "topple", atk: null, at: now + ms, centre: c.def.pos, points: [], dir, radius: 0, length, width, cover: c, msg });
    this.sys.sendNear(this.arena.centre, BOSS_MSG_RADIUS, "npcAtk", msg);
  }

  private rebuildCover() {
    for (const c of this.cover) {
      c.broken = false;
      c.hp = c.def.hp;
    }
  }
}

/**
 * Distance along a ray to an upright cylinder standing on `base` (radius r, height h, axis along the
 * local up), or Infinity beyond maxT. A ray starting inside doesn't hit it (no trapping the shooter).
 */
export function rayCylinder(o: V3, d: V3, maxT: number, base: V3, r: number, h: number): number {
  const u = normalize(base);
  const w = sub(o, base);
  const wu = dot(w, u), du = dot(d, u);
  const wp = add(w, u, -wu), dp = add(d, u, -du);
  const c = dot(wp, wp) - r * r;
  if (c <= 0 && wu >= 0 && wu <= h) return Infinity;
  let best = Infinity;
  const a = dot(dp, dp);
  if (a > 1e-9 && c > 0) {
    const b = 2 * dot(wp, dp);
    const disc = b * b - 4 * a * c;
    if (disc >= 0) {
      const t = (-b - Math.sqrt(disc)) / (2 * a);
      const y = wu + du * t;
      if (t >= 0 && t <= maxT && y >= 0 && y <= h) best = t;
    }
  }
  // The top cap, for shots from above.
  if (Math.abs(du) > 1e-9 && wu > h) {
    const t = (h - wu) / du;
    if (t >= 0 && t < best && t <= maxT) {
      const q = add(wp, dp, t);
      if (dot(q, q) <= r * r) best = t;
    }
  }
  return best;
}
