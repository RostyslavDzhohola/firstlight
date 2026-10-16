// A character's persistent data (one life). The server owns it; the owner sees it via `you`.

import type { BodyId } from "../planet/bodies.ts";
import type { InvItem } from "../net/protocol.ts";
import type { CosmeticSlot } from "./items.ts";
import { maxHp } from "./progression.ts";
import { STARTERS } from "./weapons.ts";

export const HOTBAR_SLOTS = 4;
export const BACKPACK_SLOTS = 16;

export interface CharacterData {
  starter: number;
  palette: number;
  level: number;
  xp: number;
  coins: number;
  hp: number;
  body: BodyId;
  pos: [number, number, number] | null;
  hotbar: (InvItem | null)[];
  backpack: (InvItem | null)[];
  selected: number; // hotbar index
  /** Accepted missions this life. `counts` holds per-target kills for multi-target hunts. */
  missions: { id: string; progress: number; done: boolean; counts?: number[] }[];
  lifeStartedAt: number;
  deaths: number;
  dead?: boolean;
  /** Server-issued travel ticket: the body this character may join next (portal or rebirth). */
  travelTo?: BodyId;
  /** When the travel ticket stops being valid (ms epoch); a ticket without it is expired. */
  travelUntil?: number;
  /** Worn cosmetics by slot (ids of cosmetic items that are in the inventory). Cleared on death. */
  worn?: Partial<Record<CosmeticSlot, string>>;
  /** Per-life progress for life-scoped medals and once-per-life eggs (quests lane). */
  life?: LifeProgress;
}

export interface LifeProgress {
  /** Planets set foot on (Grand Tour). */
  visited: BodyId[];
  /** Pads touched this life, per planet (Cartographer). */
  padsUsed: Partial<Record<BodyId, number[]>>;
  /** Bosses this life's character was loot-eligible on (Triple Crown). */
  bosses: string[];
  /** Eggs claimed this life (items are once per life). */
  eggs: string[];
  /** Online playtime this life in ms (Old Timer). */
  playMs: number;
  /** Part of a staged scene or credited with an admin-assisted boss kill: no life-scoped medals. */
  unofficial?: boolean;
}

export function emptyLife(): LifeProgress {
  return { visited: [], padsUsed: {}, bosses: [], eggs: [], playMs: 0 };
}

/** A fresh life: level 1, starter weapon, no coins, in Portus. */
export function newCharacter(starter: number, palette: number, now = Date.now()): CharacterData {
  const s = STARTERS[starter] ?? STARTERS[0];
  return {
    starter: STARTERS.indexOf(s),
    palette: Math.max(0, Math.min(5, palette | 0)),
    level: 1,
    xp: 0,
    coins: 0,
    hp: maxHp(1),
    body: "portus",
    pos: null,
    hotbar: [{ id: s.weapon, tier: 1, qty: 1 }, null, null, null],
    backpack: Array.from({ length: BACKPACK_SLOTS }, () => null),
    selected: 0,
    missions: [],
    lifeStartedAt: now,
    deaths: 0,
  };
}
