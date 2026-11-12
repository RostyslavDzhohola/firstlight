// Per-starter stats (issue #9, D-balance-1; docs/content.md §8.5). A light class layer: each starter
// changes a handful of numbers the server already computes in one place, each within about ±12% of
// the shared base, with one strength paid for by one weakness so no starter is strictly best
// (tools/balance checks it). The server applies them (max HP in BodyRoom/combat, run budget and dodge
// cooldown in movement.ts) and the client predicts movement from the same rows (PlayerController), so
// movement validation never fights the client. Indexed like STARTERS (append-only).

import { maxHp } from "./progression.ts";
import { STARTERS } from "./weapons.ts";

/** Shared base values (content §0): every row multiplies or replaces these. */
export const BASE_MOVE: { readonly run: number; readonly sprint: number; readonly dodgeCooldown: number } = { run: 6, sprint: 9, dodgeCooldown: 1.2 };

export interface StarterStats {
  id: (typeof STARTERS)[number]["id"];
  /** Max HP multiplier on `maxHp(level)` (rounded). */
  hp: number;
  /** Run and sprint speed multiplier (swim, horse and roll distance are shared). */
  speed: number;
  /** Seconds between dodge rolls (base 1.2). The roll itself (4.5 m over 0.3 s) is shared. */
  dodgeCooldown: number;
  /**
   * Optional spell-power / aether multiplier for the spells lane's aether pool and spells
   * (lane/spells, content/spells.ts). Applied by the lead at integration; nothing reads it here.
   */
  spellPower?: number;
  /** Two or three plain words for the pick screen. */
  traits: readonly string[];
}

export const STARTER_STATS: readonly StarterStats[] = [
  // Hexwick: fragile, strong magic (the spell multiplier is the lead's to wire), a quick roll.
  { id: "hexwick", hp: 0.9, speed: 1.0, dodgeCooldown: 1.1, spellPower: 1.15, traits: ["Fragile", "Strong magic"] },
  // Brother Ash: the sturdy one; slower to run and to roll.
  { id: "ash", hp: 1.12, speed: 0.92, dodgeCooldown: 1.35, spellPower: 0.9, traits: ["Sturdy", "Slow"] },
  // Kappa: balanced body with the best dodge and a little extra pace.
  { id: "kappa", hp: 1.0, speed: 1.04, dodgeCooldown: 1.0, spellPower: 1.0, traits: ["Balanced", "Best dodge"] },
  // Unit 7: the steady reference: base HP and pace, the steady shot; pays with a slower roll, the weakest
  // crowd clear (one target per shot) and the lowest spell power but Ash's.
  { id: "unit7", hp: 1.0, speed: 1.0, dodgeCooldown: 1.25, spellPower: 0.95, traits: ["Steady aim", "Slow roll"] },
  // Hinoko: the fastest runner, the most fragile.
  { id: "ninja", hp: 0.88, speed: 1.1, dodgeCooldown: 1.1, spellPower: 1.05, traits: ["Fast", "Fragile"] },
];

/** The row for a starter index; anything unknown gets the base (1.0 everywhere). */
export function starterStats(starter: number): StarterStats {
  return STARTER_STATS[starter] ?? BASE_STATS;
}

const BASE_STATS: StarterStats = { id: "unit7", hp: 1, speed: 1, dodgeCooldown: BASE_MOVE.dodgeCooldown, traits: [] };

/** A player's max HP: the level curve (content §1.3) times the starter's HP multiplier. */
export function starterMaxHp(starter: number, level: number): number {
  return Math.round(maxHp(level) * starterStats(starter).hp);
}

/** The starter's movement: run / sprint (m/s) and the dodge cooldown (s). */
export function starterMove(starter: number): { run: number; sprint: number; dodgeCooldown: number } {
  const s = starterStats(starter);
  return { run: BASE_MOVE.run * s.speed, sprint: BASE_MOVE.sprint * s.speed, dodgeCooldown: s.dodgeCooldown };
}

/**
 * Pick-screen bars (1–5 pips) for Toughness, Speed and Dodge: 3 pips is the shared base, and the
 * starter furthest from the base on that stat gets 1 or 5, so the differences read at a glance.
 */
export function starterBars(starter: number): { toughness: number; speed: number; dodge: number } {
  const ratios = (s: StarterStats) => [s.hp, s.speed, BASE_MOVE.dodgeCooldown / s.dodgeCooldown] as const;
  const mine = ratios(starterStats(starter));
  const spread = [0, 1, 2].map((k) => Math.max(1e-9, ...STARTER_STATS.map((s) => Math.abs(ratios(s)[k]! - 1))));
  const pips = (k: number) => Math.max(1, Math.min(5, 3 + Math.round((2 * (mine[k]! - 1)) / spread[k]!)));
  return { toughness: pips(0), speed: pips(1), dodge: pips(2) };
}
