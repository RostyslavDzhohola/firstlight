// Admin mode (D-admin-1): the owner's test switches, for admin accounts only. BodyRoom.admin drops
// the `admin` message for everyone else before a system sees it, and the switches only count while
// the identity is an admin (actors.ts adminSwitch), so nobody else can fly, outrun the movement
// check or shrug off damage. One command, `admin {cmd: "adminmode", args}`:
//   {fly?, god?, speed?: boolean}   the switches (movement.ts and combat.ts read them)
//   {action: "maxlevel"}            the level cap and full HP
//   {action: "giveall"}             one of every usable item, best tier for the level, full stacks
//   {action: "hand", id, tier}      that item (any tier) into the selected hotbar slot; a cosmetic is worn
//   {action: "normal"}              switches off, and the character as it was before max level / items
// The first change to level or items saves the character as it was (CharacterData.adminBackup,
// persisted), so "Back to normal" survives a reconnect. Every action is logged with the account id's
// first 8 characters (no names, no positions).

import { COSMETIC_BY_ID } from "@firstlight/shared/content/items";
import { HORSE_WHISTLE } from "@firstlight/shared/content/horse";
import { HOTBAR_SLOTS } from "@firstlight/shared/content/character";
import { LEVEL_CAP, maxHp, xpAtLevel } from "@firstlight/shared/content/progression";
import { WEAPONS, WEAPON_BY_ID, type WeaponDef } from "@firstlight/shared/content/weapons";
import type { InvItem, YouState } from "@firstlight/shared/net/protocol";
import type { PlayerActor } from "./actors.ts";
import type { BodyRoom } from "./BodyRoom.ts";
import { env } from "../env.ts";
import type { RoomSystem, SystemFactory } from "./systems.ts";
import { voiceItemHidden } from "./voice/index.ts";

/** Every item an admin can be handed: the catalogue less fists and what this server has switched off. */
export function adminItems(): WeaponDef[] {
  return WEAPONS.filter((w) => w.id !== "fists" && !voiceItemHidden(w.id) && !(w.id === HORSE_WHISTLE && !env.horses));
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

export class AdminModeSystem implements RoomSystem {
  private readonly room: BodyRoom;

  constructor(room: BodyRoom) {
    this.room = room;
  }

  tick() {
    // God mode: health stays full (combat already refuses damage; burns and heals can't dent it).
    for (const a of this.room.actors.values()) {
      if (!a.adminMode?.god || !a.identity.admin || a.dead) continue;
      if (a.state.hp !== a.state.maxHp) a.state.hp = a.state.maxHp;
    }
  }

  decorateYou(a: PlayerActor, you: YouState) {
    if (!a.identity.admin) return;
    const m = a.adminMode;
    you.adminMode = { fly: !!m?.fly, god: !!m?.god, speed: !!m?.speed, backup: !!a.char.adminBackup };
  }

  onAdmin(a: PlayerActor, cmd: string, args: Record<string, unknown>): boolean {
    if (cmd !== "adminmode" || !a.identity.admin) return false;
    const m = (a.adminMode ??= { fly: false, god: false, speed: false });
    for (const k of ["fly", "god", "speed"] as const) {
      if (typeof args[k] !== "boolean" || m[k] === args[k]) continue;
      m[k] = args[k];
      this.log(a, `${k} ${m[k] ? "on" : "off"}`);
    }
    switch (args.action) {
      case "maxlevel":
        this.maxLevel(a);
        break;
      case "giveall":
        this.giveAll(a);
        break;
      case "hand":
        this.hand(a, typeof args.id === "string" ? args.id : "", Number(args.tier));
        break;
      case "normal":
        this.normal(a);
        break;
    }
    a.youDirty = true;
    return true;
  }

  private log(a: PlayerActor, what: string) {
    console.log(`[admin] ${a.identity.userId.slice(0, 8)} ${what}`);
  }

  /** The character as it is now, once, before admin mode changes its level or items. */
  private backup(a: PlayerActor) {
    const c = a.char;
    c.adminBackup ??= { level: c.level, xp: c.xp, hotbar: clone(c.hotbar), backpack: clone(c.backpack), selected: c.selected, ...(c.worn ? { worn: clone(c.worn) } : {}) };
  }

  private setLevel(a: PlayerActor, level: number, xp: number) {
    a.char.level = level;
    a.char.xp = xp;
    a.state.level = level;
    a.state.maxHp = maxHp(level);
    a.state.hp = a.state.maxHp;
  }

  private maxLevel(a: PlayerActor) {
    this.backup(a);
    this.setLevel(a, LEVEL_CAP, xpAtLevel(LEVEL_CAP));
    this.room.saveActor(a);
    this.log(a, "max level");
  }

  /** Fill the hotbar and backpack with one of every usable item; the rest stay one click away (hand). */
  private giveAll(a: PlayerActor) {
    this.backup(a);
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
    this.syncCosmetics(a);
    this.room.saveActor(a);
    this.log(a, `every item (${Math.min(items.length, slots)} of ${items.length})`);
  }

  private hand(a: PlayerActor, id: string, tierIn: number) {
    const c = a.char;
    const cosmetic = COSMETIC_BY_ID.get(id);
    const def = WEAPON_BY_ID.get(id);
    if (!cosmetic && (!def || !adminItems().includes(def))) return;
    this.backup(a);
    if (cosmetic) {
      // Into a free backpack slot (or the last one), and on.
      const free = c.backpack.findIndex((x) => !x);
      c.backpack[free >= 0 ? free : c.backpack.length - 1] = { id, tier: 1, qty: 1 };
      (c.worn ??= {})[cosmetic.slot] = id;
      this.syncCosmetics(a);
    } else {
      const tier = (Math.max(1, Math.min(def!.tiers.length, Number.isInteger(tierIn) ? tierIn : 1)) as 1 | 2 | 3);
      c.hotbar[c.selected] = { id, tier, qty: def!.stack };
      this.room.equip(a, c.selected);
      this.syncCosmetics(a);
    }
    this.room.saveActor(a);
    this.log(a, `hand ${id}${cosmetic ? "" : ` ${tierIn}`}`);
  }

  private normal(a: PlayerActor) {
    a.adminMode = { fly: false, god: false, speed: false };
    const b = a.char.adminBackup;
    if (b) {
      this.setLevel(a, b.level, b.xp);
      a.char.hotbar = clone(b.hotbar);
      a.char.backpack = clone(b.backpack);
      a.char.worn = b.worn ? clone(b.worn) : {};
      delete a.char.adminBackup;
      this.room.equip(a, b.selected);
      this.syncCosmetics(a);
    }
    this.room.saveActor(a);
    this.log(a, "back to normal");
  }

  /** Worn cosmetics follow the inventory (the quest system owns PlayerState.cosmetics). */
  private syncCosmetics(a: PlayerActor) {
    for (const s of this.room.systems) if (s !== this) (s as { refreshCosmetics?: (a: PlayerActor) => void }).refreshCosmetics?.(a);
  }
}

/** The best tier of `w` that `level` may use (tiers gate by level: Max level first for tier III). */
function bestTier(w: WeaponDef, level: number): 1 | 2 | 3 {
  let t = 1;
  for (let i = 0; i < w.tiers.length; i++) if (w.tiers[i]!.level <= level) t = i + 1;
  return t as 1 | 2 | 3;
}

export const createAdminModeSystem: SystemFactory = (room) => new AdminModeSystem(room);
