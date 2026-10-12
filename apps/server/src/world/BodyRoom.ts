// One room = one copy of one body (Portus, Arcadia, Hollowmere or Meridian).
// Players enter only through POST /api/play (seat reservations); direct joins are refused.
// Owns: movement validation, combat, inventory, death and piles, logout/linger rules, AOI views.

import { CloseCode, Room, ServerError, type Client } from "@colyseus/core";
import { StateView } from "@colyseus/schema";
import { BODIES, createTerrain, isSafe, padDirs, type BodyDef, type BodyId, type Terrain } from "@firstlight/shared";
import { BACKPACK_SLOTS, HOTBAR_SLOTS, newCharacter, type CharacterData } from "@firstlight/shared/content/character";
import { levelForXp, maxHp, pvpKillXp, xpAtLevel, xpToNext } from "@firstlight/shared/content/progression";
import { WEAPON_BY_ID, WEAPON_INDEX } from "@firstlight/shared/content/weapons";
import { NET, PHRASES, type InvItem, type YouState } from "@firstlight/shared/net/protocol";
import { ANIM, BodyState, NpcState, PF, PileState, PlayerState } from "@firstlight/shared/net/schema";
import { z } from "zod";
import type { Identity } from "../auth/identity.ts";
import { actorPos, pushHistory, type Actor, type NpcActor, type PlayerActor } from "./actors.ts";
import { characterRepo } from "./characters.ts";
import { dealDamage, fire, melee, selectedWeapon, stepEffects, stepProjectiles, type CombatHost } from "./combat.ts";
import { dist3, type V3 } from "./geometry.ts";
import { emitPileEvent, onPileEvent, pileStore, type PileData } from "./piles.ts";
import { SYSTEM_FACTORIES, type RoomSystem } from "./systems.ts";

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
  dodgeBurst: 4.5,
  slack: 1.0,
  groundTolerance: 0.5,
  maxAboveGround: 40,
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

let pileSeq = 0;

export class BodyRoom extends Room<{ state: BodyState; metadata: BodyRoomMetadata }> {
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
  private lastAoi = 0;
  private lastSave = 0;
  host!: CombatHost;
  systems: RoomSystem[] = [];

  static async onAuth(): Promise<unknown> {
    throw new ServerError(403, "join through /api/play");
  }

  onCreate(options: BodyRoomOptions) {
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
      onDamage: (target, _amount, attacker) => this.afterDamage(target, attacker),
    };

    for (const p of pileStore.current.list(options.body)) this.addPileToState(p);
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
      if (m.slot !== a.char.selected) this.equip(a, m.slot);
      const r = fire(this.host, a, m);
      if (!r.ok && r.reason !== "rate") c.send("denied", { action: "fire", reason: r.reason });
    });
    this.onMessage("melee", meleeSchema, (c, m) => {
      const a = this.actor(c);
      if (!a || a.dead) return;
      if (m.slot !== a.char.selected) this.equip(a, m.slot);
      melee(this.host, a, !!m.heavy);
    });
    this.onMessage("block", z.object({ on: z.boolean() }), (c, m) => {
      const a = this.actor(c);
      if (!a) return;
      a.blocking = m.on;
      a.state.flags = m.on ? a.state.flags | PF.BLOCKING : a.state.flags & ~PF.BLOCKING;
    });
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
    this.onMessage("use", slotSchema, (c, m) => this.use(this.actor(c), m.slot));
    this.onMessage("pickup", pickupSchema, (c, m) => this.pickup(this.actor(c), m.pileId, m.itemIndex));
    this.onMessage("drop", slotSchema, (c, m) => this.drop(this.actor(c), m.slot));
    this.onMessage("move", z.object({ from: z.number().int().min(0).max(19), to: z.number().int().min(0).max(19) }), (c, m) => this.moveItem(this.actor(c), m.from, m.to));
    this.onMessage("logout", z.object({ start: z.boolean() }), (c, m) => this.logout(c, m.start));
    this.onMessage("respawn", respawnSchema, (c, m) => this.respawn(c, m.starter, m.palette));
    this.onMessage("phrase", z.object({ id: z.number().int().min(0).max(PHRASES.length - 1) }), (c, m) => {
      const a = this.actor(c);
      if (a && !a.dead) this.broadcast("phrase", { by: c.sessionId, id: m.id });
    });
    this.onMessage("admin", adminSchema, (c, m) => this.admin(c, m.cmd, m.args ?? {}));

    this.systems = SYSTEM_FACTORIES.map((f) => f(this)).filter((x): x is RoomSystem => !!x);
    this.setTimestep((dt) => this.tick(dt), NET.TICK_MS);
  }

  onDispose() {
    this.unsubscribePiles?.();
    for (const s of this.systems) s.dispose?.();
    for (const a of this.actors.values()) this.saveActor(a);
    for (const l of this.lingering.values()) this.saveActor(l.actor);
  }

  // ---------------------------------------------------------------- joining and leaving

  onJoin(client: Client, options: JoinOptions | undefined, auth?: Identity) {
    if (!auth) throw new ServerError(403, "no identity");
    // A lingering body of the same user in this room is reclaimed.
    for (const [sid, l] of this.lingering) {
      if (l.actor.identity.userId === auth.userId) {
        this.state.players.delete(sid);
        this.lingering.delete(sid);
      }
    }
    let char = characterRepo.current.load(auth.userId);
    const now = Date.now();
    if (!char) char = newCharacter(options?.starter ?? 0, options?.palette ?? 0, now);
    const p = new PlayerState();
    let pos: V3;
    if (char.pos && char.body === this.bodyDef.id && !char.dead) pos = this.snapToGround(char.pos);
    else pos = this.spawnPoint(client.sessionId);
    char.body = this.bodyDef.id;
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
    p.userId = auth.userId;
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
      combatUntil: 0,
      protectedUntil: now + RULES.PROTECT_MS,
      heals: [],
      burn: null,
      healCooldownUntil: 0,
      tonicCooldownUntil: 0,
      logoutEndsAt: null,
      dead: !!char.dead,
      diedAt: 0,
      lastDamagedBy: null,
      youDirty: true,
    };
    this.equip(a, char.selected);
    p.flags |= PF.PROTECTED;
    this.state.players.set(client.sessionId, p);
    this.actors.set(client.sessionId, a);
    client.view = new StateView();
    this.updateViews(true);
    for (const s of this.systems) s.onPlayerJoin?.(client.sessionId);
    this.sendYou(a);
    if (a.dead) client.send("death", { victim: client.sessionId, killer: null, killerName: "", aliveMs: 0, level: char.level, pileId: "" });
  }

  onDrop(client: Client) {
    const a = this.actors.get(client.sessionId);
    if (a) a.state.flags |= PF.LINGER;
    this.allowReconnection(client, NET.RECONNECT_WINDOW_S);
  }

  onReconnect(client: Client) {
    const a = this.actors.get(client.sessionId);
    if (a) {
      a.client = client;
      a.state.flags &= ~PF.LINGER;
      a.youDirty = true;
    }
  }

  onLeave(client: Client, code?: number) {
    const a = this.actors.get(client.sessionId);
    client.view?.dispose();
    if (!a) return;
    this.actors.delete(client.sessionId);
    for (const s of this.systems) s.onPlayerLeave?.(client.sessionId);
    const safe = isSafe(this.bodyDef, a.state.x, a.state.y, a.state.z);
    const cleanLogout = (a as PlayerActor & { loggedOut?: boolean }).loggedOut === true;
    const dropped = code !== CloseCode.CONSENTED; // reconnection window already elapsed
    if (a.dead || safe || cleanLogout || dropped || this.shuttingDown) {
      this.saveActor(a);
      this.state.players.delete(client.sessionId);
      return;
    }
    // Left outside a safe zone without logging out: the body stays for 30 s and can die.
    a.state.flags |= PF.LINGER;
    this.lingering.set(client.sessionId, { actor: a, until: Date.now() + RULES.LINGER_MS });
  }

  private shuttingDown = false;
  onBeforeShutdown() {
    this.shuttingDown = true;
    this.broadcast("updating", { seconds: 5 });
    for (const a of this.actors.values()) {
      a.char.pos = [a.state.x, a.state.y, a.state.z];
      this.saveActor(a);
    }
    super.onBeforeShutdown?.();
  }

  // ---------------------------------------------------------------- movement

  handleInput(client: Client, msg: z.infer<typeof inputSchema>) {
    const a = this.actors.get(client.sessionId);
    if (!a || a.dead || msg.seq <= a.state.seq) return;
    const p = a.state;
    const now = Date.now();
    const dt = Math.max(0.05, (now - a.lastMoveAt) / 1000);
    const dist = Math.hypot(msg.x - a.lastX, msg.y - a.lastY, msg.z - a.lastZ);
    const allowed = MOVE.maxSpeed * dt * 1.25 + MOVE.dodgeBurst + MOVE.slack;
    const R = this.bodyDef.radius;
    const len = Math.hypot(msg.x, msg.y, msg.z);
    const ground = this.terrain.groundHeightAt(msg.x, msg.y, msg.z);
    const above = len - R - ground;
    const swimmingOk = ground < this.bodyDef.waterLevel - 1 && len - R >= this.bodyDef.waterLevel - 2.5;
    const ok = dist <= allowed && (above >= -MOVE.groundTolerance || swimmingOk) && above <= MOVE.maxAboveGround;
    if (!ok) {
      a.violations++;
      client.send("correct", { x: a.lastX, y: a.lastY, z: a.lastZ, seq: msg.seq });
      p.seq = msg.seq;
      return;
    }
    if (a.logoutEndsAt !== null && dist > 0.4) {
      a.logoutEndsAt = null;
      a.youDirty = true;
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
    p.anim = msg.anim;
    p.seq = msg.seq;
    p.flags = msg.anim === ANIM.SWIM ? p.flags | PF.SWIMMING : p.flags & ~PF.SWIMMING;
  }

  // ---------------------------------------------------------------- inventory

  private actor(c: Client): PlayerActor | undefined {
    return this.actors.get(c.sessionId);
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
    const taken = pileStore.current.take(pileId, itemIndex);
    if (!taken) return;
    const leftovers: InvItem[] = [];
    for (const it of taken.items) if (!this.giveItem(a, it)) leftovers.push(it);
    a.char.coins += taken.coins;
    a.youDirty = true;
    if (taken.pile) emitPileEvent({ kind: "update", pile: taken.pile });
    else emitPileEvent({ kind: "remove", id: pileId, body: this.bodyDef.id });
    // Items that didn't fit go back on the ground as a new pile.
    if (leftovers.length) this.createPile(a, leftovers, 0, actorPos(a));
    if (taken.coins || taken.items.length) a.client.send("toast", { text: `Picked up ${taken.items.length - leftovers.length} item(s)${taken.coins ? ` and ${taken.coins} coins` : ""}`, kind: "coins" });
    this.saveActor(a);
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
    this.createPile(a, [item], 0, [pos[0] + f[0] * 1.2, pos[1] + f[1] * 1.2, pos[2] + f[2] * 1.2]);
    a.youDirty = true;
  }

  createPile(owner: PlayerActor, items: InvItem[], coins: number, at: V3): PileData {
    const g = this.snapToGround(at);
    const pile: PileData = {
      id: `${this.bodyDef.id}-${Date.now().toString(36)}-${(pileSeq++).toString(36)}`,
      body: this.bodyDef.id,
      x: g[0],
      y: g[1],
      z: g[2],
      owner: owner.identity.name,
      ownerUserId: owner.identity.userId,
      createdAt: Date.now(),
      items,
      coins,
    };
    const evicted = pileStore.current.add(pile);
    emitPileEvent({ kind: "add", pile });
    for (const e of evicted) emitPileEvent({ kind: "remove", id: e.id, body: e.body });
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

  afterDamage(target: Actor, attacker: PlayerActor | NpcActor | null) {
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
    const pile = items.length || victim.char.coins ? this.createPile(victim, items, victim.char.coins, actorPos(victim)) : null;
    victim.char.hotbar = [null, null, null, null];
    victim.char.backpack = Array.from({ length: BACKPACK_SLOTS }, () => null);
    victim.char.coins = 0;
    victim.char.dead = true;
    victim.char.deaths += 1;
    this.equip(victim, 0);
    const killerName = killer ? (killer.kind === "player" ? killer.identity.name : `npc:${killer.state.kind}`) : "the fall";
    this.broadcast("death", { victim: victim.id, killer: killer?.id ?? null, killerName, aliveMs: now - victim.char.lifeStartedAt, level: victim.char.level, pileId: pile?.id ?? "" });
    if (killer && killer.kind === "player" && killer.id !== victim.id) this.grantXp(killer, pvpKillXp(victim.char.level, killer.char.level));
    this.saveActor(victim);
  }

  respawn(client: Client, starter: number, palette: number) {
    const a = this.actors.get(client.sessionId);
    if (!a || !a.dead) return;
    const fresh = newCharacter(starter, palette);
    fresh.deaths = a.char.deaths;
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
    if (a.dead || isSafe(this.bodyDef, a.state.x, a.state.y, a.state.z)) {
      (a as PlayerActor & { loggedOut?: boolean }).loggedOut = true;
      this.saveActor(a);
      client.send("loggedOut", {});
      return;
    }
    if (now < a.combatUntil) {
      client.send("denied", { action: "logout", reason: "in combat" });
      return;
    }
    a.logoutEndsAt = now + RULES.LOGOUT_MS;
    a.state.flags |= PF.LOGGING_OUT;
    a.youDirty = true;
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
      const safe = isSafe(this.bodyDef, p.x, p.y, p.z);
      p.flags = safe ? p.flags | PF.SAFE : p.flags & ~PF.SAFE;
      if (a.protectedUntil <= now) p.flags &= ~PF.PROTECTED;
      if (now < a.combatUntil) p.flags |= PF.IN_COMBAT;
      else p.flags &= ~PF.IN_COMBAT;
      if (a.logoutEndsAt === null) p.flags &= ~PF.LOGGING_OUT;
      else if (now >= a.logoutEndsAt) {
        (a as PlayerActor & { loggedOut?: boolean }).loggedOut = true;
        a.logoutEndsAt = null;
        this.saveActor(a);
        a.client.send("loggedOut", {});
      }
      if (!a.dead) a.char.hp = p.hp;
    }
    for (const n of this.npcActors.values()) pushHistory(n, now);
    for (const [sid, l] of this.lingering) {
      pushHistory(l.actor, now);
      if (l.actor.dead || now >= l.until) {
        this.saveActor(l.actor);
        this.lingering.delete(sid);
        this.state.players.delete(sid);
      }
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
      for (const a of this.actors.values()) this.saveActor(a);
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
    a.client.send("you", { ...you, selected: a.char.selected, level: a.char.level, dead: a.dead });
  }

  saveActor(a: PlayerActor) {
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
