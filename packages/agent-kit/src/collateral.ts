// Who else an attack would hurt (review 2026-11-12 agent kit #3). `pvp: false` has to mean "this
// agent doesn't damage players", not only "it doesn't pick one as its target": the server's melee
// hits the nearest actors in the weapon's arc whoever they are, a projectile stops at the first body
// on its way, and a splash weapon hurts everyone in its radius. So before every attack the kit asks
// whether a player stands in the weapon's arc, on the projectile's path or in the blast, with
// margins for what the server sees differently (positions rewound by lag, its own facing).

import type { TierStats, WeaponDef } from "@firstlight/shared/content/weapons";
import { addScaled, dist, dot, len, norm, sub, tangent, type V3 } from "./vec.ts";

export interface Bystander {
  id: string;
  name: string;
  /** Feet position. */
  p: V3;
}

export interface AttackShape {
  melee: boolean;
  /** Melee reach, or how far a projectile flies. */
  range: number;
  /** Melee arc in degrees (the whole cone). */
  arc: number;
  /** Splash radius at the point of impact (0: none). */
  blast: number;
  /** A shot's spread in degrees (pellets, hip fire). */
  spread: number;
}

/** A chain weapon's bolt jumps on to bodies near the one it hits (m). */
const CHAIN_REACH = 8;

/** What a weapon's attack covers, from its content row (content/weapons.ts). */
export function attackShape(def: WeaponDef, tier: TierStats): AttackShape {
  const melee = def.delivery === "melee";
  const blast = def.delivery === "chain" ? CHAIN_REACH : tier.splash !== undefined || def.delivery === "thrown" ? (tier.radius ?? 0) : 0;
  return { melee, range: melee ? def.range : Math.max(def.range, def.falloffTo ?? 0), arc: def.arc ?? 90, blast, spread: def.spread ?? 0 };
}

/** Margins on the server's own geometry. */
export const COLLATERAL = {
  /** Extra melee reach (m) and arc (degrees, each side). */
  meleePad: 1.0,
  arcPad: 20,
  /** A player's width around a projectile's line (m), growing with distance for a moving body. */
  bodyRadius: 1.0,
  spreadPerM: 0.03,
  /** Extra blast radius (m). */
  blastPad: 1.5,
  /** Chest height above the feet (m). */
  chest: 1.0,
} as const;

/**
 * The first player this attack could hurt, or null. `pos` is the attacker's feet, `head` where a
 * shot leaves from, `facing` the unit ground direction it swings in, `aim` the point it shoots at
 * (the target's chest).
 */
export function bystanderAtRisk(shape: AttackShape, pos: V3, head: V3, facing: V3, aim: V3, others: readonly Bystander[]): Bystander | null {
  const up = norm(pos);
  if (shape.melee) {
    const cos = Math.cos((Math.min(180, shape.arc / 2 + COLLATERAL.arcPad) * Math.PI) / 180);
    for (const o of others) {
      const v = sub(o.p, pos);
      const d = len(v);
      if (d > shape.range + COLLATERAL.meleePad) continue;
      if (d < 0.6) return o; // on top of us: in any arc
      const flat = tangent(up, v);
      if (!flat || dot(flat, facing) >= cos) return o;
    }
    return null;
  }
  const spread = Math.tan((Math.min(45, shape.spread) * Math.PI) / 180);
  const line = sub(aim, head);
  const reach = len(line);
  const u = reach > 0.01 ? norm(line) : facing;
  for (const o of others) {
    const chest = addScaled(o.p, norm(o.p), COLLATERAL.chest);
    if (shape.blast > 0 && dist(chest, aim) <= shape.blast + COLLATERAL.blastPad) return o;
    const rel = sub(chest, head);
    const along = dot(rel, u);
    if (along < -0.5 || along > shape.range) continue; // behind us, or further than the shot flies
    const off = len(sub(rel, [u[0] * along, u[1] * along, u[2] * along]));
    if (off <= COLLATERAL.bodyRadius + (COLLATERAL.spreadPerM + spread) * Math.max(0, along)) return o;
  }
  return null;
}
