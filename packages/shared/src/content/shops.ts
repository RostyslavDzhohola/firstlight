// Shops in every safe zone (round 2): the Portus Exchange and a trader inside each planet's arrival
// outpost. The server lets a player buy and sell within a spot's radius on that body; the keepers
// (content/world.ts) stand at these positions, so moving a spot moves its keeper too.
//
// `pos` is a world position on the ground (metres, the body's frame). The planet spots are the
// keepers' places behind the counters of the outposts' shop stalls (D-b2-3: padOutposts.ts
// `shop.at`, on the ground; shops.test.ts holds them together). Append only: never reorder.
//
// Buying follows one rule on both sides (buyBlock): you can afford it and you're the level to use it.

import type { BodyId } from "../planet/bodies.ts";

export interface ShopSpot {
  /** The keeper's world-object id (content/world.ts). */
  id: string;
  body: BodyId;
  pos: [number, number, number];
  /** Metres along the ground from `pos` within which the till works. */
  radius: number;
  /** The shop's name and its keeper, shown in the panel and the prompt. */
  name: string;
  keeper: string;
}

export const SHOP_SPOTS: readonly ShopSpot[] = [
  { id: "juno_vale", body: "portus", pos: [0, 149.613, 10.9913], radius: 6, name: "Portus Exchange", keeper: "Juno Vale" },
  { id: "shop_arcadia", body: "arcadia", pos: [271.0583, 420.186, -17.8155], radius: 6, name: "Dawnpad Trading Post", keeper: "Pell Hayward" },
  { id: "shop_hollowmere", body: "hollowmere", pos: [395.6749, 638.2762, -19.3793], radius: 6, name: "Lanternfall Stall", keeper: "Nell Ashgrove" },
  { id: "shop_meridian", body: "meridian", pos: [368.7293, 930.8119, 6.6748], radius: 6, name: "Waystation Supply", keeper: "Clerk Ostrow" },
];

export const SHOP_SPOT_BY_ID: ReadonlyMap<string, ShopSpot> = new Map(SHOP_SPOTS.map((s) => [s.id, s]));

/** Height difference (metres) a player may have from a spot's ground (steps, stall floors, slopes). */
export const SHOP_VERTICAL = 4;

/** The shop whose till a player standing at `p` (feet) on `body` can use, if any. */
export function shopSpotAt(body: BodyId, p: readonly number[]): ShopSpot | null {
  const lp = Math.hypot(p[0]!, p[1]!, p[2]!);
  for (const s of SHOP_SPOTS) {
    if (s.body !== body) continue;
    const ls = Math.hypot(s.pos[0], s.pos[1], s.pos[2]);
    const k = (s.pos[0] * p[0]! + s.pos[1] * p[1]! + s.pos[2] * p[2]!) / (ls * lp);
    const along = Math.acos(Math.max(-1, Math.min(1, k))) * ls;
    if (along <= s.radius && Math.abs(lp - ls) <= SHOP_VERTICAL) return s;
  }
  return null;
}

/** What a buyer brings to the till. */
export interface Buyer {
  level: number;
  coins: number;
}

/** Why a priced item can't be bought: below its level, or not enough coins. */
export type BuyBlock = { reason: "level"; level: number } | { reason: "coins"; need: number; short: number };

/**
 * Locked items are shown but can't be bought (owner, round 2): you must be the level to use it and
 * able to pay for `qty`. Null when it's yours to buy.
 */
export function buyBlock(item: { level: number; price: number }, who: Buyer, qty = 1): BuyBlock | null {
  if (item.level > who.level) return { reason: "level", level: item.level };
  const need = item.price * qty;
  if (who.coins < need) return { reason: "coins", need, short: need - who.coins };
  return null;
}
