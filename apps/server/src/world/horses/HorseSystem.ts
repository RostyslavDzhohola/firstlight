// Horses (SPEC §6.14 #2; rules in @firstlight/shared/content/horse). One horse per player, owned by
// the server: the whistle (H) calls it outside safe zones while a Horse Whistle is in the bags;
// E or H near it mounts and dismounts. While mounted the room's movement check allows horse speed
// and no dodge (BodyRoom.handleInput reads `actor.mounted`), and fire/melee are refused.
// The horse leaves 30 s after a dismount, and at once on death, logout, travel, a lost whistle
// or a takeover by another session. It is never saved and never a target.

import type { Client } from "@colyseus/core";
import { isSafe } from "@firstlight/shared";
import { HORSE, hasWhistle, horseCoat, tooDeepToRide, WHISTLE_REFUSAL_TEXT, whistleRefusal } from "@firstlight/shared/content/horse";
import { HorseState, PF } from "@firstlight/shared/net/schema";
import type { YouState } from "@firstlight/shared/net/protocol";
import { z } from "zod";
import { env } from "../../env.ts";
import { actorPos, type PlayerActor } from "../actors.ts";
import type { BodyRoom } from "../BodyRoom.ts";
import { onGameEvent, type GameEvent } from "../events.ts";
import type { V3 } from "../geometry.ts";
import type { RoomSystem, SystemFactory } from "../systems.ts";

interface Horse {
  owner: string; // session id
  state: HorseState;
  /** When it was last ridden (or summoned): it leaves HORSE.idleDespawnMs after this. */
  idleSince: number;
  /** Last ridden position on dry ground (where it stays when deep water throws the rider). */
  lastDry: V3;
}

export type DismountReason = "dismount" | "thrown" | "water";
export type LeaveReason = "idle" | "death" | "left" | "no whistle" | "replaced";

const actionSchema = z.object({ action: z.enum(["whistle", "ride", "dismount"]) });

export class HorseSystem implements RoomSystem {
  readonly room: BodyRoom;
  readonly horses = new Map<string, Horse>();
  private readonly lastWhistle = new Map<string, number>();
  /** Last time each player got on or off (HORSE.toggleCooldownMs). */
  private readonly lastToggle = new Map<string, number>();
  /** "horse" messages per player in the current second (at most HORSE.messagesPerSecond count). */
  private readonly rate = new Map<string, { windowStart: number; n: number }>();
  private readonly unsubscribe: () => void;

  constructor(room: BodyRoom) {
    this.room = room;
    room.onMessage("horse", actionSchema, (c, m) => this.onAction(c, m.action));
    this.unsubscribe = onGameEvent(room, (e) => this.onEvent(e));
  }

  // ---------------------------------------------------------------- messages

  onAction(c: Client, action: "whistle" | "ride" | "dismount") {
    const a = this.room.playerById(c.sessionId);
    if (!a || a.dead || a.superseded) return;
    const now = Date.now();
    const r = this.rate.get(a.id);
    if (!r || now - r.windowStart >= 1000) this.rate.set(a.id, { windowStart: now, n: 1 });
    else if (++r.n > HORSE.messagesPerSecond) return; // spam: dropped without a reply
    const toggle = (fn: () => void) => {
      if (now - (this.lastToggle.get(a.id) ?? 0) < HORSE.toggleCooldownMs) return;
      this.lastToggle.set(a.id, now);
      fn();
    };
    if (a.mounted) return toggle(() => this.dismount(a, "dismount"));
    if (action === "dismount") return;
    const h = this.horses.get(a.id);
    if (h && this.inReach(a, h)) return toggle(() => this.mount(a, h));
    if (action === "whistle") this.summon(a);
  }

  private inReach(a: PlayerActor, h: Horse): boolean {
    const p = actorPos(a);
    return Math.hypot(p[0] - h.state.x, p[1] - h.state.y, p[2] - h.state.z) <= HORSE.mountRange + 1; // + network slack
  }

  /** Call the horse to the player's side (or bring the existing one over). */
  summon(a: PlayerActor) {
    const now = Date.now();
    const p = a.state;
    const refusal = whistleRefusal({
      dead: a.dead,
      hasWhistle: hasWhistle(a.char.hotbar, a.char.backpack),
      safe: isSafe(this.room.bodyDef, p.x, p.y, p.z),
      swimming: !!(p.flags & PF.SWIMMING) || this.deep(p.x, p.y, p.z),
      sinceLastWhistleMs: now - (this.lastWhistle.get(a.id) ?? 0),
    });
    if (refusal) {
      a.client.send("denied", { action: "horse", reason: refusal });
      const text = WHISTLE_REFUSAL_TEXT[refusal];
      if (text) a.client.send("toast", { text, kind: "warn" });
      return;
    }
    this.lastWhistle.set(a.id, now);
    const at = this.besideOf(a, HORSE.summonDistance);
    let h = this.horses.get(a.id);
    if (!h) {
      const state = new HorseState();
      state.coat = horseCoat(a.identity.userId);
      h = { owner: a.id, state, idleSince: now, lastDry: at };
      this.horses.set(a.id, h);
      this.room.state.horses.set(a.id, state);
    }
    this.place(h, at, [p.fx, p.fy, p.fz]);
    h.idleSince = now;
    h.lastDry = at;
    this.announce(a.id, "summon", at);
  }

  mount(a: PlayerActor, h: Horse) {
    if (a.mounted || (a.state.flags & PF.SWIMMING) !== 0) return;
    a.mounted = true;
    a.mountGraceUntil = 0;
    a.blocking = false;
    a.chargeStartedAt = 0;
    a.state.flags = (a.state.flags | PF.MOUNTED) & ~(PF.BLOCKING | PF.SCOPED);
    h.state.ridden = true;
    this.follow(a, h);
    this.announce(a.id, "mount", actorPos(a));
  }

  dismount(a: PlayerActor, reason: DismountReason) {
    const h = this.horses.get(a.id);
    this.clearMounted(a);
    if (!h) return;
    h.state.ridden = false;
    h.idleSince = Date.now();
    // The rider stays put; the horse steps to their right (or back to dry land out of deep water).
    this.place(h, reason === "water" ? h.lastDry : this.besideOf(a, 1.6), [a.state.fx, a.state.fy, a.state.fz]);
    this.announce(a.id, reason === "dismount" ? "dismount" : "thrown", actorPos(a));
    if (reason === "thrown") a.client.send("toast", { text: "Thrown from the saddle!", kind: "warn" });
    else if (reason === "water") a.client.send("toast", { text: "Your horse won't swim: you slide off", kind: "info" });
  }

  /** Remove the horse (and its rider from the saddle). */
  despawn(owner: string, reason: LeaveReason) {
    const h = this.horses.get(owner);
    const a = this.room.playerById(owner);
    const ridden = !!a?.mounted;
    if (a && ridden) this.clearMounted(a);
    if (!h) return;
    this.horses.delete(owner);
    this.room.state.horses.delete(owner);
    this.announce(owner, "leave", a && ridden ? actorPos(a) : [h.state.x, h.state.y, h.state.z]);
    if (a && !a.dead && reason === "idle") a.client.send("toast", { text: "Your horse wandered off. Whistle (H) to call it back", kind: "info" });
  }

  private clearMounted(a: PlayerActor) {
    if (a.mounted) a.mountGraceUntil = Date.now() + HORSE.dismountGraceMs;
    a.mounted = false;
    a.state.flags &= ~PF.MOUNTED;
  }

  // ---------------------------------------------------------------- room hooks

  tick(_dtMs: number, now: number) {
    for (const [owner, h] of this.horses) {
      const a = this.room.playerById(owner);
      // Gone, dead, replaced by another session, logged out (the leave can trail by a reconnection
      // window) or dropped (a lingering body walks, it doesn't ride): the horse goes with them.
      if (!a || a.dead || a.superseded || a.loggedOut || (a.state.flags & PF.LINGER) !== 0) {
        this.despawn(owner, a?.dead ? "death" : a && !a.superseded ? "left" : "replaced");
        continue;
      }
      if (!hasWhistle(a.char.hotbar, a.char.backpack)) {
        this.despawn(owner, "no whistle"); // sold, dropped or lost: no whistle, no horse
        continue;
      }
      if (a.mounted) {
        // A ridden horse's synced spot stays where it was mounted: clients draw it under the rider,
        // so streaming the rider's position twice would only cost bandwidth. Dismounts place it.
        h.state.ridden = true;
        const p = a.state;
        if (this.deep(p.x, p.y, p.z)) this.dismount(a, "water");
        else if (!a.airborne) h.lastDry = [p.x, p.y, p.z];
        h.idleSince = now;
      } else {
        h.state.ridden = false;
        if (now - h.idleSince >= HORSE.idleDespawnMs) this.despawn(owner, "idle");
      }
    }
  }

  decorateYou(_a: PlayerActor, you: YouState) {
    you.horses = true; // the client only offers H, E-to-ride and the whistle in the shop when this is set
  }

  onPlayerLeave(sessionId: string) {
    this.despawn(sessionId, "left"); // logout, travel, closed tab (a lingering body walks, it doesn't ride)
    this.lastWhistle.delete(sessionId);
    this.lastToggle.delete(sessionId);
    this.rate.delete(sessionId);
  }

  private onEvent(e: GameEvent) {
    if (e.type === "death") {
      this.despawn(e.victimId, "death");
    } else if (e.type === "damage" && e.targetKind === "player" && e.amount >= HORSE.throwFraction * e.maxHp) {
      const a = this.room.playerById(e.targetId);
      if (a?.mounted && !a.dead) this.dismount(a, "thrown");
    }
  }

  dispose() {
    this.unsubscribe();
  }

  // ---------------------------------------------------------------- helpers

  /** Put the horse on the rider's spot (at mount time; while ridden the client draws it under the rider). */
  private follow(a: PlayerActor, h: Horse) {
    const p = a.state;
    h.state.x = p.x;
    h.state.y = p.y;
    h.state.z = p.z;
    h.state.fx = p.fx;
    h.state.fy = p.fy;
    h.state.fz = p.fz;
  }

  private place(h: Horse, at: V3, facing: V3) {
    const g = this.room.snapToGround(at);
    h.state.x = g[0];
    h.state.y = g[1];
    h.state.z = g[2];
    h.state.fx = facing[0];
    h.state.fy = facing[1];
    h.state.fz = facing[2];
  }

  /** Too deep for a horse at this point (ground under the water surface by more than the wading depth). */
  private deep(x: number, y: number, z: number): boolean {
    return tooDeepToRide(this.room.terrain.groundHeightAt(x, y, z), this.room.bodyDef.waterLevel);
  }

  /** A dry spot `metres` from the player: their right, else left, behind, ahead; else where they stand. */
  private besideOf(a: PlayerActor, metres: number): V3 {
    const p = actorPos(a);
    const l = Math.hypot(p[0], p[1], p[2]);
    const up: V3 = [p[0] / l, p[1] / l, p[2] / l];
    let f: V3 = [a.state.fx, a.state.fy, a.state.fz];
    const fu = f[0] * up[0] + f[1] * up[1] + f[2] * up[2];
    f = [f[0] - fu * up[0], f[1] - fu * up[1], f[2] - fu * up[2]];
    if (Math.hypot(f[0], f[1], f[2]) < 1e-3) {
      const ref: V3 = Math.abs(up[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0]; // any tangent will do
      const k = ref[0] * up[0] + ref[1] * up[1] + ref[2] * up[2];
      f = [ref[0] - k * up[0], ref[1] - k * up[1], ref[2] - k * up[2]];
    }
    const n = Math.hypot(f[0], f[1], f[2]);
    f = [f[0] / n, f[1] / n, f[2] / n];
    const right: V3 = [f[1] * up[2] - f[2] * up[1], f[2] * up[0] - f[0] * up[2], f[0] * up[1] - f[1] * up[0]];
    for (const d of [right, [-right[0], -right[1], -right[2]], [-f[0], -f[1], -f[2]], f] as V3[]) {
      const q: V3 = [p[0] + d[0] * metres, p[1] + d[1] * metres, p[2] + d[2] * metres];
      if (!this.deep(q[0], q[1], q[2])) return q;
    }
    return p;
  }

  private announce(owner: string, event: "summon" | "mount" | "dismount" | "thrown" | "leave", at: V3) {
    this.room.broadcastNear("horse", { owner, event, x: at[0], y: at[1], z: at[2] }, at, 120, [owner]);
  }
}

/** SYSTEM_FACTORIES entry. With the flag off (env.horses, FEATURE_HORSES=0) there is no horse
 *  system, but "horse" stays registered: in production Colyseus drops a client that sends an
 *  unregistered message type, and a stale tab may still press H. */
export const createHorseSystem: SystemFactory = (room) => {
  if (env.horses) return new HorseSystem(room);
  room.onMessage("horse", actionSchema, (c) => c.send("denied", { action: "horse", reason: "off" }));
  return null;
};
