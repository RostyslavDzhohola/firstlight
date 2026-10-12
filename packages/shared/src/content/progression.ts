// Levels, HP, damage scaling, XP and coins (docs/content.md §1). Pure functions, shared by the
// server (authority) and the client (HUD previews).

export const LEVEL_CAP = 20;

const round5 = (x: number) => Math.round(x / 5) * 5;

/** XP needed to go from level L to L+1 (L = 1…19). */
export function xpToNext(level: number): number {
  if (level >= LEVEL_CAP) return 0;
  return round5(50 * Math.pow(level, 1.5));
}

/** Total XP at the start of a level. */
export function xpAtLevel(level: number): number {
  let s = 0;
  for (let l = 1; l < level; l++) s += xpToNext(l);
  return s;
}

/** Level for a total XP amount. */
export function levelForXp(xp: number): number {
  let l = 1;
  let need = xpToNext(1);
  let acc = 0;
  while (l < LEVEL_CAP && xp >= acc + need) {
    acc += need;
    l++;
    need = xpToNext(l);
  }
  return l;
}

export const maxHp = (level: number) => 100 + 10 * (level - 1);
export const damageMult = (level: number) => 1 + 0.03 * (level - 1);
export const enemyHpMult = (level: number) => 1 + 0.12 * (level - 1);
export const enemyDamageMult = (level: number) => 1 + 0.08 * (level - 1);

export type EnemyTier = "critter" | "regular" | "heavy" | "elite" | "beast" | "boss";
export const TIER_XP: Record<EnemyTier, number> = { critter: 0.3, regular: 1, heavy: 2, elite: 4, beast: 10, boss: 40 };
export const TIER_COINS: Record<EnemyTier, number> = { critter: 0, regular: 1, heavy: 2, elite: 5, beast: 15, boss: 0 };

export function diffMult(enemyLevel: number, playerLevel: number): number {
  const d = enemyLevel - playerLevel;
  if (d >= 3) return 1.25;
  if (d >= -2) return 1;
  if (d >= -4) return 0.6;
  return 0.2;
}

export function killXp(tier: EnemyTier, enemyLevel: number, playerLevel: number, repeatDecay = 1): number {
  return Math.round(TIER_XP[tier] * (10 + 5 * enemyLevel) * diffMult(enemyLevel, playerLevel) * repeatDecay);
}

export function pvpKillXp(victimLevel: number, killerLevel: number): number {
  return Math.round(2 * (10 + 5 * victimLevel) * diffMult(victimLevel, killerLevel));
}

export function killCoins(tier: EnemyTier, enemyLevel: number): number {
  return Math.round(TIER_COINS[tier] * (2 + 0.8 * enemyLevel));
}

/** Fall damage as a fraction of max HP: 0 up to 8 m, then 8% per metre (lethal at ≥ 20.5 m). */
export function fallDamageFraction(dropMetres: number): number {
  return dropMetres <= 8 ? 0 : Math.min(1, (dropMetres - 8) * 0.08);
}

/** Linear falloff between full-damage range and falloffTo, down to falloffMin. */
export function falloff(distance: number, full: number, to: number | undefined, min: number | undefined): number {
  if (distance <= full || to === undefined || min === undefined) return 1;
  if (distance >= to) return min;
  return 1 + ((min - 1) * (distance - full)) / (to - full);
}

/** Explosions fall off linearly from the centre to 25% at the edge. */
export function splashFalloff(distance: number, radius: number): number {
  if (distance >= radius) return 0;
  return 1 - 0.75 * (distance / radius);
}

export const ONBOARDING_XP = 50;
export const SELL_RATE = 0.25;
