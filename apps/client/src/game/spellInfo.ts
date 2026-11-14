// What each spell does at your level (#79): damage, radius, shell, aether cost and cooldown, from the
// same table and formulas the server uses (content/spells.ts, the starter's spell power). Shown on the
// spell bar's tooltips, in the journal's Spells page, and on the level-up banner ("Frostbloom 26 → 27").
// The build tree (#81) counts too: `tree` is the caster's nodes (Attuned's power, Quickened's cooldowns,
// Far Step's reach, Hardy's max HP under the ward). Pure, so it is tested without a DOM.

import { FROSTBLOOM, GLASSWING, SKIPSTEP, spellDamage, SPELLS, wardShell, WISHFALL, type SpellDef } from "@firstlight/shared/content/spells";
import { buildStats, casterPower, playerMaxHp, spellCooldownS } from "@firstlight/shared/content/tree";

type Tree = readonly string[] | undefined;
const round1 = (x: number) => Math.round(x * 10) / 10;

/** The one number that grows with level, rounded as the server lands it (null for Skipstep). */
export function spellPower(s: SpellDef, level: number, starter: number, tree?: Tree): { value: number; unit: string } | null {
  const p = casterPower({ starter, tree });
  if (s.id === "frostbloom") return { value: Math.round(spellDamage(FROSTBLOOM.damage, level, p)), unit: "damage" };
  if (s.id === "wishfall") return { value: Math.round(spellDamage(WISHFALL.damage, level, p)), unit: "damage" };
  if (s.id === "glasswing") return { value: wardShell(playerMaxHp({ starter, level, tree }), p), unit: "HP shell" };
  return null;
}

/** One line of what the spell does at `level`: "26 damage in a 5 m ring · slows 40% for 3 s". */
export function spellEffect(s: SpellDef, level: number, starter: number, tree?: Tree): string {
  const n = spellPower(s, level, starter, tree);
  switch (s.id) {
    case "skipstep":
      return `Blink up to ${tree?.length ? buildStats(tree).skipstepM : SKIPSTEP.rangeM} m the way you look`;
    case "frostbloom":
      return `${n!.value} damage in a ${FROSTBLOOM.radiusM} m ring · slows ${Math.round(FROSTBLOOM.slow * 100)}% for ${FROSTBLOOM.slowS} s`;
    case "wishfall":
      return `${n!.value} damage at the centre (a quarter at the edge) · ${WISHFALL.radiusM} m blast up to ${WISHFALL.rangeM} m away`;
    case "glasswing":
      return `A ${n!.value} HP shell for ${GLASSWING.durationS} s`;
  }
  return s.blurb;
}

/** The cost line: "30 aether · 10 s cooldown". */
export function spellCost(s: SpellDef, tree?: Tree): string {
  return `${s.cost} aether · ${round1(spellCooldownS(s, tree))} s cooldown`;
}

/** The spell bar tooltip at `level`. */
export function spellTooltip(s: SpellDef, level: number, starter: number, tree?: Tree): string {
  const head = `${s.name} (${s.keycap})`;
  if (level < s.level) return `${head}: unlocks at level ${s.level}. ${s.blurb}`;
  return `${head}: ${spellEffect(s, level, starter, tree)}. ${spellCost(s, tree)}.`;
}

/** What a level-up changed in the spells already known: "Frostbloom 26 → 27 · Wishfall 66 → 68". */
export function spellGains(prev: number, level: number, starter: number, tree?: Tree): string {
  const parts: string[] = [];
  for (const s of SPELLS) {
    if (prev < s.level) continue; // unlocked by this level-up: its own banner says so
    const a = spellPower(s, prev, starter, tree);
    const b = spellPower(s, level, starter, tree);
    if (a && b && b.value !== a.value) parts.push(`${s.name} ${a.value} → ${b.value}`);
  }
  return parts.join(" · ");
}
