// The bands the balance model holds the shipped numbers to (D-balance-1). Each check names its source:
// docs/content.md sections, DECISIONS (D), research report [04], or a run decision. A failed check is a
// number that left its band; `pnpm balance` exits non-zero on any.

import { STARTERS } from "../../packages/shared/src/content/weapons.ts";
import { maxHp } from "../../packages/shared/src/content/progression.ts";
import { STARTER_STATS, starterMaxHp } from "../../packages/shared/src/content/starters.ts";
import {
  affordability, BURST_FAMILIES, bossRows, COMBAT_FAMILIES, creatureRows, dominations, duelResults, median, progression,
  pvpCell, PVP_LEVELS, roleLeaders, weaponTable, type Family,
} from "./model.ts";

export interface Check {
  id: string;
  what: string;
  value: string;
  band: string;
  ok: boolean;
  source: string;
}

const fmt = (x: number, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : "∞");
const inBand = (x: number, lo: number, hi: number) => x >= lo - 1e-9 && x <= hi + 1e-9;

/** Weapon tiers ×3 sustained DPS within this factor of the tier's median (a weapon nobody would pick, or everyone would). */
export const DPS_BAND: [number, number] = [0.6, 1.6];
/** §2.5 PvP TTK (s) at equal level, gated tier, base HP. */
export const SUSTAINED_TTK: [number, number] = [2.2, 3.5];
export const BURST_TTK: [number, number] = [1.4, 3.5];
export const OPENER_FLOOR = 1.4;
export const FISTS_FLOOR = 3.5;
/** §2.5: the largest single hit (a Stillshot headshot) is 73–86% of an equal-level target. */
export const BIGGEST_HIT = 0.86;
/**
 * Per-starter HP shifts TTK: against every starter, still two hits and this long (D-balance-4). A hard floor,
 * held at the fastest cadence the server accepts (a modified client can play it; D-balance-6), with
 * heavies, specials and headshots.
 */
export const STARTER_TTK_FLOOR = 0.75;
/** §2.5's burst floor (s): no kill faster with headshots either (review finding 4; D-balance-8). */
export const BEST_FLOOR = 1.4;
/** [04]: each weapon's TTK within 0.6–1.6× its class median. */
export const CLASS_BAND: [number, number] = [0.6, 1.6];
/** Solo TTK of an on-level creature (median starter weapon, s), by tier. */
export const CREATURE_TTK: Record<string, [number, number]> = { critter: [0, 2], regular: [0.2, 3], heavy: [1.5, 8], elite: [3, 15], beast: [20, 45] };
/** One creature, every hit landing on an idle on-level player: at least this long (the AI clamps' intent). */
export const KILLS_PLAYER_FLOOR = 6;
/** Pack fight margin (pack's time to kill the player at 50% hits landing ÷ time to clear the pack). */
export const PACK_MARGIN: Record<string, number> = { regular: 1, heavy: 1, elite: 1.5, beast: 0.9 };
/** Tonics a solo player drinks in a beast fight, by planet (HP each): two of the planet's drop. */
export const BEAST_TONICS_HP: Record<string, number> = { arcadia: 80, hollowmere: 240, meridian: 240 };
export const BOSS_MIN: [number, number] = [3, 8];

export function checks(): Check[] {
  const out: Check[] = [];
  const add = (c: Check) => out.push(c);

  // --- weapons: sustained DPS against the tier median
  const rows = weaponTable().filter((r) => r.family !== "fists");
  for (const tier of [1, 2, 3]) {
    const tr = rows.filter((r) => r.tier === tier);
    const med = median(tr.map((r) => r.sustainedDps));
    for (const r of tr) {
      const k = r.sustainedDps / med;
      add({ id: `dps.${r.family}.t${tier}`, what: `${r.name} T${tier} sustained DPS ÷ tier median`, value: fmt(k), band: `${DPS_BAND[0]}–${DPS_BAND[1]}`, ok: inBand(k, ...DPS_BAND), source: "[04] 0.6–1.6× rule" });
    }
  }

  // --- PvP at equal level
  // One starter per HP multiplier at or under the base: the hard floor holds against each body (higher HP only helps).
  const bodies = STARTER_STATS.map((s, i) => ({ hp: s.hp, i })).filter((x, k, all) => x.hp <= 1 && all.findIndex((y) => y.hp === x.hp) === k);
  for (const level of PVP_LEVELS) {
    const cells = COMBAT_FAMILIES.map((f) => pvpCell(f, level));
    for (const c of cells) {
      const name = `${c.family} L${level}`;
      if (c.family === "fists") {
        add({ id: `pvp.fists.L${level}`, what: `Fists TTK at L${level}`, value: fmt(c.ttk), band: `≥ ${FISTS_FLOOR}`, ok: c.ttk >= FISTS_FLOOR, source: "fists never beat a weapon" });
        continue;
      }
      const burst = BURST_FAMILIES.includes(c.family);
      const band = burst ? BURST_TTK : SUSTAINED_TTK;
      add({ id: `pvp.ttk.${name}`, what: `${name} TTK (primary, body)`, value: fmt(c.ttk), band: `${band[0]}–${band[1]} s`, ok: inBand(c.ttk, ...band), source: "content §2.5" });
      add({ id: `pvp.opener.${name}`, what: `${name} TTK with heavies/specials`, value: fmt(c.openerTtk), band: `≥ ${OPENER_FLOOR} s`, ok: c.openerTtk >= OPENER_FLOOR - 1e-9, source: "content §2.5 burst floor" });
      add({ id: `pvp.best.${name}`, what: `${name} TTK with headshots (and heavies/specials)`, value: `${fmt(c.bestTtk)}/${c.bestHits}`, band: `≥ ${BEST_FLOOR} s`, ok: c.bestTtk >= BEST_FLOOR - 1e-9, source: "content §2.5 burst floor (review finding 4)" });
      add({ id: `pvp.biggest.${name}`, what: `${name} biggest hit ÷ HP`, value: fmt(c.biggestShare), band: `≤ ${BIGGEST_HIT}`, ok: c.biggestShare <= BIGGEST_HIT + 1e-9, source: "content §2.5 no one-shots" });
      for (const b of bodies) {
        const v = pvpCell(c.family, level, starterMaxHp(b.i, level), undefined, "server");
        const fast = v.bestTtk < v.openerTtk ? { t: v.bestTtk, hits: v.bestHits } : { t: v.openerTtk, hits: v.openerHits };
        add({ id: `pvp.floor.${name}.${STARTERS[b.i]!.id}`, what: `${name} vs ${STARTERS[b.i]!.name} (${v.targetHp} HP) at the server's cadence: fastest kill (heavies, specials, headshots) / biggest hit ÷ HP`, value: `${fmt(fast.t)} s, ${fast.hits} hits / ${fmt(v.biggestShare)}`, band: `≥ ${STARTER_TTK_FLOOR} s, ≥ 2 hits, < 1`, ok: fast.t >= STARTER_TTK_FLOOR - 1e-9 && fast.hits >= 2 && v.biggestShare < 1, source: "D-balance-4, D-balance-6" });
      }
    }
    for (const cls of ["melee", "magic", "ranged"]) {
      const cc = cells.filter((c) => c.family !== "fists" && classOf(c.family) === cls);
      const med = median(cc.map((c) => c.ttk));
      for (const c of cc) {
        const k = c.ttk / med;
        add({ id: `pvp.class.${c.family}.L${level}`, what: `${c.family} L${level} TTK ÷ ${cls} median`, value: fmt(k), band: `${CLASS_BAND[0]}–${CLASS_BAND[1]}`, ok: inBand(k, ...CLASS_BAND), source: "[04] via content §2.5" });
      }
    }
  }

  // --- creatures
  for (const r of creatureRows()) {
    const band = CREATURE_TTK[r.tier]!;
    const name = `${r.name} L${r.enemyLevel}`;
    add({ id: `pve.ttk.${r.id}.L${r.enemyLevel}`, what: `${name} solo TTK (median starter)`, value: fmt(r.ttkMedian), band: `${band[0]}–${band[1]} s`, ok: inBand(r.ttkMedian, ...band), source: "D-balance-1 (wall / free kill)" });
    if (r.tier === "critter") continue;
    add({ id: `pve.kills.${r.id}.L${r.enemyLevel}`, what: `${name} kills an idle on-level player in`, value: fmt(r.killsPlayerS), band: `≥ ${KILLS_PLAYER_FLOOR} s`, ok: r.killsPlayerS >= KILLS_PLAYER_FLOOR, source: "content §0 AI clamps" });
    let margin = r.margin;
    if (r.tier === "beast") margin *= (maxHp(r.playerLevel) + BEAST_TONICS_HP[planetOf(r.id)]!) / maxHp(r.playerLevel);
    const need = PACK_MARGIN[r.tier]!;
    add({ id: `pve.margin.${r.id}.L${r.enemyLevel}`, what: `${name} ${r.tier === "beast" ? "fight margin (2 tonics)" : `pack of ${r.packSize} margin`}`, value: fmt(margin), band: `≥ ${need}`, ok: margin >= need, source: "D-balance-1 (wall)" });
  }
  for (const b of bossRows()) {
    add({ id: `boss.${b.id}`, what: `${b.id} two-player kill (min)`, value: fmt(b.killMin, 1), band: `${BOSS_MIN[0]}–${BOSS_MIN[1]}`, ok: inBand(b.killMin, ...BOSS_MIN), source: "content §4 (4.7 / 5.2 / 5.8 min modelled)" });
  }

  // --- progression and coins
  const prog = progression();
  const at = (L: number) => prog.find((r) => r.level === L)!.reachedAt;
  add({ id: "xp.level2", what: "Level 2 reached at (min)", value: fmt(at(2), 1), band: "≤ 2", ok: at(2) <= 2, source: "(D) level 2 ≈ 1 min" });
  add({ id: "xp.level5", what: "Level 5 reached at (min)", value: fmt(at(5), 1), band: "7–13", ok: inBand(at(5), 7, 13), source: "(D) level 5 ≈ 9–10 min" });
  add({ id: "xp.cap", what: "Level 20 reached at (min)", value: fmt(at(20), 0), band: "60–150", ok: inBand(at(20), 60, 150), source: "content §1.1 (60–120 min brief, 112 modelled)" });
  for (let i = 1; i < prog.length - 2; i++) {
    const r = prog[i]!;
    const nb = (prog[i - 1]!.minutes + prog[i + 1]!.minutes) / 2;
    const k = r.minutes / nb;
    add({ id: `xp.step.L${r.level}`, what: `L${r.level} minutes ÷ neighbours' mean`, value: fmt(k), band: "≤ 2 and ≤ 15 min", ok: k <= 2 && r.minutes <= 15, source: "D-balance-1 (no level twice its neighbours)" });
  }
  for (const a of affordability(prog)) {
    const slack = a.item.startsWith("Heavy") ? 3 : 1;
    add({ id: `shop.${a.item}`, what: `${a.item} (${a.price}) affordable at level`, value: String(a.affordableAt), band: `≤ ${a.gate + slack}`, ok: a.affordableAt <= a.gate + slack, source: "content §1.4 (T2 at L6, T3 at L12)" });
  }

  // --- starters
  for (const s of STARTER_STATS) {
    for (const [k, v] of [["hp", s.hp], ["speed", s.speed]] as const) add({ id: `starter.${s.id}.${k}`, what: `${s.id} ${k} multiplier`, value: fmt(v), band: "0.85–1.15", ok: inBand(v, 0.85, 1.15), source: "issue #9, D-balance-4 (light layer)" });
    add({ id: `starter.${s.id}.dodge`, what: `${s.id} dodge cooldown (s)`, value: fmt(s.dodgeCooldown), band: "1.0–1.4", ok: inBand(s.dodgeCooldown, 1.0, 1.4), source: "issue #9, D-balance-4" });
  }
  const dom = dominations();
  add({ id: "starter.dominance", what: "Starters at least as good as another on every stat", value: dom.length ? dom.map((d) => d.join(" > ")).join(", ") : "none", band: "none", ok: dom.length === 0, source: "issue #9" });
  const leaders = roleLeaders();
  const leads = STARTERS.map((s) => Object.values(leaders).filter((names) => names.includes(s.name)).length);
  STARTERS.forEach((s, i) => add({ id: `starter.${s.id}.role`, what: `${s.name} leads roles`, value: String(leads[i]), band: `1–${Object.keys(leaders).length - 1}`, ok: leads[i]! >= 1 && leads[i]! < Object.keys(leaders).length, source: "issue #9 (each plays differently, none strictly best)" }));
  const worst = Math.min(...duelResults().map((r) => Math.min(r.ratio, 1 / r.ratio)));
  add({ id: "starter.duels", what: "Most lopsided starter duel (loser's speed ÷ winner's)", value: fmt(worst), band: "≥ 0.6", ok: worst >= 0.6, source: "D-balance-4 (no hopeless matchup)" });
  return out;
}

function classOf(f: Family): string {
  return f === "kunai" ? "ranged" : ["sunbrand", "riverstaff", "axe", "hammer"].includes(f) ? "melee" : ["hexquill", "emberglass", "stormcoil"].includes(f) ? "magic" : "ranged";
}

function planetOf(npcId: string): string {
  return npcId === "bramblehorn" ? "arcadia" : npcId === "fenstalker" ? "hollowmere" : "meridian";
}
