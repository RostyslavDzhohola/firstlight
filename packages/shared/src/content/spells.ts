// The spellbook (docs/content.md §2.6): every character has aether and four spells on their own
// keys, apart from the weapon in hand. Numbers live here; the server (world/spells) is the authority
// and the client (game/SpellClient, ui/spellBar) reads the same table for the HUD and the effects.
// Spell ids are append-only: SPELLS[i] is spell i for good (cooldown arrays are indexed by it).

/** The spell resource. Private to its owner (sent in `you.spells`). */
export const AETHER = {
  max: 100,
  /** Refill per second. */
  regenPerS: 6,
  /** Refill pauses this long after a cast. */
  regenDelayMs: 1500,
} as const;

export type SpellId = "skipstep" | "frostbloom" | "wishfall" | "glasswing";

export interface SpellDef {
  id: SpellId;
  name: string;
  /** KeyboardEvent.code and the keycap shown for it. */
  code: string;
  keycap: string;
  /** Character level that unlocks it (level resets on rebirth, and so do the spells). */
  level: number;
  /** Aether spent per cast. */
  cost: number;
  cooldownS: number;
  /** One line for menus and the how-to-play list. */
  blurb: string;
  /** Does it deal damage (a cast tags combat, like an attack)? */
  harmful: boolean;
}

export const SPELLS: readonly SpellDef[] = [
  { id: "skipstep", name: "Skipstep", code: "KeyQ", keycap: "Q", level: 1, cost: 20, cooldownS: 6, harmful: false, blurb: "Blink up to 10 m the way you look. Walls stop it." },
  { id: "frostbloom", name: "Frostbloom", code: "KeyF", keycap: "F", level: 3, cost: 30, cooldownS: 10, harmful: true, blurb: "A ring of frost around you: damage and a 3 s slow." },
  { id: "wishfall", name: "Wishfall", code: "KeyX", keycap: "X", level: 6, cost: 45, cooldownS: 14, harmful: true, blurb: "Call a star down where you aim. It lands after a moment." },
  { id: "glasswing", name: "Glasswing Ward", code: "KeyZ", keycap: "Z", level: 9, cost: 35, cooldownS: 18, harmful: false, blurb: "A shell that soaks up damage for 4 s." },
];

export const SPELL_INDEX: ReadonlyMap<string, number> = new Map(SPELLS.map((s, i) => [s.id, i]));
export const SPELL_BY_ID: ReadonlyMap<string, SpellDef> = new Map(SPELLS.map((s) => [s.id, s]));
export const SPELL_IDS = SPELLS.map((s) => s.id) as [SpellId, ...SpellId[]];

/** Skipstep: a blink along the ground. */
export const SKIPSTEP = {
  rangeM: 10,
  /** A blink shorter than this (a wall right ahead) is refused and costs nothing. */
  minM: 1.5,
  /** The path is walked in steps this long; each must be clear. */
  stepM: 0.5,
  /** Ground may rise or drop this much per step (no blinking up or off cliffs). */
  maxStepRiseM: 1.0,
} as const;

/** Frostbloom: a nova around the caster. Friendly fire is on, as everywhere; the caster is spared. */
export const FROSTBLOOM = {
  radiusM: 5,
  /** Base damage at level 1, the same anywhere in the ring. */
  damage: 24,
  /** Move-speed cut (0.4 = −40%) and how long it lasts. Bosses take the damage but not the slow. */
  slow: 0.4,
  slowS: 3,
} as const;

/** Wishfall: a star called down on a ground point; everyone nearby sees the ring first. */
export const WISHFALL = {
  rangeM: 30,
  telegraphS: 1.2,
  radiusM: 4,
  /** Base damage at the centre at level 1; falls linearly to 25% at the edge (like every blast). The caster takes half. */
  damage: 60,
} as const;

/** Glasswing Ward: a personal shell that absorbs damage dealt by players and creatures. */
export const GLASSWING = {
  /** Shell HP per 100 of the caster's max HP. */
  absorbPer100MaxHp: 30,
  durationS: 4,
} as const;

/** Spell damage scales with level like weapons (content §1.3), never with weapon tier. */
export const spellDamage = (base: number, level: number) => base * (1 + 0.03 * (level - 1));

export const spellUnlocked = (s: SpellDef, level: number) => level >= s.level;

/** The private spell state in `you.spells`. Times are server clock (ms). */
export interface SpellsYou {
  /** Aether at time `t`. */
  aether: number;
  t: number;
  /** Refill starts (or started) here. */
  regenAt: number;
  /** When each spell is ready again, by SPELLS index (0 = ready). */
  ready: number[];
  /** A Glasswing Ward that is up: shell HP left and when it ends. */
  ward?: { hp: number; max: number; until: number };
}

/** Aether at `now` from a stored value: it refills from max(t, regenAt) at AETHER.regenPerS up to the max. */
export function aetherAt(s: { aether: number; t: number; regenAt: number }, now: number): number {
  const since = Math.max(0, now - Math.max(s.t, s.regenAt));
  return Math.min(AETHER.max, s.aether + (since / 1000) * AETHER.regenPerS);
}

/** Why a cast can't happen right now, from the state the client can see, or null. The server decides. */
export function castBlock(s: SpellDef, level: number, book: SpellsYou | null | undefined, now: number): "level" | "cooldown" | "aether" | null {
  if (!spellUnlocked(s, level)) return "level";
  if (!book) return null;
  if ((book.ready[SPELL_INDEX.get(s.id)!] ?? 0) > now) return "cooldown";
  if (aetherAt(book, now) < s.cost) return "aether";
  return null;
}
