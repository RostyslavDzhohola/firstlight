// A character's persistent data (one life). The server owns it; the owner sees it via `you`.

import type { BodyId } from "../planet/bodies.ts";
import type { InvItem } from "../net/protocol.ts";
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
  missions: { id: string; progress: number; done: boolean }[];
  lifeStartedAt: number;
  deaths: number;
  dead?: boolean;
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
