// Weapon and item catalogue (docs/content.md §2). Numbers are starting values for tuning.
// Damage values are base damage at level 1; the level multiplier is applied in combat.ts.

export type WeaponClass = "melee" | "magic" | "ranged" | "support" | "item";
export type Delivery = "melee" | "hitscan" | "pellets" | "projectile" | "arrow" | "chain" | "thrown" | "heal" | "bubble" | "none";
export type Destroys = "none" | "light" | "heavy";

export interface TierStats {
  level: number; // equip gate
  price: number;
  damage: number; // per hit (per pellet for pellets; full-draw for arrows)
  rate: number; // seconds between attacks
  mag?: number; // rounds per magazine (guns)
  reload?: number; // seconds
  heat?: number; // shots before a 1.5 s overheat lockout (magic)
  block?: number; // fraction of frontal damage blocked (melee RMB)
  splash?: number; // splash damage at centre
  radius?: number; // splash/explosion radius
  burn?: number; // damage per second for 3 s
  jumps?: number; // chain jumps
  pierce?: number;
  pellets?: number;
  tap?: number; // bow tap damage
  draw?: number; // bow full draw time
  heavy?: number; // charged/heavy damage
  heavyTime?: number;
  zoom?: number;
  headMult?: number;
  heal?: number; // fraction of target max HP (Patchkit) or HP (tonics)
  channel?: number; // Patchkit channel seconds before the heal starts
  shell?: number; // bubble HP per 100 owner max HP
  duration?: number;
  cooldown?: number;
  knockback?: number; // metres (Riverstaff: on every 3rd hit in a row)
  fuse?: number; // seconds (grenades; shortens by tier)
}

export interface WeaponDef {
  id: string;
  name: string;
  cls: WeaponClass;
  delivery: Delivery;
  range: number; // metres (full damage range for hitscan)
  falloffTo?: number; // distance where damage reaches falloffMin
  falloffMin?: number;
  arc?: number; // melee arc in degrees
  maxTargets?: number;
  windup?: number;
  speed?: number; // projectile speed m/s
  gravity?: number; // projectile gravity m/s²
  spread?: number; // hip spread (degrees)
  adsSpread?: number;
  fuse?: number;
  destroys: Destroys;
  stack: number; // max per inventory slot
  tiers: [TierStats, TierStats, TierStats];
}

const T = (level: number, price: number, s: Omit<TierStats, "level" | "price">): TierStats => ({ level, price, ...s });

export const WEAPONS: readonly WeaponDef[] = [
  {
    id: "fists", name: "Fists", cls: "melee", delivery: "melee", range: 1.6, arc: 70, maxTargets: 1, windup: 0.05,
    destroys: "none", stack: 1,
    tiers: [T(1, 0, { damage: 8, rate: 0.4, knockback: 0.5 }), T(1, 0, { damage: 8, rate: 0.4 }), T(1, 0, { damage: 8, rate: 0.4 })],
  },
  {
    id: "sunbrand", name: "Sunbrand", cls: "melee", delivery: "melee", range: 2.4, arc: 110, maxTargets: 3, windup: 0.12,
    destroys: "light", stack: 1,
    tiers: [T(1, 60, { damage: 18, rate: 0.45, block: 0.7 }), T(6, 300, { damage: 24, rate: 0.45, block: 0.75 }), T(12, 900, { damage: 31, rate: 0.45, block: 0.8 })],
  },
  {
    id: "riverstaff", name: "Riverstaff", cls: "melee", delivery: "melee", range: 3.0, arc: 150, maxTargets: 4, windup: 0.1,
    destroys: "light", stack: 1,
    tiers: [T(1, 60, { damage: 13, rate: 0.4, block: 0.5, knockback: 3 }), T(6, 300, { damage: 18, rate: 0.4, block: 0.55, knockback: 3.5 }), T(12, 900, { damage: 23, rate: 0.4, block: 0.6, knockback: 4 })],
  },
  {
    id: "axe", name: "Bearded Axe", cls: "melee", delivery: "melee", range: 2.2, arc: 90, maxTargets: 2, windup: 0.25,
    destroys: "light", stack: 1,
    tiers: [T(1, 60, { damage: 30, rate: 0.8, heavy: 66, heavyTime: 0.8 }), T(6, 300, { damage: 41, rate: 0.8, heavy: 90, heavyTime: 0.75 }), T(12, 900, { damage: 52, rate: 0.8, heavy: 114, heavyTime: 0.7 })],
  },
  {
    id: "hammer", name: "Quarry Hammer", cls: "melee", delivery: "melee", range: 2.3, arc: 100, maxTargets: 3, windup: 0.35,
    destroys: "heavy", stack: 1,
    tiers: [T(1, 60, { damage: 40, rate: 1.1, heavy: 55, heavyTime: 1.0, radius: 3, cooldown: 6 }), T(6, 300, { damage: 54, rate: 1.1, heavy: 74, heavyTime: 1.0, radius: 3.5, cooldown: 6 }), T(12, 900, { damage: 70, rate: 1.1, heavy: 96, heavyTime: 1.0, radius: 4, cooldown: 6 })],
  },
  {
    id: "hexquill", name: "Hexquill", cls: "magic", delivery: "projectile", range: 40, speed: 45, gravity: 0,
    destroys: "light", stack: 1,
    tiers: [T(1, 60, { damage: 15, rate: 0.4, heat: 12, pierce: 0 }), T(6, 300, { damage: 20, rate: 0.4, heat: 14, pierce: 1 }), T(12, 900, { damage: 26, rate: 0.4, heat: 16, pierce: 2 })],
  },
  {
    id: "emberglass", name: "Emberglass Staff", cls: "magic", delivery: "projectile", range: 35, speed: 28, gravity: 0,
    destroys: "heavy", stack: 1,
    tiers: [T(1, 60, { damage: 24, splash: 12, radius: 2, burn: 4, rate: 0.8, heat: 5 }), T(6, 300, { damage: 32, splash: 16, radius: 2.5, burn: 5, rate: 0.8, heat: 6 }), T(12, 900, { damage: 42, splash: 21, radius: 3, burn: 7, rate: 0.8, heat: 7 })],
  },
  {
    id: "stormcoil", name: "Stormcoil", cls: "magic", delivery: "chain", range: 22,
    destroys: "heavy", stack: 1,
    tiers: [T(1, 60, { damage: 20, rate: 0.7, heat: 6, jumps: 2 }), T(6, 300, { damage: 27, rate: 0.7, heat: 7, jumps: 3 }), T(12, 900, { damage: 35, rate: 0.7, heat: 8, jumps: 4 })],
  },
  {
    id: "carbine", name: "Pocket Carbine", cls: "ranged", delivery: "hitscan", range: 25, falloffTo: 45, falloffMin: 0.6, spread: 1.5, adsSpread: 0.3,
    destroys: "light", stack: 1,
    tiers: [T(1, 60, { damage: 9, rate: 0.25, mag: 24, reload: 1.4 }), T(6, 300, { damage: 12, rate: 0.25, mag: 28, reload: 1.3 }), T(12, 900, { damage: 16, rate: 0.25, mag: 32, reload: 1.2 })],
  },
  {
    id: "scatterpipe", name: "Scatterpipe", cls: "ranged", delivery: "pellets", range: 10, falloffTo: 22, falloffMin: 0.3, spread: 7, adsSpread: 5,
    destroys: "light", stack: 1,
    // 7 pellets × 6 / 8 / 10 damage (content.md §2.3, §2.5 "all 7 pellets").
    tiers: [T(1, 60, { damage: 6, pellets: 7, rate: 0.9, mag: 6, reload: 2.0 }), T(6, 300, { damage: 8, pellets: 7, rate: 0.9, mag: 7, reload: 1.8 }), T(12, 900, { damage: 10, pellets: 7, rate: 0.9, mag: 8, reload: 1.6 })],
  },
  {
    id: "longbow", name: "Yew Longbow", cls: "ranged", delivery: "arrow", range: 100, speed: 55, gravity: 9.8,
    destroys: "light", stack: 1,
    tiers: [T(1, 60, { damage: 45, tap: 15, rate: 0.5, draw: 1.0, headMult: 1.5, zoom: 1.8 }), T(6, 300, { damage: 61, tap: 20, rate: 0.5, draw: 0.9, headMult: 1.5, zoom: 1.8 }), T(12, 900, { damage: 75, tap: 25, rate: 0.5, draw: 0.8, headMult: 1.5, zoom: 1.8 })],
  },
  {
    id: "stillshot", name: "Stillshot Rifle", cls: "ranged", delivery: "hitscan", range: 150, spread: 4, adsSpread: 0,
    destroys: "light", stack: 1,
    tiers: [T(1, 90, { damage: 45, rate: 1.4, mag: 4, reload: 2.2, headMult: 1.8, zoom: 4 }), T(6, 450, { damage: 61, rate: 1.4, mag: 5, reload: 2.0, headMult: 1.8, zoom: 5 }), T(12, 1350, { damage: 75, rate: 1.4, mag: 5, reload: 1.8, headMult: 1.8, zoom: 6 })],
  },
  {
    id: "comet", name: "Comet Launcher", cls: "ranged", delivery: "projectile", range: 80, speed: 30, gravity: 0,
    destroys: "heavy", stack: 1,
    tiers: [T(1, 90, { damage: 70, splash: 45, radius: 3.5, rate: 1.8, mag: 1, reload: 1.8, knockback: 4 }), T(6, 450, { damage: 95, splash: 61, radius: 4, rate: 1.7, mag: 1, reload: 1.7, knockback: 4 }), T(12, 1350, { damage: 123, splash: 79, radius: 4.5, rate: 1.6, mag: 1, reload: 1.6, knockback: 4 })],
  },
  {
    id: "grenade", name: "Scrapburst Grenade", cls: "support", delivery: "thrown", range: 20, speed: 18, gravity: 9.8, fuse: 1.6,
    destroys: "heavy", stack: 5,
    tiers: [T(1, 15, { damage: 70, radius: 4, rate: 0.8, fuse: 1.6 }), T(6, 40, { damage: 95, radius: 4.5, rate: 0.8, fuse: 1.5 }), T(12, 90, { damage: 123, radius: 5, rate: 0.8, fuse: 1.4 })],
  },
  {
    id: "patchkit", name: "Patchkit", cls: "support", delivery: "heal", range: 4,
    destroys: "none", stack: 5,
    // Channel 1.0 / 0.9 / 0.8 s, then heal × the target's max HP over 2 s (content.md §2.3).
    tiers: [T(1, 25, { damage: 0, heal: 0.3, rate: 1.0, channel: 1.0, duration: 2, cooldown: 6 }), T(6, 60, { damage: 0, heal: 0.4, rate: 0.9, channel: 0.9, duration: 2, cooldown: 6 }), T(12, 120, { damage: 0, heal: 0.5, rate: 0.8, channel: 0.8, duration: 2, cooldown: 6 })],
  },
  {
    id: "bubble", name: "Prism Bubble", cls: "support", delivery: "bubble", range: 0,
    destroys: "none", stack: 1,
    tiers: [T(1, 120, { damage: 0, shell: 150, radius: 3, duration: 6, cooldown: 25, rate: 0.5 }), T(6, 400, { damage: 0, shell: 200, radius: 3.5, duration: 7, cooldown: 22, rate: 0.5 }), T(12, 1000, { damage: 0, shell: 260, radius: 4, duration: 8, cooldown: 20, rate: 0.5 })],
  },
  {
    id: "radio", name: "Radio", cls: "item", delivery: "none", range: 0,
    destroys: "none", stack: 1,
    tiers: [T(1, 100, { damage: 0, rate: 0 }), T(1, 100, { damage: 0, rate: 0 }), T(1, 100, { damage: 0, rate: 0 })],
  },
  {
    id: "tonic_small", name: "Small Tonic", cls: "item", delivery: "heal", range: 0,
    destroys: "none", stack: 10,
    tiers: [T(1, 10, { damage: 0, heal: 40, rate: 0.4, cooldown: 8, duration: 3 }), T(1, 10, { damage: 0, heal: 40, rate: 0.4 }), T(1, 10, { damage: 0, heal: 40, rate: 0.4 })],
  },
  {
    id: "tonic_large", name: "Large Tonic", cls: "item", delivery: "heal", range: 0,
    destroys: "none", stack: 10,
    tiers: [T(1, 35, { damage: 0, heal: 120, rate: 0.4, cooldown: 8, duration: 4 }), T(1, 35, { damage: 0, heal: 120, rate: 0.4 }), T(1, 35, { damage: 0, heal: 120, rate: 0.4 })],
  },
  // Horses (content/horse.ts): carry it, press H outside a safe zone. Appended last: PlayerState.weapon
  // holds indexes into this list, so existing entries never move.
  {
    id: "horse_whistle", name: "Horse Whistle", cls: "item", delivery: "none", range: 0,
    destroys: "none", stack: 1,
    tiers: [T(1, 1500, { damage: 0, rate: 0 }), T(1, 1500, { damage: 0, rate: 0 }), T(1, 1500, { damage: 0, rate: 0 })],
  },
];

export const WEAPON_INDEX: ReadonlyMap<string, number> = new Map(WEAPONS.map((w, i) => [w.id, i]));
export const WEAPON_BY_ID: ReadonlyMap<string, WeaponDef> = new Map(WEAPONS.map((w) => [w.id, w]));

export function weapon(id: string): WeaponDef {
  const w = WEAPON_BY_ID.get(id);
  if (!w) throw new Error(`unknown weapon ${id}`);
  return w;
}

/** Starter weapon per character (content.md §2.4). Order matches PlayerState.starter. */
export const STARTERS = [
  { id: "hexwick", name: "Hexwick", weapon: "hexquill" },
  { id: "ash", name: "Brother Ash", weapon: "sunbrand" },
  { id: "kappa", name: "Kappa", weapon: "riverstaff" },
  { id: "unit7", name: "Unit 7", weapon: "carbine" },
] as const;

export const PALETTE_NAMES = ["Ivory", "Sand", "Midnight", "Moss", "Ember", "Dusk"] as const;
