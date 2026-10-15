// Enemies, wildlife and bosses (docs/content.md §0, §3, §4). Pure data plus small helpers shared by
// the server AI (authority) and the client renderer. NpcState.kind is the index into NPC_DEFS.
//
// Content conflicts resolved here (floors in §0 win over per-enemy numbers in §3):
// - Hopbit hop, Woolback buck and Collector taser list 0.4 s telegraphs; the light floor is 0.5 s.
// - Dunebreaker tail swipe lists 0.8 s for a 23% hit; hits ≥ 20% of on-level HP use the heavy floor (0.9 s).
// - Leash is 40 m (SPEC §6.4 and the lane brief); content §3.1 says 45 m. One constant: NPC_RULES.leash.
// - Meridian Oversight follows content §3.4 (slate-grey matte hardsuits, amber slit visors, hexagonal
//   glyph), kept clearly apart from Unit 7's ivory plates (F12 review). It's a client look only.

import type { BodyId, FeatureAnchor } from "../planet/bodies.ts";
import { enemyDamageMult, enemyHpMult, killCoins, maxHp, type EnemyTier } from "./progression.ts";

export type PlanetId = Exclude<BodyId, "portus">;
export type NpcFamily = "brightbit" | "hollow" | "oversight" | "woolback" | "wolf" | "beast" | "boss" | "egg";
export type Locomotion = "ground" | "hover" | "swim" | "wade";
/** hostile: attacks on sight · neutral: fights back when hit · critter: flees when hit · passive: never attacks. */
export type Temper = "hostile" | "neutral" | "critter" | "passive";
export type AttackWeight = "light" | "heavy" | "lethal";
export type AttackShape =
  | "arc" // wedge in front (or behind with `back`) of the NPC: radius + angle
  | "ring" // around the NPC (or a foot): radius, optional inner radius
  | "circle" // ground circles at locked target points: radius × count
  | "line" // rectangle from the NPC along the locked direction: length × width
  | "charge" // the NPC dashes along a line, hitting what it touches
  | "leap" // the NPC jumps to a locked point and hits around the landing
  | "bolt" // visible projectile(s) toward the target
  | "burst" // hitscan rounds after a lock-on laser
  | "zap" // short-range instant hit (taser)
  | "split" // boss co-op circle: true damage split among players inside, lethal when empty
  | "band" // Tide Surge: the shore band around the lake
  | "beam" // rotating beam sweep
  | "pull" // whirlpool: pulls and damages over time
  | "tag" // Collector scan cone: target takes more damage from Oversight units
  | "raise" // summon helpers (Cantor, Court Summons, Collector drones)
  | "field"; // Cease-and-Desist dome: status effect, no damage

export interface StatusEffect {
  kind: "chill" | "slow" | "nosprint" | "tag";
  seconds: number;
  /** chill/slow: move-speed reduction (0.2 = −20%); tag: extra damage taken (0.25 = +25%). */
  amount: number;
}

export interface AttackDef {
  id: string;
  name: string;
  shape: AttackShape;
  weight: AttackWeight;
  /** Damage at level 1 (scaled by enemyDamageMult), or exact damage when `fixed` (bosses, Woolback buck). */
  damage: number;
  fixed?: boolean;
  /** Seconds from the visible telegraph start to the damage (floors in TELEGRAPH_FLOORS). */
  telegraph: number;
  /** Seconds after resolving before the NPC acts again. */
  recovery: number;
  /** Seconds between uses. */
  cooldown: number;
  /** Start when the target is within [minRange, range] metres. */
  range: number;
  minRange?: number;
  radius?: number;
  inner?: number;
  width?: number;
  length?: number;
  angle?: number;
  count?: number;
  speed?: number;
  gravity?: number;
  interval?: number;
  ticks?: number;
  knockback?: number;
  /** Self-stun after a charge (seconds; Pixel Lancer only when it hits an obstacle). */
  stun?: number;
  stunOnObstacle?: boolean;
  effect?: StatusEffect;
  /** Circles follow their targets during the telegraph and lock `lockLead` s before impact. */
  track?: boolean;
  lockLead?: number;
  /** Arc behind the NPC (tail swipe). */
  back?: boolean;
  /** Ring centred on a foot offset sideways by this many metres. */
  footOffset?: number;
  /** Boss phases (1-based) where the attack is in the rotation. */
  phases?: number[];
  /** Split circles: ignore the AI caps, block, bubble and i-frames. */
  trueDamage?: boolean;
  /** Summons: def id and level. */
  summon?: string;
  summonLevel?: number;
  /** Scheduled on a timer (boss mechanics), not chosen by the attack rotation. */
  timed?: boolean;
  /** Timer per boss phase in seconds (index 0 = P1); 0 = off in that phase. */
  every?: number[];
  /** Double sweep (Hollow King P3): a second wedge this many seconds after the first. */
  repeatAfter?: number;
  repeatPhases?: number[];
}

export type DropEntry =
  | { kind: "item"; id: string; chance: number; qty?: number; tier?: 1 | 2 | 3 }
  | { kind: "weapon"; chance: number; tier?: 1 | 2 | 3 }
  | { kind: "tonic"; chance: number }
  | { kind: "grenade"; chance: number };

export interface NpcDef {
  id: string;
  name: string;
  planet: PlanetId | "any";
  family: NpcFamily;
  tier: EnemyTier;
  temper: Temper;
  /** Typical level range; spawn areas pick inside their own range. Per planet for wildlife. */
  levels: [number, number];
  levelsByPlanet?: Partial<Record<PlanetId, [number, number]>>;
  /** HP at level 1 (HP1, scaled by enemyHpMult). Bosses: HP for 2 players (HP₂), not scaled. */
  hp: number;
  hpFixed?: boolean;
  /** Enforcer riot shield HP at level 1 (frontal damage only). */
  shield?: number;
  /** Fraction of damage taken outside weak windows (bosses). */
  armour?: number;
  /** Walk / chase speeds (m/s). */
  speed: number;
  runSpeed: number;
  locomotion: Locomotion;
  hover?: number;
  /** Hitbox: vertical capsule. */
  radius: number;
  height: number;
  /** Perception: sight distance, cone (degrees), hearing radius. */
  sight: number;
  fov: number;
  hearing: number;
  /** Keep this distance band from the target (ranged and support units). */
  preferRange?: [number, number];
  /** Back off (relocate) when a player gets this close. */
  relocateWithin?: number;
  /** Typical group size. */
  pack: [number, number];
  attacks: AttackDef[];
  drops: DropEntry[];
  /** Multiplier on the tier's coin formula ("coins (half)"). */
  coinMult?: number;
  /** Flat coins instead of the formula (beasts list exact purses). */
  coinsFixed?: number;
  respawn: "pack" | "camp" | "beast" | "boss" | "egg";
  /** Client model id (apps/client/src/world/npcs/models.ts). */
  model: string;
  /** Movement snaps to 90° turns (Brightbits). */
  gridMove?: boolean;
  /** Pack-hunt howl before engaging (seconds). */
  howl?: number;
  /** Flee below this HP fraction when fewer than 2 pack mates remain. */
  fleeBelow?: number;
  /** Flee speed for critters. */
  fleeSpeed?: number;
  /** Chance to fight back once when struck (Woolback buck). */
  retaliateChance?: number;
  /** Immune to knockback. */
  steadfast?: boolean;
  /** Oversight buff aura: +damage to Oversight units within radius. */
  aura?: { radius: number; damage: number };
  /** Raise channel: interval, channel seconds, max alive. */
  raise?: { every: number; channel: number; max: number; def: string };
  /** Scatter for this many seconds from any explosion (Marsh Wisp). */
  scatter?: number;
  /** Body segments that shorten as it loses HP (Linewyrm, visual). */
  segments?: number;
  /** Radio bark on notice (Oversight). */
  bark?: string;
}

// ------------------------------------------------------------------------------------------ rules

/** Telegraph floors (content §0): light ≥ 0.5 s; heavy ≥ 0.9 s; boss lethal-tier ≥ 1.2 s; recovery after heavy ≥ 0.8 s. */
export const TELEGRAPH_FLOORS: Record<AttackWeight, number> = { light: 0.5, heavy: 0.9, lethal: 1.2 };
export const HEAVY_RECOVERY_FLOOR = 0.8;
/** Hits at or above this share of an on-level player's HP must use the heavy floor. */
export const HEAVY_SHARE = 0.2;
/** Boss hits at or above this share are lethal-tier. */
export const LETHAL_SHARE = 0.4;

/** AI hit caps (content §0, enforced in code): single hit and any sequence within a window. */
export const AI_CAPS = {
  regular: 0.35,
  boss: 0.6,
  sequence: 0.8,
  sequenceMs: 1500,
} as const;

/** Largest damage an AI hit may deal to a target with `targetMaxHp`. */
export function aiHitCap(tier: EnemyTier, targetMaxHp: number): number {
  return (tier === "boss" ? AI_CAPS.boss : AI_CAPS.regular) * targetMaxHp;
}

export const NPC_RULES = {
  /** Leash radius from the anchor (m). */
  leash: 40,
  /** EVADE when the target has been out of sight this long (s). */
  lostSightSeconds: 20,
  evadeSpeedMult: 1.5,
  /** Pack mates within this distance share the target. */
  shareTargetRadius: 15,
  /** Gunfire noise radius. */
  noiseRadius: 30,
  /** Attack tokens per player: melee / ranged (Meridian has one more ranged). */
  meleeTokens: 2,
  rangedTokens: 2,
  rangedTokensMeridian: 3,
  tokenHoldSeconds: 1.5,
  tokenStaggerSeconds: 0.4,
  /** Spawn materialise (no damage either way). */
  spawnSeconds: 1,
  /** Respawn delays (s): pack after clear (×2 while a player is within 60 m), camp, beast, boss. */
  respawnPack: 120,
  respawnCamp: 300,
  respawnBeast: 900,
  respawnBoss: 600,
  respawnSlowRadius: 60,
  /** Repeat-kill XP decay: same spawn point within 5 min: −10% per kill, floor 30%. */
  repeatWindowSeconds: 300,
  repeatStep: 0.1,
  repeatFloor: 0.3,
  /** XP goes to everyone who dealt ≥ 20% of max HP, or the killing blow. */
  xpShare: 0.2,
  /** Pads' safe rings: enemies keep this margin outside them (m). */
  safeMargin: 3,
} as const;

/** NpcState.anim values for NPCs (separate from the player ANIM table). */
export const NPC_ANIM = {
  IDLE: 0,
  WALK: 1,
  RUN: 2,
  WINDUP: 3, // telegraph; NpcState.phase = attack index + 1 for non-bosses
  STRIKE: 4,
  RECOVER: 5,
  HIT: 6,
  DEAD: 7,
  SPAWN: 8,
  FLEE: 9,
  EVADE: 10,
  STUN: 11,
  HOWL: 12,
  CHANNEL: 13,
  KNEEL: 14, // boss weak window (Moored / Asset Freeze / rib cage open)
  DASH: 15,
  GRAZE: 16,
} as const;

/** NpcState.flags bits. */
export const NF = {
  TELEGRAPH: 1,
  EVADING: 2,
  INVULN: 4,
  DEAD: 8,
  SPAWNING: 16,
  WEAK_OPEN: 32,
  ENGAGED: 64,
  SHIELD: 128,
  SHIELD_CRACKED: 256,
  BUFFED: 512,
  STUNNED: 1024,
  FLEEING: 2048,
  AGGRO: 4096,
  GOLDEN: 8192,
  ELITE: 16384,
} as const;

// ------------------------------------------------------------------------------------------ helpers for defs

type A = Omit<AttackDef, "recovery" | "cooldown"> & { recovery?: number; cooldown?: number };
const atk = (a: A): AttackDef => ({ recovery: a.weight === "light" ? 0.4 : HEAVY_RECOVERY_FLOOR, cooldown: 2, ...a });

const coinsOnly: DropEntry[] = [];
const tonic = (chance: number): DropEntry => ({ kind: "tonic", chance });
const weaponDrop = (chance: number, tier?: 1 | 2 | 3): DropEntry => (tier ? { kind: "weapon", chance, tier } : { kind: "weapon", chance });
const grenade = (chance: number): DropEntry => ({ kind: "grenade", chance });
const item = (id: string, chance: number, qty = 1): DropEntry => ({ kind: "item", id, chance, qty });

const PERCEPTION = { sight: 25, fov: 90, hearing: 12 } as const;

// ------------------------------------------------------------------------------------------ the roster

export const NPC_DEFS: readonly NpcDef[] = [
  // ---------------------------------------------------------------- Arcadia: the Brightbits
  {
    id: "hopbit", name: "Hopbit", planet: "arcadia", family: "brightbit", tier: "regular", temper: "hostile",
    levels: [1, 4], hp: 22, speed: 2.5, runSpeed: 4, locomotion: "ground", radius: 0.45, height: 0.9, ...PERCEPTION,
    pack: [4, 6], gridMove: true, respawn: "pack", model: "hopbit",
    attacks: [atk({ id: "hop", name: "Hop", shape: "leap", weight: "light", damage: 6, telegraph: 0.5, radius: 1.3, range: 3, cooldown: 1.2, recovery: 0.5 })],
    drops: [tonic(1 / 10)],
  },
  {
    id: "sparkfly", name: "Sparkfly", planet: "arcadia", family: "brightbit", tier: "regular", temper: "hostile",
    levels: [2, 6], hp: 30, speed: 3, runSpeed: 5, locomotion: "hover", hover: 2.6, radius: 0.5, height: 0.9, ...PERCEPTION,
    preferRange: [8, 12], pack: [2, 3], gridMove: true, respawn: "pack", model: "sparkfly",
    attacks: [atk({ id: "pellet", name: "Pellet", shape: "bolt", weight: "light", damage: 8, telegraph: 0.5, speed: 12, radius: 0.5, range: 16, cooldown: 2.0 })],
    drops: [tonic(1 / 10)],
  },
  {
    id: "linewyrm", name: "Linewyrm", planet: "arcadia", family: "brightbit", tier: "regular", temper: "hostile",
    levels: [3, 7], hp: 90, speed: 2.5, runSpeed: 4, locomotion: "ground", radius: 0.6, height: 0.9, ...PERCEPTION,
    pack: [1, 2], gridMove: true, segments: 5, respawn: "pack", model: "linewyrm",
    attacks: [atk({ id: "dash", name: "Head Dash", shape: "charge", weight: "light", damage: 10.5, telegraph: 0.5, speed: 8, length: 24, width: 1.4, range: 14, minRange: 2, cooldown: 5, recovery: 0.6 })],
    drops: [grenade(1 / 25)],
  },
  {
    id: "bomblet", name: "Bomblet", planet: "arcadia", family: "brightbit", tier: "regular", temper: "hostile",
    levels: [3, 7], hp: 35, speed: 2.5, runSpeed: 4, locomotion: "ground", radius: 0.55, height: 1.0, ...PERCEPTION,
    preferRange: [15, 20], relocateWithin: 10, pack: [2, 2], gridMove: true, respawn: "pack", model: "bomblet",
    attacks: [atk({ id: "lob", name: "Lobbed Bomb", shape: "circle", weight: "light", damage: 14, telegraph: 1.2, radius: 3, count: 1, range: 24, minRange: 5, cooldown: 3.0 })],
    drops: [grenade(1 / 25)],
  },
  {
    id: "pixel_lancer", name: "Pixel Lancer", planet: "arcadia", family: "brightbit", tier: "heavy", temper: "hostile",
    levels: [4, 7], hp: 75, speed: 2.5, runSpeed: 4.5, locomotion: "ground", radius: 0.6, height: 2.0, ...PERCEPTION,
    pack: [1, 1], gridMove: true, respawn: "pack", model: "pixel_lancer",
    attacks: [
      atk({ id: "charge", name: "Charge", shape: "charge", weight: "heavy", damage: 24, telegraph: 1.0, speed: 12, length: 18, width: 1.6, stun: 1.5, stunOnObstacle: true, range: 18, minRange: 6, cooldown: 6 }),
      atk({ id: "poke", name: "Poke", shape: "arc", weight: "light", damage: 10, telegraph: 0.5, radius: 2.8, angle: 50, range: 2.6, cooldown: 1.5 }),
    ],
    drops: [weaponDrop(1 / 15)],
  },
  {
    id: "cabinet_golem", name: "Cabinet Golem", planet: "arcadia", family: "brightbit", tier: "elite", temper: "hostile",
    levels: [6, 7], hp: 260, speed: 1.8, runSpeed: 2.8, locomotion: "ground", radius: 1.1, height: 3.2, ...PERCEPTION,
    pack: [1, 1], steadfast: true, respawn: "camp", model: "cabinet_golem",
    attacks: [
      atk({ id: "slam", name: "Slam", shape: "ring", weight: "heavy", damage: 28, telegraph: 0.9, radius: 4, range: 3.6, cooldown: 5, recovery: 1.0 }),
      atk({ id: "coins", name: "Coin-Cube Toss", shape: "bolt", weight: "light", damage: 12, telegraph: 0.6, count: 3, speed: 18, gravity: 9.8, radius: 0.6, range: 18, minRange: 4, cooldown: 4 }),
    ],
    drops: [weaponDrop(1 / 4)],
  },
  {
    id: "golden_hopbit", name: "Golden Hopbit", planet: "arcadia", family: "egg", tier: "critter", temper: "passive",
    levels: [1, 1], hp: 22, speed: 2.5, runSpeed: 4.5, fleeSpeed: 4.5, locomotion: "ground", radius: 0.45, height: 0.9, ...PERCEPTION,
    pack: [1, 1], gridMove: true, respawn: "egg", model: "golden_hopbit", attacks: [], drops: coinsOnly, coinsFixed: 25,
  },

  // ---------------------------------------------------------------- Hollowmere: the Hollow Court
  {
    id: "bonewalker", name: "Bonewalker", planet: "hollowmere", family: "hollow", tier: "regular", temper: "hostile",
    levels: [6, 11], hp: 55, speed: 1.6, runSpeed: 2.5, locomotion: "ground", radius: 0.45, height: 1.9, ...PERCEPTION,
    pack: [3, 4], respawn: "pack", model: "bonewalker",
    attacks: [
      atk({ id: "overhead", name: "Overhead", shape: "arc", weight: "heavy", damage: 20, telegraph: 0.9, radius: 3.0, angle: 50, range: 2.6, cooldown: 5 }),
      atk({ id: "slash", name: "Slash", shape: "arc", weight: "light", damage: 8, telegraph: 0.6, radius: 2.5, angle: 120, range: 2.3, cooldown: 1.6 }),
    ],
    drops: [tonic(1 / 12)],
  },
  {
    id: "bone_archer", name: "Bone Archer", planet: "hollowmere", family: "hollow", tier: "regular", temper: "hostile",
    levels: [6, 12], hp: 38, speed: 2, runSpeed: 3.5, locomotion: "ground", radius: 0.45, height: 1.9, sight: 30, fov: 90, hearing: 12,
    preferRange: [20, 25], relocateWithin: 8, pack: [2, 2], respawn: "pack", model: "bone_archer",
    attacks: [atk({ id: "arrow", name: "Arrow", shape: "bolt", weight: "light", damage: 11, telegraph: 0.8, speed: 30, gravity: 9.8, radius: 0.5, range: 32, minRange: 4, cooldown: 2.5 })],
    drops: [weaponDrop(1 / 40)],
  },
  {
    id: "gnawer", name: "Gnawer", planet: "hollowmere", family: "hollow", tier: "regular", temper: "hostile",
    levels: [7, 12], hp: 38, speed: 3, runSpeed: 6, locomotion: "ground", radius: 0.5, height: 1.2, ...PERCEPTION,
    pack: [2, 4], respawn: "pack", model: "gnawer",
    attacks: [
      atk({ id: "leap", name: "Leap", shape: "leap", weight: "light", damage: 18, telegraph: 0.7, radius: 2, range: 6.5, minRange: 3.5, cooldown: 5, recovery: 0.6 }),
      atk({ id: "bite", name: "Bite", shape: "arc", weight: "light", damage: 9, telegraph: 0.5, radius: 2.2, angle: 90, range: 2, cooldown: 1.2 }),
    ],
    drops: coinsOnly,
  },
  {
    id: "cantor", name: "Cantor", planet: "hollowmere", family: "hollow", tier: "regular", temper: "hostile",
    levels: [8, 13], hp: 50, speed: 1.6, runSpeed: 2.6, locomotion: "ground", radius: 0.5, height: 2.0, ...PERCEPTION,
    preferRange: [8, 12], relocateWithin: 6, pack: [1, 1], respawn: "pack", model: "cantor",
    raise: { every: 8, channel: 1.5, max: 3, def: "bonewalker" },
    attacks: [atk({ id: "grave_bolt", name: "Grave Bolt", shape: "bolt", weight: "light", damage: 12, telegraph: 0.8, speed: 10, radius: 0.6, range: 22, cooldown: 3 })],
    drops: [weaponDrop(1 / 40)],
  },
  {
    id: "marsh_wisp", name: "Marsh Wisp", planet: "hollowmere", family: "hollow", tier: "regular", temper: "hostile",
    levels: [6, 13], hp: 15, speed: 2, runSpeed: 3, locomotion: "hover", hover: 1.4, radius: 0.45, height: 0.9, ...PERCEPTION,
    pack: [4, 6], scatter: 5, coinMult: 0.5, respawn: "pack", model: "marsh_wisp",
    attacks: [atk({ id: "touch", name: "Chilling Touch", shape: "charge", weight: "light", damage: 6, telegraph: 0.5, speed: 10, length: 5, width: 1.2, range: 5, cooldown: 2.5, effect: { kind: "chill", seconds: 2, amount: 0.2 } })],
    drops: coinsOnly,
  },
  {
    id: "crypt_sentinel", name: "Crypt Sentinel", planet: "hollowmere", family: "hollow", tier: "elite", temper: "hostile",
    levels: [10, 13], hp: 170, speed: 1.4, runSpeed: 2, locomotion: "ground", radius: 0.9, height: 2.8, ...PERCEPTION,
    pack: [1, 1], steadfast: true, respawn: "camp", model: "crypt_sentinel",
    attacks: [
      atk({ id: "mace", name: "Mace Slam", shape: "ring", weight: "heavy", damage: 26, telegraph: 1.2, radius: 4, range: 3.6, cooldown: 6, recovery: 1.0 }),
      atk({ id: "bash", name: "Shield Bash", shape: "arc", weight: "light", damage: 16, telegraph: 0.7, radius: 2.6, angle: 70, range: 2.3, cooldown: 3 }),
    ],
    drops: [weaponDrop(1 / 4)],
  },

  // ---------------------------------------------------------------- Meridian: Meridian Oversight
  {
    id: "associate", name: "Associate", planet: "meridian", family: "oversight", tier: "regular", temper: "hostile",
    levels: [12, 18], hp: 50, speed: 2.4, runSpeed: 4, locomotion: "ground", radius: 0.45, height: 1.9, sight: 35, fov: 90, hearing: 12,
    preferRange: [12, 22], relocateWithin: 6, pack: [3, 4], respawn: "pack", model: "associate", bark: "Asset located.",
    attacks: [atk({ id: "burst", name: "3-Round Burst", shape: "burst", weight: "light", damage: 5, telegraph: 0.5, count: 3, interval: 0.12, range: 32, cooldown: 2.5 })],
    drops: [{ kind: "item", id: "tonic_large", chance: 1 / 12 }],
  },
  {
    id: "enforcer", name: "Enforcer", planet: "meridian", family: "oversight", tier: "heavy", temper: "hostile",
    levels: [13, 19], hp: 100, shield: 70, speed: 1.6, runSpeed: 2.2, locomotion: "ground", radius: 0.6, height: 2.0, ...PERCEPTION,
    pack: [1, 2], respawn: "pack", model: "enforcer",
    attacks: [
      atk({ id: "shove", name: "Shield Shove", shape: "arc", weight: "light", damage: 13, telegraph: 0.6, radius: 2.4, angle: 70, knockback: 3, range: 2.1, cooldown: 3 }),
      atk({ id: "baton", name: "Baton", shape: "arc", weight: "light", damage: 10, telegraph: 0.5, radius: 2.3, angle: 90, range: 2.1, cooldown: 1.4 }),
    ],
    drops: [weaponDrop(1 / 15)],
  },
  {
    id: "collector", name: "Collector", planet: "meridian", family: "oversight", tier: "regular", temper: "hostile",
    levels: [12, 20], hp: 22, speed: 4, runSpeed: 6, locomotion: "hover", hover: 6, radius: 0.55, height: 0.8, ...PERCEPTION,
    preferRange: [6, 10], pack: [1, 2], respawn: "pack", model: "collector",
    attacks: [
      atk({ id: "tag", name: "Tag", shape: "tag", weight: "light", damage: 0, telegraph: 1.0, angle: 30, range: 20, cooldown: 8, effect: { kind: "tag", seconds: 5, amount: 0.25 } }),
      atk({ id: "taser", name: "Taser", shape: "zap", weight: "light", damage: 5, telegraph: 0.5, range: 10, cooldown: 2 }),
    ],
    drops: coinsOnly,
  },
  {
    id: "auditor", name: "Auditor", planet: "meridian", family: "oversight", tier: "regular", temper: "hostile",
    levels: [14, 20], hp: 40, speed: 3, runSpeed: 4, locomotion: "hover", hover: 15, radius: 0.8, height: 1.0, sight: 32, fov: 120, hearing: 12,
    preferRange: [20, 30], relocateWithin: 12, pack: [2, 2], respawn: "pack", model: "auditor",
    attacks: [atk({ id: "mortar", name: "Mortar", shape: "circle", weight: "light", damage: 13, telegraph: 1.2, radius: 3, count: 3, range: 34, minRange: 8, cooldown: 5 })],
    drops: [grenade(1 / 25)],
  },
  {
    id: "compliance_officer", name: "Compliance Officer", planet: "meridian", family: "oversight", tier: "elite", temper: "hostile",
    levels: [16, 20], hp: 140, speed: 2, runSpeed: 3.2, locomotion: "ground", radius: 0.5, height: 1.95, sight: 35, fov: 90, hearing: 12,
    preferRange: [10, 18], pack: [1, 1], respawn: "camp", model: "compliance_officer", aura: { radius: 15, damage: 0.15 }, bark: "Escalating.",
    attacks: [
      atk({ id: "cease", name: "Cease-and-Desist", shape: "field", weight: "light", damage: 0, telegraph: 1.2, radius: 4, count: 1, range: 20, minRange: 3, cooldown: 10, effect: { kind: "nosprint", seconds: 3, amount: 1 } }),
      atk({ id: "pistol", name: "Pistol", shape: "burst", weight: "light", damage: 13, telegraph: 0.5, count: 1, range: 30, cooldown: 1.6 }),
    ],
    drops: [weaponDrop(1 / 4)],
  },
  {
    id: "ticket_000", name: "Associate #000", planet: "meridian", family: "egg", tier: "critter", temper: "passive",
    levels: [12, 12], hp: 50, speed: 2.4, runSpeed: 3, locomotion: "ground", radius: 0.45, height: 1.9, ...PERCEPTION,
    pack: [1, 1], respawn: "egg", model: "associate", attacks: [], drops: coinsOnly, coinsFixed: 0,
  },

  // ---------------------------------------------------------------- wildlife (every planet)
  {
    id: "woolback", name: "Woolback", planet: "any", family: "woolback", tier: "critter", temper: "critter",
    levels: [1, 12], levelsByPlanet: { arcadia: [1, 2], hollowmere: [6, 6], meridian: [12, 12] },
    hp: 30, speed: 1.0, runSpeed: 5, fleeSpeed: 5, locomotion: "ground", radius: 0.6, height: 1.1, ...PERCEPTION,
    pack: [4, 8], retaliateChance: 0.1, respawn: "pack", model: "woolback",
    attacks: [atk({ id: "buck", name: "Buck", shape: "arc", weight: "light", damage: 2, fixed: true, telegraph: 0.5, radius: 2.2, angle: 120, knockback: 2, range: 2.2, cooldown: 3 })],
    drops: [item("wool_tuft", 1), item("woolback_plushie", 1 / 300)],
  },
  {
    id: "dusk_wolf", name: "Dusk Wolf", planet: "any", family: "wolf", tier: "regular", temper: "hostile",
    levels: [3, 19], levelsByPlanet: { arcadia: [3, 6], hollowmere: [8, 12], meridian: [14, 19] },
    hp: 42, speed: 3, runSpeed: 7.5, locomotion: "ground", radius: 0.5, height: 1.1, ...PERCEPTION,
    pack: [3, 5], howl: 1.5, fleeBelow: 0.25, respawn: "pack", model: "dusk_wolf",
    attacks: [
      atk({ id: "lunge", name: "Lunge", shape: "charge", weight: "light", damage: 17, telegraph: 0.8, speed: 14, length: 7, width: 1.4, range: 7.5, minRange: 3, cooldown: 5, recovery: 0.6 }),
      atk({ id: "bite", name: "Bite", shape: "arc", weight: "light", damage: 8, telegraph: 0.5, radius: 2.2, angle: 90, range: 2, cooldown: 1.3 }),
    ],
    drops: [item("wolf_pelt", 0.5), item("wolfpelt_cape", 1 / 200)],
  },
  {
    id: "bramblehorn", name: "Bramblehorn", planet: "arcadia", family: "beast", tier: "beast", temper: "neutral",
    levels: [8, 8], hp: 900, speed: 1.2, runSpeed: 5, locomotion: "ground", radius: 1.8, height: 6, ...PERCEPTION,
    pack: [1, 1], steadfast: true, respawn: "beast", model: "bramblehorn",
    attacks: [
      atk({ id: "antler_charge", name: "Antler Charge", shape: "charge", weight: "heavy", damage: 32, telegraph: 1.2, speed: 12, length: 20, width: 3, range: 22, minRange: 6, cooldown: 8 }),
      atk({ id: "stomp", name: "Stomp", shape: "ring", weight: "heavy", damage: 22, telegraph: 1.0, radius: 4, range: 4, cooldown: 5 }),
    ],
    drops: [item("bramblehorn_antler", 1), item("antler_crown", 1 / 8), weaponDrop(1 / 2, 2)],
  },
  {
    id: "fenstalker", name: "Fenstalker", planet: "hollowmere", family: "beast", tier: "beast", temper: "neutral",
    levels: [14, 14], hp: 1000, speed: 1.2, runSpeed: 4.5, locomotion: "wade", radius: 1.2, height: 7, ...PERCEPTION,
    pack: [1, 1], steadfast: true, respawn: "beast", model: "fenstalker",
    attacks: [
      atk({ id: "beak", name: "Beak Spear", shape: "line", weight: "heavy", damage: 38, telegraph: 0.9, length: 9, width: 1.6, range: 8.5, cooldown: 4 }),
      atk({ id: "buffet", name: "Wing Buffet", shape: "arc", weight: "heavy", damage: 20, telegraph: 1.0, radius: 6, angle: 90, knockback: 5, range: 5.5, cooldown: 7 }),
    ],
    drops: [item("fenstalker_plume", 1), item("heron_plume_hat", 1 / 8), weaponDrop(1 / 2, 3)],
  },
  {
    id: "dunebreaker", name: "Dunebreaker", planet: "meridian", family: "beast", tier: "beast", temper: "neutral",
    levels: [20, 20], hp: 1200, speed: 1.2, runSpeed: 4, locomotion: "ground", radius: 2.0, height: 3.5, ...PERCEPTION,
    pack: [1, 1], steadfast: true, respawn: "beast", model: "dunebreaker",
    attacks: [
      atk({ id: "roll", name: "Roll Charge", shape: "charge", weight: "heavy", damage: 40, telegraph: 1.2, speed: 14, length: 25, width: 3, stun: 2, range: 24, minRange: 6, cooldown: 7 }),
      atk({ id: "tail", name: "Tail Swipe", shape: "arc", weight: "heavy", damage: 26, telegraph: 0.9, radius: 5, angle: 120, back: true, range: 5, cooldown: 4 }),
    ],
    drops: [item("dunebreaker_scale", 1), item("saltplate_mantle", 1 / 8), weaponDrop(1 / 2, 3)],
  },

  // ---------------------------------------------------------------- bosses (stats here; mechanics in BOSS_DEFS)
  {
    id: "tidewrath", name: "Tidewrath", planet: "arcadia", family: "boss", tier: "boss", temper: "hostile",
    levels: [8, 8], hp: 12_000, hpFixed: true, armour: 0.2, speed: 2.5, runSpeed: 4, locomotion: "swim", radius: 4.5, height: 7,
    sight: 60, fov: 360, hearing: 60, pack: [1, 1], steadfast: true, respawn: "boss", model: "tidewrath",
    attacks: [
      atk({ id: "tail_slam", name: "Tail Slam", shape: "line", weight: "lethal", damage: 70, fixed: true, telegraph: 1.2, length: 15, width: 6, knockback: 4, range: 40, cooldown: 7, recovery: 1.0 }),
      atk({ id: "brine_spit", name: "Brine Spit", shape: "circle", weight: "heavy", damage: 35, fixed: true, telegraph: 1.2, radius: 3, count: 3, range: 45, cooldown: 6, recovery: 0.8 }),
      atk({ id: "steam_vents", name: "Steam Vents", shape: "arc", weight: "heavy", damage: 20, fixed: true, telegraph: 1.0, radius: 30, angle: 60, ticks: 4, interval: 0.5, range: 30, cooldown: 9, phases: [2, 3], recovery: 0.8 }),
      atk({ id: "undertow", name: "Undertow", shape: "pull", weight: "heavy", damage: 5, fixed: true, telegraph: 1.0, radius: 8, speed: 2, ticks: 8, interval: 0.5, range: 45, cooldown: 14, phases: [2, 3], recovery: 0.8 }),
      atk({ id: "tide_surge", name: "Tide Surge", shape: "band", weight: "heavy", damage: 50, fixed: true, telegraph: 1.5, inner: 0, radius: 20, knockback: 6, range: 999, timed: true, every: [30, 30, 20], recovery: 1.0 }),
    ],
    drops: coinsOnly,
  },
  {
    id: "hollow_king", name: "The Hollow King", planet: "hollowmere", family: "boss", tier: "boss", temper: "hostile",
    levels: [14, 14], hp: 28_000, hpFixed: true, armour: 1, speed: 1.8, runSpeed: 3, locomotion: "ground", radius: 1.4, height: 4,
    sight: 50, fov: 360, hearing: 50, pack: [1, 1], steadfast: true, respawn: "boss", model: "hollow_king",
    attacks: [
      atk({ id: "sceptre_sweep", name: "Sceptre Sweep", shape: "arc", weight: "heavy", damage: 75, fixed: true, telegraph: 0.9, radius: 6, angle: 180, range: 5.5, cooldown: 5, repeatAfter: 0.6, repeatPhases: [3] }),
      atk({ id: "bone_volley", name: "Bone Volley", shape: "bolt", weight: "light", damage: 22, fixed: true, telegraph: 0.8, count: 5, angle: 40, speed: 24, radius: 0.6, range: 30, minRange: 4, cooldown: 6 }),
      atk({ id: "grave_hands", name: "Grave Hands", shape: "circle", weight: "heavy", damage: 55, fixed: true, telegraph: 1.2, radius: 2.5, count: 3, range: 40, cooldown: 9, effect: { kind: "slow", seconds: 1.5, amount: 0.5 } }),
      atk({ id: "toll_of_ages", name: "Toll of Ages", shape: "ring", weight: "heavy", damage: 60, fixed: true, telegraph: 1.2, radius: 6, knockback: 4, range: 6, cooldown: 10, phases: [2, 3], recovery: 1.0 }),
      atk({ id: "royal_judgement", name: "Royal Judgement", shape: "split", weight: "lethal", damage: 276, fixed: true, trueDamage: true, telegraph: 2.0, radius: 4, range: 999, timed: true, every: [20, 18, 15], recovery: 0.8 }),
      atk({ id: "court_summons", name: "Court Summons", shape: "raise", weight: "heavy", damage: 0, fixed: true, telegraph: 1.5, count: 2, summon: "bonewalker", summonLevel: 13, range: 999, timed: true, every: [30, 30, 0], recovery: 0.8 }),
    ],
    drops: coinsOnly,
  },
  {
    id: "the_receiver", name: "The Receiver", planet: "meridian", family: "boss", tier: "boss", temper: "hostile",
    levels: [20, 20], hp: 30_000, hpFixed: true, armour: 0.25, speed: 1.6, runSpeed: 2.4, locomotion: "ground", radius: 3.2, height: 12,
    sight: 60, fov: 360, hearing: 60, pack: [1, 1], steadfast: true, respawn: "boss", model: "the_receiver",
    attacks: [
      atk({ id: "stomp", name: "Stomp", shape: "ring", weight: "heavy", damage: 95, fixed: true, telegraph: 1.0, radius: 5, footOffset: 3, range: 8, cooldown: 6, recovery: 1.0 }),
      atk({ id: "shoulder_volley", name: "Shoulder Volley", shape: "circle", weight: "heavy", damage: 50, fixed: true, telegraph: 1.2, radius: 3, count: 3, track: true, lockLead: 0.5, range: 50, cooldown: 8 }),
      atk({ id: "sweep_laser", name: "Sweep Laser", shape: "beam", weight: "lethal", damage: 150, fixed: true, telegraph: 1.5, radius: 40, angle: 90, interval: 2, range: 40, cooldown: 16, phases: [3], recovery: 1.0 }),
      atk({ id: "foreclosure", name: "Foreclosure", shape: "split", weight: "lethal", damage: 348, fixed: true, trueDamage: true, telegraph: 2.0, radius: 4.5, range: 999, timed: true, every: [0, 20, 18], recovery: 0.8 }),
      atk({ id: "collector_drones", name: "Collector Drones", shape: "raise", weight: "heavy", damage: 0, fixed: true, telegraph: 1.5, count: 2, summon: "collector", summonLevel: 20, range: 999, timed: true, every: [0, 25, 25], recovery: 0.8 }),
    ],
    drops: coinsOnly,
  },
];

export const NPC_INDEX: ReadonlyMap<string, number> = new Map(NPC_DEFS.map((d, i) => [d.id, i]));

export function npcDef(id: string): NpcDef {
  const i = NPC_INDEX.get(id);
  if (i === undefined) throw new Error(`unknown npc ${id}`);
  return NPC_DEFS[i]!;
}

/** Max HP of a def at a level (bosses: HP₂, before the player-count scaling). */
export function npcMaxHp(def: NpcDef, level: number): number {
  return def.hpFixed ? def.hp : Math.round(def.hp * enemyHpMult(level));
}

export function npcShieldHp(def: NpcDef, level: number): number {
  return def.shield ? Math.round(def.shield * enemyHpMult(level)) : 0;
}

/** Damage of one hit of an attack at a level (before caps and buffs). */
export function attackDamage(a: AttackDef, level: number): number {
  return a.fixed ? a.damage : a.damage * enemyDamageMult(level);
}

/** Largest single hit as a share of an on-level player's HP (the "%" column in content §3). */
export function hitShare(def: NpcDef, a: AttackDef, level = def.levels[1]): number {
  return attackDamage(a, level) / maxHp(level);
}

/** Coins auto-credited to the top damage dealer. */
export function npcCoins(def: NpcDef, level: number): number {
  if (def.coinsFixed !== undefined) return def.coinsFixed;
  return Math.round(killCoins(def.tier, level) * (def.coinMult ?? 1));
}

/** Weapon tier by enemy level (content §3.6). `roll` in [0, 1). */
export function weaponTierFor(level: number, roll: number): 1 | 2 | 3 {
  if (level <= 5) return 1;
  if (level <= 11) return roll < 0.3 ? 1 : 2;
  return roll < 0.4 ? 2 : 3;
}

/** The 15 weapon families that drop (everything but fists, radio and tonics). */
export const DROP_WEAPONS = ["sunbrand", "riverstaff", "axe", "hammer", "hexquill", "emberglass", "stormcoil", "carbine", "scatterpipe", "longbow", "stillshot", "comet", "grenade", "patchkit", "bubble"] as const;

export const PLANET_TONIC: Record<PlanetId, { id: string; chance: number }> = {
  arcadia: { id: "tonic_small", chance: 1 / 10 },
  hollowmere: { id: "tonic_large", chance: 1 / 12 },
  meridian: { id: "tonic_large", chance: 1 / 12 },
};

/** Planet cosmetic from any enemy on that planet, with pity after 3× the expected kills in one life. */
export const PLANET_COSMETIC: Record<PlanetId, { id: string; chance: number }> = {
  arcadia: { id: "winged_cap", chance: 1 / 150 },
  hollowmere: { id: "crowbeak_mask", chance: 1 / 100 },
  meridian: { id: "hard_hat", chance: 1 / 75 },
};

/** Additional planet rolls use independent per-life pity counters. */
export const EXTRA_PLANET_COSMETICS: Record<PlanetId, readonly { id: string; chance: number }[]> = {
  arcadia: [{ id: "petalwake_mask", chance: 1 / 180 }],
  hollowmere: [{ id: "fenweave_cape", chance: 1 / 160 }],
  meridian: [],
};

// ------------------------------------------------------------------------------------------ camps and chests

export interface CampChest {
  coins: number;
  weapons: number;
  tonics: number;
  cosmetic?: { id: string; chance: number };
}

// ------------------------------------------------------------------------------------------ bosses

export interface BossDef {
  id: string; // NpcDef id
  body: PlanetId;
  level: number;
  /** Phase thresholds (HP fraction): entering P2 below [0], P3 below [1]. */
  phases: [number, number];
  /** HP(n) = HP₂ × (1 + perExtra × (max(n, 2) − 2)), n capped. */
  hpPerExtra: number;
  maxCounted: number;
  /** Reset to full HP when the arena is empty this long (s). */
  resetAfter: number;
  /** Plates (Tide Stones / Override Consoles): two bodies in two places. */
  plates?: { spacing: number; radius: number; hold: number; window: number; cooldown: number; weakMult: number };
  /** Anti-solo regeneration: share of max HP per second when no window happened recently. */
  regen?: { perSecond: number; after: number };
  loot: {
    coins: number;
    xp: number;
    always: { id: string; tier: 1 | 2 | 3 | "random2" | "random3"; qty: number }[];
    rolls: { chance: number; oneOf: string[]; weaponTier?: 2 | 3 }[];
  };
  voice: { engage: string; phase2: string; defeat: string };
}

export const BOSS_DEFS: readonly BossDef[] = [
  {
    id: "tidewrath", body: "arcadia", level: 8, phases: [0.6, 0.25], hpPerExtra: 0.35, maxCounted: 8, resetAfter: 30,
    plates: { spacing: 30, radius: 1.0, hold: 3, window: 8, cooldown: 12, weakMult: 1.5 },
    regen: { perSecond: 0.0025, after: 45 },
    loot: {
      coins: 120, xp: 2000,
      always: [{ id: "weapon", tier: "random2", qty: 1 }, { id: "tonic_large", tier: 1, qty: 2 }],
      rolls: [{ chance: 1 / 6, oneOf: ["coral_crown", "tide_cape"] }, { chance: 1 / 25, oneOf: ["tidewrath_tooth"] }],
    },
    voice: { engage: "The lake was quiet. You woke it.", phase2: "Every tide comes back. So do I.", defeat: "The water... remembers you." },
  },
  {
    id: "hollow_king", body: "hollowmere", level: 14, phases: [0.65, 0.3], hpPerExtra: 0.35, maxCounted: 8, resetAfter: 30,
    loot: {
      coins: 300, xp: 3200,
      always: [{ id: "weapon", tier: "random3", qty: 1 }],
      rolls: [{ chance: 1 / 3, oneOf: ["weapon"], weaponTier: 2 }, { chance: 1 / 6, oneOf: ["court_mantle", "funeral_veil"] }, { chance: 1 / 25, oneOf: ["hollow_crown"] }],
    },
    voice: { engage: "Kneel. The Court is in session.", phase2: "Every crown here was once a head.", defeat: "Ring the bell... for me." },
  },
  {
    id: "the_receiver", body: "meridian", level: 20, phases: [0.6, 0.25], hpPerExtra: 0.35, maxCounted: 8, resetAfter: 30,
    plates: { spacing: 32, radius: 1.2, hold: 3, window: 8, cooldown: 15, weakMult: 1.5 },
    regen: { perSecond: 0.0025, after: 45 },
    loot: {
      coins: 600, xp: 4400,
      always: [{ id: "weapon", tier: "random3", qty: 1 }],
      rolls: [{ chance: 1 / 3, oneOf: ["weapon"], weaponTier: 3 }, { chance: 1 / 6, oneOf: ["wind_up_key", "signal_dish"] }, { chance: 1 / 25, oneOf: ["receiver_floodlamp"] }],
    },
    voice: { engage: "This planet is now under new management.", phase2: "Resistance has been noted on your file.", defeat: "Shutting down... pending review." },
  },
];

export const BOSS_BY_BODY: Readonly<Partial<Record<BodyId, BossDef>>> = Object.fromEntries(BOSS_DEFS.map((b) => [b.body, b]));

/** Boss max HP for n engaged players (content §4.1). */
export function bossMaxHp(hp2: number, engaged: number, perExtra = 0.35, cap = 8): number {
  const n = Math.min(cap, Math.max(2, engaged));
  return Math.round(hp2 * (1 + perExtra * (n - 2)));
}

/** Damage each player inside a split circle takes; `inside` = 0 means everyone in the arena takes the full amount. */
export function splitDamage(total: number, inside: number): number {
  return inside <= 0 ? total : total / inside;
}

/** A split circle's total is at least this share of the sturdiest victim's max HP (content §4: 120%). */
export const SPLIT_LETHAL_SHARE = 1.2;

/**
 * Total true damage of a split circle: the listed damage (120% of an on-level player) or 120% of the
 * highest max HP among the players taking it, whichever is more. One player alone always dies, at
 * any level, and two always take 60% of the sturdier one's HP each (F12 review: the Hollow King's
 * flat 276 was survivable solo at levels 19–20).
 */
export function splitTotal(listed: number, victimMaxHp: readonly number[]): number {
  let top = 0;
  for (const hp of victimMaxHp) if (hp > top) top = hp;
  return Math.max(listed, SPLIT_LETHAL_SHARE * top);
}

// ------------------------------------------------------------------------------------------ spawn areas

/** Where an area sits: a feature anchor, or a point part-way from one anchor to another. */
export type AreaAnchor = FeatureAnchor | { lerp: [FeatureAnchor, FeatureAnchor, number] };

export interface SpawnGroupDef {
  members: { kind: string; count: [number, number] }[];
  weight: number;
  /** Ground preference for the group's home. */
  ground?: "meadow" | "ridge" | "shore" | "any";
  /** One in N groups gets a Golden Hopbit (egg E3). */
  goldenOneIn?: number;
}

export interface NpcArea {
  id: string;
  name: string;
  planet: PlanetId;
  at: AreaAnchor;
  radius: number;
  levels: [number, number];
  /** Ambient groups placed on the chunk grid inside the area. */
  groups: SpawnGroupDef[];
  /** Spawn chance per chunk candidate inside this area (wilds use PLANET_WILDS.density). */
  density?: number;
  /** A fixed camp at the area centre. */
  camp?: { members: { kind: string; count: number; level?: number }[]; chest?: CampChest };
  /** Fixed singles (beasts, sentinels at altars), at the centre or offset along the area's tangent. */
  singles?: { kind: string; level?: number; offset?: number; roam?: number }[];
}

export const NPC_AREAS: readonly NpcArea[] = [
  // Arcadia (main pad 0 "Dawnpad")
  {
    id: "clover_fields", name: "Clover Fields", planet: "arcadia", at: { lerp: [{ pad: 0 }, { tri: [0, 1, 2] }, 0.45] }, radius: 140, levels: [1, 3], density: 0.75,
    groups: [
      { members: [{ kind: "hopbit", count: [4, 6] }], weight: 5, goldenOneIn: 25 },
      { members: [{ kind: "woolback", count: [4, 8] }], weight: 3, ground: "meadow" },
    ],
  },
  {
    id: "lacefall", name: "Lacefall", planet: "arcadia", at: { lerp: [{ mid: [3, 7] }, { pad: 3 }, 0.32] }, radius: 60, levels: [2, 4], density: 0.8,
    groups: [
      { members: [{ kind: "woolback", count: [4, 6] }], weight: 3, ground: "meadow" },
      { members: [{ kind: "sparkfly", count: [1, 2] }], weight: 2 },
    ],
  },
  {
    id: "pinewhistle_wood", name: "Pinewhistle Wood", planet: "arcadia", at: { mid: [0, 4] }, radius: 130, levels: [2, 5], density: 0.6,
    groups: [
      { members: [{ kind: "sparkfly", count: [2, 3] }], weight: 3 },
      { members: [{ kind: "dusk_wolf", count: [3, 5] }], weight: 2 },
    ],
  },
  {
    id: "glasswater_shore", name: "Glasswater Lake shore", planet: "arcadia", at: { mid: [3, 7] }, radius: 150, levels: [3, 6], density: 0.6,
    groups: [{ members: [{ kind: "sparkfly", count: [1, 1] }, { kind: "bomblet", count: [1, 1] }], weight: 3, ground: "shore" }],
  },
  {
    id: "highscore_hill", name: "Highscore Hill", planet: "arcadia", at: { mid: [1, 6] }, radius: 100, levels: [3, 7], density: 0.75,
    groups: [
      { members: [{ kind: "linewyrm", count: [1, 2] }], weight: 2 },
      { members: [{ kind: "pixel_lancer", count: [1, 1] }, { kind: "hopbit", count: [4, 4] }], weight: 2 },
    ],
  },
  {
    id: "kestrel_slopes", name: "Kestrel Peak slopes", planet: "arcadia", at: { tri: [4, 5, 9] }, radius: 170, levels: [4, 7], density: 0.5,
    groups: [{ members: [{ kind: "dusk_wolf", count: [4, 5] }], weight: 3, ground: "ridge" }],
    singles: [{ kind: "bramblehorn", level: 8, offset: 120, roam: 90 }],
  },
  {
    id: "blockyard_camp", name: "Blockyard Camp", planet: "arcadia", at: { mid: [5, 10] }, radius: 35, levels: [5, 7], density: 0,
    groups: [],
    camp: {
      members: [{ kind: "cabinet_golem", count: 1, level: 7 }, { kind: "pixel_lancer", count: 2 }, { kind: "bomblet", count: 2 }, { kind: "hopbit", count: 4, level: 4 }],
      chest: { coins: 60, weapons: 1, tonics: 2, cosmetic: { id: "voxel_visor", chance: 1 / 10 } },
    },
  },

  // Hollowmere (main pad 0 "Lanternfall")
  {
    id: "whisper_fen", name: "Whisper Fen", planet: "hollowmere", at: { tri: [0, 3, 4] }, radius: 110, levels: [6, 9], density: 0.7,
    groups: [
      { members: [{ kind: "marsh_wisp", count: [4, 6] }], weight: 3 },
      { members: [{ kind: "gnawer", count: [2, 3] }], weight: 2 },
      { members: [{ kind: "woolback", count: [4, 6] }], weight: 2, ground: "meadow" },
    ],
  },
  {
    id: "saint_orrins", name: "Saint Orrin's ruin", planet: "hollowmere", at: { mid: [0, 2] }, radius: 50, levels: [7, 10], density: 0,
    groups: [],
    camp: { members: [{ kind: "bonewalker", count: 3 }, { kind: "bone_archer", count: 2 }] },
  },
  {
    id: "thornwood", name: "Thornwood", planet: "hollowmere", at: { mid: [0, 1] }, radius: 140, levels: [7, 10], density: 0.6,
    groups: [
      { members: [{ kind: "gnawer", count: [3, 4] }], weight: 3 },
      { members: [{ kind: "dusk_wolf", count: [3, 5] }], weight: 2 },
    ],
  },
  {
    id: "drowned_chapel", name: "Drowned Chapel", planet: "hollowmere", at: { lerp: [{ mid: [2, 8] }, { pad: 2 }, 0.24] }, radius: 40, levels: [8, 11], density: 0,
    groups: [],
    camp: { members: [{ kind: "bonewalker", count: 3 }, { kind: "bone_archer", count: 1 }] },
    singles: [{ kind: "crypt_sentinel", level: 10, offset: 8 }],
  },
  {
    id: "mourning_mere", name: "Mourning Mere", planet: "hollowmere", at: { mid: [2, 8] }, radius: 170, levels: [9, 12], density: 0.5,
    groups: [{ members: [{ kind: "marsh_wisp", count: [4, 6] }], weight: 3, ground: "shore" }],
    singles: [{ kind: "fenstalker", level: 14, offset: 95, roam: 40 }],
  },
  {
    id: "ossuary_camp", name: "Ossuary Camp", planet: "hollowmere", at: { lerp: [{ pad: 10 }, { pad: 8 }, 0.55] }, radius: 35, levels: [10, 13], density: 0,
    groups: [],
    camp: {
      members: [{ kind: "crypt_sentinel", count: 1, level: 13 }, { kind: "cantor", count: 2 }, { kind: "bonewalker", count: 4 }, { kind: "bone_archer", count: 2 }],
      chest: { coins: 150, weapons: 1, tonics: 2 },
    },
  },
  {
    // D28 moved the Tolling Tower 125 m toward pad 8; its approach is the ridge foot toward pad 4.
    id: "tolling_approach", name: "Tolling Tower approach", planet: "hollowmere", at: { lerp: [{ pad: 10 }, { pad: 4 }, 0.3] }, radius: 90, levels: [11, 13], density: 0.7,
    groups: [
      { members: [{ kind: "bone_archer", count: [2, 2] }], weight: 2, ground: "ridge" },
      { members: [{ kind: "gnawer", count: [2, 3] }], weight: 2 },
    ],
  },

  // Meridian (main pad 0 "Waystation Nine")
  {
    id: "cinder_canyons", name: "Cinder Canyons", planet: "meridian", at: { mid: [0, 2] }, radius: 170, levels: [12, 15], density: 0.6,
    groups: [
      { members: [{ kind: "associate", count: [3, 3] }, { kind: "collector", count: [1, 1] }], weight: 3 },
      { members: [{ kind: "dusk_wolf", count: [3, 5] }], weight: 2, ground: "ridge" },
    ],
  },
  {
    id: "brinewater", name: "Brinewater Lake", planet: "meridian", at: { mid: [4, 11] }, radius: 180, levels: [13, 16], density: 0.5,
    groups: [
      { members: [{ kind: "collector", count: [1, 2] }], weight: 2 },
      { members: [{ kind: "woolback", count: [4, 8] }], weight: 2, ground: "shore" },
    ],
  },
  {
    id: "glasspan", name: "Glasspan Salt Flats", planet: "meridian", at: { mid: [8, 9] }, radius: 170, levels: [13, 17], density: 0.5,
    groups: [{ members: [{ kind: "auditor", count: [2, 2] }], weight: 3 }],
    singles: [{ kind: "dunebreaker", level: 20, offset: 60, roam: 100 }],
  },
  {
    id: "checkpoint_seven", name: "Checkpoint Seven", planet: "meridian", at: { lerp: [{ pad: 13 }, { pad: 17 }, 0.4] }, radius: 40, levels: [14, 17], density: 0,
    groups: [],
    camp: {
      members: [{ kind: "compliance_officer", count: 1, level: 17 }, { kind: "associate", count: 6 }, { kind: "enforcer", count: 2 }, { kind: "collector", count: 2 }],
      chest: { coins: 300, weapons: 1, tonics: 2 },
    },
    // Egg E9: the non-hostile clone facing the back wall.
    singles: [{ kind: "ticket_000", level: 12, offset: 18 }],
  },
  {
    id: "oversight_lobby", name: "Chrome Spires / Oversight Lobby", planet: "meridian", at: { lerp: [{ pad: 15 }, { pad: 9 }, 0.16] }, radius: 100, levels: [15, 19], density: 0.7,
    groups: [
      { members: [{ kind: "associate", count: [4, 4] }, { kind: "enforcer", count: [2, 2] }], weight: 2 },
      { members: [{ kind: "auditor", count: [2, 2] }], weight: 1 },
    ],
  },
  {
    // Off the Chrome Spires (D28 put them between pads 15 and 9), on the rise above Glasspan.
    id: "last_billboard", name: "The Last Billboard mesa", planet: "meridian", at: { lerp: [{ pad: 9 }, { pad: 15 }, 0.2] }, radius: 60, levels: [16, 18], density: 0.8,
    groups: [{ members: [{ kind: "auditor", count: [2, 2] }], weight: 1 }],
  },
  {
    id: "yard_approach", name: "Foreclosure Yard approach", planet: "meridian", at: { lerp: [{ pad: 13 }, { pad: 17 }, 0.55] }, radius: 90, levels: [18, 20], density: 0.7,
    groups: [
      { members: [{ kind: "enforcer", count: [1, 2] }, { kind: "associate", count: [3, 3] }], weight: 2 },
      { members: [{ kind: "compliance_officer", count: [1, 1] }, { kind: "associate", count: [2, 2] }], weight: 1 },
    ],
  },
];

/** Groups outside named areas; level from the distance to the main pad across the planet's range. */
export const PLANET_WILDS: Record<PlanetId, { density: number; groups: SpawnGroupDef[] }> = {
  arcadia: {
    density: 0.3,
    groups: [
      { members: [{ kind: "hopbit", count: [4, 6] }], weight: 3, goldenOneIn: 25 },
      { members: [{ kind: "sparkfly", count: [2, 3] }], weight: 2 },
      { members: [{ kind: "bomblet", count: [2, 2] }], weight: 1 },
      { members: [{ kind: "pixel_lancer", count: [1, 1] }, { kind: "hopbit", count: [3, 4] }], weight: 1 },
      { members: [{ kind: "woolback", count: [4, 8] }], weight: 3, ground: "meadow" },
      { members: [{ kind: "dusk_wolf", count: [3, 5] }], weight: 1, ground: "ridge" },
    ],
  },
  hollowmere: {
    density: 0.25,
    groups: [
      { members: [{ kind: "bonewalker", count: [3, 4] }], weight: 3 },
      { members: [{ kind: "bonewalker", count: [2, 3] }, { kind: "cantor", count: [1, 1] }], weight: 1 },
      { members: [{ kind: "bone_archer", count: [2, 2] }], weight: 2, ground: "ridge" },
      { members: [{ kind: "gnawer", count: [2, 4] }], weight: 2 },
      { members: [{ kind: "marsh_wisp", count: [4, 6] }], weight: 1, ground: "shore" },
      { members: [{ kind: "woolback", count: [4, 8] }], weight: 2, ground: "meadow" },
      { members: [{ kind: "dusk_wolf", count: [3, 5] }], weight: 1, ground: "ridge" },
    ],
  },
  meridian: {
    density: 0.2,
    groups: [
      { members: [{ kind: "associate", count: [3, 4] }], weight: 3 },
      { members: [{ kind: "associate", count: [2, 3] }, { kind: "enforcer", count: [1, 1] }], weight: 1 },
      { members: [{ kind: "collector", count: [1, 2] }], weight: 1 },
      { members: [{ kind: "auditor", count: [2, 2] }], weight: 1 },
      { members: [{ kind: "woolback", count: [4, 8] }], weight: 2, ground: "meadow" },
      { members: [{ kind: "dusk_wolf", count: [3, 5] }], weight: 1, ground: "ridge" },
    ],
  },
};

/** A fixed group: a kind, how many and at what level. */
export interface FixedMember {
  kind: string;
  count: number;
  level: number;
}

/**
 * Portus outside the town walls (D-zones-1): fixed groups in the town frame (east, north: geodesic
 * metres from the pole, D38), weak enough for a first fight (levels 1–2). Woolbacks graze in sight of
 * both gates (the border runs through the gatehouses at ±46 m east); small Hopbit packs wait on the
 * rim ~40 m out, past their 25 m sight from the gate, so nobody is jumped on the doorstep; the far
 * side has a little more. Hostile homes keep their wander room and the NPC margin clear of the town
 * (server spawns.ts checks it); steering keeps every NPC out of the town.
 */
export const PORTUS_WILDS: readonly { id: string; east: number; north: number; members: FixedMember[] }[] = [
  // East gate: the road out runs past the paddock fence.
  { id: "east_meadow", east: 63, north: 17, members: [{ kind: "woolback", count: 4, level: 1 }] },
  { id: "east_hopbits", east: 86, north: -20, members: [{ kind: "hopbit", count: 3, level: 1 }] },
  // West gate.
  { id: "west_meadow", east: -63, north: -17, members: [{ kind: "woolback", count: 4, level: 1 }] },
  { id: "west_hopbits", east: -86, north: 20, members: [{ kind: "hopbit", count: 3, level: 1 }] },
  // Round the walls and over the rim.
  { id: "south_hopbits", east: 8, north: -84, members: [{ kind: "hopbit", count: 4, level: 2 }] },
  { id: "north_hopbits", east: -12, north: 100, members: [{ kind: "hopbit", count: 3, level: 2 }] },
  { id: "far_meadow", east: -95, north: -85, members: [{ kind: "woolback", count: 5, level: 1 }] },
  { id: "far_sparkflies", east: 105, north: 85, members: [{ kind: "sparkfly", count: 2, level: 2 }] },
];

/**
 * Creeps in sight of each planet's arrival pad (pad 0, where the portal home stands) (D-zones-2): a
 * grazing herd just past the pad's platform and a small pack of the planet's weakest hostiles just
 * outside the 45 m hostile rule, both placed toward where the arrival camera looks (the portal),
 * so a new arrival sees creeps at once and reaches a fight within ~20 s. `bearing` is degrees
 * clockwise from the arrival camera's direction (the search widens from there to dry ground);
 * `area` credits kills to a named area (for hunts that count kills by area).
 */
export const ARRIVAL_GROUPS: Record<PlanetId, readonly { id: string; metres: number; bearing: number; members: FixedMember[]; area?: string }[]> = {
  // Dawnpad already has both in view from the hashed Clover Fields groups (Woolbacks at 47 m, the
  // small Hopbit pack at 68 m, both ahead of the arrival camera); npc-spawns.test.ts holds that.
  arcadia: [],
  hollowmere: [
    { id: "lanternfall_herd", metres: 34, bearing: 20, members: [{ kind: "woolback", count: 4, level: 6 }] },
    { id: "lanternfall_bonewalkers", metres: 62, bearing: -30, members: [{ kind: "bonewalker", count: 3, level: 6 }] },
  ],
  meridian: [
    { id: "waystation_herd", metres: 34, bearing: 10, members: [{ kind: "woolback", count: 4, level: 12 }] },
    { id: "waystation_associates", metres: 62, bearing: -30, members: [{ kind: "associate", count: 3, level: 12 }] },
  ],
};

/** Level range a def can spawn at on a planet. */
export function defLevels(def: NpcDef, planet: PlanetId): [number, number] {
  return def.levelsByPlanet?.[planet] ?? def.levels;
}

// ------------------------------------------------------------------------------------------ messages

/** Shapes on the wire (npcAtk.sh). */
export const SHAPE_CODE: Record<AttackShape, number> = {
  arc: 0, ring: 1, circle: 2, line: 3, charge: 4, leap: 5, bolt: 6, burst: 7, zap: 8, split: 9, band: 10, beam: 11, pull: 12, tag: 13, raise: 14, field: 15,
};

/** Telegraph started (sent to clients near the NPC). Points are planet-space. */
export interface NpcAttackMsg {
  id: string; // npc id
  a: number; // attack index in the def
  sh: number; // SHAPE_CODE
  ms: number; // telegraph duration
  /** Origin (NPC or circle centre). */
  x: number;
  y: number;
  z: number;
  /** Direction (unit tangent) for arcs, lines, charges, beams. */
  dx: number;
  dy: number;
  dz: number;
  r: number; // radius / reach
  w: number; // width (lines) or inner radius (rings, bands)
  l: number; // length
  ang: number; // degrees
  /** Extra circle centres [x,y,z,...] (multi-circle attacks). */
  pts?: number[];
  /** Tracked target session ids (reticles follow them until lock). */
  tg?: string[];
  /** Colour language: 0 red wedge (dodge), 1 amber line (ranged lock), 2 teal ring (step out), 3 white flash (launch), 4 violet curse (split). */
  c: number;
}

export interface NpcShotMsg {
  id: string;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  g: number;
  ms: number; // lifetime
  k: number; // npc kind
}

export interface BossEventMsg {
  type: "engage" | "phase" | "voice" | "mechanic" | "mechanicEnd" | "plates" | "window" | "defeat" | "reset" | "respawn" | "hp" | "snapshot";
  boss: string; // def id
  id: string; // npc id
  phase?: number;
  /** Voice: speaker name + line (subtitles `NAME: line`). */
  name?: string;
  line?: string;
  /** Mechanic id and positions [x,y,z,...]. */
  mech?: string;
  pts?: number[];
  r?: number;
  ms?: number;
  /** Plates: occupancy and hold progress 0..1; dark = seconds until usable again. */
  held?: number[];
  progress?: number;
  dark?: number;
  /** Players counted for HP scaling. */
  engaged?: number;
  hp?: number;
  maxHp?: number;
  /** Snapshot (sent on join / when a player comes near the lair): broken cover ids, open window (ms left). */
  broken?: number[];
  windowMs?: number;
}

export type NpcServerMessages = {
  npcAtk: NpcAttackMsg;
  npcShot: NpcShotMsg;
  npcFx: { kind: StatusEffect["kind"]; ms: number; amount: number; by: string };
  npcPull: { x: number; y: number; z: number; speed: number; ms: number };
  npcKill: { id: string; kind: number; xp: number; coins: number };
  boss: BossEventMsg;
};

export const BOSS_NAME_BY_ID: Readonly<Record<string, string>> = Object.fromEntries(NPC_DEFS.filter((d) => d.family === "boss").map((d) => [d.id, d.name]));
