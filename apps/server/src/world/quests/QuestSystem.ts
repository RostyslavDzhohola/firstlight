// Quests and economy for one room (one copy of one body): fast-travel pads (discover by touch,
// travel pad-to-pad), the Portus Exchange shop, guide missions, medals and titles, Easter eggs and
// the Hall of Firsts, cosmetics, and the admin `stage <n>` command. Plugs into the room through
// RoomSystem hooks, room messages and the game event bus (../events.ts).

import type { Client } from "@colyseus/core";
import { chordMetres, padDirs, PLANET_IDS, safePadAt, type BodyId } from "@firstlight/shared";
import { BACKPACK_SLOTS, HOTBAR_SLOTS, emptyLife, type LifeProgress } from "@firstlight/shared/content/character";
import { COSMETIC_BY_ID, COSMETIC_SLOTS, itemName, itemStack, sellValue, shopEntry, type CosmeticSlot } from "@firstlight/shared/content/items";
import { MEDAL_BY_ID, MEDAL_RULES } from "@firstlight/shared/content/medals";
import { MISSION_BY_ID, MISSIONS, missionGoal, type MissionDef } from "@firstlight/shared/content/missions";
import { offsetDir, padName, place, placeDir } from "@firstlight/shared/content/places";
import { BOSS_FIRSTS, EGG_BY_ID, type EggId } from "@firstlight/shared/content/secrets";
import { inReach, objectPos, objectsOn, surfaceDistance, WORLD_OBJECT_BY_ID, type WorldObjectDef } from "@firstlight/shared/content/world";
import { WEAPON_BY_ID, WEAPONS } from "@firstlight/shared/content/weapons";
import { NPC_DEFS, NPC_INDEX, defLevels, type PlanetId } from "@firstlight/shared/content/npcs";
import type { BossId } from "@firstlight/shared/content/places";
import type { InvItem, YouState } from "@firstlight/shared/net/protocol";
import { PF } from "@firstlight/shared/net/schema";
import { z } from "zod";
import { accountLinks } from "../../auth/links.ts";
import { actorPos, type PlayerActor } from "../actors.ts";
import { withTx } from "../characters.ts";
import type { BodyRoom } from "../BodyRoom.ts";
import { emitGameEvent, onGameEvent, type DamageEvent, type DeathEvent, type GameEvent, type KillEvent, type SpawnRequestEvent } from "../events.ts";
import { npcSystemOf, onNpcEvent, type NpcEvent } from "../npc/index.ts";
import { dist3, type V3 } from "../geometry.ts";
import type { RoomSystem } from "../systems.ts";
import { EggLogic } from "./eggs.ts";
import { engrave, hallLines, onHallChanged } from "./hall.ts";
import { runStage } from "./stage.ts";
import { progressStore } from "./store.ts";

export const QUEST_RULES = {
  /** Touching a pad = feet within this many metres of its centre (D2). */
  PAD_TOUCH_M: 6,
  /** Extra metres allowed between client and server positions when using objects. */
  INTERACT_SLACK: 1.5,
  /** Hunt kills count up to this far outside the named area's radius. */
  AREA_SLACK: 20,
  FAST_TRAVEL_COOLDOWN_MS: 2000,
  /** Reach triggers ignore height differences up to this (uneven lookouts). */
  REACH_VERTICAL: 6,
  /** A reach mission arms once you've been this far from its target since your last teleport (no fast-travel shortcuts). */
  REACH_ARM_M: 60,
  /** Long Shot: the Stillshot must have fired within this window before the kill. */
  LONG_SHOT_WINDOW_MS: 150,
  SLOW_TICK_MS: 200,
};

/** Transient per-session quest state (account data is cached here, life data lives in char.life). */
export interface QuestPlayer {
  id: string;
  medals: Set<string>;
  pads: Set<number>;
  title: string | null;
  lastFastTravel: number;
  /** Enter-trigger objects and reach targets the player is currently inside (edge detection). */
  inside: Set<string>;
  seq: { E2: string[]; E5: string[] };
  e4: { lit: Set<string>; startedAt: number; ferryUntil: number };
  e8: { hit: Set<string>; startedAt: number };
  /** Opened passages (egg key → expiry ms). */
  passages: Map<string, number>;
  /** Reach missions that may complete (armed by being far from the target since the last teleport). */
  reachArmed: Set<string>;
  lowHpAt: number | null;
  woolbackHitAt: number;
}

function newQuestPlayer(id: string): QuestPlayer {
  return {
    id,
    medals: new Set(),
    pads: new Set(),
    title: null,
    lastFastTravel: 0,
    inside: new Set(),
    seq: { E2: [], E5: [] },
    e4: { lit: new Set(), startedAt: 0, ferryUntil: 0 },
    e8: { hit: new Set(), startedAt: 0 },
    passages: new Map(),
    reachArmed: new Set(),
    lowHpAt: null,
    woolbackHitAt: 0,
  };
}

/** Combat's "shot" broadcast (hitscan rays carry `hit`; Stormcoil casts carry `chain`, one point per entity hit). */
export interface ShotMsg {
  by: string;
  weapon: number;
  ox: number;
  oy: number;
  oz: number;
  dx: number;
  dy: number;
  dz: number;
  hit?: [number, number, number];
  chain?: [number, number, number][];
}

const slotSchema = z.number().int().min(0).max(HOTBAR_SLOTS + BACKPACK_SLOTS - 1);

export class QuestSystem implements RoomSystem {
  readonly room: BodyRoom;
  readonly body: BodyId;
  readonly players = new Map<string, QuestPlayer>();
  readonly objects: WorldObjectDef[];
  private readonly objPos = new Map<string, V3>();
  readonly eggs: EggLogic;
  private readonly unsubs: (() => void)[] = [];
  private lastSlow = 0;
  private lastLevelCheck = 0;
  /** Boss encounters (NPC id → account id → hurt by the boss since their first hit), for Untouchable. */
  private readonly bossHits = new Map<string, Map<string, { hurt: boolean }>>();
  private restoreBroadcast: (() => void) | null = null;

  constructor(room: BodyRoom) {
    this.room = room;
    this.body = room.bodyDef.id;
    this.objects = objectsOn(this.body);
    const t = room.terrain;
    for (const o of this.objects) this.objPos.set(o.id, objectPos(o, (x, y, z) => t.groundHeight(x, y, z)));
    this.eggs = new EggLogic(this);
    this.watchShots();

    room.onMessage("fastTravel", z.object({ pad: z.number().int().min(0).max(63) }), (c, m) => this.fastTravel(c, m.pad));
    room.onMessage("buy", z.object({ itemId: z.string().max(40), tier: z.number().int().min(1).max(3).optional(), qty: z.number().int().min(1).max(20).optional() }), (c, m) =>
      this.buy(c, m.itemId, (m.tier ?? 1) as 1 | 2 | 3, m.qty ?? 1),
    );
    room.onMessage("sell", z.object({ slot: slotSchema, qty: z.number().int().min(1).max(99).optional() }), (c, m) => this.sell(c, m.slot, m.qty));
    room.onMessage("wear", z.object({ slot: slotSchema.optional(), remove: z.enum(["hat", "cape", "mask", "backpack"]).optional() }), (c, m) => this.wear(c, m.slot, m.remove));
    room.onMessage("mission", z.object({ action: z.enum(["accept", "abandon"]), id: z.string().max(8) }), (c, m) => this.mission(c, m.action, m.id));
    room.onMessage("title", z.object({ medalId: z.string().max(40).nullable() }), (c, m) => this.setTitle(c, m.medalId));
    room.onMessage("interact", z.object({ target: z.string().max(40), code: z.string().max(8).optional() }), (c, m) => this.interact(c, m.target, m.code));
    room.onMessage("questSync", z.object({}).passthrough().optional(), (c) => this.sync(c));
    this.unsubs.push(onGameEvent(room, (e) => this.onEvent(e)));
    this.unsubs.push(onNpcEvent((e) => this.onNpcEvent(e)));
    this.unsubs.push(onHallChanged((lines) => this.room.broadcast("hall" as never, { lines } as never)));
    this.unsubs.push(
      accountLinks.on((ev) => {
        for (const a of this.room.actors.values()) if (a.identity.userId === ev.toUserId) this.loadAccount(a);
      }),
    );
  }

  dispose() {
    for (const u of this.unsubs.splice(0)) u();
    this.restoreBroadcast?.();
  }

  /** Observe combat's "shot" broadcasts (hitscan rays and Stormcoil chains) for Arc Welder and egg E8. */
  private watchShots() {
    const host = this.room.host;
    const orig = host.broadcast;
    const origNear = host.broadcastNear;
    const observe = (type: string, msg: unknown) => {
      if (type !== "shot") return;
      try {
        this.onShot(msg as ShotMsg);
      } catch (err) {
        console.error("quest shot observer failed", err);
      }
    };
    host.broadcast = (type, msg, except) => {
      orig(type, msg, except);
      observe(type, msg);
    };
    host.broadcastNear = (type, msg, at, radius, always) => {
      origNear(type, msg, at, radius, always);
      observe(type, msg);
    };
    this.restoreBroadcast = () => {
      host.broadcast = orig;
      host.broadcastNear = origNear;
    };
  }

  private readonly ops = new Map<string, number[]>();
  /** Quest operations (shop, missions, objects, travel) save to SQLite: at most 5 per second per player. */
  allowOp(a: PlayerActor | undefined): a is PlayerActor {
    if (!a || a.dead || a.superseded) return false;
    const now = Date.now();
    const list = (this.ops.get(a.id) ?? []).filter((t) => now - t < 1000);
    if (list.length >= 5) return false;
    list.push(now);
    this.ops.set(a.id, list);
    return true;
  }

  private onShot(m: ShotMsg) {
    const a = this.actor(m.by);
    if (!a || a.dead) return;
    // Arc Welder: one Stormcoil cast whose chain damaged 4 entities (only T2+ chains reach 4).
    if (WEAPONS[m.weapon]?.id === "stormcoil" && (m.chain?.length ?? 0) >= MEDAL_RULES.ARC_WELDER_TARGETS) this.award(a, "arc_welder");
    this.eggs.onShot(a, m);
  }

  // ---------------------------------------------------------------- helpers

  actor(id: string): PlayerActor | undefined {
    return this.room.actors.get(id);
  }

  qp(a: PlayerActor): QuestPlayer {
    let q = this.players.get(a.id);
    if (!q) {
      q = newQuestPlayer(a.id);
      this.players.set(a.id, q);
    }
    return q;
  }

  life(a: PlayerActor): LifeProgress {
    a.char.life ??= emptyLife();
    return a.char.life;
  }

  pos(o: WorldObjectDef | string): V3 {
    const id = typeof o === "string" ? o : o.id;
    return this.objPos.get(id)!;
  }

  near(a: PlayerActor, o: WorldObjectDef, slack = QUEST_RULES.INTERACT_SLACK): boolean {
    return inReach(this.pos(o), actorPos(a), o.range, slack);
  }

  toast(a: PlayerActor, text: string, kind: "info" | "xp" | "coins" | "medal" | "warn" = "info") {
    a.client.send("toast", { text, kind });
  }

  /** Move a player (server-authoritative), like the admin teleport. */
  teleport(a: PlayerActor, at: readonly number[]) {
    this.qp(a).reachArmed.clear();
    const p = this.room.snapToGround(at);
    a.state.x = a.lastX = p[0];
    a.state.y = a.lastY = p[1];
    a.state.z = a.lastZ = p[2];
    a.lastMoveAt = Date.now();
    a.history.length = 0;
    a.client.send("correct", { x: p[0], y: p[1], z: p[2], seq: a.state.seq });
  }

  /** Surface point `metres` from a direction at a stable bearing (for arrivals and formations). */
  around(dir: readonly number[], east: number, north: number): V3 {
    const l = Math.hypot(dir[0]!, dir[1]!, dir[2]!) || 1;
    const d = offsetDir([dir[0]! / l, dir[1]! / l, dir[2]! / l], east, north, this.room.bodyDef.radius);
    const R = this.room.bodyDef.radius;
    return [d[0] * R, d[1] * R, d[2] * R];
  }

  private canStore(a: PlayerActor, item: InvItem): boolean {
    const stack = itemStack(item.id);
    for (const list of [a.char.hotbar, a.char.backpack]) {
      for (const s of list) {
        if (!s) return true;
        if (stack > 1 && s.id === item.id && s.tier === item.tier && !s.skin && !item.skin && s.qty + item.qty <= stack) return true;
      }
    }
    return false;
  }

  /** Give an item: weapons and consumables like the room does (hotbar first); everything else to the backpack first. */
  give(a: PlayerActor, item: InvItem): boolean {
    if (WEAPON_BY_ID.has(item.id) && !item.skin) return this.room.giveItem(a, item);
    const stack = itemStack(item.id);
    if (stack > 1) {
      for (const list of [a.char.backpack, a.char.hotbar]) {
        for (const s of list) {
          if (s && s.id === item.id && s.tier === item.tier && s.qty + item.qty <= stack) {
            s.qty += item.qty;
            a.youDirty = true;
            return true;
          }
        }
      }
    }
    for (const list of [a.char.backpack, a.char.hotbar]) {
      const i = list.findIndex((s) => !s);
      if (i >= 0) {
        list[i] = { ...item };
        if (list === a.char.hotbar && i === a.char.selected) this.room.equip(a, i);
        a.youDirty = true;
        return true;
      }
    }
    return false;
  }

  /**
   * Give items (or drop the overflow at the player's feet), apply `also` (coins, flags) and save,
   * all in one transaction with the pile write (no dupes or losses on a crash).
   */
  grant(a: PlayerActor, items: InvItem[], also?: () => void) {
    const events: (() => void)[] = [];
    let dropped = false;
    withTx(() => {
      also?.();
      const left = items.filter((it) => !this.give(a, it));
      if (left.length) {
        this.room.createPile(a, left, 0, actorPos(a), events);
        dropped = true;
      }
      this.room.saveActor(a);
    });
    for (const e of events) e();
    if (dropped) this.toast(a, "Your bags are full — the rest is on the ground at your feet", "warn");
    a.youDirty = true;
  }

  // ---------------------------------------------------------------- lifecycle

  onPlayerJoin(sessionId: string) {
    const a = this.actor(sessionId);
    if (!a) return;
    this.players.set(sessionId, newQuestPlayer(sessionId));
    this.life(a);
    this.loadAccount(a);
    this.refreshCosmetics(a);
  }

  onPlayerLeave(sessionId: string) {
    this.players.delete(sessionId);
  }

  /** (Re)load account-level progress for a player: medals, title, discovered pads on this body. */
  loadAccount(a: PlayerActor) {
    const q = this.qp(a);
    const uid = a.identity.userId;
    if (a.identity.loadtest) return;
    const store = progressStore.current;
    q.medals = new Set(store.medals(uid));
    q.pads = new Set(store.pads(uid, this.body));
    const t = store.title(uid);
    q.title = t && q.medals.has(t) ? t : null;
    a.state.title = q.title ? (MEDAL_BY_ID.get(q.title)?.title ?? "") : "";
    a.youDirty = true;
  }

  decorateYou(a: PlayerActor, you: YouState) {
    const q = this.qp(a);
    you.missions = a.char.missions.map((m) => {
      const def = MISSION_BY_ID.get(m.id);
      return { id: m.id, progress: m.progress, goal: def ? missionGoal(def) : 1, done: m.done };
    });
    you.medals = [...q.medals];
    you.pads = [...q.pads].sort((x, y) => x - y);
    you.title = q.title;
    you.worn = { ...(a.char.worn ?? {}) };
  }

  sync(c: Client) {
    c.send("hall", { lines: hallLines() });
    this.eggs.syncTo(c);
  }

  // ---------------------------------------------------------------- tick

  tick(dtMs: number, now: number) {
    for (const a of this.room.actors.values()) {
      if (a.dead) continue;
      const life = this.life(a);
      life.playMs += dtMs;
    }
    if (now - this.lastSlow < QUEST_RULES.SLOW_TICK_MS) return;
    this.lastSlow = now;
    const checkLevels = now - this.lastLevelCheck > 1000;
    if (checkLevels) this.lastLevelCheck = now;
    for (const a of this.room.actors.values()) {
      if (a.dead) continue;
      const q = this.qp(a);
      if (this.room.bodyDef.padLayout !== "none") this.touchPads(a, q);
      this.checkReach(a, q);
      this.eggs.tickPlayer(a, q, now);
      this.refreshCosmetics(a);
      if (q.lowHpAt !== null && now - q.lowHpAt >= MEDAL_RULES.BY_A_THREAD_MS) {
        q.lowHpAt = null;
        this.award(a, "by_a_thread");
      }
      if (checkLevels) {
        if (a.char.level >= MEDAL_RULES.TEN_DOWN_LEVEL) this.award(a, "ten_down");
        if (a.char.level >= MEDAL_RULES.FIRSTLIGHT_LEVEL) this.award(a, "firstlight");
        if (this.life(a).playMs >= MEDAL_RULES.OLD_TIMER_MS) this.award(a, "old_timer");
      }
    }
    this.eggs.tickRoom(now);
  }

  // ---------------------------------------------------------------- pads and fast travel

  private touchPads(a: PlayerActor, q: QuestPlayer) {
    const def = this.room.bodyDef;
    const p = actorPos(a);
    const l = Math.hypot(p[0], p[1], p[2]);
    const pads = padDirs(def);
    for (let i = 0; i < pads.length; i++) {
      if (chordMetres(pads[i]!, p[0] / l, p[1] / l, p[2] / l, def.radius) > QUEST_RULES.PAD_TOUCH_M) continue;
      // Life progress (Cartographer): every pad touched this life.
      const life = this.life(a);
      const used = (life.padsUsed[this.body] ??= []);
      if (!used.includes(i)) {
        used.push(i);
        if (used.length >= pads.length) this.award(a, "cartographer");
      }
      if (q.pads.has(i) || a.identity.loadtest) continue;
      q.pads.add(i);
      progressStore.current.discoverPad(a.identity.userId, this.body, i);
      a.youDirty = true;
      this.toast(a, `Pad discovered: ${padName(this.body, i)} — fast travel here from any pad (M)`, "info");
      emitGameEvent(this.room, { type: "padDiscovered", playerId: a.id, pad: i });
    }
  }

  fastTravel(c: Client, pad: number) {
    const a = this.actor(c.sessionId);
    if (!this.allowOp(a)) return;
    const deny = (reason: string) => c.send("denied", { action: "fastTravel", reason });
    const def = this.room.bodyDef;
    const pads = padDirs(def);
    if (def.padLayout === "none" || pad >= pads.length) return deny("no such pad");
    const here = safePadAt(def, a.state.x, a.state.y, a.state.z);
    if (here < 0) return deny("stand on a pad");
    if (here === pad) return deny("already here");
    const q = this.qp(a);
    if (!q.pads.has(pad)) return deny("undiscovered");
    const now = Date.now();
    if (now - q.lastFastTravel < QUEST_RULES.FAST_TRAVEL_COOLDOWN_MS) return deny("cooldown");
    q.lastFastTravel = now;
    const d = pads[pad]!;
    const ang = ((a.id.charCodeAt(0) + now) % 360) * (Math.PI / 180);
    this.teleport(a, this.around(d, Math.cos(ang) * 3.5, Math.sin(ang) * 3.5));
    this.toast(a, `Travelled to ${padName(this.body, pad)}`, "info");
  }

  // ---------------------------------------------------------------- shop

  private atShop(a: PlayerActor): boolean {
    const keeper = WORLD_OBJECT_BY_ID.get("juno_vale")!;
    return this.body === "portus" && this.near(a, keeper, 2.5);
  }

  buy(c: Client, itemId: string, tier: 1 | 2 | 3, qty: number) {
    const a = this.actor(c.sessionId);
    if (!this.allowOp(a)) return;
    const fail = (reason: string, text: string) => {
      c.send("shop", { ok: false, action: "buy", reason });
      this.toast(a, text, "warn");
    };
    if (!this.atShop(a)) return fail("too far", "Talk to Juno Vale at the Portus Exchange to buy");
    const entry = shopEntry(itemId, tier);
    if (!entry) return fail("not sold", "The Exchange doesn't sell that");
    const n = entry.stack > 1 ? Math.max(1, Math.min(entry.stack, qty)) : 1;
    const cost = entry.price * n;
    if (a.char.coins < cost) return fail("coins", `Not enough coins (${cost} ◎ needed)`);
    const item: InvItem = { id: itemId, tier, qty: n };
    if (!this.canStore(a, item)) return fail("full", "Your bags are full — sell or drop something first");
    this.grant(a, [item], () => {
      a.char.coins -= cost;
    });
    c.send("shop", { ok: true, action: "buy" });
    const gate = entry.level > a.char.level ? ` (equip at level ${entry.level})` : "";
    this.toast(a, `Bought ${n > 1 ? `${n} × ` : ""}${entry.name}${tier > 1 ? ` ${"I".repeat(tier)}` : ""} for ${cost} ◎${gate}`, "coins");
  }

  sell(c: Client, slot: number, qty?: number) {
    const a = this.actor(c.sessionId);
    if (!this.allowOp(a)) return;
    const fail = (reason: string, text: string) => {
      c.send("shop", { ok: false, action: "sell", reason });
      this.toast(a, text, "warn");
    };
    if (!this.atShop(a)) return fail("too far", "Talk to Juno Vale at the Portus Exchange to sell");
    const list = slot < HOTBAR_SLOTS ? a.char.hotbar : a.char.backpack;
    const i = slot < HOTBAR_SLOTS ? slot : slot - HOTBAR_SLOTS;
    const item = list[i];
    if (!item) return fail("empty", "Nothing in that slot");
    const n = Math.max(1, Math.min(item.qty, qty ?? item.qty));
    const value = sellValue(item, n);
    if (value <= 0) return fail("worthless", "Juno shakes her head: “I can't sell that on.”");
    item.qty -= n;
    if (item.qty <= 0) list[i] = null;
    a.char.coins += value;
    if (slot === a.char.selected) this.room.equip(a, a.char.selected);
    this.refreshCosmetics(a);
    a.youDirty = true;
    c.send("shop", { ok: true, action: "sell" });
    this.toast(a, `Sold ${n > 1 ? `${n} × ` : ""}${itemName(item)} for ${value} ◎`, "coins");
    this.room.saveActor(a);
  }

  // ---------------------------------------------------------------- cosmetics

  wear(c: Client, slot?: number, remove?: CosmeticSlot) {
    const a = this.actor(c.sessionId);
    if (!this.allowOp(a)) return;
    const worn = (a.char.worn ??= {});
    if (remove) {
      delete worn[remove];
    } else if (slot !== undefined) {
      const item = slot < HOTBAR_SLOTS ? a.char.hotbar[slot] : a.char.backpack[slot - HOTBAR_SLOTS];
      const def = item ? COSMETIC_BY_ID.get(item.id) : undefined;
      if (!def) {
        c.send("shop", { ok: false, action: "wear", reason: "not a cosmetic" });
        return;
      }
      if (worn[def.slot] === def.id) delete worn[def.slot];
      else worn[def.slot] = def.id;
    }
    this.refreshCosmetics(a);
    a.youDirty = true;
    c.send("shop", { ok: true, action: "wear" });
  }

  /** Drop worn cosmetics that left the inventory and mirror the rest to PlayerState.cosmetics. */
  refreshCosmetics(a: PlayerActor) {
    const worn = a.char.worn;
    let s = "";
    if (worn) {
      const have = new Set<string>();
      for (const it of a.char.hotbar) if (it) have.add(it.id);
      for (const it of a.char.backpack) if (it) have.add(it.id);
      const ids: string[] = [];
      for (const slot of COSMETIC_SLOTS) {
        const id = worn[slot];
        if (!id) continue;
        if (!have.has(id) || COSMETIC_BY_ID.get(id)?.slot !== slot) {
          delete worn[slot];
          a.youDirty = true;
        } else ids.push(id);
      }
      s = ids.join(",");
    }
    if (a.state.cosmetics !== s) a.state.cosmetics = s;
  }

  // ---------------------------------------------------------------- missions

  mission(c: Client, action: "accept" | "abandon", id: string) {
    const a = this.actor(c.sessionId);
    if (!this.allowOp(a)) return;
    const def = MISSION_BY_ID.get(id);
    if (!def) return;
    const list = a.char.missions;
    const have = list.find((m) => m.id === id);
    if (action === "abandon") {
      if (!have || have.done) return;
      a.char.missions = list.filter((m) => m !== have);
      a.youDirty = true;
      this.toast(a, `Mission abandoned: ${def.name}`, "info");
      return;
    }
    if (def.body !== this.body) return c.send("denied", { action: "mission", reason: "wrong planet" });
    const guide = WORLD_OBJECT_BY_ID.get(`guide_${def.body}`)!;
    if (!this.near(a, guide, 3)) return c.send("denied", { action: "mission", reason: "too far" });
    if (have) return c.send("denied", { action: "mission", reason: have.done ? "done this life" : "active" });
    list.push({ id, progress: 0, done: false, ...(def.hunt ? { counts: def.hunt.targets.map(() => 0) } : {}) });
    a.youDirty = true;
    this.toast(a, `Mission accepted: ${def.name} — ${def.objective}`, "info");
    this.room.saveActor(a);
  }

  private activeMissions(a: PlayerActor): { m: CharacterMission; def: MissionDef }[] {
    const out: { m: CharacterMission; def: MissionDef }[] = [];
    for (const m of a.char.missions) {
      if (m.done) continue;
      const def = MISSION_BY_ID.get(m.id);
      if (def && def.body === this.body) out.push({ m, def });
    }
    return out;
  }

  completeMission(a: PlayerActor, m: CharacterMission, def: MissionDef) {
    if (m.done) return;
    m.done = true;
    m.progress = missionGoal(def);
    this.room.grantXp(a, def.reward.xp);
    this.grant(
      a,
      def.reward.items.map((i) => ({ ...i })),
      () => {
        a.char.coins += def.reward.coins;
      },
    );
    const extra = def.reward.items.map((i) => `${i.qty} × ${itemName(i)}`).join(", ");
    this.toast(a, `Mission complete: ${def.name} · +${def.reward.xp} XP · +${def.reward.coins} ◎${extra ? ` · ${extra}` : ""}`, "xp");
    a.client.send("missionDone", { id: def.id, xp: def.reward.xp, coins: def.reward.coins });
    emitGameEvent(this.room, { type: "missionDone", playerId: a.id, missionId: def.id });
    if (MISSIONS.every((d) => a.char.missions.some((x) => x.id === d.id && x.done))) this.award(a, "errand_runner");
  }

  private onKillForMissions(e: KillEvent) {
    const credit = new Set(e.creditIds ?? (e.killerId ? [e.killerId] : []));
    for (const id of credit) {
      const a = this.actor(id);
      if (!a || a.dead) continue;
      for (const { m, def } of this.activeMissions(a)) {
        if (!def.hunt) continue;
        if (def.hunt.place && e.area !== def.hunt.place) {
          // No matching spawn-area id: fall back to the kill position, if there is one.
          if (!e.pos) continue;
          const p = place(def.hunt.place);
          const d = placeDir(p);
          const R = this.room.bodyDef.radius;
          const l = Math.hypot(e.pos[0], e.pos[1], e.pos[2]) || 1;
          if (chordMetres(d, e.pos[0] / l, e.pos[1] / l, e.pos[2] / l, R) > p.radius + QUEST_RULES.AREA_SLACK) continue;
        }
        const ti = def.hunt.targets.findIndex((t) => t.npcKind === e.npcKind);
        if (ti < 0) continue;
        const counts = (m.counts ??= def.hunt.targets.map(() => 0));
        if ((counts[ti] ?? 0) >= def.hunt.targets[ti]!.count) continue;
        counts[ti] = (counts[ti] ?? 0) + 1;
        m.progress = def.hunt.targets.reduce((s, t, k) => s + Math.min(t.count, counts[k] ?? 0), 0);
        a.youDirty = true;
        if (m.progress >= missionGoal(def)) this.completeMission(a, m, def);
      }
    }
  }

  private readonly reachTargets = new Map<string, V3>();

  private checkReach(a: PlayerActor, q: QuestPlayer) {
    for (const { m, def } of this.activeMissions(a)) {
      if (!def.reach) continue;
      let target = this.reachTargets.get(def.reach.place);
      if (!target) this.reachTargets.set(def.reach.place, (target = this.room.snapToGround(placeDir(def.reach.place))));
      const p = actorPos(a);
      const across = surfaceDistance(target, p);
      if (across >= QUEST_RULES.REACH_ARM_M) q.reachArmed.add(def.id);
      const vertical = Math.abs(Math.hypot(p[0], p[1], p[2]) - Math.hypot(target[0], target[1], target[2]));
      if (across <= def.reach.radius && vertical <= QUEST_RULES.REACH_VERTICAL && q.reachArmed.has(def.id)) this.completeMission(a, m, def);
    }
  }

  // ---------------------------------------------------------------- medals and titles

  /** Award a medal once per account. Returns true if newly earned. */
  award(a: PlayerActor, medalId: string): boolean {
    const def = MEDAL_BY_ID.get(medalId);
    if (!def || a.identity.loadtest) return false;
    const q = this.qp(a);
    if (q.medals.has(medalId)) return false;
    q.medals.add(medalId);
    const fresh = progressStore.current.awardMedal(a.identity.userId, medalId);
    a.youDirty = true;
    if (!fresh) return false;
    this.toast(a, `Medal earned: ${def.name} — wear the title “${def.title}” from the journal (J)`, "medal");
    a.client.send("medal", { id: medalId });
    emitGameEvent(this.room, { type: "medal", playerId: a.id, medalId });
    return true;
  }

  setTitle(c: Client, medalId: string | null) {
    const a = this.actor(c.sessionId);
    if (!a || a.identity.loadtest || !this.allowOp(a)) return;
    const q = this.qp(a);
    if (medalId !== null && (!MEDAL_BY_ID.has(medalId) || !q.medals.has(medalId))) {
      c.send("denied", { action: "title", reason: "not earned" });
      return;
    }
    if (!progressStore.current.setTitle(a.identity.userId, medalId)) {
      c.send("denied", { action: "title", reason: "not earned" });
      return;
    }
    q.title = medalId;
    a.state.title = medalId ? MEDAL_BY_ID.get(medalId)!.title : "";
    a.youDirty = true;
    this.toast(a, medalId ? `Title set: ${a.state.title}` : "Title cleared", "medal");
  }

  // ---------------------------------------------------------------- interaction

  interact(c: Client, target: string, code?: string) {
    const a = this.actor(c.sessionId);
    if (!this.allowOp(a)) return;
    const o = WORLD_OBJECT_BY_ID.get(target);
    if (!o || o.body !== this.body || o.trigger !== "interact") return;
    if (!this.near(a, o)) return c.send("denied", { action: "interact", reason: "too far" });
    if (o.mission) {
      const active = a.char.missions.find((m) => m.id === o.mission && !m.done);
      const def = MISSION_BY_ID.get(o.mission);
      if (active && def) this.completeMission(a, active, def);
      return;
    }
    if (o.egg) this.eggs.interact(a, this.qp(a), o, code);
  }

  /** Grant an egg's rare item (once per life), its hidden medal (once per account) and try the Hall of Firsts. */
  claimEgg(a: PlayerActor, eggId: EggId) {
    const egg = EGG_BY_ID.get(eggId);
    if (!egg || a.dead) return;
    const life = this.life(a);
    if (life.eggs.includes(eggId)) {
      this.toast(a, `You already took the ${egg.itemName} in this life`, "info");
      return;
    }
    this.grant(a, [{ ...egg.item }], () => {
      life.eggs.push(eggId);
    });
    this.toast(a, `Secret found: ${egg.name} — ${egg.itemName}`, "medal");
    this.award(a, egg.medal);
    if (!a.identity.loadtest && engrave(eggId, a.identity.userId, a.identity.name)) {
      this.toast(a, "You found it first — your name is engraved on the Hall of Firsts in Portus", "medal");
    }
  }

  // ---------------------------------------------------------------- events (medals, missions, eggs)

  private onEvent(e: GameEvent) {
    switch (e.type) {
      case "kill":
        this.onKillForMissions(e);
        this.onKillForMedals(e);
        break;
      case "damage":
        this.onDamage(e);
        break;
      case "death":
        this.onDeath(e);
        break;
      case "pickup": {
        const a = this.actor(e.playerId);
        if (a && e.items > 0 && e.pileOwnerUserId === a.identity.userId && e.pileCreatedAt < a.char.lifeStartedAt) this.award(a, "back_for_my_stuff");
        break;
      }
      case "levelUp": {
        const a = this.actor(e.playerId);
        if (!a) break;
        if (e.level >= MEDAL_RULES.TEN_DOWN_LEVEL) this.award(a, "ten_down");
        if (e.level >= MEDAL_RULES.FIRSTLIGHT_LEVEL) this.award(a, "firstlight");
        break;
      }
      case "travel": {
        const a = this.actor(e.playerId);
        if (!a || a.dead || !(PLANET_IDS as readonly string[]).includes(e.body)) break;
        const life = this.life(a);
        if (!life.visited.includes(e.body)) life.visited.push(e.body);
        if (PLANET_IDS.every((b) => life.visited.includes(b))) this.award(a, "grand_tour");
        break;
      }
      case "propBroken": {
        const a = e.playerId ? this.actor(e.playerId) : undefined;
        if (!a || a.identity.loadtest) break;
        const n = progressStore.current.addStat(a.identity.userId, "props_broken", 1);
        if (n >= MEDAL_RULES.DEMOLITION_PROPS) this.award(a, "demolition_crew");
        break;
      }
      case "onboardingDone": {
        const a = this.actor(e.playerId);
        if (a) this.award(a, "spark");
        break;
      }
      case "secretFound": {
        const a = this.actor(e.playerId);
        if (a) this.claimEgg(a, e.secretId);
        break;
      }
      case "secretStep": {
        const a = this.actor(e.playerId);
        if (a) this.eggs.onStep(a, this.qp(a), e.secretId, e.step);
        break;
      }
      case "spawnRequest":
        this.spawn(e);
        break;
      default:
        break;
    }
  }

  private onKillForMedals(e: KillEvent) {
    // Long Shot: the killing blow from a Stillshot at ≥ 120 m.
    const killer = e.killerId ? this.actor(e.killerId) : undefined;
    if (killer && e.pos && this.firedStillshot(killer) && dist3(actorPos(killer), e.pos) >= MEDAL_RULES.LONG_SHOT_METRES) this.award(killer, "long_shot");
    if (!e.bossId) return;
    const medal = e.bossId === "tidewrath" ? "tide_turner" : e.bossId === "hollow_king" ? "regicide" : "decommissioned";
    const eligible = (e.creditIds ?? (e.killerId ? [e.killerId] : [])).map((id) => this.actor(id)).filter((a): a is PlayerActor => !!a);
    for (const a of eligible) {
      this.award(a, medal);
      const life = this.life(a);
      if (!life.bosses.includes(e.bossId)) life.bosses.push(e.bossId);
      if (["tidewrath", "hollow_king", "receiver"].every((b) => life.bosses.includes(b))) this.award(a, "triple_crown");
      const hits = this.bossHits.get(e.npcKind)?.get(a.identity.userId);
      if (hits && !hits.hurt) this.award(a, "untouchable");
    }
    this.bossHits.delete(e.npcKind);
    const people = eligible.filter((a) => !a.identity.loadtest);
    if (people.length) engrave(BOSS_FIRSTS[e.bossId], people[0]!.identity.userId, people.map((a) => a.identity.name).join(", ").slice(0, 200));
  }

  /** The Stillshot is in hand and fired just now (the kill came from that shot, not an older projectile). */
  private firedStillshot(a: PlayerActor): boolean {
    return a.char.hotbar[a.char.selected]?.id === "stillshot" && Date.now() - a.lastAttackAt <= QUEST_RULES.LONG_SHOT_WINDOW_MS;
  }

  private onDamage(e: DamageEvent) {
    if (e.targetKind === "player") {
      const a = this.actor(e.targetId);
      if (!a) return;
      const q = this.qp(a);
      if (e.attackerKind === "npc" && e.npcKind === "woolback") q.woolbackHitAt = e.at;
      if (e.attackerKind === "npc" && e.boss) {
        const hit = this.bossHits.get(e.npcKind ?? e.attackerId ?? "")?.get(a.identity.userId);
        if (hit) hit.hurt = true;
      }
      if (e.hpAfter > 0 && e.hpAfter <= e.maxHp * MEDAL_RULES.BY_A_THREAD_FRACTION && q.lowHpAt === null) q.lowHpAt = e.at;
    }
    if (e.attackerKind === "player" && e.attackerId && e.targetKind === "npc") {
      const a = this.actor(e.attackerId);
      if (!a) return;
      if (e.boss) {
        const key = e.npcKind ?? e.targetId;
        let enc = this.bossHits.get(key);
        if (!enc) this.bossHits.set(key, (enc = new Map()));
        if (!enc.has(a.identity.userId)) enc.set(a.identity.userId, { hurt: false });
      }
      // Long Shot on an NPC: this hit killed it, from a Stillshot that just fired, 120 m or more away.
      const npc = this.room.npcActors.get(e.targetId);
      if (e.hpAfter <= 0 && npc && this.firedStillshot(a) && dist3(actorPos(a), actorPos(npc)) >= MEDAL_RULES.LONG_SHOT_METRES) this.award(a, "long_shot");
    }
  }

  // ---------------------------------------------------------------- the NPC lane

  /** Bridge the NPC lane's process-wide events (kills, boss kills, egg steps) onto this room's bus. */
  private onNpcEvent(e: NpcEvent) {
    if (e.body !== this.body) return;
    const here = (ids: string[]) => ids.filter((id) => this.room.actors.has(id));
    if (e.kind === "kill") {
      const credit = here(e.players);
      if (credit.length) emitGameEvent(this.room, { type: "kill", npcKind: e.def, killerId: null, creditIds: credit, level: e.npcLevel, ...(e.area ? { area: e.area } : {}) });
    } else if (e.kind === "bossKill") {
      const credit = here(e.sessionIds);
      const bossId = BOSS_OF_NPC[e.boss];
      if (credit.length && bossId) emitGameEvent(this.room, { type: "kill", npcKind: e.boss, bossId, killerId: null, creditIds: credit });
    } else if (e.kind === "egg") {
      if (this.room.actors.has(e.sessionId)) emitGameEvent(this.room, { type: "secretStep", playerId: e.sessionId, secretId: e.egg, step: e.egg === "E3" ? "burrow" : "lift" });
    }
  }

  /** Honour a spawn request (egg penalties, staged scenes) through the room's NPC system. */
  private spawn(e: SpawnRequestEvent) {
    const npcs = npcSystemOf(this.room);
    if (!npcs) return;
    const now = Date.now();
    if (e.bossId) {
      npcs.boss?.forceSpawn(now);
      return;
    }
    const idx = e.npcKind ? NPC_INDEX.get(e.npcKind) : undefined;
    if (idx === undefined) return;
    const def = NPC_DEFS[idx]!;
    const [lo, hi] = defLevels(def, this.body as PlanetId);
    const level = Math.round((lo + hi) / 2);
    for (let i = 0; i < Math.min(8, e.count); i++) {
      const ang = (i / Math.max(1, e.count)) * Math.PI * 2;
      const at = this.room.snapToGround(this.around(e.pos, Math.cos(ang) * 4, Math.sin(ang) * 4));
      npcs.createNpc(idx, level, at, now, { roam: 8 });
    }
  }

  private onDeath(e: DeathEvent) {
    const victim = this.actor(e.victimId);
    if (victim) {
      const q = this.qp(victim);
      const now = Date.now();
      if (e.killerKind === "npc" && e.npcKind === "woolback") this.award(victim, "killed_by_a_woolback");
      else if (e.killerKind === "world" && now - q.woolbackHitAt <= MEDAL_RULES.WOOLBACK_FALL_WINDOW_MS) this.award(victim, "killed_by_a_woolback");
      if (e.killerKind === "player" && e.killerId === victim.id) this.award(victim, "own_goal");
      // Everything carried is in the pile now: nothing is worn; egg sequences reset.
      victim.char.worn = {};
      this.refreshCosmetics(victim);
      this.players.set(victim.id, { ...newQuestPlayer(victim.id), medals: q.medals, pads: q.pads, title: q.title });
    }
    if (e.killerKind === "player" && e.killerId && e.killerId !== e.victimId) {
      const killer = this.actor(e.killerId);
      if (!killer) return;
      if (victim && killer.state.party && killer.state.party === victim.state.party) this.award(victim, "with_friends_like_these");
      if (this.firedStillshot(killer) && dist3(actorPos(killer), e.pos) >= MEDAL_RULES.LONG_SHOT_METRES) this.award(killer, "long_shot");
    }
  }

  // ---------------------------------------------------------------- admin

  onAdmin(a: PlayerActor, cmd: string, args: Record<string, unknown>): boolean {
    switch (cmd) {
      case "stage":
        runStage(this, a, Math.trunc(Number(args.n ?? 1)), args.all === true);
        return true;
      case "medal": {
        const id = String(args.id ?? "");
        const t = typeof args.target === "string" ? (this.actor(args.target) ?? a) : a;
        this.award(t, id);
        return true;
      }
      case "egg": {
        const id = String(args.id ?? "") as EggId;
        const t = typeof args.target === "string" ? (this.actor(args.target) ?? a) : a;
        if (typeof args.step === "string") this.eggs.onStep(t, this.qp(t), id, args.step);
        else this.claimEgg(t, id);
        return true;
      }
      default:
        return false;
    }
  }
}

type CharacterMission = PlayerActor["char"]["missions"][number];

/** NPC lane boss def ids → quests boss ids. */
const BOSS_OF_NPC: Record<string, BossId> = { tidewrath: "tidewrath", hollow_king: "hollow_king", the_receiver: "receiver" };

export function createQuestSystem(room: BodyRoom): RoomSystem {
  return new QuestSystem(room);
}

