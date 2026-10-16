// One room = one copy of one body (Portus, Arcadia, Hollowmere or Meridian).
// Players enter only through POST /api/play (seat reservations); direct joins are refused.
// Owns: movement validation, combat, inventory, death and piles, logout/linger rules, AOI views.

import { CloseCode, Room, ServerError, type Client } from "@colyseus/core";
import { StateView } from "@colyseus/schema";
import { BODIES, createTerrain, isSafe, padDirs, portalNear, portalSpots, type BodyDef, type BodyId, type PortalSpot, type Terrain } from "@firstlight/shared";
import { BACKPACK_SLOTS, HOTBAR_SLOTS, newCharacter, type CharacterData } from "@firstlight/shared/content/character";
import { INV_SLOTS, moveSlot, storeItem } from "@firstlight/shared/content/inventory";
import { fallDamageFraction, levelForXp, maxHp, pvpKillXp, xpAtLevel, xpToNext } from "@firstlight/shared/content/progression";
import { WEAPON_BY_ID, WEAPON_INDEX } from "@firstlight/shared/content/weapons";
import { NET, PHRASES, type InvItem, type YouState } from "@firstlight/shared/net/protocol";
import { ANIM, BodyState, NpcState, PF, PileState, PlayerState } from "@firstlight/shared/net/schema";
import { z } from "zod";
import type { Identity } from "../auth/identity.ts";
import { actorPos, adminSwitch, inSaddle, pushHistory, type Actor, type NpcActor, type PlayerActor } from "./actors.ts";
import { characterRepo, withTx } from "./characters.ts";
import { SWIM_FLOAT } from "@firstlight/shared/planet/water";
import { structureCollider, type StructureCollider } from "@firstlight/shared/planet/town";
import { CLOSE, hub, type HubRoom } from "./hub.ts";

/** Ban lookup for reconnects; set at boot when the database is available. */
export const bannedCheck: { current: (userId: string) => boolean } = { current: () => false };
import { dealDamage, fire, melee, selectedWeapon, stepEffects, stepProjectiles, type CombatHost } from "./combat.ts";
import { dist3, type V3 } from "./geometry.ts";
import { emitGameEvent, npcKindOf } from "./events.ts";
import { emitPileEvent, onPileEvent, pileStore, type PileData, type PileKind } from "./piles.ts";
import { SYSTEM_FACTORIES, type RoomSystem } from "./systems.ts";
import { voiceItemHidden } from "./voice/index.ts";
import { endSandboxOf, identityIsAdmin, stillAdmin } from "./adminMode.ts";
import { currentSandbox, runIn, sandboxOf, sandboxRoomClosed, sandboxRoomOpened, type Sandbox } from "../sandbox.ts";
import { supportOf } from "./support.ts";
import { identityCheck, storageRecovery, ticketFor, travelRedirect } from "./admission.ts";
import { pendingSeats } from "./reservations.ts";
import { seatRefusal } from "../social/moderation.ts";
import { groundMotion, heightAboveSupport, motionFields, moveLimits, settle, startFall, validateMove, MOVE, type MoveWorld } from "./movement.ts";
import { matchMaker } from "@colyseus/core";
import { liveSessions } from "../auth/sessions.ts";
import { accountLinks } from "../auth/links.ts";

export interface BodyRoomOptions {
  body: BodyId;
  copy: number;
  loadtest?: boolean;
  /** An admin sandbox room (D-admin-3): the owner's user id; their sandbox must be open. */
  sandbox?: string;
}

export interface BodyRoomMetadata {
  body: BodyId;
  copy: number;
  loadtest: boolean;
  /** The owner of an admin sandbox room; public matchmaking never picks one. */
  sandbox?: string;
}

/** Join options forwarded from /api/play for brand-new characters. */
export interface JoinOptions {
  body: BodyId;
  starter?: number;
  palette?: number;
}

export { MOVE } from "./movement.ts";

export const RULES = {
  LOGOUT_MS: 30_000,
  LINGER_MS: 30_000,
  PROTECT_MS: 5_000,
  COMBAT_LOGOUT_BLOCK_MS: 10_000,
  PICKUP_RANGE: 3.5,
  AOI_ADD: 80,
  AOI_REMOVE: 100,
  SAVE_EVERY_MS: 30_000,
  /** A portal travel ticket must be used within this time (F12 B3). */
  TRAVEL_TICKET_MS: 60_000,
};

/**
 * Runtime state a takeover hands from the old actor to the new session's (F12 B2): protection keeps
 * its expiry, and cooldowns, damage/heal-over-time and NPC effects survive a reload.
 */
const CARRIED_ON_TAKEOVER = ["protectedUntil", "heals", "healAcc", "burn", "healCooldownUntil", "tonicCooldownUntil", "lastAttackAt", "reloadEndsAt", "heat", "overheatUntil", "specialReadyAt", "lastDodgeAt", "lastPhraseAt", "lastDamagedBy", "npcFx", "violations"] as const satisfies readonly (keyof PlayerActor)[];

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
  pendingSeats.invalidate(ev.fromUserId); // seats reserved as the guest are void
  hub.retireAll(CLOSE.MERGED, "account merged, rejoin", ev.fromUserId);
  hub.retireAll(CLOSE.ELSEWHERE, "signed in elsewhere", ev.toUserId);
  // Sandboxes (D-admin-3) hold copies under the old ids: they close too (nothing in them is saved).
  endSandboxOf(ev.fromUserId, CLOSE.MERGED, "account merged, rejoin");
  endSandboxOf(ev.toUserId, CLOSE.ELSEWHERE, "signed in elsewhere");
});

/** Last PvP kill time per killer>victim account pair (repeat kills within 10 min give 10% XP). */
const pvpKills = new Map<string, number>();
const PVP_REPEAT_MS = 10 * 60_000;

/** Record a PvP kill; true if the same pair already had one within 10 min. Old pairs are forgotten (F12 S10). */
export function repeatPvpKill(killerUserId: string, victimUserId: string, now: number): boolean {
  for (const [k, t] of pvpKills) if (now - t >= PVP_REPEAT_MS) pvpKills.delete(k);
  const key = `${killerUserId}>${victimUserId}`;
  const repeat = pvpKills.has(key);
  pvpKills.set(key, now);
  return repeat;
}

/** Remembered killer>victim pairs (tests). */
export function pvpPairCount(): number {
  return pvpKills.size;
}

const NO_FOOTING = { top: 0, inside: false };

/** Lazy `you` updates (magazine counts) go out at most this often. */
const YOU_LAZY_MS = 400;

/**
 * Per-client caps (messages per second) for types without a limiter of their own (F12 nits: travel
 * and respawn write SQLite; ping, questSync and client:info answer with messages). Colyseus's 60/s
 * per client still bounds everything else.
 */
export const MESSAGE_RATES: Record<string, number> = { ping: 20, travel: 2, respawn: 1, logout: 4, questSync: 2, "client:info": 2, skySync: 2, npcSync: 2 };
/** Malformed messages are dropped (no kick for a harmless drift); this many within 10 s disconnects. */
const BAD_MESSAGE_LIMIT = 20;

type MessageSchema = { safeParse(v: unknown): { success: boolean; data?: unknown } };

/**
 * Every method of a sandbox room runs inside its sandbox (D-admin-3, sandbox.ts), whoever calls it:
 * Colyseus (onJoin, onLeave, onDispose…), the room itself, or another room (a takeover, moderation).
 * Message handlers and the tick get the same through guardMessages and the timers create() starts.
 */
function scopeTo(room: BodyRoom, sb: Sandbox) {
  const self = room as unknown as Record<string, unknown>;
  const names = new Set<string>();
  for (let proto = Object.getPrototypeOf(room) as object | null; proto && proto !== Room.prototype; proto = Object.getPrototypeOf(proto) as object | null) {
    for (const name of Object.getOwnPropertyNames(proto)) {
      if (name !== "constructor" && typeof Object.getOwnPropertyDescriptor(proto, name)?.value === "function") names.add(name);
    }
  }
  // What the instance calls now: Colyseus has already wrapped onJoin, onLeave… on the instance itself.
  for (const name of names) {
    const fn = self[name] as (...args: unknown[]) => unknown;
    self[name] = function (this: unknown, ...args: unknown[]) {
      return runIn(sb, () => fn.apply(this, args));
    };
  }
}

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
  moveWorld!: MoveWorld;
  /** The body's structure sites (Portus' town, a planet's pad outpost): block movement and placement (placeBody). */
  private structures: StructureCollider | null = null;
  systems: RoomSystem[] = [];
  portals: PortalSpot[] = [];
  /** An admin sandbox room (D-admin-3): only its owner gets in, and nothing in it is saved. */
  sandbox: Sandbox | null = null;

  static async onAuth(): Promise<unknown> {
    throw new ServerError(403, "join through /api/play");
  }

  private readonly msgWindows = new Map<string, Map<string, { at: number; n: number }>>();
  private readonly badMessages = new Map<string, number[]>();

  /**
   * Every handler registered on this room (the room's and the systems') goes through here: per-type
   * rate caps, and zod validation that drops a malformed message instead of letting Colyseus close
   * the connection for it (F12 protocol-drift nit).
   */
  private guardMessages() {
    const register = this.onMessage.bind(this) as unknown as (type: string, ...rest: unknown[]) => () => void;
    const guarded = (type: string, a: unknown, b?: unknown): (() => void) => {
      if (type === "*") {
        const h = (b ?? a) as (...args: unknown[]) => unknown;
        const scoped = (...args: unknown[]) => (this.sandbox ? runIn(this.sandbox, () => h(...args)) : h(...args));
        return b === undefined ? register(type, scoped) : register(type, a, scoped);
      }
      const schema = typeof b === "function" ? (a as MessageSchema) : undefined;
      const handler = (typeof b === "function" ? b : a) as (c: Client, m: unknown, ...rest: unknown[]) => unknown;
      const handle = (c: Client, raw: unknown, rest: unknown[]) => {
        if (!this.withinRate(c.sessionId, type)) return;
        if (!schema) return handler(c, raw, ...rest);
        const r = schema.safeParse(raw);
        if (!r.success) return this.badMessage(c);
        return handler(c, r.data, ...rest);
      };
      // A sandbox room's messages run inside its sandbox (D-admin-3).
      return register(type, (c: Client, raw: unknown, ...rest: unknown[]) => (this.sandbox ? runIn(this.sandbox, () => handle(c, raw, rest)) : handle(c, raw, rest)));
    };
    (this as unknown as { onMessage: typeof guarded }).onMessage = guarded;
  }

  private withinRate(sessionId: string, type: string): boolean {
    const limit = MESSAGE_RATES[type];
    if (!limit) return true;
    let windows = this.msgWindows.get(sessionId);
    if (!windows) this.msgWindows.set(sessionId, (windows = new Map()));
    const now = Date.now();
    const w = windows.get(type);
    if (!w || now - w.at >= 1000) {
      windows.set(type, { at: now, n: 1 });
      return true;
    }
    if (w.n >= limit) return false;
    w.n++;
    return true;
  }

  private badMessage(c: Client) {
    const now = Date.now();
    const list = (this.badMessages.get(c.sessionId) ?? []).filter((t) => now - t < 10_000);
    list.push(now);
    this.badMessages.set(c.sessionId, list);
    if (list.length >= BAD_MESSAGE_LIMIT) c.leave(CloseCode.WITH_ERROR, "too many malformed messages");
  }

  onCreate(options: BodyRoomOptions) {
    if (options.sandbox) {
      // /api/play opened the sandbox; from here on everything this room does runs inside it.
      const sb = sandboxOf(options.sandbox);
      if (!sb) throw new ServerError(403, "no sandbox");
      this.sandbox = sb;
      sandboxRoomOpened(sb);
      scopeTo(this, sb);
    }
    this.create(options);
  }

  private create(options: BodyRoomOptions) {
    this.guardMessages();
    // The client consumes its seat right after /api/play; short reservations stop seat hoarding.
    this.seatReservationTimeout = 8;
    this.bodyDef = BODIES[options.body];
    this.terrain = createTerrain(this.bodyDef);
    const terrain = this.terrain;
    // Structure sites (D38, D42): Portus' town and the planets' pad outposts: indestructible walls,
    // houses and towers, the same shared solids the client controller collides with; they count like
    // intact props (tops hold feet, insides refuse), stop shots and sight (host.walls, D43) and NPCs (D44).
    const structures = (this.structures = structureCollider(terrain));
    const footing = { top: 0, inside: false };
    this.moveWorld = {
      radius: this.bodyDef.radius,
      waterLevel: this.bodyDef.waterLevel,
      groundAt: (x, y, z) => terrain.groundHeightAt(x, y, z),
      footing: (x, y, z, step) => {
        const props = this.host.props?.footing?.(x, y, z, step) ?? NO_FOOTING;
        if (!structures) return props;
        const town = structures.footing(x, y, z, step);
        footing.top = Math.max(props.top, town.top);
        footing.inside = props.inside || town.inside;
        return footing;
      },
      crosses: (ax, ay, az, bx, by, bz) =>
        (this.host.props?.crosses?.(ax, ay, az, bx, by, bz) ?? false) || (structures?.crosses(ax, ay, az, bx, by, bz) ?? false),
    };
    this.state.body = options.body;
    this.state.copy = options.copy;
    void this.setMetadata({ body: options.body, copy: options.copy, loadtest: !!options.loadtest, ...(options.sandbox ? { sandbox: options.sandbox } : {}) });

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
      // The structures (the town's walls, a planet outpost's buildings) stop shots, blasts, melee and sight (D-zones-3, D43).
      ...(structures.solids.length > 0 ? { walls: structures } : {}),
      // Attack and damage gates ask the zone where the player stands now, not the tick-old flag.
      safeNow: (a, now) => this.safeNow(a, now),
    };

    // Load-test copies neither show nor touch the public world's piles (piles belong to a body, not a copy).
    const listPiles = !options.loadtest;
    if (listPiles) for (const p of pileStore.current.list(options.body)) this.addPileToState(p);
    this.portals = portalSpots(this.bodyDef, this.terrain);
    this.unsubscribePiles = onPileEvent((e) => {
      if (!listPiles) return;
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
      if (inSaddle(a, Date.now())) return void c.send("denied", { action: "fire", reason: "mounted" }); // no weapons from the saddle
      if (m.slot !== a.char.selected) this.equip(a, m.slot);
      const r = fire(this.host, a, m);
      if (!r.ok && r.reason !== "rate") c.send("denied", { action: "fire", reason: r.reason });
    });
    this.onMessage("melee", meleeSchema, (c, m) => {
      const a = this.actor(c);
      if (!a || a.dead) return;
      if (inSaddle(a, Date.now())) return void c.send("denied", { action: "melee", reason: "mounted" });
      if (m.slot !== a.char.selected) this.equip(a, m.slot);
      // Refusals get a reason, like `fire` (safe zone, arrival protection…): the client shows it.
      const r = melee(this.host, a, !!m.heavy);
      if (!r.ok && r.reason !== "rate") c.send("denied", { action: "melee", reason: r.reason });
    });
    this.onMessage("block", z.object({ on: z.boolean() }), (c, m) => {
      const a = this.actor(c);
      if (!a || (m.on && inSaddle(a, Date.now()))) return;
      a.blocking = m.on;
      a.state.flags = m.on ? a.state.flags | PF.BLOCKING : a.state.flags & ~PF.BLOCKING;
    });
    this.onMessage("charge", z.object({ on: z.boolean() }), (c, m) => {
      const a = this.actor(c);
      if (a && !a.dead) a.chargeStartedAt = m.on && !inSaddle(a, Date.now()) ? Date.now() : 0;
    });
    this.onMessage("travel", z.object({ to: z.enum(["portus", "arcadia", "hollowmere", "meridian"]) }), (c, m) => this.travelRequest(c, m.to));
    this.onMessage("scope", z.object({ on: z.boolean() }), (c, m) => {
      const a = this.actor(c);
      if (!a || (m.on && inSaddle(a, Date.now()))) return;
      a.state.flags = m.on ? a.state.flags | PF.SCOPED : a.state.flags & ~PF.SCOPED;
    });
    this.onMessage("reload", z.object({ slot: z.number().int().min(0).max(3) }), (c) => this.reload(this.actor(c)));
    this.onMessage("equip", z.object({ slot: z.number().int().min(0).max(3) }), (c, m) => {
      const a = this.actor(c);
      if (a && !a.dead) this.equip(a, m.slot);
    });
    this.onMessage("use", slotSchema.extend({ targetId: z.string().max(64).optional() }), (c, m) => {
      const a = this.actor(c);
      if (this.invAllowed(a)) this.use(a, m.slot, m.targetId);
    });
    this.onMessage("pickup", pickupSchema, (c, m) => {
      const a = this.actor(c);
      if (this.invAllowed(a)) this.pickup(a, m.pileId, m.itemIndex);
    });
    this.onMessage("drop", slotSchema, (c, m) => {
      const a = this.actor(c);
      if (this.invAllowed(a)) this.drop(a, m.slot);
    });
    this.onMessage("move", z.object({ from: z.number().int().min(0).max(INV_SLOTS - 1), to: z.number().int().min(0).max(INV_SLOTS - 1) }), (c, m) => {
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

  /** Each system and each player on its own: one failure doesn't stop the rest (F12 final Opus nit). */
  onDispose() {
    if (this.sandbox) sandboxRoomClosed(this.sandbox);
    this.unsubscribePiles?.();
    for (const s of this.systems) this.guarded("dispose", () => s.dispose?.());
    for (const a of this.actors.values()) this.guarded("final leave", () => this.finalLeave(a));
    for (const l of this.lingering.values()) this.guarded("final leave", () => this.finalLeave(l.actor));
  }

  /** Run `fn`, logging (not throwing) a failure: shutdown and dispose go on for everyone else. */
  private guarded(what: string, fn: () => void) {
    try {
      fn();
    } catch (err) {
      console.error(`[room ${this.roomId}] ${what} failed: ${(err as Error)?.message ?? err}`);
    }
  }

  /**
   * Errors in handlers or the tick must never take the whole process down (review blocker). Log only
   * what failed and where: Colyseus attaches the client (reconnection token), auth, join options and
   * message payloads to these errors, and none of that may reach the logs (F12 S9).
   */
  onUncaughtException(error: Error, method: string) {
    const cause = (error as { cause?: unknown }).cause;
    const e = cause instanceof Error ? cause : error;
    const where = (e.stack ?? "").split("\n").slice(1, 7).join("\n");
    console.error(`[room ${this.roomId}] ${method} failed: ${e.name}: ${e.message}${where ? `\n${where}` : ""}`);
  }

  // ---------------------------------------------------------------- joining and leaving

  onJoin(client: Client, options: JoinOptions | undefined, auth?: Identity) {
    if (!auth) throw new ServerError(403, "no identity");
    const now = Date.now();
    // A reservation is checked again when it is used (F12 B5): before any takeover happens.
    const refusal = this.seatRefusal(client.sessionId, auth, now);
    if (refusal) throw new ServerError(403, refusal);
    // A sandbox is its owner's alone, and only while they are an admin (D-admin-3). Joining the real
    // world closes the owner's sandbox (a sandbox body still in it, in another window, goes).
    if (this.sandbox && (auth.userId !== this.sandbox.owner || !identityIsAdmin(auth))) throw new ServerError(403, "private sandbox");
    if (!this.sandbox) endSandboxOf(auth.userId);
    // One authoritative character per user: take over a live, dropped or lingering actor anywhere.
    let char: CharacterData | null = null;
    let inheritedCombat = false;
    let inheritedPos: V3 | null = null;
    const prev = hub.get(auth.userId);
    const old = prev?.actor ?? null;
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
    if (char.pos && char.body === this.bodyDef.id && !char.dead && this.plausible(char.pos)) pos = this.placeBody(char.pos, client.sessionId);
    else pos = this.spawnPoint(client.sessionId);
    char.body = this.bodyDef.id;
    char.travelTo = undefined;
    char.travelUntil = undefined;
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
      ...motionFields(Math.hypot(p.x, p.y, p.z), now),
      chargeStartedAt: 0,
      specialReadyAt: 0,
      lastPhraseAt: 0,
      healAcc: 0,
      ...(this.sandbox ? { sandbox: this.sandbox } : {}),
    };
    if (old) {
      const carried = a as unknown as Record<string, unknown>, from = old as unknown as Record<string, unknown>;
      for (const k of CARRIED_ON_TAKEOVER) carried[k] = from[k];
      if (inheritedCombat) a.protectedUntil = 0;
    }
    this.equip(a, char.selected);
    if (a.protectedUntil > now) p.flags |= PF.PROTECTED;
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

  /**
   * Why this seat may not be used now, or null: it must be a live /api/play reservation for this
   * account (not voided by a merge), the account must still be valid and not banned or kicked, and
   * the character must still be allowed on this body (its travel ticket may have been used or expired).
   */
  private seatRefusal(sessionId: string, auth: Identity, now: number): string | null {
    if (!pendingSeats.consume(sessionId, auth.userId, now)) return "seat expired";
    if (!auth.loadtest && seatRefusal(auth.userId, now)) return "not allowed";
    if (auth.account && identityCheck.current(auth.userId)) return "sign in again";
    if (!storageRecovery.ok(auth.userId)) return "storage";
    if (travelRedirect(auth, this.bodyDef.id, now)) return "travel";
    return null;
  }

  onDrop(client: Client) {
    const a = this.actors.get(client.sessionId);
    if (!a || a.superseded || a.loggedOut || this.shuttingDown) return;
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
    this.detach(a);
    if (a.superseded) {
      this.state.players.delete(client.sessionId);
      return;
    }
    const now = Date.now();
    // Safe zones and portal handoffs only skip the linger out of combat (F12 B3, SPEC §5.6).
    const calm = now >= a.combatUntil;
    const safe = isSafe(this.bodyDef, a.state.x, a.state.y, a.state.z);
    const handoff = (a.toSandboxUntil ?? 0) > now || (!!a.char.travelTo && ticketFor(a.char, a.char.travelTo, now) && portalNear(this.portals, a.state.x, a.state.y, a.state.z)?.to === a.char.travelTo);
    const dropped = code !== CloseCode.CONSENTED; // the 30 s reconnection window already elapsed
    // Nothing can catch a sandbox body (and nothing about it is saved): it goes at once.
    if (a.dead || a.loggedOut || dropped || this.shuttingDown || this.sandbox || (calm && (safe || handoff))) {
      this.finalLeave(a);
      this.state.players.delete(client.sessionId);
      return;
    }
    // Left without logging out (outside a safe zone, or in a fight): the body stays for 30 s and can die.
    a.state.flags |= PF.LINGER;
    this.guarded("linger save", () => this.saveActor(a));
    this.lingering.set(client.sessionId, { actor: a, until: now + RULES.LINGER_MS });
    this.autoDispose = false; // keep simulating the body even if nobody else is here
  }

  /**
   * The one way an actor stops being a connected player here (leave, takeover, merge, kick): drop
   * it from the live map and run every system's leave hook, exactly once (F12 B4).
   */
  private detach(a: PlayerActor) {
    if (a.detached) return;
    a.detached = true;
    if (this.actors.get(a.id) === a) this.actors.delete(a.id);
    this.invOps.delete(a.id);
    this.msgWindows.delete(a.id);
    this.badMessages.delete(a.id);
    liveSessions.unregister(a.identity.userId, a.id);
    for (const s of this.systems) {
      try {
        s.onPlayerLeave?.(a.id);
      } catch (err) {
        console.error(`[room ${this.roomId}] leave hook failed: ${(err as Error)?.message ?? err}`);
      }
    }
  }

  /** Save and forget an actor that is leaving the world. */
  private finalLeave(a: PlayerActor) {
    if (a.superseded) return;
    this.removeBody(a);
    // A failed last save leaves the last good one in the database (as after a crash); the actor
    // still goes, so a leave or a shutdown never stalls on it.
    this.guarded("final save", () => this.saveActor(a));
    hub.release(a.identity.userId, a);
  }

  /** The body is gone from this world (no more targets, attack slots or hits on it): system hooks, once. */
  private removeBody(a: PlayerActor) {
    if (a.removed) return;
    a.removed = true;
    for (const s of this.systems) {
      try {
        s.onBodyRemoved?.(a);
      } catch (err) {
        console.error(`[room ${this.roomId}] body hook failed: ${(err as Error)?.message ?? err}`);
      }
    }
  }

  /** Remove an actor without saving (superseded by a newer session or an account merge). */
  retire(a: PlayerActor, code: number, reason: string) {
    a.superseded = true;
    this.detach(a);
    this.removeBody(a);
    this.lingering.delete(a.id);
    this.state.players.delete(a.id);
    const c = this.clients.getById(a.id);
    if (c) c.leave(code, reason);
  }

  private shuttingDown = false;
  onBeforeShutdown() {
    this.shuttingDown = true;
    this.broadcast("updating", { seconds: 5 });
    // One transaction for speed; a player whose save fails is logged and skipped, not everyone.
    this.guarded("shutdown save", () =>
      withTx(() => {
        for (const a of this.actors.values()) this.guarded("shutdown save", () => this.saveActor(a));
        for (const l of this.lingering.values()) this.guarded("shutdown save", () => this.saveActor(l.actor));
      }),
    );
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
    // No portal escapes from a fight (F12 B3): the ticket waits for the combat tag to run out.
    if (Date.now() < a.combatUntil) {
      client.send("denied", { action: "travel", reason: "in combat" });
      return;
    }
    a.char.travelTo = to;
    a.char.travelUntil = Date.now() + RULES.TRAVEL_TICKET_MS;
    this.saveActor(a);
    client.send("travelOk", { to });
  }

  // ---------------------------------------------------------------- movement

  handleInput(client: Client, msg: z.infer<typeof inputSchema>) {
    const a = this.actors.get(client.sessionId);
    if (!a || a.dead || a.superseded || msg.seq <= a.state.seq) return;
    const p = a.state;
    const now = Date.now();
    a.lastInputAt = now;
    // NPC slows / Cease-and-Desist (npc/effects.ts) and riding (horses) set the refill; see movement.ts.
    const r = validateMove(a, msg, this.moveWorld, moveLimits(a, now), now);
    const flying = adminSwitch(a, "fly");
    if (!r.ok) {
      a.violations++;
      // Refused while airborne: the server applies gravity instead of holding the body up there
      // (an admin flying stays where it was).
      const at = (flying ? null : settle(a, this.moveWorld, now)) ?? [a.lastX, a.lastY, a.lastZ];
      client.send("correct", { x: at[0], y: at[1], z: at[2], seq: msg.seq });
      p.seq = msg.seq;
      return;
    }
    const R = this.bodyDef.radius;
    const { len, ground, grounded, swimming: swimmingOk } = r;
    // Server-side fall damage from the validated trajectory.
    if (!grounded) {
      a.airborne = true;
      // Flying (admin mode): a fall only counts from where flying stopped.
      a.peakRadius = flying ? len : Math.max(a.peakRadius, len);
    } else {
      if (a.airborne && !swimmingOk && !flying) {
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

  use(a: PlayerActor | undefined, slot: number, targetId?: string) {
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
      a.heals.push({ perSec: (tier.heal ?? 40) / dur, until: now + dur * 1000, left: tier.heal ?? 40 });
      this.consume(a, slot);
    } else if (item.id === "patchkit" || item.id === "bubble") {
      supportOf(this)?.use(a, slot, item, targetId); // channelled heal / shield bubble (support.ts)
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

  /** Add an item (shared/content/inventory.ts storeItem): weapons and consumables to the hotbar first, loot to the backpack first. */
  giveItem(a: PlayerActor, item: InvItem): boolean {
    return this.storeAt(a, item) >= 0;
  }

  /** giveItem, returning the slot the item went to (0–3 hotbar, 4–19 backpack), or -1 when full. */
  private storeAt(a: PlayerActor, item: InvItem): number {
    const slot = storeItem(a.char, item);
    if (slot < 0) return -1;
    if (slot === a.char.selected) this.equip(a, slot);
    a.youDirty = true;
    return slot;
  }

  /** Move, merge or swap two inventory slots (0–3 hotbar, 4–19 backpack). */
  moveItem(a: PlayerActor | undefined, from: number, to: number) {
    if (!a || a.dead || !moveSlot(a.char, from, to)) return;
    this.equip(a, a.char.selected);
  }

  pickup(a: PlayerActor | undefined, pileId: string, itemIndex?: number) {
    if (!a || a.dead || a.identity.loadtest || this.metadata?.loadtest) return;
    const pile = pileStore.current.get(pileId);
    if (!pile || pile.body !== this.bodyDef.id) return;
    if (dist3([pile.x, pile.y, pile.z], actorPos(a)) > RULES.PICKUP_RANGE) return;
    // Take from the pile and save the character in one transaction (no dupes, no losses on crash).
    const events: (() => void)[] = [];
    let result: { taken: { items: InvItem[]; coins: number; pile: PileData | null }; leftovers: InvItem[]; toBackpack: number } | null;
    try {
      result = this.persist([a], () => {
        const taken = pileStore.current.take(pileId, itemIndex);
        if (!taken) return null;
        const leftovers: InvItem[] = [];
        let toBackpack = 0;
        for (const it of taken.items) {
          const slot = this.storeAt(a, it);
          if (slot < 0) leftovers.push(it);
          else if (slot >= HOTBAR_SLOTS) toBackpack++;
        }
        a.char.coins += taken.coins;
        if (taken.pile) events.push(() => emitPileEvent({ kind: "update", pile: taken.pile! }));
        else events.push(() => emitPileEvent({ kind: "remove", id: pileId, body: this.bodyDef.id }));
        // Items that didn't fit go back on the ground as a new pile.
        if (leftovers.length) this.createPile(a, leftovers, 0, actorPos(a), events);
        this.saveActor(a);
        return { taken, leftovers, toBackpack };
      });
    } catch {
      a.client.send("denied", { action: "pickup", reason: "try again" });
      return;
    }
    for (const e of events) e();
    if (!result) return;
    emitGameEvent(this, { type: "pickup", playerId: a.id, pileId, pileOwnerUserId: pile.ownerUserId, pileCreatedAt: pile.createdAt, items: result.taken.items.length - result.leftovers.length, coins: result.taken.coins });
    a.youDirty = true;
    const { taken, leftovers, toBackpack } = result;
    // Where the loot went, and the key that opens the backpack (the only other pointer is the tutorial).
    const bag = toBackpack ? ` · ${toBackpack} in your backpack (I)` : "";
    if (taken.coins || taken.items.length) a.client.send("toast", { text: `Picked up ${taken.items.length - leftovers.length} item(s)${taken.coins ? ` and ${taken.coins} coins` : ""}${bag}`, kind: "coins" });
  }

  drop(a: PlayerActor | undefined, slot: number) {
    if (!a || a.dead) return;
    const list = slot < HOTBAR_SLOTS ? a.char.hotbar : a.char.backpack;
    const i = slot < HOTBAR_SLOTS ? slot : slot - HOTBAR_SLOTS;
    const item = list[i];
    if (!item) return;
    // The radio is hidden while voice is off: it never lands on the ground (D-controls-1).
    if (voiceItemHidden(item.id)) return void a.client.send("denied", { action: "drop", reason: "off" });
    const pos = actorPos(a);
    const f: V3 = [a.state.fx, a.state.fy, a.state.fz];
    const events: (() => void)[] = [];
    try {
      this.persist([a], () => {
        list[i] = null;
        if (slot === a.char.selected) this.equip(a, a.char.selected);
        this.createPile(a, [item], 0, [pos[0] + f[0] * 1.2, pos[1] + f[1] * 1.2, pos[2] + f[2] * 1.2], events);
        this.saveActor(a);
      });
    } catch {
      a.client.send("denied", { action: "drop", reason: "try again" });
      return;
    }
    for (const e of events) e();
    a.youDirty = true;
  }

  /**
   * Character + pile writes in one SQLite transaction. If it throws, the listed characters are put
   * back exactly as they were before `fn` and the error is rethrown: memory never runs ahead of
   * the database (F12 B6). Publish pile events queued by `fn` only after this returns.
   */
  persist<T>(actors: readonly PlayerActor[], fn: () => T): T {
    const before = actors.map((a) => ({ a, char: structuredClone(a.char) }));
    try {
      return withTx(fn);
    } catch (err) {
      for (const { a, char } of before) {
        const live = a.char as unknown as Record<string, unknown>;
        for (const k of Object.keys(live)) if (!(k in char)) delete live[k];
        Object.assign(a.char, char);
        a.state.level = a.char.level;
        a.state.maxHp = maxHp(a.char.level);
        a.state.hp = Math.min(a.state.hp, a.state.maxHp);
        this.equip(a, a.char.selected);
      }
      console.error(`[room ${this.roomId}] save failed, changes undone: ${(err as Error)?.message ?? err}`);
      throw err;
    }
  }

  /**
   * Leave a pile on the ground. `kind`: "death" for what a player carried when they died (the cap
   * protects these), "loot" by default (drops, chests, boss overflow), "staged" for admin scenes;
   * `ttlMs` makes it expire (swept by the quest system). Load-test bots and load-test copies leave
   * nothing (null): piles belong to a body, not a copy, so they would show up in public copies and
   * count toward the body's cap (F12 final Opus SF4).
   */
  createPile(owner: PlayerActor, items: InvItem[], coins: number, at: V3, deferred?: (() => void)[], opts: { kind?: PileKind; ttlMs?: number } = {}): PileData | null {
    if (owner.identity.loadtest || this.metadata?.loadtest) return null;
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
      kind: opts.kind ?? "loot",
      ...(opts.ttlMs ? { expiresAt: Date.now() + opts.ttlMs } : {}),
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
    // A hidden radio (voice off, D-controls-1) goes with the old life instead of dropping as loot.
    const items = [...victim.char.hotbar, ...victim.char.backpack].filter((x): x is InvItem => !!x && !voiceItemHidden(x.id));
    const events: (() => void)[] = [];
    let pile: PileData | null = null;
    try {
      this.persist([victim], () => {
        pile = items.length || victim.char.coins ? this.createPile(victim, items, victim.char.coins, actorPos(victim), events, { kind: "death" }) : null;
        victim.char.hotbar = [null, null, null, null];
        victim.char.backpack = Array.from({ length: BACKPACK_SLOTS }, () => null);
        victim.char.coins = 0;
        victim.char.dead = true;
        victim.char.deaths += 1;
        this.saveActor(victim);
      });
    } catch {
      // The death couldn't be recorded (no pile, inventory still saved): drop this actor without
      // saving and let the client rejoin from the last good save rather than lose or copy items.
      // Until saving works again the account stays out (no die-rejoin loop; F12 re-review S5).
      storageRecovery.mark(victim.identity.userId);
      hub.release(victim.identity.userId, victim);
      this.retire(victim, CLOSE.STORAGE, "saving failed, rejoin later");
      return;
    }
    for (const e of events) e();
    this.equip(victim, 0);
    const killerName = killer ? (killer.kind === "player" ? killer.identity.name : `npc:${npcKindOf(killer) ?? killer.state.kind}`) : "the fall";
    const pileId = (pile as PileData | null)?.id ?? "";
    this.broadcast("death", { victim: victim.id, killer: killer?.id ?? null, killerName, aliveMs: now - victim.char.lifeStartedAt, level: victim.char.level, pileId });
    emitGameEvent(this, { type: "death", victimId: victim.id, killerId: killer?.id ?? null, killerKind: killer?.kind ?? "world", npcKind: killer?.kind === "npc" ? npcKindOf(killer) : undefined, pos: actorPos(victim) });
    if (killer && killer.kind === "player" && killer.id !== victim.id) {
      const repeat = repeatPvpKill(killer.identity.userId, victim.identity.userId, now);
      this.grantXp(killer, Math.round(pvpKillXp(victim.char.level, killer.char.level) * (repeat ? 0.1 : 1)));
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

  /**
   * The durable half of an XP reward: the character's XP and level, nothing else (no save, no
   * messages). Call it inside the transaction that saves whatever the XP comes with (a mission's
   * done flag and coins, loot, onboarding flags), so they commit together or not at all (F12 final
   * B1). Returns the live half, to run once that transaction has committed: level-up HP and level
   * on the synced state, the toast and the levelUp event. Neither half saves or adds XP again.
   */
  addXp(a: PlayerActor, amount: number): () => void {
    if (!(amount > 0) || a.dead) return () => {};
    a.char.xp += amount;
    a.char.level = levelForXp(a.char.xp);
    a.youDirty = true;
    return () => this.showLevel(a);
  }

  /**
   * After a committed XP change: the levels the synced state doesn't show yet (more HP, the level,
   * a toast, the levelUp event). Idempotent: a second call finds nothing new.
   */
  private showLevel(a: PlayerActor) {
    a.youDirty = true;
    const shown = a.state.level;
    if (a.char.level <= shown) return;
    a.state.maxHp = maxHp(a.char.level);
    a.state.hp = levelUpHp(a.state.hp, shown, a.char.level);
    a.state.level = a.char.level;
    a.client.send("toast", { text: `Level ${a.char.level}!`, kind: "xp" });
    emitGameEvent(this, { type: "levelUp", playerId: a.id, level: a.char.level });
  }

  /**
   * XP that comes with nothing else durable (a PvP kill): a level-up is saved at once, in a
   * transaction of its own, before anyone hears of it; a failed save leaves the XP unpaid.
   */
  grantXp(a: PlayerActor, amount: number) {
    let live = (): void => {};
    try {
      this.persist([a], () => {
        const before = a.char.level;
        live = this.addXp(a, amount);
        if (a.char.level > before) this.saveActor(a);
      });
    } catch {
      return;
    }
    live();
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
    // Asked of the account each time (adminMode.ts): a revoked admin's commands stop at once.
    if (!a || !stillAdmin(this, a)) return;
    emitGameEvent(this, { type: "admin", playerId: a.id, cmd, ...(typeof args.target === "string" ? { targetId: args.target } : {}) });
    // Numbers must be finite, integers where counts are meant, and in range (F12 S14). A bad
    // argument refuses the whole command; a missing one takes the default.
    let bad: string | null = null;
    const num = (k: string, d: number, min: number, max: number, integer = false): number => {
      const v = args[k];
      if (v === undefined) return d;
      if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max || (integer && !Number.isInteger(v))) {
        bad ??= k;
        return d;
      }
      return v;
    };
    const refuse = () => (bad ? (client.send("denied", { action: "admin", reason: `bad ${bad}` }), true) : false);
    const target = typeof args.target === "string" ? this.actors.get(args.target) : a;
    const R = this.bodyDef.radius;
    switch (cmd) {
      case "teleport": {
        const t = target ?? a;
        const want: V3 = [num("x", NaN, -4 * R, 4 * R), num("y", NaN, -4 * R, 4 * R), num("z", NaN, -4 * R, 4 * R)];
        if (!bad && !(Math.hypot(...want) > R * 0.5)) bad = "position";
        if (refuse()) return;
        const p = this.placeBody(want, t.id);
        t.state.x = t.lastX = p[0];
        t.state.y = t.lastY = p[1];
        t.state.z = t.lastZ = p[2];
        t.history.length = 0;
        groundMotion(t, Math.hypot(p[0], p[1], p[2]), Date.now());
        t.airborne = false;
        t.peakRadius = Math.hypot(p[0], p[1], p[2]);
        t.client.send("correct", { x: p[0], y: p[1], z: p[2], seq: t.state.seq });
        break;
      }
      case "give": {
        const id = typeof args.id === "string" ? args.id : "carbine";
        const tier = num("tier", 1, 1, 3, true);
        const qty = num("qty", 1, 1, Math.max(1, WEAPON_BY_ID.get(id)?.stack ?? 1), true);
        if (refuse()) return;
        if (WEAPON_BY_ID.has(id)) this.giveItem(target ?? a, { id, tier: tier as 1 | 2 | 3, qty });
        break;
      }
      case "level": {
        const t = target ?? a;
        const lv = num("level", 1, 1, 20, true);
        if (refuse()) return;
        t.char.xp = xpAtLevel(lv);
        t.char.level = lv;
        t.state.level = lv;
        t.state.maxHp = maxHp(lv);
        t.state.hp = t.state.maxHp;
        t.youDirty = true;
        break;
      }
      case "coins": {
        const amount = num("amount", 100, -1_000_000, 1_000_000, true);
        if (refuse()) return;
        const t = target ?? a;
        t.char.coins = Math.max(0, t.char.coins + amount);
        t.youDirty = true;
        break;
      }
      case "heal":
        (target ?? a).state.hp = (target ?? a).state.maxHp;
        break;
      case "unprotect":
        (target ?? a).protectedUntil = 0;
        (target ?? a).state.flags &= ~PF.PROTECTED;
        break;
      case "damage": {
        const amount = num("amount", 10, 0, 100_000);
        if (refuse()) return;
        if (target) dealDamage(this.host, null, target, amount, false);
        break;
      }
      case "announce":
        // To every room: not from a sandbox, which only reaches itself (D-admin-3).
        if (this.sandbox) return void client.send("denied", { action: "admin", reason: "not from a sandbox" });
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
      const safe = this.safeNow(a, now);
      p.flags = safe ? p.flags | PF.SAFE : p.flags & ~PF.SAFE;
      if (a.protectedUntil <= now) p.flags &= ~PF.PROTECTED;
      if (now < a.combatUntil) p.flags |= PF.IN_COMBAT;
      else p.flags &= ~PF.IN_COMBAT;
      if (a.logoutEndsAt === null) p.flags &= ~PF.LOGGING_OUT;
      else if (now >= a.logoutEndsAt) this.completeLogout(a);
      if (!a.dead) a.char.hp = p.hp;
      if (now - Math.max(a.lastMoveAt, a.lastInputAt ?? 0) > MOVE.silentFallMs) this.idleGravity(a, now, true);
    }
    for (const n of this.npcActors.values()) pushHistory(n, now);
    for (const [sid, l] of this.lingering) {
      this.idleGravity(l.actor, now, false);
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
    for (const a of this.actors.values()) if (a.youDirty || (a.youLazy && now - (a.lastYouAt ?? 0) >= YOU_LAZY_MS)) this.sendYou(a);
    if (now - this.lastSave > RULES.SAVE_EVERY_MS) {
      this.lastSave = now;
      withTx(() => {
        for (const a of this.actors.values()) this.saveActor(a);
      });
    }
  }

  /**
   * Gravity for a body the client isn't moving (idle, lingering): if what held it up is gone (a prop
   * broke) it starts to fall; a falling body follows the air envelope down; on landing the fall is
   * resolved here, fall damage included (F12 re-review S3). The client hears where it ended up.
   */
  private idleGravity(a: PlayerActor, now: number, connected: boolean) {
    if (a.dead || adminSwitch(a, "fly")) return; // an admin flying hovers
    if (!a.airborne) {
      if (heightAboveSupport(a, this.moveWorld) <= MOVE.groundedAbove) return;
      startFall(a, now);
    }
    const at = settle(a, this.moveWorld, now);
    if (at && connected) a.client.send("correct", { x: at[0], y: at[1], z: at[2], seq: a.state.seq });
    if (heightAboveSupport(a, this.moveWorld) > MOVE.groundedAbove) return;
    // Landed.
    const len = Math.hypot(a.state.x, a.state.y, a.state.z);
    const frac = fallDamageFraction(a.peakRadius - len);
    a.airborne = false;
    a.peakRadius = len;
    groundMotion(a, len, now);
    if (frac > 0) dealDamage(this.host, null, a, frac * maxHp(a.char.level), false);
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
    a.youLazy = false;
    a.lastYouAt = Date.now();
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
    // Defence in depth (D-admin-3): a sandbox's character is saved into its sandbox only. Calls into a
    // sandbox room run inside it (scopeTo), so this never trips unless something bypasses that.
    if (a.sandbox && currentSandbox() !== a.sandbox) return void console.error(`[sandbox] refused to save ${a.identity.userId.slice(0, 8)} outside its sandbox`);
    if (!a.dead) a.char.pos = [a.state.x, a.state.y, a.state.z];
    // Inside a reward transaction the character may be levels ahead of the synced state, whose HP
    // rises only after the commit (showLevel). Save the HP it will show, so a crash in between
    // restarts with the level's HP (F12 confirm Codex N-S1). A failed save restores `char` (persist).
    a.char.hp = a.dead ? a.state.hp : levelUpHp(a.state.hp, a.state.level, a.char.level);
    characterRepo.current.save(a.identity.userId, a.char);
  }

  // ---------------------------------------------------------------- helpers

  /** The ground (or swim surface) under a position; a degenerate one (zero, NaN) snaps to the main pad. */
  snapToGround(p: readonly number[]): V3 {
    const l = Math.hypot(p[0]!, p[1]!, p[2]!);
    const d = l > 1e-6 && Number.isFinite(l) ? norm(p) : (padDirs(this.bodyDef)[0]! as V3);
    const g = this.terrain.groundHeight(d[0], d[1], d[2]);
    const R = this.bodyDef.radius;
    const r = R + Math.max(g, this.bodyDef.waterLevel - SWIM_FLOAT) + 0.02;
    return [d[0] * r, d[1] * r, d[2] * r];
  }

  /**
   * Where to put a player (a restored save, a teleport, a stage spot): the ground under `p`, pushed
   * out of the body's structures (Portus' town, a pad outpost) exactly as the client's first frame would push it (D39,
   * round-1 B1), so client and server start from the same clear point; a push longer than the move
   * budget would otherwise be refused and corrected back inside, forever. A spot that can't be
   * cleared (boxed in) falls back to the spawn ring.
   */
  placeBody(p: readonly number[], seed = ""): V3 {
    return this.clearOfStructures(this.snapToGround(p)) ?? this.spawnPoint(seed);
  }

  /** `g` (on the ground) pushed out of the body's structures, or null if it stays inside one. */
  private clearOfStructures(g: V3): V3 | null {
    if (!this.structures) return g;
    const q = { x: g[0], y: g[1], z: g[2] };
    const R = this.bodyDef.radius;
    const feetR = (x: number, y: number, z: number) => R + Math.max(this.terrain.groundHeight(x, y, z), this.bodyDef.waterLevel - SWIM_FLOAT) + 0.02;
    return this.structures.clearSpot(q, feetR) ? [q.x, q.y, q.z] : null;
  }

  /** A saved position worth restoring: finite, and not metres under the ground (F12 final Opus N-B1). */
  private plausible(p: readonly number[]): boolean {
    if (p.length !== 3 || !p.every(Number.isFinite)) return false;
    const l = Math.hypot(p[0]!, p[1]!, p[2]!);
    if (!(l >= this.bodyDef.radius * 0.5)) return false;
    const g = this.terrain.groundHeight(p[0]! / l, p[1]! / l, p[2]! / l);
    return l - this.bodyDef.radius - g >= -3;
  }

  /**
   * Is `a` in a safe zone right now, where it stands? Pad rings protect only once out of combat (no
   * running onto a pad mid-fight, F12); the Portus town protects whoever is inside its walls at once,
   * combat tag or not (D-zones-3). The tick writes it into the SAFE flag; combat's attack and damage
   * gates call it directly, so a move into the town counts before the next tick (Codex round 2).
   */
  safeNow(a: PlayerActor, now: number): boolean {
    const p = a.state;
    return isSafe(this.bodyDef, p.x, p.y, p.z) && (this.bodyDef.terrain.kind === "hub" || now >= a.combatUntil);
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
    // The spawn ring is clear of the town (shared tests); clear it anyway, never recursing.
    const g = this.snapToGround(dir);
    return this.clearOfStructures(g) ?? g;
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

/** HP after levelling from `shown` to `level`: the max-HP gain is added, capped at the new max. */
function levelUpHp(hp: number, shown: number, level: number): number {
  if (level <= shown) return hp;
  const newMax = maxHp(level);
  return Math.min(newMax, hp + (newMax - maxHp(shown)));
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
