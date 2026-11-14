// FIRSTLIGHT balance model (D-balance-1). Pure functions over the shipped catalogues
// (packages/shared/src/content/*), mirroring the server's rules:
// - weapons: apps/server/src/world/combat.ts consumeAttack (rate, magazine + reload, heat that cools one
//   shot per second and locks out 1.5 s), bow draw, charged heavies and their cooldowns, the kunai's
//   Ember Seal, burn that refreshes and never stacks, damage rounded per hit, the level multiplier;
// - creatures: apps/server/src/world/npc (attack pick = first ready attack in def order, cooldown from
//   the start, busy for telegraph + recovery) and the AI clamps in NpcSystem.hitPlayer (single hit ≤ 35%
//   of the target's max HP, bosses 60%, any sequence ≤ 80% within 1.5 s);
// - progression and coins: content/progression.ts, missions.ts, the spawn areas in npcs.ts.
// Simplifications are named where they happen. Times are seconds.

import { WEAPONS, STARTERS, type WeaponDef, type TierStats } from "../../packages/shared/src/content/weapons.ts";
import { damageMult, killCoins, killXp, LEVEL_CAP, maxHp, ONBOARDING_XP, REGEN, xpToNext } from "../../packages/shared/src/content/progression.ts";
import { AI_CAPS, aiHitCap, attackDamage, BOSS_DEFS, NPC_AREAS, NPC_DEFS, npcCoins, npcDef, npcMaxHp, npcShieldHp, type AttackDef, type NpcDef } from "../../packages/shared/src/content/npcs.ts";
import { MISSIONS } from "../../packages/shared/src/content/missions.ts";
import { STARTER_STATS, starterMaxHp, starterMove, starterSpellPower } from "../../packages/shared/src/content/starters.ts";
import { FROSTBLOOM, SPELL_BY_ID, spellDamage, wardShell, WISHFALL } from "../../packages/shared/src/content/spells.ts";

// ------------------------------------------------------------------------------------ weapons

/** Families that deal damage in a fight (support items, the radio, tonics and the whistle don't). */
export const COMBAT_FAMILIES = ["fists", "sunbrand", "riverstaff", "axe", "hammer", "hexquill", "emberglass", "stormcoil", "carbine", "scatterpipe", "longbow", "stillshot", "comet", "kunai"] as const;
export type Family = (typeof COMBAT_FAMILIES)[number];

/** The tier a level may equip (content §1.5 gates: T2 at 6, T3 at 12), as an index. */
export const gatedTier = (level: number): 0 | 1 | 2 => (level >= 12 ? 2 : level >= 6 ? 1 : 0);

export interface Hit {
  t: number;
  dmg: number;
  /** Burn this hit applies (refreshes the one burn slot, never stacks). */
  burn?: number;
}

/**
 * "plain": body hits with the primary attack only (§2.5's table: axe and hammer lights, kunai darts).
 * "full": body hits plus charged heavies and specials on their cooldowns (how a player fights).
 * "best": "full" with every head/weak-point hit the weapon rewards (combat.ts weakMult).
 */
export type Policy = "plain" | "full" | "best";

const BURN_S = 3;
const OVERHEAT_S = 1.5;

/**
 * How fast the attacker presses. "client": the shipped client's own gates (each attack waits the tier's
 * rate, charges and seals are held their full time; the game as designed). "server": the fastest cadence
 * `combat.ts` accepts, which a modified client can play every time: consumeAttack lets an attack through
 * at 0.85 × the rate (a jitter allowance), `melee()` takes a heavy charged 0.9 × heavyTime and
 * `castSpecial()` a seal held 0.9 × heavyTime. Reloads, heat, draws and cooldowns are exact on both.
 */
export type Cadence = "client" | "server";
/** combat.ts consumeAttack: `now - lastAttackAt < rate × 0.85` is refused. */
export const SERVER_RATE_ALLOWANCE = 0.85;
/** combat.ts melee() / castSpecial(): a charge or seal held 90% of heavyTime counts. */
export const SERVER_CHARGE_ALLOWANCE = 0.9;

/**
 * Every damaging hit one attacker lands on one target that is always in reach, from the first press at
 * t = 0 (pre-drawn bows, pre-charged heavies and a pre-held seal, as §2.5 counts), up to `horizon`.
 * Melee damage lands on the press, as the server's `melee()` applies it (D-balance-5: the catalogue's
 * `windup` is not a delay in the game). Projectile travel time is ignored unless `distance` is set.
 */
export interface TimelineOptions {
  /** Bow drawn, heavy charged and seal held before the first press (§2.5 counts it so). Default true. */
  preheld?: boolean;
  /** Target distance (m): projectile hits land distance / speed after release. Default 0 (point-blank). */
  distance?: number;
  /** Default "client". */
  cadence?: Cadence;
}

export function hitTimeline(def: WeaponDef, tierIndex: number, level: number, policy: Policy, horizon = 60, opts: TimelineOptions = {}): Hit[] {
  const preheld = opts.preheld ?? true;
  const server = opts.cadence === "server";
  const rk = server ? SERVER_RATE_ALLOWANCE : 1;
  const ck = server ? SERVER_CHARGE_ALLOWANCE : 1;
  const flight = (w: WeaponDef) => (opts.distance && (w.delivery === "projectile" || w.delivery === "arrow") ? opts.distance / (w.speed ?? 30) : 0);
  const tier = def.tiers[tierIndex]!;
  const lvl = damageMult(level);
  const hits: Hit[] = [];
  const round = (x: number) => Math.max(1, Math.round(x));
  // combat.ts weakMult: every projectile, pellet and hitscan hit on the head takes the tier's headMult (1.5 default).
  const weak = policy === "best" && def.delivery !== "melee" && def.delivery !== "chain" && def.delivery !== "thrown" ? (tier.headMult ?? 1.5) : 1;
  // The kunai's Ember Seal (policy "full"/"best"): a hand seal held heavyTime, cast on the tier's cooldown,
  // ignoring the throw rate and the reload. A throw breaks the seal (D-balance-7: combat.ts fire() drops the
  // charge, the client throws nothing while a seal is held), so the hold starts after the last dart, and the
  // seal's markAttack() restarts the rate gate: the next dart waits the rate after it (review finding 2).
  // The client starts a hold only once the cooldown is over; the server times the hold alone (0.9 × heavyTime).
  const seal = def.special && policy !== "plain" && tier.cooldown ? WEAPONS.find((w) => w.id === def.special) : undefined;
  const holdS = (tier.heavyTime ?? 0.4) * ck;
  let sealCdAt = 0;
  let t = 0;
  let last = -Infinity;
  let mag = tier.mag;
  let heat = 0;
  let heavyReadyAt = 0;
  let thrown = 0;
  for (let guard = 0; guard < 10_000 && t <= horizon; guard++) {
    // The seal goes as soon as its cooldown is up by the next press (pre-held at t = 0 when `preheld`), unless the
    // dart due now doesn't delay it (the hold, restarted after that dart, still ends by the same time).
    const sealAt = (after: number) => (server ? Math.max(sealCdAt, after + holdS) : Math.max(sealCdAt, after) + holdS);
    const s = t === 0 && last === -Infinity && preheld ? 0 : sealAt(Math.max(0, last));
    if (seal && sealCdAt <= t + 1e-9 && sealAt(t) > s + 1e-9) {
      const st = seal.tiers[tierIndex]!;
      // The fireball's head hit takes the seal tier's own headMult (combat.ts weakMult on the projectile's tier).
      hits.push({ t: s + flight(seal), dmg: round(st.damage * lvl * (policy === "best" ? (st.headMult ?? 1.5) : 1)), burn: st.burn });
      sealCdAt = s + tier.cooldown!;
      last = s;
      t = Math.max(t, s + tier.rate * rk);
    }
    let dmg = tier.damage;
    let at = t;
    let gap = tier.rate * rk;
    if (def.delivery === "arrow") {
      // Full draws only: the server times the draw from the charge start, restarted after each shot (exact).
      gap = Math.max(tier.rate * rk, tier.draw ?? 1);
      if (t === 0 && !preheld) at = tier.draw ?? 1;
    } else if (tier.heavy !== undefined && policy !== "plain" && heavyReadyAt <= t) {
      // Charged heavy (axe chop, hammer slam): every melee resets the charge, so it is held from the last hit.
      // Heavy first: a light then a heavy is never quicker (its gap is max(rate, charge), the other way the rate).
      dmg = tier.heavy;
      if (t > 0 || !preheld) at = Math.max(t, (t > 0 ? last : 0) + (tier.heavyTime ?? 1) * ck);
      if (tier.cooldown) heavyReadyAt = at + tier.cooldown;
    } else if (def.delivery === "pellets") {
      dmg = tier.damage * (tier.pellets ?? 6);
    } else if (def.delivery === "thrown" && ++thrown > def.stack) break;
    hits.push({ t: at + flight(def) + (def.delivery === "thrown" ? (tier.fuse ?? def.fuse ?? 0) : 0), dmg: def.delivery === "pellets" ? (tier.pellets ?? 6) * round(tier.damage * lvl * weak) : round(dmg * lvl * weak), burn: tier.burn });
    // consumeAttack: magazine + reload, heat cooling one shot per second, the 1.5 s lockout.
    let ready = at + gap;
    if (mag !== undefined) {
      mag -= 1;
      if (mag <= 0) {
        mag = tier.mag;
        ready = Math.max(ready, at + (tier.reload ?? 1.5));
      }
    }
    if (tier.heat !== undefined) {
      heat = Math.max(0, heat - (last === -Infinity ? 0 : at - last)) + 1;
      if (heat >= tier.heat) {
        heat = 0;
        ready = Math.max(ready, at + OVERHEAT_S);
      }
    }
    last = at;
    t = ready;
  }
  return hits.sort((a, b) => a.t - b.t);
}

/** Damage dealt by `T` (inclusive): instant hits plus the one refreshing burn slot, burning continuously. */
export function damageBy(hits: readonly Hit[], T: number): number {
  let sum = 0;
  let burn: { per: number; from: number; until: number } | null = null;
  const settle = (to: number) => {
    if (burn) sum += burn.per * Math.max(0, Math.min(burn.until, to) - burn.from);
  };
  for (const h of hits) {
    if (h.t > T) break;
    sum += h.dmg;
    if (h.burn) {
      settle(h.t);
      burn = { per: h.burn, from: h.t, until: h.t + BURN_S };
    }
  }
  settle(T);
  return sum;
}

/** Time (from t = 0) at which `hp` is gone, and the number of direct hits it took; null if never in the horizon. */
export function timeToKill(hits: readonly Hit[], hp: number): { t: number; hits: number } | null {
  let sum = 0;
  let burn: { per: number; from: number; until: number } | null = null;
  for (let i = 0; i < hits.length; i++) {
    const h = hits[i]!;
    // Burn between the previous event and this one.
    if (burn) {
      const end = Math.min(burn.until, h.t);
      const gain = burn.per * Math.max(0, end - burn.from);
      if (sum + gain >= hp) return { t: burn.from + (hp - sum) / burn.per, hits: i };
      sum += gain;
      burn.from = end;
    }
    sum += h.dmg;
    if (sum >= hp) return { t: h.t, hits: i + 1 };
    if (h.burn) burn = { per: h.burn, from: h.t, until: h.t + BURN_S };
  }
  if (burn && sum + burn.per * (burn.until - burn.from) >= hp) return { t: burn.from + (hp - sum) / burn.per, hits: hits.length };
  return null;
}

export interface WeaponRow {
  family: Family;
  name: string;
  cls: string;
  tier: number;
  level: number;
  sustainedDps: number;
  burstDps: number;
  biggestHit: number;
}

const SUSTAIN_S = 60;
const BURST_S = 3;

/** Sustained DPS ("full" policy over 60 s, limits and cooldowns included) and burst DPS ("best", first 3 s) at the tier's gate level. */
export function weaponRow(family: Family, tierIndex: number, level = [1, 6, 12][tierIndex]!): WeaponRow {
  const def = WEAPONS.find((w) => w.id === family)!;
  const body = hitTimeline(def, tierIndex, level, "full", SUSTAIN_S);
  const best = hitTimeline(def, tierIndex, level, "best", BURST_S);
  const inWindow = (hs: Hit[], w: number) => hs.filter((h) => h.t < w);
  return {
    family, name: def.name, cls: def.cls, tier: tierIndex + 1, level,
    sustainedDps: damageBy(inWindow(body, SUSTAIN_S), SUSTAIN_S) / SUSTAIN_S,
    burstDps: damageBy(inWindow(best, BURST_S), BURST_S) / BURST_S,
    biggestHit: Math.max(...best.map((h) => h.dmg)),
  };
}

export function weaponTable(): WeaponRow[] {
  return COMBAT_FAMILIES.flatMap((f) => (f === "fists" ? [weaponRow(f, 0)] : [0, 1, 2].map((i) => weaponRow(f, i))));
}

// ------------------------------------------------------------------------------------ PvP

export const PVP_LEVELS = [1, 6, 12, 20] as const;

/** Families §2.5 counts as burst (headshot, direct rocket, point-blank pellets): a lower floor. */
export const BURST_FAMILIES: readonly Family[] = ["scatterpipe", "stillshot", "comet"];

export interface PvpCell {
  family: Family;
  level: number;
  targetHp: number;
  cadence: Cadence;
  /** Seconds from the first hit to the kill, "plain" policy (§2.5 format), and the hits it took. */
  ttk: number;
  hits: number;
  /** "full" policy (heavies and specials as openers, then on cooldown): the opener floor. */
  openerTtk: number;
  openerHits: number;
  /** "best" policy (plus headshots), seconds from the first hit. */
  bestTtk: number;
  bestHits: number;
  /** Largest single hit / target HP. */
  biggestShare: number;
}

/** TTK at equal level with the gated tier against a target of `targetHp` (default: the base curve), at the client's or the server's cadence. */
export function pvpCell(family: Family, level: number, targetHp = maxHp(level), tierIndex: number = family === "fists" ? 0 : gatedTier(level), cadence: Cadence = "client"): PvpCell {
  const def = WEAPONS.find((w) => w.id === family)!;
  const body = hitTimeline(def, tierIndex, level, "plain", 120, { cadence });
  const full = hitTimeline(def, tierIndex, level, "full", 120, { cadence });
  const best = hitTimeline(def, tierIndex, level, "best", 120, { cadence });
  const k = timeToKill(body, targetHp)!;
  const kf = timeToKill(full, targetHp)!;
  const kb = timeToKill(best, targetHp)!;
  return {
    family, level, targetHp, cadence,
    ttk: k.t - body[0]!.t, hits: k.hits,
    openerTtk: kf.t - full[0]!.t, openerHits: kf.hits,
    bestTtk: kb.t - best[0]!.t, bestHits: kb.hits,
    biggestShare: Math.max(...best.map((h) => h.dmg)) / targetHp,
  };
}

export function pvpMatrix(): PvpCell[] {
  return COMBAT_FAMILIES.flatMap((f) => PVP_LEVELS.map((l) => pvpCell(f, l)));
}

// ------------------------------------------------------------------------------------ starters

/** Duels start this far apart: a close engagement (cover, woods, town edges), inside every ranged starter's full-damage range. */
export const DUEL_DISTANCE_M = 10;
/** Roll i-frames (content §0: 0.05–0.30 s) and the share of cooldowns a dueller spends rolling. */
export const IFRAME_S = 0.25;
export const ROLL_USE = 0.5;

/** Effective HP multiplier from rolling: the share of incoming hits that land in i-frames is avoided. */
export function dodgeFactor(dodgeCooldown: number): number {
  return 1 / (1 - (IFRAME_S / dodgeCooldown) * ROLL_USE);
}

export interface DuelCell {
  attacker: number;
  defender: number;
  level: number;
  /** Seconds until the attacker's first hit: sprinting into reach (both melee starters close in). */
  closeS: number;
  /** "full" policy, nothing pre-held, projectile flight included: seconds from reach to the kill (defender's HP × its roll factor). */
  ttk: number;
  /** closeS + ttk: the attacker's time to win, both standing their ground once in reach. */
  total: number;
}

/** Seconds until `a` (reach ra, sprint va) can hit `b` (reach rb, sprint vb), both closing while out of their own reach. */
export function closingTime(ra: number, va: number, rb: number, vb: number, d0 = DUEL_DISTANCE_M): number {
  let d = d0;
  let t = 0;
  const dt = 0.01;
  while (d > ra && t < 60) {
    d -= (va + (d > rb ? vb : 0)) * dt;
    t += dt;
  }
  return t;
}

export function starterDuels(): DuelCell[] {
  const out: DuelCell[] = [];
  const reach = (i: number) => WEAPONS.find((w) => w.id === STARTERS[i]!.weapon)!.range;
  for (const level of PVP_LEVELS) {
    for (let a = 0; a < STARTERS.length; a++) {
      for (let d = 0; d < STARTERS.length; d++) {
        if (a === d) continue;
        const closeS = closingTime(reach(a), starterMove(a).sprint, reach(d), starterMove(d).sprint);
        const def = WEAPONS.find((w) => w.id === STARTERS[a]!.weapon)!;
        const hp = starterMaxHp(d, level) * dodgeFactor(starterMove(d).dodgeCooldown);
        // Seen at the same moment: nothing pre-held; projectiles fly the gap still open when they fire.
        const gap = Math.min(DUEL_DISTANCE_M, Math.max(reach(a), reach(d)));
        const ttk = timeToKill(hitTimeline(def, gatedTier(level), level, "full", 120, { preheld: false, distance: def.cls === "melee" ? 0 : gap }), hp)!.t;
        out.push({ attacker: a, defender: d, level, closeS, ttk, total: closeS + ttk });
      }
    }
  }
  return out;
}

export interface DuelResult {
  a: number;
  b: number;
  level: number;
  /** b's time to win ÷ a's: > 1 means a wins. */
  ratio: number;
}

/** Every pairing once per level: who wins the stand-up duel and by how much. */
export function duelResults(cells = starterDuels()): DuelResult[] {
  const out: DuelResult[] = [];
  for (const c of cells) {
    if (c.attacker > c.defender) continue;
    const back = cells.find((x) => x.attacker === c.defender && x.defender === c.attacker && x.level === c.level)!;
    out.push({ a: c.attacker, b: c.defender, level: c.level, ratio: back.total / c.total });
  }
  return out;
}

/** Matchups (of 4 opponents × 4 levels) each starter wins. */
export function duelWins(results = duelResults()): number[] {
  const wins = STARTERS.map(() => 0);
  for (const r of results) wins[r.ratio > 1 ? r.a : r.b]! += 1;
  return wins;
}

export interface StarterProfile {
  index: number;
  name: string;
  hp: number;
  sprint: number;
  dodgeCooldown: number;
  /** Own starter weapon, sustained DPS at L6 (T2). */
  dps: number;
  /** Own weapon reach (m). */
  reach: number;
  spellPower: number;
}

export function starterProfiles(): StarterProfile[] {
  return STARTERS.map((s, i) => {
    const m = starterMove(i);
    const def = WEAPONS.find((w) => w.id === s.weapon)!;
    return {
      index: i, name: s.name, hp: starterMaxHp(i, 1), sprint: m.sprint, dodgeCooldown: m.dodgeCooldown,
      dps: weaponRow(s.weapon as Family, 1).sustainedDps, reach: def.range, spellPower: STARTER_STATS[i]?.spellPower ?? 1,
    };
  });
}

/** Pairs (a, b) where a is at least as good as b on every axis and better on one: "strictly best". */
export function dominations(profiles = starterProfiles()): [string, string][] {
  const axes = (p: StarterProfile) => [p.hp, p.sprint, -p.dodgeCooldown, p.dps, p.reach];
  const out: [string, string][] = [];
  for (const a of profiles) {
    for (const b of profiles) {
      if (a === b) continue;
      const xa = axes(a), xb = axes(b);
      if (xa.every((v, i) => v >= xb[i]!) && xa.some((v, i) => v > xb[i]!)) out.push([a.name, b.name]);
    }
  }
  return out;
}

/** A pack around you spreads over a half circle: an arc of `arc`° catches arc/180 of the targets it may hit. */
export const PACK_SPREAD_DEG = 180;
export const PACK_SIZE = 4;

/** Seconds a starter needs to clear PACK_SIZE on-level Dusk Wolves with its own weapon (gated tier): arcs cleave, pierce adds half a target. */
export function starterPackClear(starter: number, level: number): number {
  const def = WEAPONS.find((w) => w.id === STARTERS[starter]!.weapon)!;
  const tier = def.tiers[gatedTier(level)]!;
  const wolfHp = npcMaxHp(npcDef("dusk_wolf"), level);
  const hp = Array.from({ length: PACK_SIZE }, () => wolfHp);
  const per = def.delivery === "melee" ? Math.max(1, ((def.maxTargets ?? 1) * Math.min(PACK_SPREAD_DEG, def.arc ?? 90)) / PACK_SPREAD_DEG) : 1 + 0.5 * (tier.pierce ?? 0);
  let carry = 0;
  for (const h of hitTimeline(def, gatedTier(level), level, "full", 300)) {
    const alive = hp.map((x, i) => [x, i] as const).filter(([x]) => x > 0);
    if (!alive.length) break;
    carry += Math.min(per, alive.length);
    const n = Math.floor(carry);
    carry -= n;
    for (const [, i] of alive.slice(0, n)) hp[i]! -= h.dmg + (h.burn ?? 0) * BURN_S;
    if (hp.every((x) => x <= 0)) return h.t + (PACK_SIZE - 1) * RETARGET_S / (per >= 2 ? 2 : 1);
  }
  return Infinity;
}

export interface StarterRoles {
  name: string;
  /** Duel matchups won (of 4 opponents × 4 levels). */
  duelWins: number;
  /** Mean pack-clear seconds over the PvP levels (lower is better). */
  packClear: number;
  /** Max HP × roll factor at level 1. */
  survival: number;
  /** Max HP at level 1. */
  toughness: number;
  /** Rolls per minute. */
  evasion: number;
  /** Sprint m/s. */
  mobility: number;
  spellPower: number;
}

export function starterRoles(): StarterRoles[] {
  const wins = duelWins();
  return STARTERS.map((s, i) => ({
    name: s.name,
    duelWins: wins[i]!,
    packClear: PVP_LEVELS.reduce((sum, l) => sum + starterPackClear(i, l), 0) / PVP_LEVELS.length,
    survival: starterMaxHp(i, 1) * dodgeFactor(starterMove(i).dodgeCooldown),
    toughness: starterMaxHp(i, 1),
    evasion: 60 / starterMove(i).dodgeCooldown,
    mobility: starterMove(i).sprint,
    spellPower: STARTER_STATS[i]?.spellPower ?? 1,
  }));
}

/** For each role, the starter(s) at the top. */
export function roleLeaders(roles = starterRoles()): Record<"duel" | "crowd" | "toughness" | "evasion" | "mobility" | "magic", string[]> {
  const top = (f: (r: StarterRoles) => number) => {
    const best = Math.max(...roles.map(f));
    return roles.filter((r) => Math.abs(f(r) - best) < 1e-9).map((r) => r.name);
  };
  return { duel: top((r) => r.duelWins), crowd: top((r) => -r.packClear), toughness: top((r) => r.toughness), evasion: top((r) => r.evasion), mobility: top((r) => r.mobility), magic: top((r) => r.spellPower) };
}

// ------------------------------------------------------------------------------------ spells

// The spellbook (content §2.7) per starter: spell damage and the ward's shell scale with the starter's
// spell power (content §8.5), applied in apps/server/src/world/spells/SpellSystem.ts. The duels above
// don't cast: putting spells into them would re-tune every duel band, so the spell checks stand apart.

/** Levels the spell tables show: Frostbloom's, Wishfall's and the ward's unlocks, then the PvP levels. */
export const SPELL_LEVELS = [3, 6, 9, 12, 20] as const;

/** A hit as the server lands it (dealDamage rounds each one). */
const landed = (x: number) => Math.max(1, Math.round(x));

export interface SpellRow {
  starter: number;
  name: string;
  power: number;
  level: number;
  /** Frostbloom's hit, Wishfall's centre (0 below their unlock levels) and the ward's shell. */
  frostbloom: number;
  wishfall: number;
  ward: number;
}

export function spellRows(): SpellRow[] {
  const at = (id: string, level: number, x: number) => (level >= SPELL_BY_ID.get(id)!.level ? x : 0);
  return STARTERS.flatMap((s, i) => SPELL_LEVELS.map((level) => {
    const power = starterSpellPower(i);
    return {
      starter: i, name: s.name, power, level,
      frostbloom: at("frostbloom", level, landed(spellDamage(FROSTBLOOM.damage, level, power))),
      wishfall: at("wishfall", level, landed(spellDamage(WISHFALL.damage, level, power))),
      ward: at("glasswing", level, wardShell(starterMaxHp(i, level), power)),
    };
  }));
}

/** The most fragile starter's max HP at `level`. */
export const frailHp = (level: number) => Math.min(...STARTERS.map((_, i) => starterMaxHp(i, level)));

export interface SpellPeaks {
  /** Largest single spell hit (Wishfall's centre) ÷ an equal-level target's HP: base body, most fragile starter. */
  hitOfBase: number;
  hitOfFrail: number;
  /** Largest hit that lands with no warning (Frostbloom) ÷ base HP. */
  instantOfBase: number;
  /** The opening pair (Frostbloom + Wishfall's centre) ÷ the most fragile starter's HP. */
  pairOfFrail: number;
}

/** The worst case over every starter as the caster and every level a spell is open at. */
export function spellPeaks(): SpellPeaks {
  const out: SpellPeaks = { hitOfBase: 0, hitOfFrail: 0, instantOfBase: 0, pairOfFrail: 0 };
  for (let i = 0; i < STARTERS.length; i++) {
    const power = starterSpellPower(i);
    for (let level = SPELL_BY_ID.get("frostbloom")!.level; level <= LEVEL_CAP; level++) {
      const f = landed(spellDamage(FROSTBLOOM.damage, level, power));
      const w = level >= SPELL_BY_ID.get("wishfall")!.level ? landed(spellDamage(WISHFALL.damage, level, power)) : 0;
      out.instantOfBase = Math.max(out.instantOfBase, f / maxHp(level));
      out.hitOfBase = Math.max(out.hitOfBase, w / maxHp(level));
      out.hitOfFrail = Math.max(out.hitOfFrail, w / frailHp(level));
      out.pairOfFrail = Math.max(out.pairOfFrail, (f + w) / frailHp(level));
    }
  }
  return out;
}

/**
 * Levels at which a Frostbloom and one weapon hit landing together (nothing holds a weapon back
 * after a cast) take a full-HP, equal-level target of `hp(level)` down: the weapon hit is the
 * biggest there is, a Stillshot headshot at the gated tier. The target has to be within the
 * nova's 5 m. A known dip under the 0.75 s floor (content §2.7, D-spells-9); reported, not a check.
 */
export function novaHeadshotLevels(power: number, hp: (level: number) => number = maxHp): number[] {
  const still = WEAPONS.find((w) => w.id === "stillshot")!;
  const out: number[] = [];
  for (let level = SPELL_BY_ID.get("frostbloom")!.level; level <= LEVEL_CAP; level++) {
    const t = still.tiers[gatedTier(level)]!;
    const head = landed(t.damage * damageMult(level) * (t.headMult ?? 1.5));
    if (landed(spellDamage(FROSTBLOOM.damage, level, power)) + head >= hp(level)) out.push(level);
  }
  return out;
}

// ------------------------------------------------------------------------------------ creatures

/** Expected player level where a creature of level E lives: on level, inside the cap. */
export const expectedPlayerLevel = (enemyLevel: number) => Math.max(1, Math.min(LEVEL_CAP, enemyLevel));

/** Every level range a creature appears at (per planet for wildlife), as [min, max] pairs. */
export function creatureLevels(def: NpcDef): [number, number][] {
  return def.levelsByPlanet ? Object.values(def.levelsByPlanet) : [def.levels];
}

/** Hostile and neutral creatures a player fights (not eggs, not bosses). */
export const FIGHT_DEFS = NPC_DEFS.filter((d) => d.family !== "egg" && d.tier !== "boss");

/** Seconds for one player with each starter's weapon (gated tier) to kill the creature, from the first press. */
export function playerKillsCreature(def: NpcDef, enemyLevel: number, playerLevel = expectedPlayerLevel(enemyLevel)): { min: number; median: number; max: number } {
  // The Enforcer's riot shield blocks frontal damage until broken: count it (a head-on fight).
  const hp = npcMaxHp(def, enemyLevel) + npcShieldHp(def, enemyLevel);
  const times = STARTERS.map((s) => {
    const w = WEAPONS.find((x) => x.id === s.weapon)!;
    const k = timeToKill(hitTimeline(w, gatedTier(playerLevel), playerLevel, "full", 300), hp);
    return k ? k.t : Infinity;
  }).sort((a, b) => a - b);
  return { min: times[0]!, median: times[2]!, max: times[4]! };
}

const isMelee = (a: AttackDef) => a.shape === "arc" || a.shape === "ring" || a.shape === "charge" || a.shape === "leap" || a.shape === "line";

/** Damage events one creature lands on a player who never dodges and is always in every attack's range. */
export function creatureTimeline(def: NpcDef, enemyLevel: number, horizon = 120, start = 0, landRate = 1): { t: number; dmg: number }[] {
  const attacks = def.attacks.filter((a) => !a.timed && (a.damage > 0));
  const cd = attacks.map(() => start);
  const out: { t: number; dmg: number }[] = [];
  let t = start;
  for (let guard = 0; guard < 5000 && t < horizon; guard++) {
    const i = attacks.findIndex((_, k) => cd[k]! <= t + 1e-9);
    if (i < 0) {
      t = Math.min(...cd);
      continue;
    }
    const a = attacks[i]!;
    cd[i] = t + a.cooldown;
    // Bursts and fans land every round on a still target; ground circles put one under each player.
    const rounds = a.shape === "burst" || a.shape === "bolt" ? (a.count ?? 1) : a.ticks ?? 1;
    const gap = a.interval ?? 0;
    for (let r = 0; r < rounds; r++) out.push({ t: t + a.telegraph + r * gap, dmg: attackDamage(a, enemyLevel) * landRate });
    t += a.telegraph + (rounds - 1) * gap + a.recovery;
  }
  return out.sort((x, y) => x.t - y.t);
}

/** Apply the AI clamps (NpcSystem.hitPlayer) to merged events from one or more creatures of a tier. */
export function clampHits(events: { t: number; dmg: number }[], tier: NpcDef["tier"], targetMaxHp: number): { t: number; dmg: number }[] {
  const recent: { t: number; amt: number }[] = [];
  const out: { t: number; dmg: number }[] = [];
  for (const e of events) {
    let dmg = Math.min(e.dmg, aiHitCap(tier, targetMaxHp));
    const used = recent.filter((h) => e.t - h.t < AI_CAPS.sequenceMs / 1000).reduce((s, h) => s + h.amt, 0);
    dmg = Math.min(dmg, AI_CAPS.sequence * targetMaxHp - used);
    if (dmg < 0.5) continue;
    recent.push({ t: e.t, amt: dmg });
    out.push({ t: e.t, dmg: Math.max(1, Math.round(dmg)) });
  }
  return out;
}

/** Attackers a pack can field on one player at once (attack tokens, content §3.1). */
export function packAttackers(def: NpcDef, packSize: number): number {
  const ranged = def.attacks.some((a) => !a.timed && a.damage > 0 && !isMelee(a));
  const tokens = ranged ? (def.planet === "meridian" ? 3 : 2) : 2;
  return Math.min(packSize, tokens);
}

/**
 * Seconds a creature (or `count` of them, 0.4 s apart: the token stagger) takes to kill an on-level
 * player with `hp`, every attack landing × `landRate` (1 = a player who never dodges).
 */
export function creatureKillsPlayer(def: NpcDef, enemyLevel: number, hp: number, count = 1, landRate = 1): number {
  const merged = Array.from({ length: count }, (_, k) => creatureTimeline(def, enemyLevel, 300, k * 0.4, landRate)).flat().sort((a, b) => a.t - b.t);
  let sum = 0;
  for (const e of clampHits(merged, def.tier, hp)) {
    sum += e.dmg;
    if (sum >= hp) return e.t;
  }
  return Infinity;
}

/** Players dodge telegraphed attacks: the share of creature damage the model assumes lands in a real fight. */
export const LAND_RATE = 0.5;
/** Seconds between kills in a pack fight (turn, re-aim, the next one closing in). */
export const RETARGET_S = 0.5;

export interface CreatureRow {
  id: string;
  name: string;
  tier: string;
  enemyLevel: number;
  playerLevel: number;
  hp: number;
  /** Median of the five starter weapons, seconds. */
  ttkMedian: number;
  ttkMin: number;
  ttkMax: number;
  biggestShare: number;
  /** One creature, every hit landing, on a base-HP on-level player. */
  killsPlayerS: number;
  /** Pack fight: time to clear a full pack vs time the pack needs to kill the player at LAND_RATE. */
  packSize: number;
  packClearS: number;
  packKillsPlayerS: number;
  /** packKillsPlayer / packClear: > 1 the player wins without a tonic. */
  margin: number;
}

export function creatureRows(): CreatureRow[] {
  const rows: CreatureRow[] = [];
  for (const def of FIGHT_DEFS) {
    for (const [lo, hi] of creatureLevels(def)) {
      for (const E of lo === hi ? [lo] : [lo, hi]) {
        const L = expectedPlayerLevel(E);
        const hp = maxHp(L);
        const k = playerKillsCreature(def, E, L);
        const pack = def.pack[1];
        const attackers = def.temper === "hostile" ? packAttackers(def, pack) : 1;
        const packClear = pack * k.median + (pack - 1) * RETARGET_S;
        const packKills = creatureKillsPlayer(def, E, hp, attackers, LAND_RATE);
        const biggest = Math.max(0, ...def.attacks.filter((a) => !a.timed).map((a) => Math.min(attackDamage(a, E), aiHitCap(def.tier, hp)) / hp));
        rows.push({
          id: def.id, name: def.name, tier: def.tier, enemyLevel: E, playerLevel: L, hp: npcMaxHp(def, E) + npcShieldHp(def, E),
          ttkMedian: k.median, ttkMin: k.min, ttkMax: k.max, biggestShare: biggest,
          killsPlayerS: creatureKillsPlayer(def, E, hp), packSize: pack, packClearS: packClear, packKillsPlayerS: packKills,
          margin: packKills / packClear,
        });
      }
    }
  }
  return rows;
}

// ------------------------------------------------------------------------------------ regeneration (#77)

export interface RegenSafety {
  /** Longest pause between one creature's attacks on a player it fights (any fight creature, any of its levels), s. */
  creatureGapS: number;
  creatureGapId: string;
  /** The slowest starter weapon's time between attacks, s. */
  starterSwingS: number;
  /** Seconds regeneration needs from 0 to full health. */
  fullS: number;
  /** HP regenerated in the time of the quickest on-level regular's kill of an idle player, ÷ max HP. */
  regenInFightShare: number;
}

/**
 * Regeneration can't out-heal a fight (#77): it waits REGEN.DELAY_S without damage taken or dealt,
 * so a fight where the creature attacks, or the player swings, more often than that never sees it.
 */
export function regenSafety(): RegenSafety {
  let creatureGapS = 0;
  let creatureGapId = "";
  for (const def of FIGHT_DEFS) {
    if (def.temper !== "hostile") continue; // neutral beasts only fight back: the player's swings hold the tag
    for (const [lo, hi] of creatureLevels(def)) {
      for (const E of lo === hi ? [lo] : [lo, hi]) {
        const ev = creatureTimeline(def, E, 120);
        for (let i = 1; i < ev.length; i++) {
          const gap = ev[i]!.t - ev[i - 1]!.t;
          if (gap > creatureGapS) {
            creatureGapS = gap;
            creatureGapId = `${def.id} L${E}`;
          }
        }
      }
    }
  }
  const starterSwingS = Math.max(...STARTERS.map((s) => WEAPON_BY_ID_LOCAL.get(s.weapon)!.tiers[0]!.rate));
  const fullS = 1 / REGEN.PER_SEC;
  // Even if it did run, the share of HP it could add in the time a regular kills an idle player.
  const quick = Math.min(...creatureRows().filter((r) => r.tier === "regular").map((r) => r.killsPlayerS));
  return { creatureGapS, creatureGapId, starterSwingS, fullS, regenInFightShare: REGEN.PER_SEC * quick };
}

const WEAPON_BY_ID_LOCAL = new Map(WEAPONS.map((w) => [w.id as string, w]));

// ------------------------------------------------------------------------------------ bosses

export interface BossRow {
  id: string;
  level: number;
  hp2: number;
  /** Minutes for two on-level players on gated starter weapons. */
  killMin: number;
}

/**
 * Two players, each at the median starter sustained DPS. Armoured bosses take `armour` except in the
 * weak window (plates: hold, then `window` s at 100% with the weak point ×weakMult on half the hits,
 * then the plates' cooldown); players attack 70% of the time (telegraphs, mechanics, moving).
 */
export function bossRows(): BossRow[] {
  return BOSS_DEFS.map((b) => {
    const def = npcDef(b.id);
    const L = b.level - 1; // the content's model: two players one level under the boss
    const dps = median(STARTERS.map((s) => weaponRow(s.weapon as Family, gatedTier(L), L).sustainedDps));
    let mult = def.armour ?? 1;
    if (b.plates) {
      const cycle = b.plates.hold + b.plates.window + b.plates.cooldown;
      const open = b.plates.window / cycle;
      mult = open * (1 + b.plates.weakMult) / 2 + (1 - open - b.plates.hold / cycle) * (def.armour ?? 1);
    }
    const UPTIME = 0.7;
    return { id: b.id, level: b.level, hp2: def.hp, killMin: def.hp / (2 * dps * mult * UPTIME) / 60 };
  });
}

// ------------------------------------------------------------------------------------ progression

/** Seconds between kills on top of the fight itself: finding the next pack, travel, a tonic (content §1.1 assumes ~2.5 kills/min). */
export const OVERHEAD_S = 20;

/** Where each mission is usually done (content §1.1 "credited at the level it is usually done"). */
export const MISSION_LEVEL: Record<string, number> = { A1: 3, A2: 4, A3: 5, H1: 8, H2: 9, H3: 10, M1: 14, M2: 15, M3: 16 };

/** Camps cleared once on the way (chest coins at the camp's top level). */
export const CAMP_LEVEL: Record<string, number> = { blockyard_camp: 7, ossuary_camp: 13, checkpoint_seven: 17 };

export interface LevelRow {
  level: number;
  area: string;
  xpPerMin: number;
  coinsPerMin: number;
  minutes: number;
  reachedAt: number;
  coinsAtStart: number;
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2;
};

/** Farming one area at player level L: XP and coins per minute (median starter weapon). */
export function areaRate(areaId: string, L: number): { xpPerMin: number; coinsPerMin: number } {
  const area = NPC_AREAS.find((a) => a.id === areaId)!;
  const E = Math.max(area.levels[0], Math.min(area.levels[1], L));
  const members: { def: NpcDef; n: number }[] = [];
  for (const g of area.groups) for (const m of g.members) members.push({ def: npcDef(m.kind), n: g.weight * (m.count[0] + m.count[1]) / 2 });
  if (area.camp) for (const m of area.camp.members) members.push({ def: npcDef(m.kind), n: m.count });
  const total = members.reduce((s, m) => s + m.n, 0);
  let xp = 0, coins = 0, time = 0;
  for (const m of members) {
    const lv = E;
    const k = playerKillsCreature(m.def, lv, L);
    xp += m.n * killXp(m.def.tier, lv, L);
    coins += m.n * npcCoins(m.def, lv);
    time += m.n * (k.median + OVERHEAD_S);
  }
  return { xpPerMin: (xp / total) / (time / total / 60), coinsPerMin: (coins / total) / (time / total / 60) };
}

/** The intended route: at each level, the best-paying named area whose range holds the level. */
export function progression(): LevelRow[] {
  const rows: LevelRow[] = [];
  let reached = 0;
  let coins = 0;
  for (let L = 1; L < LEVEL_CAP; L++) {
    const need = L === 1 ? xpToNext(1) - ONBOARDING_XP : xpToNext(L);
    const missionXp = MISSIONS.filter((m) => MISSION_LEVEL[m.id] === L).reduce((s, m) => s + m.reward.xp, 0);
    const missionCoins = MISSIONS.filter((m) => MISSION_LEVEL[m.id] === L).reduce((s, m) => s + m.reward.coins, 0);
    const chest = NPC_AREAS.filter((a) => CAMP_LEVEL[a.id] === L).reduce((s, a) => s + (a.camp?.chest?.coins ?? 0), 0);
    const candidates = NPC_AREAS.filter((a) => a.groups.length + (a.camp ? 1 : 0) > 0 && a.levels[0] <= L && L <= a.levels[1]);
    let best = { area: "-", xpPerMin: 0, coinsPerMin: 0 };
    for (const a of candidates) {
      const r = areaRate(a.id, L);
      if (r.xpPerMin > best.xpPerMin) best = { area: a.id, ...r };
    }
    const grind = Math.max(0, need - missionXp);
    const minutes = (L === 1 ? 1 : 0) + grind / best.xpPerMin; // L1: the ~60 s tutorial pays 50 XP
    rows.push({ level: L, area: best.area, xpPerMin: best.xpPerMin, coinsPerMin: best.coinsPerMin, minutes, reachedAt: reached, coinsAtStart: coins });
    coins += best.coinsPerMin * (grind / best.xpPerMin) + missionCoins + chest;
    reached += minutes;
  }
  rows.push({ level: LEVEL_CAP, area: "-", xpPerMin: 0, coinsPerMin: 0, minutes: 0, reachedAt: reached, coinsAtStart: coins });
  return rows;
}

export interface Affordability {
  item: string;
  price: number;
  gate: number;
  /** First level whose starting purse (no spending, no deaths) covers the price, after `spentBefore`. */
  affordableAt: number;
  spentBefore: number;
}

/** When a one-life player can afford each tier: T2 from zero, T3 after buying the T2 (standard and heavy prices). */
export function affordability(rows = progression()): Affordability[] {
  const at = (price: number, spent: number) => rows.find((r) => r.coinsAtStart - spent >= price)?.level ?? Infinity;
  const std = WEAPONS.find((w) => w.id === "carbine")!.tiers;
  const heavy = WEAPONS.find((w) => w.id === "stillshot")!.tiers;
  const tonics = 100; // a few tonics on the way (content §1.4 "about 1,200 after T2 and tonics")
  return [
    { item: "Standard T2", price: std[1].price, gate: std[1].level, affordableAt: at(std[1].price, 0), spentBefore: 0 },
    { item: "Standard T3", price: std[2].price, gate: std[2].level, affordableAt: at(std[2].price, std[1].price + tonics), spentBefore: std[1].price + tonics },
    { item: "Heavy T2", price: heavy[1].price, gate: heavy[1].level, affordableAt: at(heavy[1].price, 0), spentBefore: 0 },
    { item: "Heavy T3", price: heavy[2].price, gate: heavy[2].level, affordableAt: at(heavy[2].price, heavy[1].price + tonics), spentBefore: heavy[1].price + tonics },
  ];
}

export type { TierStats };
export { median };
