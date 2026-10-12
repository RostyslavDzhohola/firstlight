// Support items (content.md §2.3): the Patchkit and the Prism Bubble.
//
// Patchkit: a channel (1.0 / 0.9 / 0.8 s), then the target heals 30 / 40 / 50% of THEIR max HP over
// 2 s. The target is yourself, or any live player within 4 m (the client sends the one in its
// crosshair; strangers included). Damage to the user during the channel cancels it and the kit is
// kept; a finished channel uses one kit and starts the 6 s shared cooldown.
//
// Prism Bubble: a sphere at the user's feet (r 3 / 3.5 / 4 m, 6 / 7 / 8 s) with 150 / 200 / 260 shell
// HP per 100 of the owner's max HP. Hitscan, projectiles and splash that cross the shell, either way,
// stop at it and the shell takes the damage; melee and walking pass through, and boss split circles
// ignore it (true damage never asks). The item is kept; it has a cooldown (25 / 22 / 20 s).
// Combat asks `host.bubbles` (BubbleHost); NPC ranged attacks ask it through NpcSystem.hitPlayer.

import { HOTBAR_SLOTS } from "@firstlight/shared/content/character";
import type { InvItem } from "@firstlight/shared/net/protocol";
import { WEAPON_BY_ID } from "@firstlight/shared/content/weapons";
import { actorPos, type PlayerActor } from "./actors.ts";
import type { BodyRoom } from "./BodyRoom.ts";
import { onGameEvent } from "./events.ts";
import type { V3 } from "./geometry.ts";
import type { RoomSystem } from "./systems.ts";

/**
 * Account timers at process level, so a copy switch, a body hop or a recreated room doesn't reset
 * them (F12 review S2). A server restart does (they are short).
 */
export const SUPPORT_TIMERS = {
  /** Account id → when the Prism Bubble can be deployed again. */
  bubbleReady: new Map<string, number>(),
};

export const SUPPORT = {
  /** Extra metres allowed on the Patchkit's 4 m reach (latency between client and server positions). */
  reachSlack: 1.5,
  /** Bubble messages go to clients within this distance (m). */
  bubbleRadius: 200,
};

// ------------------------------------------------------------------------------------ bubbles

export interface Bubble {
  id: number;
  /** Owner's session id. */
  owner: string;
  c: V3;
  r: number;
  hp: number;
  until: number;
}

/** What combat needs from the bubbles (set as CombatHost.bubbles). */
export interface BubbleHost {
  /** First shell the segment `o + d·t`, t ∈ [0, maxT], crosses (in either direction), or null. */
  cross(o: V3, d: V3, maxT: number): { bubble: Bubble; t: number } | null;
  /** First shell between two points, or null. */
  between(a: V3, b: V3): Bubble | null;
  /** The shell takes `amount`; at 0 HP it pops. */
  absorb(b: Bubble, amount: number): void;
}

/** Distance along a unit ray to where it crosses a sphere's surface within `maxT`, or null. */
export function segmentShellT(o: V3, d: V3, maxT: number, c: V3, r: number): number | null {
  const ox = o[0] - c[0], oy = o[1] - c[1], oz = o[2] - c[2];
  const b = ox * d[0] + oy * d[1] + oz * d[2];
  const cc = ox * ox + oy * oy + oz * oz - r * r;
  const disc = b * b - cc;
  if (disc < 0) return null;
  const s = Math.sqrt(disc);
  // Outside: where it enters; inside: where it leaves.
  const t = cc > 0 ? -b - s : -b + s;
  return t >= 0 && t <= maxT ? t : null;
}

let bubbleSeq = 1;

/** The live bubbles of one room copy. */
export class BubbleField implements BubbleHost {
  readonly list: Bubble[] = [];
  private readonly onPop: (b: Bubble) => void;
  private readonly hit = { bubble: null as unknown as Bubble, t: 0 };

  constructor(onPop: (b: Bubble) => void = () => {}) {
    this.onPop = onPop;
  }

  add(owner: string, c: V3, r: number, hp: number, until: number): Bubble {
    const b: Bubble = { id: bubbleSeq++, owner, c: [c[0], c[1], c[2]], r, hp, until };
    this.list.push(b);
    return b;
  }

  cross(o: V3, d: V3, maxT: number): { bubble: Bubble; t: number } | null {
    let best: Bubble | null = null;
    let bestT = Infinity;
    for (const b of this.list) {
      const t = segmentShellT(o, d, Math.min(maxT, bestT), b.c, b.r);
      if (t !== null && t < bestT) {
        bestT = t;
        best = b;
      }
    }
    if (!best) return null;
    this.hit.bubble = best;
    this.hit.t = bestT;
    return this.hit;
  }

  between(a: V3, b: V3): Bubble | null {
    if (!this.list.length) return null;
    const d: V3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const l = Math.hypot(d[0], d[1], d[2]);
    if (l < 1e-6) return null;
    return this.cross(a, [d[0] / l, d[1] / l, d[2] / l], l)?.bubble ?? null;
  }

  absorb(b: Bubble, amount: number) {
    if (!(amount > 0) || !this.list.includes(b)) return;
    b.hp = Math.max(0, b.hp - amount);
    if (b.hp <= 0) this.pop(b);
  }

  expire(now: number) {
    for (const b of [...this.list]) if (now >= b.until) this.pop(b);
  }

  clear() {
    this.list.length = 0;
  }

  private pop(b: Bubble) {
    const i = this.list.indexOf(b);
    if (i < 0) return;
    this.list.splice(i, 1);
    this.onPop(b);
  }
}

/**
 * Splash against shells, decided for every target before any shell is charged, so who is checked
 * first can't matter (F12 review S3). `blocks(point)` says whether a shell lies between the blast and
 * that point; `charge()` then charges each intercepting shell once. Overflow is defined as none: a
 * shell that runs out while stopping a blast still stops all of it, then pops.
 */
export function splashShield(bubbles: BubbleHost | undefined, at: V3) {
  const shells = new Set<Bubble>();
  return {
    blocks(point: V3): boolean {
      const s = bubbles?.between(at, point) ?? null;
      if (s) shells.add(s);
      return !!s;
    },
    charge(amount: (b: Bubble) => number) {
      for (const s of shells) bubbles!.absorb(s, amount(s));
    },
  };
}

/** Chest height above an actor's feet, where splash and NPC rounds are aimed. */
export function chestOf(feet: V3, h = 1.0): V3 {
  const l = Math.hypot(feet[0], feet[1], feet[2]) || 1;
  return [feet[0] + (feet[0] / l) * h, feet[1] + (feet[1] / l) * h, feet[2] + (feet[2] / l) * h];
}

// ------------------------------------------------------------------------------------ the system

interface Channel {
  slot: number;
  tier: number;
  target: string;
  endsAt: number;
}

const systems = new WeakMap<BodyRoom, SupportSystem>();

/** The room's support system (Patchkit channels, bubbles), if it has one. */
export function supportOf(room: BodyRoom): SupportSystem | undefined {
  return systems.get(room);
}

export class SupportSystem implements RoomSystem {
  readonly room: BodyRoom;
  readonly bubbles: BubbleField;
  /** Session id → the Patchkit channel in progress. */
  readonly channels = new Map<string, Channel>();
  private readonly unsub: () => void;

  constructor(room: BodyRoom) {
    this.room = room;
    this.bubbles = new BubbleField((b) => this.room.broadcastNear("bubblePop", { id: b.id }, b.c, SUPPORT.bubbleRadius));
    // Damage to someone channelling a Patchkit cancels it (the kit is kept).
    this.unsub = onGameEvent(room, (e) => {
      if (e.type === "damage" && e.targetKind === "player" && e.amount > 0 && this.channels.has(e.targetId)) this.cancel(e.targetId, "interrupted");
    });
  }

  /** `use` on a Patchkit or Prism Bubble (BodyRoom.use has checked the slot, the item and the level gate). */
  use(a: PlayerActor, slot: number, item: InvItem, targetId?: string) {
    if (item.id === "patchkit") this.startPatch(a, slot, item, targetId);
    else if (item.id === "bubble") this.deploy(a, item);
  }

  private deny(a: PlayerActor, reason: string) {
    a.client.send("denied", { action: "use", reason });
  }

  private startPatch(a: PlayerActor, slot: number, item: InvItem, targetId?: string) {
    const now = Date.now();
    const tier = WEAPON_BY_ID.get("patchkit")!.tiers[item.tier - 1]!;
    if (now < a.healCooldownUntil) return this.deny(a, "cooldown");
    if (this.channels.has(a.id)) return this.deny(a, "busy");
    let target = a;
    if (targetId && targetId !== a.id) {
      const t = this.room.actors.get(targetId);
      if (!t || t.dead) return this.deny(a, "no target");
      if (!this.inReach(a, t)) return this.deny(a, "out of reach");
      target = t;
    }
    const ms = Math.round((tier.channel ?? 1) * 1000);
    this.channels.set(a.id, { slot, tier: item.tier, target: target.id, endsAt: now + ms });
    a.client.send("channel", { kind: "patchkit", ms, target: target.id });
  }

  private inReach(a: PlayerActor, t: PlayerActor): boolean {
    const reach = WEAPON_BY_ID.get("patchkit")!.range + SUPPORT.reachSlack;
    const p = actorPos(a), q = actorPos(t);
    return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) <= reach;
  }

  private finishPatch(a: PlayerActor, ch: Channel, now: number) {
    this.channels.delete(a.id);
    const list = ch.slot < HOTBAR_SLOTS ? a.char.hotbar : a.char.backpack;
    const i = ch.slot < HOTBAR_SLOTS ? ch.slot : ch.slot - HOTBAR_SLOTS;
    const item = list[i];
    if (a.dead || !item || item.id !== "patchkit" || item.tier !== ch.tier) return this.end(a, false, "kit gone");
    const target = ch.target === a.id ? a : this.room.actors.get(ch.target);
    if (!target || target.dead) return this.end(a, false, "no target");
    if (target !== a && !this.inReach(a, target)) return this.end(a, false, "out of reach");
    const tier = WEAPON_BY_ID.get("patchkit")!.tiers[ch.tier - 1]!;
    const over = tier.duration ?? 2;
    const amount = (tier.heal ?? 0.3) * target.state.maxHp;
    target.heals.push({ perSec: amount / over, until: now + over * 1000, left: amount });
    a.healCooldownUntil = now + (tier.cooldown ?? 6) * 1000;
    item.qty -= 1;
    if (item.qty <= 0) list[i] = null;
    if (ch.slot === a.char.selected) this.room.equip(a, a.char.selected);
    a.youDirty = true;
    this.end(a, true);
  }

  private cancel(sessionId: string, reason: string) {
    const a = this.room.actors.get(sessionId);
    this.channels.delete(sessionId);
    if (a) this.end(a, false, reason);
  }

  private end(a: PlayerActor, ok: boolean, reason?: string) {
    a.client.send("channelEnd", ok ? { kind: "patchkit", ok } : { kind: "patchkit", ok, reason });
  }

  private deploy(a: PlayerActor, item: InvItem) {
    const now = Date.now();
    const tier = WEAPON_BY_ID.get("bubble")!.tiers[item.tier - 1]!;
    if ((SUPPORT_TIMERS.bubbleReady.get(a.identity.userId) ?? 0) > now) return this.deny(a, "cooldown");
    SUPPORT_TIMERS.bubbleReady.set(a.identity.userId, now + (tier.cooldown ?? 25) * 1000);
    const at = actorPos(a);
    const r = tier.radius ?? 3;
    const hp = Math.round(((tier.shell ?? 150) / 100) * a.state.maxHp);
    const ms = (tier.duration ?? 6) * 1000;
    const b = this.bubbles.add(a.id, at, r, hp, now + ms);
    this.room.broadcastNear("bubble", { id: b.id, by: a.id, x: at[0], y: at[1], z: at[2], r, ms, hp }, at, SUPPORT.bubbleRadius);
  }

  tick(_dtMs: number, now: number) {
    for (const [id, ch] of this.channels) {
      if (now < ch.endsAt) continue;
      const a = this.room.actors.get(id);
      if (a) this.finishPatch(a, ch, now);
      else this.channels.delete(id);
    }
    this.bubbles.expire(now);
    for (const [k, until] of SUPPORT_TIMERS.bubbleReady) if (until <= now) SUPPORT_TIMERS.bubbleReady.delete(k);
  }

  onPlayerLeave(sessionId: string) {
    this.channels.delete(sessionId);
  }

  dispose() {
    this.unsub();
    this.bubbles.clear();
    if (this.room.host?.bubbles === this.bubbles) this.room.host.bubbles = undefined;
    systems.delete(this.room);
  }
}

/** SYSTEM_FACTORIES entry: one support system per room copy, hooked into combat. */
export function createSupportSystem(room: BodyRoom): RoomSystem {
  const sys = new SupportSystem(room);
  systems.set(room, sys);
  room.host.bubbles = sys.bubbles;
  return sys;
}
