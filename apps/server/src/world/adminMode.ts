// Admin mode (D-admin-1, D-admin-3): the owner's test switches, for admin accounts only, and only in
// the admin's sandbox: a private copy of the body (its own BodyRoom, its own NPCs) that nobody else
// can join and where nothing is saved (sandbox.ts). The real character's row is never touched.
//
// Entering: in the real world the client asks `admin {cmd: "adminmode", args: {action: "sandbox"}}`;
// the room checks the admin is alive and out of a fight, saves the real character and answers
// `sandbox {home}`; the client leaves (a handoff, no linger) and joins its sandbox through /api/play
// with `sandbox: true` (admins only; refused while the real character is dead or fighting). Every
// other admin-mode command works only in the sandbox:
//   {fly?, god?, speed?: boolean}   the switches (movement.ts and combat.ts read them via adminSwitch)
//   {action: "maxlevel"}            the level cap and full HP
//   {action: "giveall"}             one of every usable item, best tier for the level, full stacks
//   {action: "hand", id, tier}      that item (any tier) into the selected hotbar slot; a cosmetic is worn
// "Back to normal" is the client leaving the sandbox and joining the real world, where it gets the
// real character from the database. Travel between bodies in a sandbox stays in it.
//
// Admin rights are asked of the account on every privileged message (stillAdmin) and every couple of
// seconds for the passive switches; losing them in a sandbox sends the admin back to the real world.
// Actions are logged with the account id's first 8 characters (no names, no positions).

import { COSMETIC_BY_ID } from "@firstlight/shared/content/items";
import { HORSE_WHISTLE } from "@firstlight/shared/content/horse";
import { HOTBAR_SLOTS } from "@firstlight/shared/content/character";
import { LEVEL_CAP, maxHp, xpAtLevel } from "@firstlight/shared/content/progression";
import { WEAPONS, WEAPON_BY_ID, type WeaponDef } from "@firstlight/shared/content/weapons";
import type { InvItem, YouState } from "@firstlight/shared/net/protocol";
import { PF } from "@firstlight/shared/net/schema";
import type { Identity } from "../auth/identity.ts";
import { closeSandbox, runIn, sandboxActive, sandboxOf } from "../sandbox.ts";
import { adminSwitch, type PlayerActor } from "./actors.ts";
import type { BodyRoom } from "./BodyRoom.ts";
import { CLOSE, hub } from "./hub.ts";
import { env } from "../env.ts";
import type { RoomSystem, SystemFactory } from "./systems.ts";
import { voiceItemHidden } from "./voice/index.ts";

/**
 * Is this account still an admin? Set at boot from the account table (main.ts); null = no answer
 * (tests, tools), and dev tokens (no `identity.account`) keep what their token says.
 */
export const adminCheck: { current: (userId: string) => boolean | null } = { current: () => null };

/** How often live admins are checked against the account for the passive switches (ms). */
export const ADMIN_RECHECK_MS = 2000;

/** Every item an admin can be handed: the catalogue less fists and what this server has switched off. */
export function adminItems(): WeaponDef[] {
  return WEAPONS.filter((w) => w.id !== "fists" && !voiceItemHidden(w.id) && !(w.id === HORSE_WHISTLE && !env.horses));
}

/** An admin identity, asked of the account now (for accounts; dev tokens keep their word). */
export function identityIsAdmin(identity: Identity): boolean {
  if (!identity.admin) return false;
  return !identity.account || adminCheck.current(identity.userId) !== false;
}

/**
 * Still an admin? Asked before every privileged message (and every couple of seconds). Losing it
 * takes the admin flag away on the spot, and in a sandbox sends the player back to the real world.
 */
export function stillAdmin(room: BodyRoom, a: PlayerActor): boolean {
  if (identityIsAdmin(a.identity)) return true;
  if (!a.identity.admin) return false;
  a.identity.admin = false;
  a.state.flags &= ~PF.ADMIN;
  a.youDirty = true;
  log(a, "admin rights gone");
  if (room.sandbox) {
    closeSandbox(a.identity.userId);
    hub.release(a.identity.userId, a);
    room.retire(a, CLOSE.SANDBOX_OVER, "admin rights revoked");
  }
  return false;
}

/**
 * The owner is joining the real world (BodyRoom.onJoin): their sandbox closes, and a sandbox body
 * still in it (another window) is removed. The next sandbox starts again from the database.
 */
export function endSandboxOf(userId: string, code: number = CLOSE.ELSEWHERE, reason = "playing in another window"): void {
  const sb = closeSandbox(userId);
  if (!sb) return;
  runIn(sb, () => {
    const e = hub.get(userId);
    if (!e) return;
    hub.release(userId, e.actor);
    e.room.retire(e.actor, code, reason);
  });
  console.log(`[admin] ${userId.slice(0, 8)} sandbox closed`);
}

/** The user's body in their open sandbox, if any (sandboxes have no social presence; moderation asks here). */
export function sandboxBodyOf(userId: string): { room: BodyRoom; actor: PlayerActor } | null {
  const sb = sandboxOf(userId);
  const e = sb ? runIn(sb, () => hub.get(userId)) : undefined;
  return e ? { room: e.room as BodyRoom, actor: e.actor } : null;
}

function log(a: PlayerActor, what: string) {
  console.log(`[admin] ${a.identity.userId.slice(0, 8)} ${what}`);
}

/** Worn cosmetics follow the inventory (the quest system owns PlayerState.cosmetics). */
function syncCosmetics(room: BodyRoom, a: PlayerActor) {
  for (const s of room.systems) if (!(s instanceof AdminModeSystem)) (s as { refreshCosmetics?: (a: PlayerActor) => void }).refreshCosmetics?.(a);
}

export class AdminModeSystem implements RoomSystem {
  private readonly room: BodyRoom;
  private nextCheck = 0;

  constructor(room: BodyRoom) {
    this.room = room;
  }

  tick(_dtMs: number, now: number) {
    const check = now >= this.nextCheck;
    if (check) this.nextCheck = now + ADMIN_RECHECK_MS;
    // A closed sandbox keeps nobody (endSandboxOf retires its bodies; this catches any left over).
    const sb = this.room.sandbox;
    if (sb && !sandboxActive(sb)) {
      for (const a of [...this.room.actors.values()]) {
        hub.release(a.identity.userId, a);
        this.room.retire(a, CLOSE.SANDBOX_OVER, "sandbox closed");
      }
      return;
    }
    for (const a of [...this.room.actors.values()]) {
      if (!a.identity.admin) continue;
      // Admin taken away (account table): the switches go with it (and the sandbox, stillAdmin).
      if (check && !stillAdmin(this.room, a)) continue;
      // God mode: health stays full (combat already refuses damage; burns and heals can't dent it).
      if (adminSwitch(a, "god") && !a.dead && a.state.hp !== a.state.maxHp) a.state.hp = a.state.maxHp;
    }
  }

  decorateYou(a: PlayerActor, you: YouState) {
    if (!a.identity.admin) return;
    const sb = a.sandbox;
    you.adminMode = sb
      ? { fly: sb.switches.fly, god: sb.switches.god, speed: sb.switches.speed, sandbox: true, home: sb.home }
      : { fly: false, god: false, speed: false, sandbox: false };
  }

  onAdmin(a: PlayerActor, cmd: string, args: Record<string, unknown>): boolean {
    if (cmd !== "adminmode") return false;
    // BodyRoom.admin asked stillAdmin just now.
    const sb = this.room.sandbox;
    if (!sb) {
      if (args.action === "sandbox") this.toSandbox(a);
      else a.client.send("denied", { action: "admin", reason: "sandbox only" }); // the real world never has test switches
      return true;
    }
    if (a.sandbox !== sb || !sandboxActive(sb)) return true;
    for (const k of ["fly", "god", "speed"] as const) {
      if (typeof args[k] !== "boolean" || sb.switches[k] === args[k]) continue;
      sb.switches[k] = args[k];
      log(a, `sandbox: ${k} ${sb.switches[k] ? "on" : "off"}`);
    }
    if (args.action === "maxlevel") this.maxLevel(a);
    else if (args.action === "giveall") this.giveAll(a);
    else if (args.action === "hand") this.hand(a, typeof args.id === "string" ? args.id : "", Number(args.tier));
    a.youDirty = true;
    return true;
  }

  /**
   * The real world's half of entering a sandbox: alive and out of a fight (a sandbox is no way out of
   * one), saved now, and leaving next is a handoff (no lingering body).
   */
  private toSandbox(a: PlayerActor) {
    const now = Date.now();
    const deny = (reason: string) => a.client.send("denied", { action: "sandbox", reason });
    if (a.dead) return deny("respawn first");
    if (now < a.combatUntil) return deny("in combat");
    a.toSandboxUntil = now + 30_000;
    this.room.saveActor(a);
    a.client.send("sandbox", { home: this.room.bodyDef.id });
    log(a, "to the sandbox");
  }

  // The test kit changes the sandbox's copy of the character only.

  private maxLevel(a: PlayerActor) {
    a.char.level = LEVEL_CAP;
    a.char.xp = xpAtLevel(LEVEL_CAP);
    a.state.level = LEVEL_CAP;
    a.state.maxHp = maxHp(LEVEL_CAP);
    a.state.hp = a.state.maxHp;
    log(a, "sandbox: max level");
  }

  /** Fill the hotbar and backpack with one of every usable item; the rest stay one click away (hand). */
  private giveAll(a: PlayerActor) {
    const c = a.char;
    const items: InvItem[] = adminItems().map((w) => ({ id: w.id, tier: bestTier(w, c.level), qty: w.stack }));
    const slots = c.hotbar.length + c.backpack.length;
    for (let i = 0; i < slots; i++) {
      const it = items[i] ?? null;
      if (i < HOTBAR_SLOTS) c.hotbar[i] = it;
      else c.backpack[i - HOTBAR_SLOTS] = it;
    }
    c.worn = {};
    this.room.equip(a, Math.min(c.selected, HOTBAR_SLOTS - 1));
    syncCosmetics(this.room, a);
    log(a, `sandbox: every item (${Math.min(items.length, slots)} of ${items.length})`);
  }

  private hand(a: PlayerActor, id: string, tierIn: number) {
    const c = a.char;
    const cosmetic = COSMETIC_BY_ID.get(id);
    const def = WEAPON_BY_ID.get(id);
    if (!cosmetic && (!def || !adminItems().includes(def))) return;
    if (cosmetic) {
      // Into a free backpack slot (or the last one), and on.
      const free = c.backpack.findIndex((x) => !x);
      c.backpack[free >= 0 ? free : c.backpack.length - 1] = { id, tier: 1, qty: 1 };
      (c.worn ??= {})[cosmetic.slot] = id;
    } else {
      const tier = Math.max(1, Math.min(def!.tiers.length, Number.isInteger(tierIn) ? tierIn : 1)) as 1 | 2 | 3;
      c.hotbar[c.selected] = { id, tier, qty: def!.stack };
      this.room.equip(a, c.selected);
    }
    syncCosmetics(this.room, a);
    log(a, `sandbox: hand ${id}${cosmetic ? "" : ` ${tierIn}`}`);
  }
}

/** The best tier of `w` that `level` may use (tiers gate by level: Max level first for tier III). */
function bestTier(w: WeaponDef, level: number): 1 | 2 | 3 {
  let t = 1;
  for (let i = 0; i < w.tiers.length; i++) if (w.tiers[i]!.level <= level) t = i + 1;
  return t as 1 | 2 | 3;
}

export const createAdminModeSystem: SystemFactory = (room) => new AdminModeSystem(room);
