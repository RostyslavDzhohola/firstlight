// Admin mode (D-admin-1, D-admin-2): the owner's test switches, for admin accounts only. BodyRoom.admin
// drops the `admin` message for everyone else, the switches only count while the identity is an
// admin (actors.ts adminSwitch), and admin rights are checked again against the account on every
// command and every couple of seconds (adminCheck), so a revoked admin loses them while connected.
// One command, `admin {cmd: "adminmode", args}`:
//   {fly?, god?, speed?: boolean}   the switches (movement.ts and combat.ts read them)
//   {action: "maxlevel"}            the level cap and full HP
//   {action: "giveall"}             one of every usable item, best tier for the level, full stacks
//   {action: "hand", id, tier}      that item (any tier) into the selected hotbar slot; a cosmetic is worn
//   {action: "normal"}              the end of the test session: everything as it was
//
// Test sessions (D-admin-2): test state is never canonical. The first admin-mode command starts a
// session that keeps a copy of the character as it was (`adminTest.canonical`); from then on saves
// write that copy (BodyRoom.saveActor), never the live, boosted one, so the database, the
// leaderboard and an account merge only ever see the real character. Nothing leaves a session: no
// drops, pickups or piles, no PvP, no medals, Hall of Firsts or egg credit, and a boss fight with a
// tester in it counts as assisted. It ends with Back to normal, leaving the world (travel, closing
// the game, another window), dying (no death: back to normal at full health) or losing admin; each
// puts the live character back to the saved one. Actions are logged with the account id's first 8
// characters (no names, no positions).

import { COSMETIC_BY_ID } from "@firstlight/shared/content/items";
import { HORSE_WHISTLE } from "@firstlight/shared/content/horse";
import { HOTBAR_SLOTS } from "@firstlight/shared/content/character";
import { LEVEL_CAP, maxHp, xpAtLevel } from "@firstlight/shared/content/progression";
import { WEAPONS, WEAPON_BY_ID, type WeaponDef } from "@firstlight/shared/content/weapons";
import type { InvItem, YouState } from "@firstlight/shared/net/protocol";
import { PF } from "@firstlight/shared/net/schema";
import type { PlayerActor } from "./actors.ts";
import type { BodyRoom } from "./BodyRoom.ts";
import { env } from "../env.ts";
import type { RoomSystem, SystemFactory } from "./systems.ts";
import { voiceItemHidden } from "./voice/index.ts";

/**
 * Is this account still an admin? Set at boot from the account table (main.ts); null = no answer
 * (tests, tools), and dev tokens (no `identity.account`) keep what their token says.
 */
export const adminCheck: { current: (userId: string) => boolean | null } = { current: () => null };

/** How often live admins are checked against the account (ms). */
export const ADMIN_RECHECK_MS = 2000;

/** Every item an admin can be handed: the catalogue less fists and what this server has switched off. */
export function adminItems(): WeaponDef[] {
  return WEAPONS.filter((w) => w.id !== "fists" && !voiceItemHidden(w.id) && !(w.id === HORSE_WHISTLE && !env.horses));
}

/** Is `a` in an admin test session (its live character isn't the saved one)? */
export function inTestSession(a: PlayerActor): boolean {
  return !!a.adminTest;
}

/**
 * Still an admin, asked of the account now (for accounts; dev tokens keep their word). Losing it
 * takes the switches and the test session away on the spot.
 */
export function stillAdmin(room: BodyRoom, a: PlayerActor): boolean {
  if (!a.identity.admin) return false;
  if (!a.identity.account) return true;
  if (adminCheck.current(a.identity.userId) !== false) return true;
  a.identity.admin = false;
  a.state.flags &= ~PF.ADMIN;
  a.adminMode = { fly: false, god: false, speed: false };
  endTestSession(room, a, "admin revoked");
  a.youDirty = true;
  return false;
}

/**
 * The end of a test session: the live character becomes the saved one again (it keeps standing where
 * it is), switches off. No-op outside a session. Safe to call from any exit (normal, leave, death,
 * revocation).
 */
export function endTestSession(room: BodyRoom, a: PlayerActor, why: string) {
  a.adminMode = { fly: false, god: false, speed: false };
  const t = a.adminTest;
  if (!t) return;
  delete a.adminTest;
  const c = structuredClone(t.canonical);
  c.pos = [a.state.x, a.state.y, a.state.z];
  a.char = c;
  a.state.level = c.level;
  a.state.maxHp = maxHp(c.level);
  a.state.hp = Math.max(1, Math.min(a.state.maxHp, a.state.hp));
  room.equip(a, c.selected);
  syncCosmetics(room, a);
  a.youDirty = true;
  log(a, `test session over (${why})`);
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
    for (const a of this.room.actors.values()) {
      if (!a.identity.admin) continue;
      // Admin taken away (account table): switches and test session go at once.
      if (check && !stillAdmin(this.room, a)) continue;
      // God mode: health stays full (combat already refuses damage; burns and heals can't dent it).
      if (a.adminMode?.god && !a.dead && a.state.hp !== a.state.maxHp) a.state.hp = a.state.maxHp;
    }
  }

  decorateYou(a: PlayerActor, you: YouState) {
    if (!a.identity.admin) return;
    const m = a.adminMode;
    you.adminMode = { fly: !!m?.fly, god: !!m?.god, speed: !!m?.speed, session: !!a.adminTest };
  }

  onAdmin(a: PlayerActor, cmd: string, args: Record<string, unknown>): boolean {
    if (cmd !== "adminmode") return false;
    if (!stillAdmin(this.room, a)) return true;
    if (args.action === "normal") {
      endTestSession(this.room, a, "back to normal");
      this.room.saveActor(a);
      log(a, "back to normal");
      a.youDirty = true;
      return true;
    }
    // Any other admin-mode command starts (or continues) a test session.
    a.adminTest ??= { canonical: structuredClone(a.char) };
    const m = (a.adminMode ??= { fly: false, god: false, speed: false });
    for (const k of ["fly", "god", "speed"] as const) {
      if (typeof args[k] !== "boolean" || m[k] === args[k]) continue;
      m[k] = args[k];
      log(a, `${k} ${m[k] ? "on" : "off"}`);
    }
    if (args.action === "maxlevel") this.maxLevel(a);
    else if (args.action === "giveall") this.giveAll(a);
    else if (args.action === "hand") this.hand(a, typeof args.id === "string" ? args.id : "", Number(args.tier));
    a.youDirty = true;
    return true;
  }

  // The test kit changes the live character only: saves keep writing the canonical one.

  private maxLevel(a: PlayerActor) {
    a.char.level = LEVEL_CAP;
    a.char.xp = xpAtLevel(LEVEL_CAP);
    a.state.level = LEVEL_CAP;
    a.state.maxHp = maxHp(LEVEL_CAP);
    a.state.hp = a.state.maxHp;
    log(a, "max level");
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
    log(a, `every item (${Math.min(items.length, slots)} of ${items.length})`);
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
    log(a, `hand ${id}${cosmetic ? "" : ` ${tierIn}`}`);
  }
}

/** The best tier of `w` that `level` may use (tiers gate by level: Max level first for tier III). */
function bestTier(w: WeaponDef, level: number): 1 | 2 | 3 {
  let t = 1;
  for (let i = 0; i < w.tiers.length; i++) if (w.tiers[i]!.level <= level) t = i + 1;
  return t as 1 | 2 | 3;
}

export const createAdminModeSystem: SystemFactory = (room) => new AdminModeSystem(room);
