// Easter eggs (docs/content.md §6), server side. Each egg ends in QuestSystem.claimEgg (item once
// per life, hidden medal once per account, Hall of Firsts for the first account). Hidden rooms
// (Upside-Down Chapel, Ferryman's Isle, Vat Room) are reached by a server teleport after the step
// that opens them; the passage stays open for that player for a few minutes.
//
// E8 (shoot the billboard lamps) watches hitscan "shot" broadcasts: the room's combat host is
// wrapped on Meridian so every shot ray is tested against the five lamp spheres. Projectiles don't
// count (by design the lamps are a Stillshot job: 62 m up, out of every other hitscan's range).

import type { Client } from "@colyseus/core";
import { EGG_RULES, type EggId } from "@firstlight/shared/content/secrets";
import { placeDir } from "@firstlight/shared/content/places";
import { inReach, type WorldObjectDef } from "@firstlight/shared/content/world";
import { WEAPONS } from "@firstlight/shared/content/weapons";
import { actorPos, type PlayerActor } from "../actors.ts";
import { emitGameEvent } from "../events.ts";
import { dist3, type V3 } from "../geometry.ts";
import type { QuestPlayer, QuestSystem } from "./QuestSystem.ts";

const RIDDLES: Partial<Record<EggId, string>> = {
  E2: "The plaque reads: “Rain feeds the leaf, the leaf drinks the sun, the sun lights the ember.” Four buttons: raindrop, leaf, sun, flame.",
  E5: "The plaque reads: “Ring for the dead, then the lost, then the living.” Three ropes: skull, broken lantern, candle.",
};

interface ShotMsg {
  by: string;
  weapon: number;
  ox: number;
  oy: number;
  oz: number;
  dx: number;
  dy: number;
  dz: number;
  hit?: [number, number, number];
}

export class EggLogic {
  private readonly sys: QuestSystem;
  private readonly lamps: WorldObjectDef[];
  /** Lamp id → when it relights (ms); absent = lit. */
  private readonly lampsOff = new Map<string, number>();
  private restoreBroadcast: (() => void) | null = null;

  constructor(sys: QuestSystem) {
    this.sys = sys;
    this.lamps = sys.objects.filter((o) => o.trigger === "shoot");
    if (this.lamps.length) this.watchShots();
  }

  dispose() {
    this.restoreBroadcast?.();
  }

  private watchShots() {
    const host = this.sys.room.host;
    const orig = host.broadcast;
    host.broadcast = (type, msg, except) => {
      orig(type, msg, except);
      if (type === "shot") {
        try {
          this.onShot(msg as ShotMsg);
        } catch (err) {
          console.error("lamp shot check failed", err);
        }
      }
    };
    this.restoreBroadcast = () => {
      host.broadcast = orig;
    };
  }

  syncTo(c: Client) {
    for (const id of this.lampsOff.keys()) c.send("lamp", { id, on: false });
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
    for (const [k, until] of q.passages) if (until < now) q.passages.delete(k);
  }

  tickRoom(now: number) {
    for (const [id, until] of this.lampsOff) {
      if (until > now) continue;
      this.lampsOff.delete(id);
      this.sys.room.broadcast("lamp" as never, { id, on: true } as never);
    }
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

  private penalty(a: PlayerActor, npcKind: string, count: number) {
    emitGameEvent(this.sys.room, { type: "spawnRequest", reason: "egg", npcKind, count, pos: actorPos(a), playerId: a.id });
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
        a.char.coins -= EGG_RULES.E1_COST;
        a.youDirty = true;
        toast("You leave a coin. The sleeping Hopbit shrine glows…");
        return this.sys.claimEgg(a, "E1");
      }
      case "E2":
      case "E5": {
        if (o.part === "plaque") return toast(RIDDLES[egg]!);
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
          this.penalty(a, "hopbit", EGG_RULES.E2_PENALTY_HOPBITS);
        } else {
          toast("A wrong note. The water stirs and bones rise!", "warn");
          this.penalty(a, "bonewalker", EGG_RULES.E5_PENALTY_BONEWALKERS);
        }
        return;
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
      case "E7":
        if (code === undefined) {
          a.client.send("prompt", { kind: "keypad", target: o.id });
          return;
        }
        if (code === EGG_RULES.E7_CODE) {
          toast("The safe clicks open.");
          return this.sys.claimEgg(a, "E7");
        }
        return toast("ACCESS DENIED", "warn");
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

  /** Steps reported by other lanes (E3: the Golden Hopbit reached its burrow) or the admin `egg` command. */
  onStep(a: PlayerActor, q: QuestPlayer, egg: EggId, step: string) {
    if (egg === "E3") {
      this.open(q, "E3");
      this.sys.toast(a, "The Golden Hopbit dives into a burrow under the lone oak — and the burrow opens wide.", "info");
    } else if (egg === "E4" && step === "lanterns") {
      q.e4 = { lit: new Set(), startedAt: Date.now(), ferryUntil: Date.now() + EGG_RULES.E4_FERRY_MS };
    } else if (egg === "E6" || egg === "E8" || egg === "E9") {
      this.open(q, egg);
    }
  }

  onPhrase(sessionId: string, phraseId: number) {
    if (phraseId !== EGG_RULES.E9_PHRASE) return;
    const a = this.sys.actor(sessionId);
    if (!a || a.dead) return;
    const trooper = this.sys.objects.find((o) => o.id === "e9_trooper");
    if (!trooper || !inReach(this.sys.pos(trooper), actorPos(a), EGG_RULES.E9_RANGE)) return;
    const q = this.sys.qp(a);
    this.sys.toast(a, "Ticket #000 turns, studies you, and nods. It walks you to a freight lift that sinks below Checkpoint Seven…", "info");
    this.sys.room.clock.setTimeout(() => {
      const still = this.sys.actor(sessionId);
      if (!still || still.dead) return;
      this.open(q, "E9");
      this.teleportTo(still, "vat_room");
      this.sys.toast(still, "The Vat Room: rows of empty trooper pods. One stands open.", "info");
    }, 2500);
  }

  // ---------------------------------------------------------------- E8 lamps

  private onShot(m: ShotMsg) {
    const a = this.sys.actor(m.by);
    if (!a || a.dead) return;
    const w = WEAPONS[m.weapon];
    const o: V3 = [m.ox, m.oy, m.oz];
    const d: V3 = [m.dx, m.dy, m.dz];
    const maxT = m.hit ? dist3(o, m.hit) : (w?.falloffTo ?? w?.range ?? 0);
    const now = Date.now();
    for (const lamp of this.lamps) {
      if (this.lampsOff.has(lamp.id)) continue;
      const c = this.sys.pos(lamp);
      const t = raySphere(o, d, c, EGG_RULES.E8_LAMP_RADIUS);
      if (t === null || t > maxT + EGG_RULES.E8_LAMP_RADIUS) continue;
      this.lampsOff.set(lamp.id, now + EGG_RULES.E8_WINDOW_MS);
      this.sys.room.broadcast("lamp" as never, { id: lamp.id, on: false } as never);
      const q = this.sys.qp(a);
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

