// One room = one copy of one body (Portus, Arcadia, Hollowmere or Meridian).
// Players enter only through POST /api/play (seat reservations); direct joins are refused.
// Owns: movement validation, combat, inventory, death and piles, logout/linger rules, AOI views.

import { CloseCode, Room, ServerError, type Client } from "@colyseus/core";
import { StateView } from "@colyseus/schema";
import { BODIES, createTerrain, isSafe, padDirs, portalNear, portalSpots, type BodyDef, type BodyId, type PortalSpot, type Terrain } from "@firstlight/shared";
import { BACKPACK_SLOTS, HOTBAR_SLOTS, newCharacter, type CharacterData } from "@firstlight/shared/content/character";
import { HORSE, rideSpeed } from "@firstlight/shared/content/horse";
import { fallDamageFraction, levelForXp, maxHp, pvpKillXp, xpAtLevel, xpToNext } from "@firstlight/shared/content/progression";
import { WEAPON_BY_ID, WEAPON_INDEX } from "@firstlight/shared/content/weapons";
import { NET, PHRASES, type InvItem, type YouState } from "@firstlight/shared/net/protocol";
import { ANIM, BodyState, NpcState, PF, PileState, PlayerState } from "@firstlight/shared/net/schema";
import { z } from "zod";
import type { Identity } from "../auth/identity.ts";
import { actorPos, pushHistory, type Actor, type NpcActor, type PlayerActor } from "./actors.ts";
import { characterRepo, withTx } from "./characters.ts";
import { CLOSE, hub, type HubRoom } from "./hub.ts";

/** Ban lookup for reconnects; set at boot when the database is available. */
export const bannedCheck: { current: (userId: string) => boolean } = { current: () => false };
import { dealDamage, fire, melee, selectedWeapon, stepEffects, stepProjectiles, type CombatHost } from "./combat.ts";
import { dist3, type V3 } from "./geometry.ts";
import { emitGameEvent, npcKindOf } from "./events.ts";
import { emitPileEvent, onPileEvent, pileStore, type PileData } from "./piles.ts";
import { SYSTEM_FACTORIES, type RoomSystem } from "./systems.ts";
import { activeMoveFx, movementLimits } from "./npc/effects.ts";
import { matchMaker } from "@colyseus/core";
import { liveSessions } from "../auth/sessions.ts";
import { accountLinks } from "../auth/links.ts";

export interface BodyRoomOptions {
  body: BodyId;
  copy: number;
  loadtest?: boolean;
}

export interface BodyRoomMetadata {
  body: BodyId;
  copy: number;
  loadtest: boolean;
}

/** Join options forwarded from /api/play for brand-new characters. */
export interface JoinOptions {
  body: BodyId;
  starter?: number;
  palette?: number;
}

export const MOVE = {
  maxSpeed: 9,
  speedSlack: 1.2, // network jitter allowance on top of sprint speed
  budgetCap: 3.5, // metres that can be banked (≈ 0.3 s of sprint + slack)
  dodgeBurst: 4.5,
  dodgeCooldownMs: 1100,
  groundTolerance: 0.5,
  maxJumpAbove: 2.6, // highest a jump can lift the feet above ground (with slopes)
  swimDepthSlack: 2.5,
};

export const RULES = {
  LOGOUT_MS: 30_000,
  LINGER_MS: 30_000,
  PROTECT_MS: 5_000,
  COMBAT_LOGOUT_BLOCK_MS: 10_000,
  PICKUP_RANGE: 3.5,
  AOI_ADD: 80,
  AOI_REMOVE: 100,
  SAVE_EVERY_MS: 30_000,
};

const vec = z.number().finite();
const inputSchema = z.object({ seq: z.number().int().nonnegative(), x: vec, y: vec, z: vec, fx: z.number().min(-1).max(1), fy: z.number().min(-1).max(1), fz: z.number().min(-1).max(1), anim: z.number().int().min(0).max(31), t: vec });
const fireSchema = z.object({ slot: z.number().int().min(0).max(3), ox: vec, oy: vec, oz: vec, dx: vec, dy: vec, dz: vec, t: vec, charge: z.number().min(0).max(1).optional() });
const meleeSchema = z.object({ slot: z.number().int().min(0).max(3), t: vec, heavy: z.boolean().optional() });
const slotSchema = z.object({ slot: z.number().int().min(0).max(HOTBAR_SLOTS + BACKPACK_SLOTS - 1) });
const pickupSchema = z.object({ pileId: z.string().max(64), itemIndex: z.number().int().min(0).max(64).optional() });
const respawnSchema = z.object({ starter: z.number().int().min(0).max(3), palette: z.number().int().min(0).max(5) });
const adminSchema = z.object({ cmd: z.string().max(32), args: z.record(z.string(), z.unknown()).optional() });


// Account merges: flush both identities before rows move, then retire their live actors without
// saving (the database now holds the winner). The guest rejoins under the new id.
accountLinks.onBeforeLink((from, to) => hub.flush(from, to));
accountLinks.on((ev) => {
  hub.retireAll(CLOSE.MERGED, "account merged, rejoin", ev.fromUserId);
  hub.retireAll(CLOSE.ELSEWHERE, "signed in elsewhere", ev.toUserId);
});

/** Last PvP kill time per killer>victim pair (repeat kills within 10 min give 10% XP). */
const pvpKills = new Map<string, number>();

const CLIENT_ANIMS: ReadonlySet<number> = new Set([ANIM.IDLE, ANIM.WALK, ANIM.RUN, ANIM.SPRINT, ANIM.JUMP, ANIM.FALL, ANIM.SWIM, ANIM.DODGE, ANIM.ATTACK, ANIM.HEAVY, ANIM.BLOCK, ANIM.AIM, ANIM.CAST, ANIM.EMOTE]);

export class BodyRoom extends Room<{ state: BodyState; metadata: BodyRoomMetadata }> implements HubRoom {
  maxClients = NET.MAX_CLIENTS;
  patchRate = NET.TICK_MS;
  maxMessagesPerSecond = 60;
  autoDispose = true;
  state = new BodyState();

  bodyDef!: BodyDef;
  terrain!: Terrain;
  readonly actors = new Map<string, PlayerActor>();
  readonly npcActors = new Map<string, NpcActor>();
  readonly lingering = new Map<string, { actor: PlayerActor; until: number }>();
  private readonly piles = new Map<string, PileData>();
  private unsubscribePiles: (() => void) | null = null;
  private unsubscribeLinks: (() => void) | null = null;
  private lastAoi = 0;
  private lastSave = 0;
  host!: CombatHost;
  systems: RoomSystem[] = [];
  portals: PortalSpot[] = [];

  static async onAuth(): Promise<unknown> {
    throw new ServerError(403, "join through /api/play");
  }

  onCreate(options: BodyRoomOptions) {
    // The client consumes its seat right after /api/play; short reservations stop seat hoarding.
    this.seatReservationTimeout = 8;
    this.bodyDef = BODIES[options.body];
    this.terrain = createTerrain(this.bodyDef);
    this.state.body = options.body;
    this.state.copy = options.copy;
    void this.setMetadata({ body: options.body, copy: options.copy, loadtest: !!options.loadtest });

    const room = this;
    this.host = {
      terrain: this.terrain,
      now: () => Date.now(),
      *players() {
        yield* room.actors.values();
        for (const l of room.lingering.values()) yield l.actor;
      },
      npcs: () => this.npcActors.values(),
      broadcast: (type, msg, except) => this.broadcast(type as never, msg as never, except ? { except: except.client } : undefined),
      broadcastNear: (type, msg, at, radius, always) => this.broadcastNear(type, msg, at, radius, always),
      onDamage: (target, amount, attacker) => this.afterDamage(target, attacker, amount),
    };

    for (const p of pileStore.current.list(options.body)) this.addPileToState(p);
    this.portals = portalSpots(this.bodyDef, this.terrain);
    this.unsubscribePiles = onPileEvent((e) => {
      if (e.kind === "remove") {
        if (e.body === this.bodyDef.id) this.removePileFromState(e.id);
      } else if (e.pile.body === this.bodyDef.id) {
        if (e.kind === "add") this.addPileToState(e.pile);
        else this.updatePileInState(e.pile);
      }
    });

    this.onMessage("input", inputSchema, (c, m) => this.handleInput(c, m));
    this.onMessage("ping", z.object({ t: vec }), (c, m) => c.send("pong", { t: m.t, serverTime: Date.now() }));
    this.onMessage("fire", fireSchema, (c, m) => {
      const a = this.actor(c);
      if (!a || a.dead) return;
      if (a.mounted) return void c.send("denied", { action: "fire", reason: "mounted" }); // no weapons from the saddle
      if (m.slot !== a.char.selected) this.equip(a, m.slot);
      const r = fire(this.host, a, m);
      if (!r.ok && r.reason !== "rate") c.send("denied", { action: "fire", reason: r.reason });
    });
    this.onMessage("melee", meleeSchema, (c, m) => {
      const a = this.actor(c);
      if (!a || a.dead) return;
      if (a.mounted) return void c.send("denied", { action: "melee", reason: "mounted" });
      if (m.slot !== a.char.selected) this.equip(a, m.slot);
      melee(this.host, a, !!m.heavy);
    });
    this.onMessage("block", z.object({ on: z.boolean() }), (c, m) => {
      const a = this.actor(c);
      if (!a || (m.on && a.mounted)) return;
      a.blocking = m.on;
      a.state.flags = m.on ? a.state.flags | PF.BLOCKING : a.state.flags & ~PF.BLOCKING;
    });
    this.onMessage("charge", z.object({ on: z.boolean() }), (c, m) => {
      const a = this.actor(c);
      if (a && !a.dead) a.chargeStartedAt = m.on && !a.mounted ? Date.now() : 0;
    });
    this.onMessage("travel", z.object({ to: z.enum(["portus", "arcadia", "hollowmere", "meridian"]) }), (c, m) => this.travelRequest(c, m.to));
    this.onMessage("scope", z.object({ on: z.boolean() }), (c, m) => {
      const a = this.actor(c);
      if (!a) return;
      a.state.flags = m.on ? a.state.flags | PF.SCOPED : a.state.flags & ~PF.SCOPED;
    });
    this.onMessage("reload", z.object({ slot: z.number().int().min(0).max(3) }), (c) => this.reload(this.actor(c)));
    this.onMessage("equip", z.object({ slot: z.number().int().min(0).max(3) }), (c, m) => {
      const a = this.actor(c);
      if (a && !a.dead) this.equip(a, m.slot);
    });
    this.onMessage("use", slotSchema, (c, m) => {
      const a = this.actor(c);
      if (this.invAllowed(a)) this.use(a, m.slot);
    });
    this.onMessage("pickup", pickupSchema, (c, m) => {
      const a = this.actor(c);
      if (this.invAllowed(a)) this.pickup(a, m.pileId, m.itemIndex);
    });
    this.onMessage("drop", slotSchema, (c, m) => {
      const a = this.actor(c);
      if (this.invAllowed(a)) this.drop(a, m.slot);
    });
    this.onMessage("move", z.object({ from: z.number().int().min(0).max(19), to: z.number().int().min(0).max(19) }), (c, m) => {
      const a = this.actor(c);
      if (this.invAllowed(a)) this.moveItem(a, m.from, m.to);
    });
    this.onMessage("logout", z.object({ start: z.boolean() }), (c, m) => this.logout(c, m.start));
    this.onMessage("respawn", respawnSchema, (c, m) => this.respawn(c, m.starter, m.palette));
    this.onMessage("phrase", z.object({ id: z.number().int().min(0).max(PHRASES.length - 1) }), (c, m) => {
      const a = this.actor(c);
      const now = Date.now();
      if (!a || a.dead || now - a.lastPhraseAt < 1000) return;
      a.lastPhraseAt = now;
      this.broadcastNear("phrase", { by: c.sessionId, id: m.id }, actorPos(a), 120);
    });
    this.onMessage("admin", adminSchema, (c, m) => this.admin(c, m.cmd, m.args ?? {}));

    this.systems = SYSTEM_FACTORIES.map((f) => f(this)).filter((x): x is RoomSystem => !!x);
    this.setTimestep((dt) => this.tick(dt), NET.TICK_MS);
  }

  onDispose() {
    this.unsubscribePiles?.();
    for (const s of this.systems) s.dispose?.();
    for (const a of this.actors.values()) this.finalLeave(a);
    for (const l of this.lingering.values()) this.finalLeave(l.actor);
  }

  /** Errors in handlers or the tick must never take the whole process down (review blocker). */
  onUncaughtException(error: Error, method: string) {
    console.error(`[room ${this.roomId}] ${method} failed:`, error);
  }

  // ---------------------------------------------------------------- joining and leaving

  onJoin(client: Client, options: JoinOptions | undefined, auth?: Identity) {
    if (!auth) throw new ServerError(403, "no identity");
    const now = Date.now();
    // One authoritative character per user: take over a live, dropped or lingering actor anywhere.
    let char: CharacterData | null = null;
    let inheritedCombat = false;
    let inheritedPos: V3 | null = null;
    const prev = hub.get(auth.userId);
    if (prev) {
      char = prev.actor.char;
      inheritedCombat = prev.actor.combatUntil > now && !prev.actor.dead;
      if (prev.actor.state && !prev.actor.dead) inheritedPos = [prev.actor.state.x, prev.actor.state.y, prev.actor.state.z];
      prev.room.saveActor(prev.actor);
      hub.release(auth.userId, prev.actor);
      prev.room.retire(prev.actor, CLOSE.ELSEWHERE, "playing in another window");
    }
    const legacy = liveSessions.register(auth.userId, this.roomId, client.sessionId);
    void legacy;
    characterRepo.current.ensure?.(auth.userId);
    char ??= characterRepo.current.load(auth.userId);
    if (!char) char = newCharacter(options?.starter ?? 0, options?.palette ?? 0, now);
    if (inheritedPos && char.body === this.bodyDef.id) char.pos = inheritedPos;
    const p = new PlayerState();
    let pos: V3;
    if (char.pos && char.body === this.bodyDef.id && !char.dead) pos = this.snapToGround(char.pos);
    else pos = this.spawnPoint(client.sessionId);
    char.body = this.bodyDef.id;
    char.travelTo = undefined;
    p.x = pos[0];
    p.y = pos[1];
    p.z = pos[2];
    const f = tangentForward(norm(pos));
    p.fx = f[0];
    p.fy = f[1];
    p.fz = f[2];
    p.anim = ANIM.IDLE;
    p.level = char.level;
    p.maxHp = maxHp(char.level);
    p.hp = char.dead ? 0 : Math.max(1, Math.min(p.maxHp, char.hp || p.maxHp));
    p.name = auth.name;
    p.userId = auth.userId; // random opaque id (not a credential): clients need it for blocks, mutes, parties (D27)
    p.starter = char.starter;
    p.palette = char.palette;
    p.flags = (auth.admin ? PF.ADMIN : 0) | (auth.loadtest ? PF.LOADTEST : 0) | (char.dead ? PF.DEAD : 0);
    const a: PlayerActor = {
      kind: "player",
      id: client.sessionId,
      client,
      identity: auth,
      char,
      state: p,
      history: [],
      lastX: p.x,
      lastY: p.y,
      lastZ: p.z,
      lastMoveAt: now,
      joinedAt: now,
      violations: 0,
      lastAttackAt: 0,
      reloadEndsAt: 0,
      heat: 0,
      overheatUntil: 0,
      blocking: false,
      // Rejoining out of a fight keeps you in it: no fresh protection, combat tag carried over.
      combatUntil: inheritedCombat ? now + 10_000 : 0,
      protectedUntil: inheritedCombat ? 0 : now + RULES.PROTECT_MS,
      heals: [],
      burn: null,
      healCooldownUntil: 0,
      tonicCooldownUntil: 0,
      logoutEndsAt: null,
      dead: !!char.dead,
      diedAt: 0,
      lastDamagedBy: null,
      youDirty: true,
      moveBudget: MOVE.budgetCap,
      lastBudgetAt: now,
      lastDodgeAt: 0,
      peakRadius: Math.hypot(p.x, p.y, p.z),
      airborne: false,
      chargeStartedAt: 0,
      specialReadyAt: 0,
      lastPhraseAt: 0,
      healAcc: 0,
    };
    this.equip(a, char.selected);
    if (!inheritedCombat) p.flags |= PF.PROTECTED;
    this.state.players.set(client.sessionId, p);
    this.actors.set(client.sessionId, a);
    hub.set(auth.userId, this, a);
    client.view = new StateView();
    this.updateViews(true);
    for (const s of this.systems) s.onPlayerJoin?.(client.sessionId);
    emitGameEvent(this, { type: "travel", playerId: client.sessionId, body: this.bodyDef.id });
    this.sendYou(a);
    if (a.dead) client.send("death", { victim: client.sessionId, killer: null, killerName: "", aliveMs: 0, level: char.level, pileId: "" });
  }

  onDrop(client: Client) {
    const a = this.actors.get(client.sessionId);
    if (!a || a.superseded || this.shuttingDown) return;
    a.state.flags |= PF.LINGER;
    // Kicked or banned: no reconnection seat (onLeave runs next and removes the body).
    if (this.systems.some((s) => s.canReconnect?.(client.sessionId) === false)) return;
    // The promise rejects when the window expires or the room disposes; never let that escape.
    this.allowReconnection(client, NET.RECONNECT_WINDOW_S).catch(() => {});
  }

  onReconnect(client: Client) {
    // Reconnects skip /api/play, so bans are checked here too (SPEC §5.2).
    if (this.systems.some((s) => s.canReconnect?.(client.sessionId) === false)) throw new ServerError(CLOSE.BANNED, "not allowed back");
    const a = this.actors.get(client.sessionId);
    if (!a || a.superseded || hub.get(a.identity.userId)?.actor !== a || this.isBanned(a.identity.userId)) {
      client.leave(CLOSE.ELSEWHERE, "session replaced");
      return;
    }
    a.client = client;
    a.state.flags &= ~PF.LINGER;
    a.youDirty = true;
    if (a.dead) client.send("death", { victim: client.sessionId, killer: null, killerName: "", aliveMs: Date.now() - a.char.lifeStartedAt, level: a.char.level, pileId: "" });
  }

  onLeave(client: Client, code?: number) {
    client.view?.dispose();
    const a = this.actors.get(client.sessionId);
    if (!a) return;
    this.actors.delete(client.sessionId);
    liveSessions.unregister(a.identity.userId, client.sessionId);
    for (const s of this.systems) s.onPlayerLeave?.(client.sessionId);
    if (a.superseded) {
      this.state.players.delete(client.sessionId);
      return;
    }
    const safe = isSafe(this.bodyDef, a.state.x, a.state.y, a.state.z);
    const dropped = code !== CloseCode.CONSENTED; // the 30 s reconnection window already elapsed
    if (a.dead || safe || a.loggedOut || dropped || this.shuttingDown || a.char.travelTo) {
      this.finalLeave(a);
      this.state.players.delete(client.sessionId);
      return;
    }
    // Left outside a safe zone without logging out: the body stays for 30 s and can die.
    a.state.flags |= PF.LINGER;
    this.saveActor(a);
    this.lingering.set(client.sessionId, { actor: a, until: Date.now() + RULES.LINGER_MS });
    this.autoDispose = false; // keep simulating the body even if nobody else is here
  }

  /** Save and forget an actor that is leaving the world. */
  private finalLeave(a: PlayerActor) {
    if (a.superseded) return;
    this.saveActor(a);
    hub.release(a.identity.userId, a);
  }

  /** Remove an actor without saving (superseded by a newer session or an account merge). */
  retire(a: PlayerActor, code: number, reason: string) {
    a.superseded = true;
    this.actors.delete(a.id);
    this.lingering.delete(a.id);
    this.state.players.delete(a.id);
    liveSessions.unregister(a.identity.userId, a.id);
    const c = this.clients.getById(a.id);
    if (c) c.leave(code, reason);
  }

  private shuttingDown = false;
  onBeforeShutdown() {
    this.shuttingDown = true;
    this.broadcast("updating", { seconds: 5 });
    withTx(() => {
      for (const a of this.actors.values()) this.saveActor(a);
      for (const l of this.lingering.values()) this.saveActor(l.actor);
    });
    super.onBeforeShutdown?.();
  }

  private isBanned(userId: string): boolean {
    try {
      return bannedCheck.current(userId);
    } catch {
      return false;
    }
  }

  // ---------------------------------------------------------------- travel

  /** Standing in a portal: authorise travel to its body (checked again by /api/play). */
  travelRequest(client: Client, to: BodyId) {
    const a = this.actors.get(client.sessionId);
    if (!a || a.dead) return;
    const spot = portalNear(this.portals, a.state.x, a.state.y, a.state.z);
    if (!spot || spot.to !== to) {
      client.send("denied", { action: "travel", reason: "not at a portal" });
      return;
    }
    a.char.travelTo = to;
    this.saveActor(a);
    client.send("travelOk", { to });
  }

  // ---------------------------------------------------------------- movement

  handleInput(client: Client, msg: z.infer<typeof inputSchema>) {
    const a = this.actors.get(client.sessionId);
    if (!a || a.dead || a.superseded || msg.seq <= a.state.seq) return;
    const p = a.state;
    const now = Date.now();
    // Distance budget: refills at sprint speed (+slack), banks at most budgetCap; a dodge adds a
    // one-off allowance no more often than its cooldown (review blocker: speed hack).
    // Riding (set only by the server's HorseSystem): gallop speed and a bigger bank, never a dodge;
    // the mounted budget outlives a dismount by HORSE.dismountGraceMs (the client is a round trip behind).
    const riding = !!a.mounted || now < (a.mountGraceUntil ?? 0);
    const elapsed = Math.min(0.25, (now - a.lastBudgetAt) / 1000);
    a.lastBudgetAt = now;
    // NPC slows / Cease-and-Desist (npc/effects.ts) scale the refill and can refuse the dodge burst.
    const limits = movementLimits(a, now);
    const fx = activeMoveFx(a, now);
    const refill = riding ? rideSpeed(true, fx.slow, fx.noSprint) : MOVE.maxSpeed * limits.speed;
    a.moveBudget = Math.min(riding ? HORSE.budgetCap : MOVE.budgetCap, a.moveBudget + refill * MOVE.speedSlack * elapsed);
    let dodge = 0;
    if (msg.anim === ANIM.DODGE && !riding && limits.dodge > 0 && now - a.lastDodgeAt >= MOVE.dodgeCooldownMs) {
      a.lastDodgeAt = now;
      dodge = MOVE.dodgeBurst * limits.dodge;
    }
    const dist = Math.hypot(msg.x - a.lastX, msg.y - a.lastY, msg.z - a.lastZ);
    const R = this.bodyDef.radius;
    const len = Math.hypot(msg.x, msg.y, msg.z);
    const ground = this.terrain.groundHeightAt(msg.x, msg.y, msg.z);
    const above = len - R - ground;
    const prevLen = Math.hypot(a.lastX, a.lastY, a.lastZ);
    const swimmingOk = ground < this.bodyDef.waterLevel - 1 && len - R >= this.bodyDef.waterLevel - MOVE.swimDepthSlack && len - R <= this.bodyDef.waterLevel + 0.5;
    // Height: no gaining height above ground beyond a jump; falling off cliffs is fine.
    const heightOk = above >= -MOVE.groundTolerance && (above <= MOVE.maxJumpAbove || len <= prevLen + 0.05);
    const ok = dist <= a.moveBudget + dodge + 0.05 && (heightOk || swimmingOk);
    if (!ok) {
      a.violations++;
      client.send("correct", { x: a.lastX, y: a.lastY, z: a.lastZ, seq: msg.seq });
      p.seq = msg.seq;
      return;
    }
    a.moveBudget = Math.max(0, a.moveBudget + dodge - dist);
    // Server-side fall damage from the validated trajectory.
    const grounded = above <= 0.35 || swimmingOk;
    if (!grounded) {
      a.airborne = true;
      a.peakRadius = Math.max(a.peakRadius, len);
    } else {
      if (a.airborne && !swimmingOk) {
        const drop = a.peakRadius - (R + ground);
        const frac = fallDamageFraction(drop);
        if (frac > 0) dealDamage(this.host, null, a, frac * maxHp(a.char.level), false);
      }
      a.airborne = false;
      a.peakRadius = len;
    }
    if (a.logoutEndsAt !== null && a.logoutFrom) {
      const [lx, ly, lz] = a.logoutFrom;
      if (Math.hypot(msg.x - lx, msg.y - ly, msg.z - lz) > 0.5) {
        a.logoutEndsAt = null;
        a.logoutFrom = undefined;
        a.youDirty = true;
      }
    }
    a.lastX = msg.x;
    a.lastY = msg.y;
    a.lastZ = msg.z;
    a.lastMoveAt = now;
    p.x = msg.x;
    p.y = msg.y;
    p.z = msg.z;
    p.fx = msg.fx;
    p.fy = msg.fy;
    p.fz = msg.fz;
    p.anim = CLIENT_ANIMS.has(msg.anim) ? msg.anim : ANIM.IDLE;
    p.seq = msg.seq;
    p.flags = swimmingOk ? p.flags | PF.SWIMMING : p.flags & ~PF.SWIMMING;
  }

  // ---------------------------------------------------------------- inventory

  private actor(c: Client): PlayerActor | undefined {
    return this.actors.get(c.sessionId);
  }

  private readonly invOps = new Map<string, number[]>();
  /** Inventory operations hit SQLite: at most 5 per second per player. */
  private invAllowed(a: PlayerActor | undefined): a is PlayerActor {
    if (!a || a.dead || a.superseded) return false;
    const now = Date.now();
    const list = (this.invOps.get(a.id) ?? []).filter((t) => now - t < 1000);
    if (list.length >= 5) return false;
    list.push(now);
    this.invOps.set(a.id, list);
    return true;
  }

  equip(a: PlayerActor, slot: number) {
    a.char.selected = Math.max(0, Math.min(HOTBAR_SLOTS - 1, slot));
    const item = a.char.hotbar[a.char.selected];
    a.state.weapon = item ? (WEAPON_INDEX.get(item.id) ?? 0) : 0;
    a.blocking = false;
    a.state.flags &= ~(PF.BLOCKING | PF.SCOPED);
    a.youDirty = true;
  }

  reload(a: PlayerActor | undefined) {
    if (!a || a.dead) return;
    const { tier } = selectedWeapon(a);
    const item = a.char.hotbar[a.char.selected];
    if (!item || tier.mag === undefined || (item.mag ?? tier.mag) >= tier.mag) return;
    a.reloadEndsAt = Date.now() + (tier.reload ?? 1.5) * 1000;
    item.mag = tier.mag;
    a.youDirty = true;
  }

  use(a: PlayerActor | undefined, slot: number) {
    if (!a || a.dead) return;
    const item = slot < HOTBAR_SLOTS ? a.char.hotbar[slot] : a.char.backpack[slot - HOTBAR_SLOTS];
    if (!item) return;
    const def = WEAPON_BY_ID.get(item.id);
    if (!def) return;
    const now = Date.now();
    const tier = def.tiers[item.tier - 1]!;
    if (tier.level > a.char.level) {
      a.client.send("denied", { action: "use", reason: "level gate" });
      return;
    }
    if (item.id === "tonic_small" || item.id === "tonic_large") {
      if (now < a.tonicCooldownUntil) return;
      a.tonicCooldownUntil = now + 8000;
      const dur = item.id === "tonic_small" ? 3 : 4;
      a.heals.push({ perSec: (tier.heal ?? 40) / dur, until: now + dur * 1000 });
      this.consume(a, slot);
    } else if (item.id === "patchkit") {
      if (now < a.healCooldownUntil) return;
      a.healCooldownUntil = now + (tier.cooldown ?? 6) * 1000;
      a.heals.push({ perSec: ((tier.heal ?? 0.3) * maxHp(a.char.level)) / 2, until: now + 2000 + (tier.rate ?? 1) * 1000 });
      this.consume(a, slot);
    }
  }

  private consume(a: PlayerActor, slot: number) {
    const list = slot < HOTBAR_SLOTS ? a.char.hotbar : a.char.backpack;
    const i = slot < HOTBAR_SLOTS ? slot : slot - HOTBAR_SLOTS;
    const item = list[i];
    if (!item) return;
    item.qty -= 1;
    if (item.qty <= 0) list[i] = null;
    if (slot === a.char.selected) this.equip(a, a.char.selected);
    a.youDirty = true;
  }

  /** Add an item to the first free (or stackable) slot: hotbar first, then backpack. */
  giveItem(a: PlayerActor, item: InvItem): boolean {
    const def = WEAPON_BY_ID.get(item.id);
    const stack = def?.stack ?? 1;
    for (const list of [a.char.hotbar, a.char.backpack]) {
      for (const s of list) {
        if (s && s.id === item.id && s.tier === item.tier && stack > 1 && s.qty + item.qty <= stack) {
          s.qty += item.qty;
          a.youDirty = true;
          return true;
        }
      }
    }
    for (const list of [a.char.hotbar, a.char.backpack]) {
      const i = list.findIndex((s) => !s);
      if (i >= 0) {
        list[i] = { ...item };
        if (list === a.char.hotbar && i === a.char.selected) this.equip(a, i);
        a.youDirty = true;
        return true;
      }
    }
    return false;
  }

  moveItem(a: PlayerActor | undefined, from: number, to: number) {
    if (!a || a.dead || from === to) return;
    const get = (s: number) => (s < HOTBAR_SLOTS ? a.char.hotbar[s] : a.char.backpack[s - HOTBAR_SLOTS]) ?? null;
    const set = (s: number, v: InvItem | null) => {
      if (s < HOTBAR_SLOTS) a.char.hotbar[s] = v;
      else a.char.backpack[s - HOTBAR_SLOTS] = v;
    };
    const x = get(from);
    set(from, get(to));
    set(to, x);
    this.equip(a, a.char.selected);
  }

  pickup(a: PlayerActor | undefined, pileId: string, itemIndex?: number) {
    if (!a || a.dead) return;
    const pile = pileStore.current.get(pileId);
    if (!pile || pile.body !== this.bodyDef.id) return;
    if (dist3([pile.x, pile.y, pile.z], actorPos(a)) > RULES.PICKUP_RANGE) return;
    // Take from the pile and save the character in one transaction (no dupes, no losses on crash).
    const events: (() => void)[] = [];
    const result = withTx(() => {
      const taken = pileStore.current.take(pileId, itemIndex);
      if (!taken) return null;
      const leftovers: InvItem[] = [];
      for (const it of taken.items) if (!this.giveItem(a, it)) leftovers.push(it);
      a.char.coins += taken.coins;
      if (taken.pile) events.push(() => emitPileEvent({ kind: "update", pile: taken.pile! }));
      else events.push(() => emitPileEvent({ kind: "remove", id: pileId, body: this.bodyDef.id }));
      // Items that didn't fit go back on the ground as a new pile.
      if (leftovers.length) this.createPile(a, leftovers, 0, actorPos(a), events);
      this.saveActor(a);
      return { taken, leftovers };
    });
    for (const e of events) e();
    if (!result) return;
    emitGameEvent(this, { type: "pickup", playerId: a.id, pileId, pileOwnerUserId: pile.ownerUserId, pileCreatedAt: pile.createdAt, items: result.taken.items.length - result.leftovers.length, coins: result.taken.coins });
    a.youDirty = true;
    const { taken, leftovers } = result;
    if (taken.coins || taken.items.length) a.client.send("toast", { text: `Picked up ${taken.items.length - leftovers.length} item(s)${taken.coins ? ` and ${taken.coins} coins` : ""}`, kind: "coins" });
  }

  drop(a: PlayerActor | undefined, slot: number) {
    if (!a || a.dead) return;
    const list = slot < HOTBAR_SLOTS ? a.char.hotbar : a.char.backpack;
    const i = slot < HOTBAR_SLOTS ? slot : slot - HOTBAR_SLOTS;
    const item = list[i];
    if (!item) return;
    list[i] = null;
    if (slot === a.char.selected) this.equip(a, a.char.selected);
    const pos = actorPos(a);
    const f: V3 = [a.state.fx, a.state.fy, a.state.fz];
    const events: (() => void)[] = [];
    withTx(() => {
      this.createPile(a, [item], 0, [pos[0] + f[0] * 1.2, pos[1] + f[1] * 1.2, pos[2] + f[2] * 1.2], events);
      this.saveActor(a);
    });
    for (const e of events) e();
    a.youDirty = true;
  }

  createPile(owner: PlayerActor, items: InvItem[], coins: number, at: V3, deferred?: (() => void)[]): PileData {
    const g = this.snapToGround(at);
    const { pile, evicted } = pileStore.current.add({
      body: this.bodyDef.id,
      x: g[0],
      y: g[1],
      z: g[2],
      owner: owner.identity.name,
      ownerUserId: owner.identity.userId,
      createdAt: Date.now(),
      items,
      coins,
    });
    const publish = () => {
      emitPileEvent({ kind: "add", pile });
      for (const id of evicted) emitPileEvent({ kind: "remove", id, body: this.bodyDef.id });
    };
    if (deferred) deferred.push(publish);
    else publish();
    return pile;
  }

  private addPileToState(p: PileData) {
    this.piles.set(p.id, p);
    const s = new PileState();
    s.x = p.x;
    s.y = p.y;
    s.z = p.z;
    s.owner = p.owner;
    s.createdAt = p.createdAt;
    s.items = Math.min(255, p.items.length);
    s.coins = p.coins;
    this.state.piles.set(p.id, s);
  }

  private updatePileInState(p: PileData) {
    this.piles.set(p.id, p);
    const s = this.state.piles.get(p.id);
    if (!s) return this.addPileToState(p);
    s.items = Math.min(255, p.items.length);
    s.coins = p.coins;
  }

  private removePileFromState(id: string) {
    this.piles.delete(id);
    const s = this.state.piles.get(id);
    if (s) for (const c of this.clients) c.view?.remove(s);
    this.state.piles.delete(id);
  }

  // ---------------------------------------------------------------- damage, death, rebirth

  afterDamage(target: Actor, attacker: PlayerActor | NpcActor | null, amount = 0) {
    const npc = target.kind === "npc" ? target : attacker?.kind === "npc" ? attacker : null;
    emitGameEvent(this, {
      type: "damage", targetId: target.id, targetKind: target.kind, attackerId: attacker?.id ?? null, attackerKind: attacker?.kind ?? "world",
      npcKind: npc ? npcKindOf(npc) : undefined, boss: !!npc?.boss, amount, hpAfter: target.state.hp, maxHp: target.state.maxHp, at: Date.now(),
    });
    if (target.kind === "player") {
      target.youDirty = true;
      if (target.state.hp <= 0 && !target.dead) this.kill(target, attacker);
    } else if (target.state.hp <= 0) {
      target.onKilled?.(attacker?.id ?? null);
    }
  }

  kill(victim: PlayerActor, killer: PlayerActor | NpcActor | null) {
    const now = Date.now();
    victim.dead = true;
    victim.diedAt = now;
    victim.state.flags |= PF.DEAD;
    victim.state.anim = ANIM.DEAD;
    victim.logoutEndsAt = null;
    const items = [...victim.char.hotbar, ...victim.char.backpack].filter((x): x is InvItem => !!x);
    const events: (() => void)[] = [];
    let pile: PileData | null = null;
    withTx(() => {
      pile = (items.length || victim.char.coins) && !victim.identity.loadtest ? this.createPile(victim, items, victim.char.coins, actorPos(victim), events) : null;
      victim.char.hotbar = [null, null, null, null];
      victim.char.backpack = Array.from({ length: BACKPACK_SLOTS }, () => null);
      victim.char.coins = 0;
      victim.char.dead = true;
      victim.char.deaths += 1;
      this.saveActor(victim);
    });
    for (const e of events) e();
    this.equip(victim, 0);
    const killerName = killer ? (killer.kind === "player" ? killer.identity.name : `npc:${npcKindOf(killer) ?? killer.state.kind}`) : "the fall";
    const pileId = (pile as PileData | null)?.id ?? "";
    this.broadcast("death", { victim: victim.id, killer: killer?.id ?? null, killerName, aliveMs: now - victim.char.lifeStartedAt, level: victim.char.level, pileId });
    emitGameEvent(this, { type: "death", victimId: victim.id, killerId: killer?.id ?? null, killerKind: killer?.kind ?? "world", npcKind: killer?.kind === "npc" ? npcKindOf(killer) : undefined, pos: actorPos(victim) });
    if (killer && killer.kind === "player" && killer.id !== victim.id) {
      const key = `${killer.identity.userId}>${victim.identity.userId}`;
      const recent = pvpKills.get(key) ?? 0;
      pvpKills.set(key, now);
      this.grantXp(killer, Math.round(pvpKillXp(victim.char.level, killer.char.level) * (now - recent < 10 * 60_000 ? 0.1 : 1)));
    }
  }

  respawn(client: Client, starter: number, palette: number) {
    const a = this.actors.get(client.sessionId);
    if (!a || !a.dead) return;
    const fresh = newCharacter(starter, palette);
    fresh.deaths = a.char.deaths;
    fresh.travelTo = "portus";
    a.char = fresh;
    characterRepo.current.save(a.identity.userId, fresh);
    // Rebirth happens in Portus: the client leaves and joins Portus.
    client.send("reborn", { body: "portus" });
  }

  grantXp(a: PlayerActor, amount: number) {
    if (amount <= 0 || a.dead) return;
    const before = a.char.level;
    a.char.xp += amount;
    a.char.level = levelForXp(a.char.xp);
    if (a.char.level > before) {
      const oldMax = maxHp(before);
      const newMax = maxHp(a.char.level);
      a.state.maxHp = newMax;
      a.state.hp = Math.min(newMax, a.state.hp + (newMax - oldMax));
      a.state.level = a.char.level;
      a.client.send("toast", { text: `Level ${a.char.level}!`, kind: "xp" });
      emitGameEvent(this, { type: "levelUp", playerId: a.id, level: a.char.level });
      this.saveActor(a);
    }
    a.youDirty = true;
  }

  // ---------------------------------------------------------------- logout

  logout(client: Client, start: boolean) {
    const a = this.actors.get(client.sessionId);
    if (!a) return;
    const now = Date.now();
    if (!start) {
      a.logoutEndsAt = null;
      a.youDirty = true;
      return;
    }
    if (a.dead || (isSafe(this.bodyDef, a.state.x, a.state.y, a.state.z) && now >= a.combatUntil)) {
      this.completeLogout(a);
      return;
    }
    if (now < a.combatUntil) {
      client.send("denied", { action: "logout", reason: "in combat" });
      return;
    }
    a.logoutEndsAt = now + RULES.LOGOUT_MS;
    a.logoutFrom = [a.state.x, a.state.y, a.state.z];
    a.state.flags |= PF.LOGGING_OUT;
    a.youDirty = true;
  }

  /** Logout finished: save, tell the client, and detach the actor (no linger, no sticky flag). */
  completeLogout(a: PlayerActor) {
    a.loggedOut = true;
    a.logoutEndsAt = null;
    this.saveActor(a);
    a.client.send("loggedOut", {});
    const c = a.client;
    setTimeout(() => c.leave(CLOSE.LOGGED_OUT, "logged out"), 250);
  }

  // ---------------------------------------------------------------- admin (tests, staged scenes)

  admin(client: Client, cmd: string, args: Record<string, unknown>) {
    const a = this.actors.get(client.sessionId);
    if (!a || !a.identity.admin) return;
    const num = (k: string, d = 0) => (typeof args[k] === "number" ? (args[k] as number) : d);
    const target = typeof args.target === "string" ? this.actors.get(args.target) : a;
    switch (cmd) {
      case "teleport": {
        const t = target ?? a;
        const p = this.snapToGround([num("x"), num("y"), num("z")]);
        t.state.x = t.lastX = p[0];
        t.state.y = t.lastY = p[1];
        t.state.z = t.lastZ = p[2];
        t.history.length = 0;
        t.client.send("correct", { x: p[0], y: p[1], z: p[2], seq: t.state.seq });
        break;
      }
      case "give": {
        const id = typeof args.id === "string" ? args.id : "carbine";
        if (WEAPON_BY_ID.has(id)) this.giveItem(target ?? a, { id, tier: (Math.max(1, Math.min(3, num("tier", 1))) as 1 | 2 | 3), qty: Math.max(1, num("qty", 1)) });
        break;
      }
      case "level": {
        const t = target ?? a;
        const lv = Math.max(1, Math.min(20, num("level", 1)));
        t.char.xp = xpAtLevel(lv);
        t.char.level = lv;
        t.state.level = lv;
        t.state.maxHp = maxHp(lv);
        t.state.hp = t.state.maxHp;
        t.youDirty = true;
        break;
      }
      case "coins":
        (target ?? a).char.coins += num("amount", 100);
        (target ?? a).youDirty = true;
        break;
      case "heal":
        (target ?? a).state.hp = (target ?? a).state.maxHp;
        break;
      case "unprotect":
        (target ?? a).protectedUntil = 0;
        (target ?? a).state.flags &= ~PF.PROTECTED;
        break;
      case "damage":
        if (target) dealDamage(this.host, null, target, num("amount", 10), false);
        break;
      case "announce":
        this.presence.publish("announce", String(args.text ?? "").slice(0, 200));
        this.broadcast("announce", { text: String(args.text ?? "").slice(0, 200) });
        break;
      default:
        for (const s of this.systems) if (s.onAdmin?.(a, cmd, args)) break;
    }
  }

  // ---------------------------------------------------------------- tick

  /** Recent tick durations (ms) for /api/metrics. */
  readonly tickTimes: number[] = [];

  tick(dtMs: number) {
    const t0 = performance.now();
    this.tickBody(dtMs);
    this.tickTimes.push(performance.now() - t0);
    if (this.tickTimes.length > 400) this.tickTimes.shift();
  }

  private tickBody(dtMs: number) {
    const now = Date.now();
    const dt = dtMs / 1000;
    this.state.time = now;
    for (const a of this.actors.values()) {
      const p = a.state;
      pushHistory(a, now);
      // Safe-zone protection only applies once out of combat (no running onto a pad mid-fight).
      const safe = isSafe(this.bodyDef, p.x, p.y, p.z) && now >= a.combatUntil;
      p.flags = safe ? p.flags | PF.SAFE : p.flags & ~PF.SAFE;
      if (a.protectedUntil <= now) p.flags &= ~PF.PROTECTED;
      if (now < a.combatUntil) p.flags |= PF.IN_COMBAT;
      else p.flags &= ~PF.IN_COMBAT;
      if (a.logoutEndsAt === null) p.flags &= ~PF.LOGGING_OUT;
      else if (now >= a.logoutEndsAt) this.completeLogout(a);
      if (!a.dead) a.char.hp = p.hp;
    }
    for (const n of this.npcActors.values()) pushHistory(n, now);
    for (const [sid, l] of this.lingering) {
      pushHistory(l.actor, now);
      if (l.actor.dead || now >= l.until) {
        this.finalLeave(l.actor);
        this.lingering.delete(sid);
        this.state.players.delete(sid);
      }
    }
    // Lingering bodies keep the room alive; once they're gone an empty room may dispose.
    if (this.lingering.size === 0 && !this.autoDispose) {
      this.autoDispose = true;
      if (this.clients.length === 0) void this.disconnect();
    }
    for (const s of this.systems) s.tick(dtMs, now);
    stepProjectiles(this.host, dt);
    stepEffects(this.host, dt);
    if (now - this.lastAoi > 200) {
      this.lastAoi = now;
      this.updateViews(false);
    }
    for (const a of this.actors.values()) if (a.youDirty) this.sendYou(a);
    if (now - this.lastSave > RULES.SAVE_EVERY_MS) {
      this.lastSave = now;
      withTx(() => {
        for (const a of this.actors.values()) this.saveActor(a);
      });
    }
  }

  /** Distance-based views for NPCs and piles (players are not view-filtered). */
  updateViews(force: boolean) {
    for (const c of this.clients) {
      const a = this.actors.get(c.sessionId);
      if (!a || !c.view) continue;
      const me = actorPos(a);
      for (const [id, s] of this.state.piles) {
        const d = dist3(me, [s.x, s.y, s.z]);
        const has = c.view.has(s);
        if (!has && d <= RULES.AOI_ADD) c.view.add(s);
        else if (has && d > RULES.AOI_REMOVE) c.view.remove(s);
        void id;
      }
      for (const n of this.npcActors.values()) {
        const d = dist3(me, actorPos(n));
        const has = c.view.has(n.state);
        if (!has && d <= RULES.AOI_ADD) c.view.add(n.state);
        else if (has && d > RULES.AOI_REMOVE) c.view.remove(n.state);
      }
    }
    void force;
  }

  sendYou(a: PlayerActor) {
    a.youDirty = false;
    const you: YouState = {
      xp: a.char.xp - xpAtLevel(a.char.level),
      xpToNext: xpToNext(a.char.level),
      coins: a.char.coins,
      hotbar: a.char.hotbar,
      backpack: a.char.backpack,
      missions: a.char.missions.map((m) => ({ id: m.id, progress: m.progress, goal: 0, done: m.done })),
      medals: [],
      pads: [],
      logoutEndsAt: a.logoutEndsAt,
      protectedUntil: a.protectedUntil,
    };
    for (const s of this.systems) s.decorateYou?.(a, you);
    a.client.send("you", { ...you, selected: a.char.selected, level: a.char.level, dead: a.dead });
  }

  saveActor(a: PlayerActor) {
    if (a.superseded || a.identity.loadtest) return;
    if (!a.dead) a.char.pos = [a.state.x, a.state.y, a.state.z];
    a.char.hp = a.state.hp;
    characterRepo.current.save(a.identity.userId, a.char);
  }

  // ---------------------------------------------------------------- helpers

  snapToGround(p: readonly number[]): V3 {
    const d = norm(p);
    const g = this.terrain.groundHeight(d[0], d[1], d[2]);
    const R = this.bodyDef.radius;
    const r = R + Math.max(g, this.bodyDef.waterLevel - 1.05) + 0.02;
    return [d[0] * r, d[1] * r, d[2] * r];
  }

  spawnPoint(seed: string): V3 {
    const pads = padDirs(this.bodyDef);
    const d = pads[0]!;
    let h = 0;
    for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
    const ang = ((h % 360) / 360) * Math.PI * 2;
    const r = 2 + (h % 5);
    const t1 = tangentForward(d);
    const t2 = cross(d, t1);
    const R = this.bodyDef.radius;
    const dir = norm([
      d[0] + ((Math.cos(ang) * t1[0] + Math.sin(ang) * t2[0]) * r) / R,
      d[1] + ((Math.cos(ang) * t1[1] + Math.sin(ang) * t2[1]) * r) / R,
      d[2] + ((Math.cos(ang) * t1[2] + Math.sin(ang) * t2[2]) * r) / R,
    ]);
    return this.snapToGround(dir);
  }

  /** Send to clients within `radius` of `at`, plus `always` session ids (bandwidth: review). */
  broadcastNear(type: string, msg: unknown, at: readonly number[], radius: number, always?: string[]) {
    const r2 = radius * radius;
    for (const c of this.clients) {
      const a = this.actors.get(c.sessionId);
      if (!a) continue;
      const dx = a.state.x - at[0]!, dy = a.state.y - at[1]!, dz = a.state.z - at[2]!;
      if (dx * dx + dy * dy + dz * dz <= r2 || always?.includes(c.sessionId)) c.send(type, msg);
    }
  }

  /** For systems (AI, missions) that award XP to a player by session id. */
  playerById(id: string): PlayerActor | undefined {
    return this.actors.get(id);
  }

  addNpc(n: NpcActor) {
    this.npcActors.set(n.id, n);
    this.state.npcs.set(n.id, n.state);
  }

  removeNpc(id: string) {
    const n = this.npcActors.get(id);
    if (!n) return;
    for (const c of this.clients) c.view?.remove(n.state);
    this.npcActors.delete(id);
    this.state.npcs.delete(id);
  }

  newNpcState(): NpcState {
    return new NpcState();
  }
}

function norm(v: readonly number[]): V3 {
  const l = Math.hypot(v[0]!, v[1]!, v[2]!);
  return [v[0]! / l, v[1]! / l, v[2]! / l];
}

function cross(a: readonly number[], b: readonly number[]): V3 {
  return [a[1]! * b[2]! - a[2]! * b[1]!, a[2]! * b[0]! - a[0]! * b[2]!, a[0]! * b[1]! - a[1]! * b[0]!];
}

/** A stable tangent direction at `up`. */
export function tangentForward(up: readonly number[]): V3 {
  const ref = Math.abs(up[2]!) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  const d = ref[0]! * up[0]! + ref[1]! * up[1]! + ref[2]! * up[2]!;
  return norm([ref[0]! - d * up[0]!, ref[1]! - d * up[1]!, ref[2]! - d * up[2]!]);
}

export type { CharacterData };
