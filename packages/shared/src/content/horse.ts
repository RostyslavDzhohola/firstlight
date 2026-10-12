// Horses (SPEC §6.14 #2, content.md §1.5 "Horse"). One rule set for the client and the server.
//
// A Horse Whistle is an ordinary inventory item (sold at the Portus Exchange; it drops in the death
// pile like everything else). With it in your bags, H outside a safe zone calls your horse to your
// side; E (or H) near it mounts and dismounts. While mounted you move at horse speed, can't dodge
// and can't attack (no weapons from the saddle); a big hit or deep water throws you off. The horse
// itself is never a target and is never saved: it leaves 30 s after you dismount, and at once when
// you die, log out, travel or lose the whistle.

import type { InvItem } from "../net/protocol.ts";

export const HORSE_WHISTLE = "horse_whistle";

export const HORSE = {
  /** Portus Exchange price of the whistle (content.md §1.5). */
  price: 1500,
  /** Riding speeds (m/s): canter and gallop (Shift). On foot: run 6, sprint 9. */
  speed: 14,
  sprint: 16,
  /** Server movement budget while mounted: refill at gallop × slack, bank up to this many metres. */
  budgetCap: 5,
  /** After a dismount the server keeps the mounted budget this long (the client is a round trip behind). */
  dismountGraceMs: 600,
  /** E / H mounts when the rider's feet are this close to the horse. */
  mountRange: 3.5,
  /** The whistle summons the horse this far to the side of the player. */
  summonDistance: 3,
  /** Whistling again within this many ms is ignored. */
  whistleCooldownMs: 2000,
  /** An unridden horse leaves after this long. */
  idleDespawnMs: 30_000,
  /** One hit of at least this fraction of max HP throws the rider. */
  throwFraction: 0.2,
  /** Water deeper than this (m) throws the rider (the horse won't swim). */
  wadeDepth: 1.0,
  /** Seat height above the horse's feet (m), from the GLB's saddle socket (tools/blender/horse). */
  seatHeight: 1.55,
  /** A seated rider's feet sit about this high above the horse's (seat minus the seated pelvis,
   *  0.73–0.87 m across the starters): the server lifts a mounted player's hit capsule by it, so
   *  shots land where the rider is drawn (headshots included) and the horse's legs don't count. */
  riderLift: 0.8,
} as const;

/** Coats: [coat, mane/tail/hooves, blanket]. A horse's coat comes from its owner (stable per account). */
export const HORSE_COATS: readonly (readonly [number, number, number])[] = [
  [0x8a4b2a, 0x2a1a12, 0xc8473a], // chestnut, red blanket
  [0x5a3a26, 0x15100d, 0x3f6fb5], // bay, blue blanket
  [0xb9b4ac, 0x55514c, 0x5e8a3c], // grey, green blanket
  [0xd9b56e, 0xf1e6cc, 0x7a4fa0], // palomino, purple blanket
  [0x2b2522, 0x0e0c0b, 0xe0a83a], // black, gold blanket
  [0xe8e2d6, 0x9a948a, 0x2f8f8a], // white, teal blanket
];

/** Stable coat index for an owner id (account id on the server). */
export function horseCoat(ownerId: string): number {
  let h = 2166136261;
  for (let i = 0; i < ownerId.length; i++) h = Math.imul(h ^ ownerId.charCodeAt(i), 16777619) >>> 0;
  return h % HORSE_COATS.length;
}

/** True when a hotbar/backpack pair holds a Horse Whistle. */
export function hasWhistle(...lists: readonly (readonly (InvItem | null | undefined)[] | undefined)[]): boolean {
  return lists.some((l) => !!l?.some((it) => it?.id === HORSE_WHISTLE));
}

/** Deep enough to throw the rider: ground below the water surface by more than the wading depth. */
export function tooDeepToRide(groundHeight: number, waterLevel: number): boolean {
  return groundHeight < waterLevel - HORSE.wadeDepth;
}

/** Why the whistle can't be used right now (null = allowed). Shared so the client can explain early. */
export type WhistleRefusal = "dead" | "no whistle" | "safe zone" | "water" | "cooldown";
export function whistleRefusal(s: { dead: boolean; hasWhistle: boolean; safe: boolean; swimming: boolean; sinceLastWhistleMs: number }): WhistleRefusal | null {
  if (s.dead) return "dead";
  if (!s.hasWhistle) return "no whistle";
  if (s.safe) return "safe zone";
  if (s.swimming) return "water";
  if (s.sinceLastWhistleMs < HORSE.whistleCooldownMs) return "cooldown";
  return null;
}

export const WHISTLE_REFUSAL_TEXT: Record<WhistleRefusal, string> = {
  dead: "",
  "no whistle": `You need a Horse Whistle (Portus Exchange, ${HORSE.price.toLocaleString("en-US")} ◎)`,
  "safe zone": "No horses in safe zones: whistle outside Portus and the pad rings",
  water: "Your horse won't come into deep water",
  cooldown: "",
};
