// Easter eggs (docs/content.md §6), server side. Each egg ends in QuestSystem.claimEgg (item once
// per life, hidden medal once per account, Hall of Firsts for the first account). Hidden rooms
// (Upside-Down Chapel, Ferryman's Isle, Vat Room) are reached by a server teleport after the step
// that opens them; the passage stays open for that player for a few minutes.
//
// E8 (shoot the billboard lamps) tests hitscan "shot" broadcasts (observed by QuestSystem) against
// the five lamp spheres. Projectiles don't count (by design the lamps are a Stillshot job: 62 m up,
// out of every other hitscan's range). Each player has their own sequence and sees their own lamps
// go dark, so nobody can block someone else's run by shooting a lamp first.

import type { Client } from "@colyseus/core";
import { EGG_RULES, type EggId } from "@firstlight/shared/content/secrets";
import { placeDir } from "@firstlight/shared/content/places";
import { inReach, type WorldObjectDef } from "@firstlight/shared/content/world";
import { WEAPONS } from "@firstlight/shared/content/weapons";
import { actorPos, type PlayerActor } from "../actors.ts";
import { emitGameEvent } from "../events.ts";
import { dist3, type V3 } from "../geometry.ts";
import type { QuestPlayer, QuestSystem, ShotMsg } from "./QuestSystem.ts";

/**
 * Anti-abuse limits on the puzzles (server tuning, not content; tests change and restore them).
 * A wrong E2/E5 answer raises penalty NPCs: the puzzle then locks for that account for `lockMs`,
 * penalty NPCs dissolve after `ttlMs`, and at most `perPlayer` (per account) and `perBody` (per room)
 * are alive at once. The E7 keypad locks an account out for `keypadLockMs` after `keypadTries`
 * wrong codes in a row. E10/E11 failures use the same account puzzle lockout without spawning NPCs.
 * E12 uses the keypad limits independently of E7.
 */
export const EGG_LIMITS = {
  lockMs: 15_000,
  ttlMs: 90_000,
  perPlayer: 6,
  perBody: 12,
  keypadTries: 5,
  keypadLockMs: 60_000,
  /** Wrong keypad codes are forgotten after this long without another try. */
  keypadIdleMs: 10 * 60_000,
  wickWindowMs: 45_000,
};

/**
 * Account timers at process level, not per room, so switching copies or bodies and recreating a room
 * don't reset them (F12 review S2). A server restart does reset them: they are short anti-abuse timers.
 */
export const EGG_TIMERS = {
  /** `${userId}|${egg}` → when that puzzle unlocks again after a wrong answer. */
  puzzles: new Map<string, number>(),
  /** Account/keypad key → failed attempts, lockout end (0 = none) and last attempt. */
  keypads: new Map<string, { fails: number; until: number; last: number }>(),
};

const RIDDLES: Partial<Record<EggId, string>> = {
  E2: "The plaque reads: “Rain feeds the leaf, the leaf drinks the sun, the sun lights the ember.” Four buttons: raindrop, leaf, sun, flame.",
  E10: "The weathered dial reads: 'Under earth, a sleeping root waits for a silver bead. Only then does the flower wake.'",
  E11: "The stone reads: 'A wick alone drifts away. Keep the little lights together before the mist takes them. The reeds keep what they remember.'",
  E12: "The slip lists a timebox inspection: 'Rails: a trident. Brake: a lone nail. Teeth: an open hand. Bolts: a pair of squares. Enter the counts in inspection order.'",
  E5: "The plaque reads: “Ring for the dead, then the lost, then the living.” Three ropes: skull, broken lantern, candle.",
};

export class EggLogic {
  private readonly sys: QuestSystem;
  private readonly lamps: WorldObjectDef[];
  /** Session id → lamp id → when that player's lamp relights (ms); absent = lit. */
  private readonly dark = new Map<string, Map<string, number>>();

  constructor(sys: QuestSystem) {
    this.sys = sys;
    this.lamps = sys.objects.filter((o) => o.trigger === "shoot");
  }

  syncTo(c: Client) {
    for (const id of this.dark.get(c.sessionId)?.keys() ?? []) c.send("lamp", { id, on: false });
    const a = this.sys.actor(c.sessionId);
    if (a) for (const o of this.sys.objects) if (o.egg === "E11" && o.part === "wick") c.send("lamp", { id: o.id, on: this.sys.qp(a).e11.lit.has(o.id) });
  }

  // ---------------------------------------------------------------- per tick

  tickPlayer(a: PlayerActor, q: QuestPlayer, now: number) {
    // Enter triggers: the well (E6) and the ghost ferry (E4).
    for (const o of this.sys.objects) {
      if (o.trigger !== "enter") continue;
      const inside = inReach(this.sys.pos(o), actorPos(a), o.range);
      const was = q.inside.has(o.id);
      if (inside && !was) {
        q.inside.add(o.id);
        this.onEnter(a, q, o, now);
      } else if (!inside && was) q.inside.delete(o.id);
    }
    if (q.e4.lit.size && now - q.e4.startedAt > EGG_RULES.E4_WINDOW_MS && q.e4.ferryUntil < now) {
      q.e4 = { lit: new Set(), startedAt: 0, ferryUntil: 0 };
      this.sys.toast(a, "The marsh lanterns gutter out", "info");
    }
    if (q.e11.lit.size && now - q.e11.startedAt > EGG_LIMITS.wickWindowMs) {
      this.resetWicks(a, q);
      EGG_TIMERS.puzzles.set(`${a.identity.userId}|E11`, now + EGG_LIMITS.lockMs);
      this.sys.toast(a, "The floating wicks fade into the mist", "info");
    }
    for (const [k, until] of q.passages) if (until < now) q.passages.delete(k);
  }

  tickRoom(now: number) {
    for (const [k, until] of EGG_TIMERS.puzzles) if (until <= now) EGG_TIMERS.puzzles.delete(k);
    for (const [k, v] of EGG_TIMERS.keypads) {
      if (v.until > now) continue; // locked out: keep
      if (v.until || now - v.last >= EGG_LIMITS.keypadIdleMs) EGG_TIMERS.keypads.delete(k); // lockout over, or idle
    }
    for (const [sid, lamps] of this.dark) {
      const a = this.sys.actor(sid);
      for (const [id, until] of lamps) {
        if (until > now && a) continue;
        lamps.delete(id);
        a?.client.send("lamp", { id, on: true });
      }
      if (!lamps.size) this.dark.delete(sid);
    }
  }

  resetWicks(a: PlayerActor, q: QuestPlayer) {
    for (const id of q.e11.lit) a.client.send("lamp", { id, on: false });
    q.e11 = { lit: new Set(), startedAt: 0 };
  }

  private open(q: QuestPlayer, key: string) {
    q.passages.set(key, Date.now() + EGG_RULES.PASSAGE_MS);
  }

  private isOpen(q: QuestPlayer, key: string): boolean {
    return (q.passages.get(key) ?? 0) > Date.now();
  }

  private teleportTo(a: PlayerActor, placeId: string) {
    const d = placeDir(placeId);
    this.sys.teleport(a, this.sys.around(d, 1.5, -1.5));
  }

  private penalty(a: PlayerActor, egg: EggId, npcKind: string, count: number) {
    EGG_TIMERS.puzzles.set(`${a.identity.userId}|${egg}`, Date.now() + EGG_LIMITS.lockMs);
    emitGameEvent(this.sys.room, { type: "spawnRequest", reason: "egg", npcKind, count, pos: actorPos(a), playerId: a.id, egg });
  }

  /** The account is locked out of the E7 keypad right now. */
  keypadLocked(userId: string, now = Date.now()): boolean {
    return (EGG_TIMERS.keypads.get(userId)?.until ?? 0) > now;
  }

  /** Milliseconds until the account may try this puzzle again (0 = open). */
  lockedFor(userId: string, egg: EggId, now = Date.now()): number {
    return Math.max(0, (EGG_TIMERS.puzzles.get(`${userId}|${egg}`) ?? 0) - now);
  }

  // ---------------------------------------------------------------- triggers

  private onEnter(a: PlayerActor, q: QuestPlayer, o: WorldObjectDef, now: number) {
    if (o.id === "e6_well") {
      this.open(q, "E6");
      this.sys.toast(a, "You drop into the well… deep water breaks the fall. A side arch leads up into a chapel built upside down.", "info");
      this.teleportTo(a, "upside_down_chapel");
    } else if (o.id === "e4_ferry") {
      if (q.e4.ferryUntil < now) return;
      q.e4 = { lit: new Set(), startedAt: 0, ferryUntil: 0 };
      this.open(q, "E4");
      this.sys.toast(a, "The ghost ferry slides out across Mourning Mere and leaves you on Ferryman's Isle.", "info");
      this.teleportTo(a, "ferrymans_isle");
    }
  }

  interact(a: PlayerActor, q: QuestPlayer, o: WorldObjectDef, code?: string) {
    const egg = o.egg!;
    const now = Date.now();
    const toast = (t: string, k: "info" | "warn" = "info") => this.sys.toast(a, t, k);
    switch (egg) {
      case "E1": {
        if (this.sys.life(a).eggs.includes("E1")) return this.sys.claimEgg(a, "E1"); // explains, keeps the coin
        if (a.char.coins < EGG_RULES.E1_COST) return toast("The offering bowl is empty. It seems to want a coin.");
        // The coin goes in the claim's own save: a failed save keeps it (F12 final Opus nit).
        return this.sys.claimEgg(a, "E1", { cost: EGG_RULES.E1_COST, note: "You leave a coin. The sleeping Hopbit shrine glows…" });
      }
      case "E2":
      case "E5": {
        if (o.part === "plaque") return toast(RIDDLES[egg]!);
        const wait = this.lockedFor(a.identity.userId, egg, now);
        if (wait > 0) {
          const s = Math.ceil(wait / 1000);
          return toast(egg === "E2" ? `The cabinet is rebooting… (${s} s)` : `The ropes hang still. The bells are not ready (${s} s).`, "warn");
        }
        const order: readonly string[] = egg === "E2" ? EGG_RULES.E2_ORDER : EGG_RULES.E5_ORDER;
        const seq = q.seq[egg];
        if (o.part === order[seq.length]) {
          seq.push(o.part);
          if (seq.length === order.length) {
            q.seq[egg] = [];
            toast(egg === "E2" ? "The cabinet chimes: NEW HIGH SCORE. A drawer slides open." : "The bells ring out in order. Something beside the altar unlocks.");
            return this.sys.claimEgg(a, egg);
          }
          return toast(egg === "E2" ? "*click*" : "A bell tolls somewhere above.");
        }
        q.seq[egg] = [];
        if (egg === "E2") {
          toast("The cabinet buzzes: GAME OVER. Something hops out of the ruins!", "warn");
          this.penalty(a, egg, "hopbit", EGG_RULES.E2_PENALTY_HOPBITS);
        } else {
          toast("A wrong note. The water stirs and bones rise!", "warn");
          this.penalty(a, egg, "bonewalker", EGG_RULES.E5_PENALTY_BONEWALKERS);
        }
        return;
      }
      case "E10": {
        if (o.part === "plaque") return toast(RIDDLES.E10!);
        if (this.lockedFor(a.identity.userId, egg, now)) return toast("The dial rests under a film of dew. Wait a moment.", "warn");
        const order = ["root", "dew", "bloom"];
        if (q.seq.E10.length === order.length) {
          this.sys.claimEgg(a, egg);
          if (this.sys.life(a).eggs.includes(egg)) q.seq.E10 = [];
          return;
        }
        const seq = q.seq.E10;
        if (o.part !== order[seq.length]) {
          q.seq.E10 = [];
          EGG_TIMERS.puzzles.set(`${a.identity.userId}|${egg}`, now + EGG_LIMITS.lockMs);
          return toast("The dial folds shut. The carvings fall still.", "warn");
        }
        seq.push(o.part);
        if (seq.length < order.length) return toast("A silver bead settles in the carving.");
        // Retain the completed sequence until the claim saves, so a storage failure can be retried.
        this.sys.claimEgg(a, egg);
        if (this.sys.life(a).eggs.includes(egg)) q.seq.E10 = [];
        return;
      }
      case "E11": {
        if (o.part === "plaque") return toast(RIDDLES.E11!);
        if (this.lockedFor(a.identity.userId, egg, now)) return toast("The mist holds the wicks. Wait a moment.", "warn");
        if (q.e11.lit.size && now - q.e11.startedAt > EGG_LIMITS.wickWindowMs) {
          this.resetWicks(a, q);
          EGG_TIMERS.puzzles.set(`${a.identity.userId}|${egg}`, now + EGG_LIMITS.lockMs);
          return toast("The floating wicks fade into the mist", "warn");
        }
        if (o.part === "chest") {
          if (q.e11.lit.size === 3) {
            this.sys.claimEgg(a, egg);
            if (this.sys.life(a).eggs.includes(egg)) this.resetWicks(a, q);
            return;
          }
          this.resetWicks(a, q);
          EGG_TIMERS.puzzles.set(`${a.identity.userId}|${egg}`, now + EGG_LIMITS.lockMs);
          return toast("The reeds tighten around the coffer. Its lights are scattered.", "warn");
        }
        if (!q.e11.lit.size) q.e11.startedAt = now;
        q.e11.lit.add(o.id);
        a.client.send("lamp", { id: o.id, on: true });
        return toast(`The floating wick catches (${q.e11.lit.size}/3)`);
      }
      case "E12": {
        if (o.part === "plaque") return toast(RIDDLES.E12!);
        const key = `${a.identity.userId}|${egg}`;
        const k = EGG_TIMERS.keypads.get(key);
        if (k && k.until > now) return toast(`TIMEBOX LOCKED. Try again in ${Math.ceil((k.until - now) / 1000)} s`, "warn");
        if (code === undefined) return a.client.send("prompt", { kind: "keypad", target: o.id });
        if (code === "3158") {
          EGG_TIMERS.keypads.delete(key);
          return this.sys.claimEgg(a, egg);
        }
        const fails = (k?.fails ?? 0) + 1;
        const until = fails >= EGG_LIMITS.keypadTries ? now + EGG_LIMITS.keypadLockMs : 0;
        EGG_TIMERS.keypads.set(key, { fails: until ? 0 : fails, until, last: now });
        return toast(until ? "TIMEBOX LOCKED. The inspection counter needs to cool." : "The timebox rejects the inspection.", "warn");
      }
      case "E3":
        if (this.isOpen(q, "E3")) return this.sys.claimEgg(a, "E3");
        return toast("The burrow is far too small for you. Something small and golden might know the way in.");
      case "E4": {
        if (o.part === "chest") {
          if (this.isOpen(q, "E4")) return this.sys.claimEgg(a, "E4");
          return toast("The chest's lock is crusted with river silt. Nobody has rowed out here in years.");
        }
        if (q.e4.ferryUntil > now) return toast("The ferry is waiting at the jetty.");
        if (!q.e4.lit.size || now - q.e4.startedAt > EGG_RULES.E4_WINDOW_MS) q.e4 = { lit: new Set(), startedAt: now, ferryUntil: 0 };
        if (q.e4.lit.has(o.id)) return toast("This lantern already burns.");
        q.e4.lit.add(o.id);
        if (q.e4.lit.size >= EGG_RULES.E4_LANTERNS) {
          q.e4.ferryUntil = now + EGG_RULES.E4_FERRY_MS;
          return toast("All seven lanterns burn. A ghost ferry waits at the Fen jetty — for a minute.");
        }
        return toast(`The lantern flickers to life (${q.e4.lit.size}/${EGG_RULES.E4_LANTERNS})`);
      }
      case "E6":
        if (this.isOpen(q, "E6")) return this.sys.claimEgg(a, "E6");
        return toast("The bell hangs from the “floor” above, out of reach from this side.");
      case "E7": {
        const k = EGG_TIMERS.keypads.get(a.identity.userId);
        if (k && k.until > now) return toast(`KEYPAD LOCKED. Try again in ${Math.ceil((k.until - now) / 1000)} s`, "warn");
        if (code === undefined) {
          a.client.send("prompt", { kind: "keypad", target: o.id });
          return;
        }
        if (code === EGG_RULES.E7_CODE) {
          EGG_TIMERS.keypads.delete(a.identity.userId);
          toast("The safe clicks open.");
          return this.sys.claimEgg(a, "E7");
        }
        const fails = (k?.fails ?? 0) + 1;
        if (fails >= EGG_LIMITS.keypadTries) {
          EGG_TIMERS.keypads.set(a.identity.userId, { fails: 0, until: now + EGG_LIMITS.keypadLockMs, last: now });
          return toast(`ACCESS DENIED. KEYPAD LOCKED for ${Math.round(EGG_LIMITS.keypadLockMs / 1000)} s`, "warn");
        }
        EGG_TIMERS.keypads.set(a.identity.userId, { fails, until: 0, last: now });
        return toast("ACCESS DENIED", "warn");
      }
      case "E8":
        if (this.isOpen(q, "E8")) {
          toast("The hatch opens into the Signal Room. A wall of CRTs flickers; a cloak of static hangs on a hook.");
          return this.sys.claimEgg(a, "E8");
        }
        return toast("The maintenance hatch is locked. Far above, the billboard lamps hum.");
      case "E9":
        if (this.isOpen(q, "E9")) return this.sys.claimEgg(a, "E9");
        return toast("The pod is sealed.");
    }
  }

  /**
   * Steps reported by the NPC lane (E3: the Golden Hopbit ran into its burrow; E9: Ticket #000
   * reached the freight lift) or the admin `egg <id> <step>` command.
   */
  onStep(a: PlayerActor, q: QuestPlayer, egg: EggId, step: string) {
    if (egg === "E3") {
      this.open(q, "E3");
      this.sys.toast(a, "The Golden Hopbit dives into its burrow under the lone oak. Follow it in!", "info");
    } else if (egg === "E9") {
      this.open(q, "E9");
      this.sys.toast(a, "Ticket #000 steps into a freight lift and holds the door. It sinks below Checkpoint Seven…", "info");
      this.teleportTo(a, "vat_room");
      this.sys.toast(a, "The Vat Room: rows of empty trooper pods. One stands open.", "info");
    } else if (egg === "E4" && step === "lanterns") {
      q.e4 = { lit: new Set(), startedAt: Date.now(), ferryUntil: Date.now() + EGG_RULES.E4_FERRY_MS };
    } else if (egg === "E6" || egg === "E8") {
      this.open(q, egg);
    }
  }

  // ---------------------------------------------------------------- E8 lamps

  onShot(a: PlayerActor, m: ShotMsg) {
    if (!this.lamps.length) return;
    const w = WEAPONS[m.weapon];
    const o: V3 = [m.ox, m.oy, m.oz];
    const d: V3 = [m.dx, m.dy, m.dz];
    const maxT = m.hit ? dist3(o, m.hit) : (w?.falloffTo ?? w?.range ?? 0);
    const now = Date.now();
    const q = this.sys.qp(a);
    let dark = this.dark.get(a.id);
    for (const lamp of this.lamps) {
      if ((dark?.get(lamp.id) ?? 0) > now) continue; // already out for this player
      const c = this.sys.pos(lamp);
      const t = raySphere(o, d, c, EGG_RULES.E8_LAMP_RADIUS);
      if (t === null || t > maxT + EGG_RULES.E8_LAMP_RADIUS) continue;
      if (!dark) this.dark.set(a.id, (dark = new Map()));
      dark.set(lamp.id, now + EGG_RULES.E8_WINDOW_MS);
      a.client.send("lamp", { id: lamp.id, on: false });
      if (!q.e8.hit.size || now - q.e8.startedAt > EGG_RULES.E8_WINDOW_MS) q.e8 = { hit: new Set(), startedAt: now };
      q.e8.hit.add(lamp.id);
      if (q.e8.hit.size >= EGG_RULES.E8_LAMPS) {
        q.e8 = { hit: new Set(), startedAt: 0 };
        this.open(q, "E8");
        this.sys.toast(a, "The Last Billboard goes dark. Far below, a maintenance hatch clanks open.", "info");
      }
      break;
    }
  }
}

/** Distance along a unit ray to a sphere, or null. */
export function raySphere(o: V3, d: V3, c: V3, r: number): number | null {
  const ox = o[0] - c[0], oy = o[1] - c[1], oz = o[2] - c[2];
  const b = ox * d[0] + oy * d[1] + oz * d[2];
  const cc = ox * ox + oy * oy + oz * oz - r * r;
  const disc = b * b - cc;
  if (disc < 0) return null;
  const t = -b - Math.sqrt(disc);
  return t >= 0 ? t : -b + Math.sqrt(disc) >= 0 ? 0 : null;
}

