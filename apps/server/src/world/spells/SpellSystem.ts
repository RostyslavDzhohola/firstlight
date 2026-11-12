// The spellbook on the server (content §2.7, D-spells-1…): aether, cooldowns and the four spells.
// Everything is decided here (D3): the client sends `cast {spell, aim}` and draws what the `spell`
// events and its private `you.spells` say.
//
// - Skipstep: the server walks the blink (skipstep.ts), moves the body and sends `correct`.
// - Frostbloom: a nova through combat's dealDamage (walls and Prism Bubbles shelter, safe zones and
//   protection hold, friendly fire on), plus a slow: players through the NPC lane's movement effects (enforced by
//   the movement budget, predicted by the client), creatures through NpcActor.slow (bosses: none).
// - Wishfall: a warning ring now, combat's explode() when it lands (heavy destruction, the caster
//   takes half, Prism Bubbles and walls shelter as from any blast).
// - Glasswing Ward: CombatHost.wards; dealDamage takes an attacker's damage from the shell first.
//
// Aether and cooldowns are kept per account at process level, like the support timers: a body hop
// or a new room copy doesn't refill or reset them. A server restart does (they are short).

import type { Client } from "@colyseus/core";
import { z } from "zod";
import {
  AETHER, aetherAt, FROSTBLOOM, GLASSWING, SKIPSTEP, SPELL_BY_ID, SPELL_IDS, SPELL_INDEX, SPELLS, spellDamage, WISHFALL,
  type SpellDef, type SpellId,
} from "@firstlight/shared/content/spells";
import type { CastMsg, SpellEvent, YouState } from "@firstlight/shared/net/protocol";
import { PF } from "@firstlight/shared/net/schema";
import { sandboxed } from "../../sandbox.ts";
import { actorPos, inSaddle, type Actor, type NpcActor, type PlayerActor } from "../actors.ts";
import type { BodyRoom } from "../BodyRoom.ts";
import { COMBAT_TAG_MS, dealDamage, explode, wallBetween } from "../combat.ts";
import { emitGameEvent } from "../events.ts";
import { dist3, PLAYER_RADIUS, rayTerrain, type V3 } from "../geometry.ts";
import { groundMotion } from "../movement.ts";
import { applyMoveEffect } from "../npc/effects.ts";
import { splashShield } from "../support.ts";
import type { RoomSystem } from "../systems.ts";
import { skipstepPath } from "./skipstep.ts";

/** Tuning that isn't a game number (those are in content/spells.ts). */
export const SPELL_NET = {
  /** `spell` events reach clients within this distance (m). */
  radius: 160,
  /** After a blink, inputs still coming from the old place are dropped for at most this long (ms). */
  staleInputMs: 1000,
  /** Wishfall's landing point is searched back toward the caster in steps this long (m). */
  starStepM: 0.5,
};

interface Book {
  aether: number;
  t: number;
  regenAt: number;
  ready: number[];
}

const books = sandboxed(new Map<string, Book>(), () => new Map<string, Book>());
/** Account id → spellbook state; an admin sandbox has its own (D-admin-3). Tests clear it. */
export const SPELL_BOOKS = {
  get byUser(): Map<string, Book> {
    return books.current;
  },
};

interface Ward {
  hp: number;
  max: number;
  until: number;
}

interface Star {
  id: number;
  owner: PlayerActor;
  at: V3;
  landAt: number;
  damage: number;
}

const finite = z.number().finite().min(-1e6).max(1e6);
const castSchema = z.object({
  spell: z.enum(SPELL_IDS),
  dx: finite,
  dy: finite,
  dz: finite,
  tx: finite.optional(),
  ty: finite.optional(),
  tz: finite.optional(),
});

let starSeq = 1;

function lift(p: V3, h: number): V3 {
  const l = Math.hypot(p[0], p[1], p[2]) || 1;
  return [p[0] + (p[0] / l) * h, p[1] + (p[1] / l) * h, p[2] + (p[2] / l) * h];
}

export class SpellSystem implements RoomSystem {
  readonly room: BodyRoom;
  /** Session id → the Glasswing Ward that is up. */
  readonly wards = new Map<string, Ward>();
  /** Stars on their way down. */
  readonly stars: Star[] = [];
  private lastPrune = 0;

  constructor(room: BodyRoom) {
    this.room = room;
    room.onMessage("cast", castSchema, (c: Client, m: CastMsg) => this.cast(c, m));
    room.host.wards = { absorb: (target, amount, attacker) => this.absorb(target, amount, attacker) };
  }

  // ------------------------------------------------------------------------------------ the book

  book(a: PlayerActor, now: number): Book {
    const all = SPELL_BOOKS.byUser;
    let b = all.get(a.identity.userId);
    if (!b) all.set(a.identity.userId, (b = { aether: AETHER.max, t: now, regenAt: 0, ready: SPELLS.map(() => 0) }));
    while (b.ready.length < SPELLS.length) b.ready.push(0);
    return b;
  }

  decorateYou(a: PlayerActor, you: YouState) {
    const now = Date.now();
    const b = this.book(a, now);
    const w = this.wards.get(a.id);
    you.spells = {
      aether: Math.round(aetherAt(b, now) * 10) / 10,
      t: now,
      regenAt: b.regenAt,
      ready: b.ready.map((r) => (r > now ? r : 0)),
      ...(w && w.until > now ? { ward: { hp: Math.round(w.hp), max: w.max, until: w.until } } : {}),
    };
  }

  // ------------------------------------------------------------------------------------ casting

  private send(e: SpellEvent, extra: string[] = []) {
    this.room.broadcastNear("spell", e, [e.x, e.y, e.z], SPELL_NET.radius, [e.by, ...extra]);
  }

  /** Why `a` can't cast `def` right now, or null. The same rules as an attack, then the book's. */
  private refusal(a: PlayerActor, def: SpellDef, b: Book, now: number): string | null {
    if (a.dead || a.superseded) return "dead";
    if (inSaddle(a, now)) return "mounted";
    if (this.room.safeNow(a, now)) return "safe zone";
    if (a.protectedUntil > now) return "protected";
    if (a.state.flags & PF.SWIMMING) return "swimming";
    if (def.level > a.char.level) return "locked";
    if ((b.ready[SPELL_INDEX.get(def.id)!] ?? 0) > now) return "cooldown";
    if (aetherAt(b, now) < def.cost) return "aether";
    return null;
  }

  private cast(c: Client, m: CastMsg) {
    const a = this.room.actors.get(c.sessionId);
    const def = SPELL_BY_ID.get(m.spell);
    if (!a || !def) return;
    const deny = (reason: string) => void c.send("denied", { action: "cast", reason });
    const now = Date.now();
    const b = this.book(a, now);
    const no = this.refusal(a, def, b, now);
    if (no) return deny(no);
    const dl = Math.hypot(m.dx, m.dy, m.dz);
    if (!(dl > 0.5 && dl < 1.5)) return deny("dir");
    const d: V3 = [m.dx / dl, m.dy / dl, m.dz / dl];
    // The spell itself; one that can't happen (a wall right ahead) costs nothing.
    const done = this.perform(a, def.id, d, m, now);
    if (done !== true) return deny(done);
    b.aether = aetherAt(b, now) - def.cost;
    b.t = now;
    b.regenAt = now + AETHER.regenDelayMs;
    b.ready[SPELL_INDEX.get(def.id)!] = now + def.cooldownS * 1000;
    a.logoutEndsAt = null; // casting cancels a logout countdown
    if (def.harmful) a.combatUntil = now + COMBAT_TAG_MS;
    a.youDirty = true;
    emitGameEvent(this.room, { type: "spellCast", playerId: a.id, spell: def.id });
  }

  private perform(a: PlayerActor, id: SpellId, d: V3, m: CastMsg, now: number): true | string {
    switch (id) {
      case "skipstep":
        return this.skipstep(a, d, now);
      case "frostbloom":
        this.frostbloom(a, now);
        return true;
      case "wishfall":
        return this.wishfall(a, d, m, now);
      case "glasswing":
        this.glasswing(a, now);
        return true;
    }
  }

  private skipstep(a: PlayerActor, d: V3, now: number): true | string {
    const from = actorPos(a);
    // Looking straight up or down has no ground direction: the way the body faces.
    const path = skipstepPath(this.room.moveWorld, from, d) ?? skipstepPath(this.room.moveWorld, from, [a.state.fx, a.state.fy, a.state.fz]);
    if (!path || path.dist < SKIPSTEP.minM) return "blocked";
    const to = path.to;
    a.serverMove = { x: a.lastX, y: a.lastY, z: a.lastZ, until: now + SPELL_NET.staleInputMs };
    a.state.x = a.lastX = to[0];
    a.state.y = a.lastY = to[1];
    a.state.z = a.lastZ = to[2];
    a.lastMoveAt = now;
    a.history.length = 0; // nobody is shot at a place on the way
    // A new envelope from the ground here. A fall under way still counts (airborne and its peak
    // are kept): the blink is no way down a cliff.
    groundMotion(a, Math.hypot(to[0], to[1], to[2]), now);
    a.client.send("correct", { x: to[0], y: to[1], z: to[2], seq: a.state.seq });
    this.send({ spell: "skipstep", phase: "cast", by: a.id, x: from[0], y: from[1], z: from[2], tx: to[0], ty: to[1], tz: to[2] });
    return true;
  }

  private *actors(): Iterable<Actor> {
    yield* this.room.host.players();
    yield* this.room.host.npcs();
  }

  private frostbloom(a: PlayerActor, now: number) {
    const host = this.room.host;
    const at = actorPos(a);
    const chest = lift(at, 1.0);
    const dmg = spellDamage(FROSTBLOOM.damage, a.char.level);
    const slowed: string[] = [];
    // Prism Bubble shells shelter as from any blast: who (and which props) they cover is decided
    // before any shell is charged, and each shell in the way pays once (review 1).
    const shield = splashShield(host.bubbles, chest);
    // Who is in the ring is decided before anyone is hurt (a death mustn't change the list).
    const inRing: Actor[] = [];
    for (const t of this.actors()) {
      if (t.id === a.id) continue;
      const r = t.kind === "player" ? PLAYER_RADIUS : t.radius;
      if (dist3(at, actorPos(t)) > FROSTBLOOM.radiusM + r) continue;
      const tc = lift(actorPos(t), t.kind === "player" ? 1.0 : Math.min(t.height * 0.5, 3));
      if (shield.blocks(tc)) continue;
      if (wallBetween(host, chest, tc)) continue; // not through a wall (D-zones-3)
      inRing.push(t);
    }
    for (const t of inRing) {
      const tp = actorPos(t);
      if (!dealDamage(host, a, t, dmg, false, [at[0] - tp[0], at[1] - tp[1], at[2] - tp[2]])) continue;
      if (t.kind === "player") {
        if (t.dead) continue;
        // The NPC lane's slow: the movement budget enforces it, the client predicts it (npcFx).
        const e = { kind: "slow" as const, seconds: FROSTBLOOM.slowS, amount: FROSTBLOOM.slow };
        applyMoveEffect(t, e, now);
        t.client?.send("npcFx", { kind: e.kind, ms: e.seconds * 1000, amount: e.amount, by: a.id });
        slowed.push(t.id);
      } else if (t.state.hp > 0 && !t.boss) {
        slowNpc(t, FROSTBLOOM.slow, now + FROSTBLOOM.slowS * 1000);
        slowed.push(t.id);
      }
    }
    // Frost cracks what a light weapon breaks (crates, barrels, fences).
    host.props?.splash(chest, FROSTBLOOM.radiusM, dmg, "light", "frostbloom", a.id, undefined, (c) => shield.blocks(c) || wallBetween(host, chest, c));
    shield.charge(() => dmg); // flat in the ring, like the nova itself
    this.send({ spell: "frostbloom", phase: "cast", by: a.id, x: at[0], y: at[1], z: at[2], r: FROSTBLOOM.radiusM, ms: FROSTBLOOM.slowS * 1000, hit: slowed });
  }

  /**
   * Where the star lands: the asked point (or what the ray from the head along the aim meets),
   * pulled back to the first thing between the caster's head and it, on the ground, and no further
   * than the range from the caster's feet. Null: there is no ground in range (a caster 30 m up).
   */
  starTarget(a: PlayerActor, d: V3, m: { tx?: number; ty?: number; tz?: number }): V3 | null {
    const host = this.room.host;
    const feet = actorPos(a);
    const head = lift(feet, 1.6);
    const range = WISHFALL.rangeM;
    const firstSolid = (o: V3, dir: V3, maxT: number): number =>
      Math.min(
        rayTerrain(host.terrain, o, dir, maxT, 1),
        host.walls?.raycast(o[0], o[1], o[2], dir[0], dir[1], dir[2], maxT) ?? Infinity,
        host.props?.raycast(o, dir, maxT)?.t ?? Infinity,
      );
    let target: V3;
    if (m.tx !== undefined && m.ty !== undefined && m.tz !== undefined && Math.hypot(m.tx, m.ty, m.tz) > this.room.bodyDef.radius * 0.5) {
      target = [m.tx, m.ty, m.tz];
    } else {
      const t = Math.min(range, firstSolid(head, d, range));
      target = [head[0] + d[0] * t, head[1] + d[1] * t, head[2] + d[2] * t];
    }
    const v: V3 = [target[0] - feet[0], target[1] - feet[1], target[2] - feet[2]];
    const far = Math.hypot(v[0], v[1], v[2]);
    if (far > range) target = [feet[0] + (v[0] * range) / far, feet[1] + (v[1] * range) / far, feet[2] + (v[2] * range) / far];
    // Not over a wall or a hill the caster can't see past: the star lands in front of it.
    const aim = lift(this.room.snapToGround(target), 1.0);
    const line: V3 = [aim[0] - head[0], aim[1] - head[1], aim[2] - head[2]];
    const l = Math.hypot(line[0], line[1], line[2]);
    if (l > 1e-3) {
      const dir: V3 = [line[0] / l, line[1] / l, line[2] / l];
      const stop = firstSolid(head, dir, l);
      if (stop < l - 0.05) {
        const t = Math.max(0, stop - 0.5);
        target = [head[0] + dir[0] * t, head[1] + dir[1] * t, head[2] + dir[2] * t];
      }
    }
    // The range holds for the ground the star lands on, not for the point before it was put there
    // (review 2): from a height or down a slope the ground under a point 30 m off is farther.
    return this.groundWithin(feet, target, range);
  }

  /**
   * The ground point on the way from `feet` to `target` that is farthest from the caster and still
   * within `range` metres of the feet. Walks back from the target in 0.5 m steps and closes in on
   * the range's edge between two steps. Null: not even the ground under the feet is in range.
   */
  private groundWithin(feet: V3, target: V3, range: number): V3 | null {
    const v: V3 = [target[0] - feet[0], target[1] - feet[1], target[2] - feet[2]];
    const steps = Math.max(1, Math.ceil(Math.hypot(v[0], v[1], v[2]) / SPELL_NET.starStepM));
    const groundAt = (k: number): V3 => this.room.snapToGround([feet[0] + v[0] * k, feet[1] + v[1] * k, feet[2] + v[2] * k]);
    let over = false;
    for (let i = steps; i >= 0; i--) {
      const p = groundAt(i / steps);
      if (dist3(feet, p) > range) {
        over = true;
        continue;
      }
      if (!over) return p;
      // The edge of the range lies between this step and the one before: the farthest point inside it.
      let lo = i / steps, hi = (i + 1) / steps, best = p;
      for (let n = 0; n < 7; n++) {
        const mid = (lo + hi) / 2;
        const q = groundAt(mid);
        if (dist3(feet, q) <= range) {
          lo = mid;
          best = q;
        } else hi = mid;
      }
      return best;
    }
    return null;
  }

  private wishfall(a: PlayerActor, d: V3, m: CastMsg, now: number): true | string {
    const at = this.starTarget(a, d, m);
    if (!at) return "blocked"; // nowhere for it to land: nothing is spent
    const star: Star = { id: starSeq++, owner: a, at, landAt: now + WISHFALL.telegraphS * 1000, damage: spellDamage(WISHFALL.damage, a.char.level) };
    this.stars.push(star);
    this.send({ spell: "wishfall", phase: "cast", by: a.id, x: at[0], y: at[1], z: at[2], r: WISHFALL.radiusM, ms: WISHFALL.telegraphS * 1000, id: star.id });
    return true;
  }

  private land(s: Star) {
    const a = s.owner;
    // The blast, through combat (safe zones, protection, walls, bubbles, self ×0.5, heavy destruction).
    // A caster who has left the world since deals none; the star still lands for everyone watching.
    if (!a.removed && !a.superseded) explode(this.room.host, a, lift(s.at, 0.4), WISHFALL.radiusM, s.damage, -1, undefined, undefined, true);
    this.send({ spell: "wishfall", phase: "impact", by: a.id, x: s.at[0], y: s.at[1], z: s.at[2], r: WISHFALL.radiusM, id: s.id });
  }

  private glasswing(a: PlayerActor, now: number) {
    const max = Math.round((GLASSWING.absorbPer100MaxHp / 100) * a.state.maxHp);
    const ms = GLASSWING.durationS * 1000;
    this.wards.set(a.id, { hp: max, max, until: now + ms });
    const at = actorPos(a);
    this.send({ spell: "glasswing", phase: "cast", by: a.id, x: at[0], y: at[1], z: at[2], ms, hp: max });
  }

  /** CombatHost.wards: the shell takes what it can of `amount`; the rest gets through. */
  private absorb(target: PlayerActor, amount: number, attacker: PlayerActor | NpcActor): number {
    const w = this.wards.get(target.id);
    if (!w || !(amount > 0)) return amount;
    if (Date.now() >= w.until) return amount;
    const take = Math.min(w.hp, amount);
    w.hp -= take;
    target.youDirty = true;
    const at = actorPos(target);
    this.send({ spell: "glasswing", phase: "absorb", by: target.id, x: at[0], y: at[1], z: at[2], amount: Math.max(1, Math.round(take)), from: attacker.id, hp: Math.round(w.hp) }, [attacker.id]);
    if (w.hp <= 0.5) this.endWard(target.id, true);
    return amount - take;
  }

  private endWard(sessionId: string, broke: boolean) {
    if (!this.wards.delete(sessionId)) return;
    const a = this.room.actors.get(sessionId);
    if (!a) return;
    a.youDirty = true;
    const at = actorPos(a);
    this.send({ spell: "glasswing", phase: "end", by: sessionId, x: at[0], y: at[1], z: at[2], broke });
  }

  // ------------------------------------------------------------------------------------ the room

  tick(_dtMs: number, now: number) {
    for (let i = this.stars.length - 1; i >= 0; i--) {
      const s = this.stars[i]!;
      if (now < s.landAt) continue;
      this.stars.splice(i, 1);
      this.land(s);
    }
    for (const [id, w] of this.wards) {
      const a = this.room.actors.get(id);
      if (now >= w.until || !a || a.dead) this.endWard(id, false);
    }
    if (now - this.lastPrune > 5000) {
      this.lastPrune = now;
      // A full book with nothing cooling down is the same as no book.
      for (const [k, b] of SPELL_BOOKS.byUser) if (aetherAt(b, now) >= AETHER.max && b.ready.every((r) => r <= now)) SPELL_BOOKS.byUser.delete(k);
    }
  }

  /** Admin `spells {refill: true}`: full aether and no cooldowns for the admin (staging, tests). */
  onAdmin(a: PlayerActor, cmd: string, args: Record<string, unknown>): boolean {
    if (cmd !== "spells") return false;
    if (args.refill === true) {
      SPELL_BOOKS.byUser.delete(a.identity.userId);
      a.youDirty = true;
    }
    return true;
  }

  onPlayerLeave(sessionId: string) {
    this.wards.delete(sessionId);
  }

  dispose() {
    this.stars.length = 0;
    this.wards.clear();
    if (this.room.host) this.room.host.wards = undefined;
  }
}

/** Slow a creature: the stronger slow wins, an equal one extends (like players' slows, npc/effects.ts). */
export function slowNpc(n: NpcActor, amount: number, until: number) {
  const s = n.slow;
  if (!s || Date.now() >= s.until || amount > s.amount) n.slow = { amount, until };
  else if (amount === s.amount) s.until = Math.max(s.until, until);
}

/** SYSTEM_FACTORIES entry: one spell system per room copy. */
export function createSpellSystem(room: BodyRoom): RoomSystem {
  return new SpellSystem(room);
}
