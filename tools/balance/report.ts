// `pnpm balance`: prints the balance model's tables for the shipped catalogues and every band check;
// exits 1 when any number left its band (D-balance-1). `--failures` prints only the failed checks,
// `--json` prints everything as JSON.

import { STARTERS } from "../../packages/shared/src/content/weapons.ts";
import { STARTER_STATS, starterMaxHp, starterMove } from "../../packages/shared/src/content/starters.ts";
import { checks } from "./bands.ts";
import {
  affordability, bossRows, COMBAT_FAMILIES, creatureRows, duelWins, progression, pvpCell, PVP_LEVELS, roleLeaders,
  starterRoles, weaponTable,
} from "./model.ts";

const args = new Set(process.argv.slice(2));
const f = (x: number, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : "∞");

function table(title: string, head: string[], rows: (string | number)[][]) {
  const cells = [head, ...rows.map((r) => r.map(String))];
  const w = head.map((_, i) => Math.max(...cells.map((r) => (r[i] ?? "").length)));
  console.log(`\n## ${title}\n`);
  cells.forEach((r, k) => {
    console.log(r.map((c, i) => (i === 0 ? c.padEnd(w[i]!) : c.padStart(w[i]!))).join("  "));
    if (k === 0) console.log(w.map((n) => "-".repeat(n)).join("  "));
  });
}

const all = checks();
const failed = all.filter((c) => !c.ok);

if (args.has("--json")) {
  console.log(JSON.stringify({ weapons: weaponTable(), pvp: COMBAT_FAMILIES.flatMap((fam) => PVP_LEVELS.map((l) => pvpCell(fam, l))), creatures: creatureRows(), bosses: bossRows(), progression: progression(), shop: affordability(), starters: starterRoles(), checks: all }, null, 2));
} else if (!args.has("--failures")) {
  console.log("# FIRSTLIGHT balance report (tools/balance; D-balance-1)");
  table("Weapon DPS at the tier's gate level (sustained: 60 s with reloads, heat and cooldowns; burst: first 3 s with headshots)",
    ["Weapon", "T", "Lv", "Sustained", "Burst", "Biggest hit"],
    weaponTable().map((r) => [r.name, r.tier, r.level, f(r.sustainedDps, 1), f(r.burstDps, 1), r.biggestHit]));
  table("PvP time to kill at equal level, gated tier, base HP (s from the first hit / hits; opener = with heavies and specials)",
    ["Weapon", ...PVP_LEVELS.map((l) => `L${l}`), ...PVP_LEVELS.map((l) => `L${l} opener`)],
    COMBAT_FAMILIES.map((fam) => {
      const cs = PVP_LEVELS.map((l) => pvpCell(fam, l));
      return [fam, ...cs.map((c) => `${f(c.ttk)}/${c.hits}`), ...cs.map((c) => `${f(c.openerTtk)}/${c.openerHits}`)];
    }));
  table("Creatures at their levels (player on level; TTK = solo, starter weapons min/median/max; margin = pack-kills-player at 50% hits ÷ pack clear)",
    ["Creature", "Tier", "Lv", "HP", "TTK min", "TTK med", "TTK max", "Kills player", "Pack", "Margin"],
    creatureRows().map((r) => [r.name, r.tier, r.enemyLevel, r.hp, f(r.ttkMin), f(r.ttkMedian), f(r.ttkMax), f(r.killsPlayerS, 1), r.packSize, f(r.margin)]));
  table("Bosses: two on-level players, median starter weapon, 70% uptime", ["Boss", "Lv", "HP₂", "Kill (min)"], bossRows().map((b) => [b.id, b.level, b.hp2, f(b.killMin, 1)]));
  const prog = progression();
  table("Progression along the intended route (20 s between kills; missions credited at their usual level)",
    ["Level", "Area", "XP/min", "Coins/min", "Minutes", "Reached at", "Coins at start"],
    prog.map((r) => [r.level, r.area, f(r.xpPerMin, 0), f(r.coinsPerMin, 1), f(r.minutes, 1), f(r.reachedAt, 1), Math.round(r.coinsAtStart)]));
  table("Shop: first level a one-life purse covers the price (T3 after buying the T2 and ~100 of tonics)", ["Item", "Price", "Gate", "Affordable at"], affordability(prog).map((a) => [a.item, a.price, a.gate, a.affordableAt]));
  const roles = starterRoles();
  const wins = duelWins();
  table("Starters (issue #9): stats and what each is best at",
    ["Starter", "HP L1", "Run/Sprint", "Dodge cd", "Spell×", "Duel wins /16", "Pack clear s", "Traits"],
    STARTERS.map((s, i) => [s.name, starterMaxHp(i, 1), `${f(starterMove(i).run)}/${f(starterMove(i).sprint)}`, f(starterMove(i).dodgeCooldown), f(STARTER_STATS[i]!.spellPower ?? 1), wins[i]!, f(roles[i]!.packClear), STARTER_STATS[i]!.traits.join(", ")]));
  console.log("\nRole leaders:", Object.entries(roleLeaders()).map(([k, v]) => `${k}: ${v.join(", ")}`).join(" · "));
  console.log(`\n## Checks: ${all.length - failed.length}/${all.length} in band`);
}
if (!args.has("--json")) {
  for (const c of failed) console.log(`FAIL ${c.id}: ${c.what} = ${c.value} (band ${c.band}; ${c.source})`);
  if (!failed.length) console.log("All checks in band.");
}
process.exitCode = failed.length ? 1 : 0;
