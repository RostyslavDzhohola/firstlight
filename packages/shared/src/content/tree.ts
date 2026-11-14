// The build tree (issue #81, docs/content.md §1.6): every level past the first gives one point, and
// points go into five open branches in any mix. Nodes in a branch are taken top-down (a node needs
// the one above it) and cost more the deeper they sit, so a level-20 character (19 points) fills
// about half the tree: two branches to the bottom, or a little of everything. Points live and die
// with the level (a rebirth starts with none). The server decides and saves; the client and the
// agent kit read the same table to show and plan. Node ids are append-only (saved by id).
//
// Every number a node changes is read through `buildStats`, so one place says what a build does:
// max HP (`playerMaxHp`), dodge charges and pace (server movement.ts, client PlayerController),
// melee targets, arc, block and heavy cooldown (server combat.ts), ranged damage, reload, draw and
// falloff (combat.ts), spell power, cooldowns, aether refill and Skipstep reach (spells), weapon
// heat (combat.ts), tonics (BodyRoom.use), fall damage (BodyRoom) and the last-breath save (combat.ts).

import { maxHp } from "./progression.ts";
import type { SpellDef } from "./spells.ts";
import { starterSpellPower, starterStats } from "./starters.ts";

export type BranchId = "body" | "blade" | "aim" | "magic" | "travel";

export interface Branch {
  id: BranchId;
  name: string;
  /** One plain line for the panel. */
  blurb: string;
}

export const BRANCHES: readonly Branch[] = [
  { id: "body", name: "Body", blurb: "Health, rolls and tonics." },
  { id: "blade", name: "Blade", blurb: "Close fighting: more targets, a better guard." },
  { id: "aim", name: "Bow and gun", blurb: "Harder shots, faster reloads, longer reach." },
  { id: "magic", name: "Magic", blurb: "Stronger, quicker spells and staves." },
  { id: "travel", name: "Travel", blurb: "Faster feet, farther blinks, softer landings." },
];

/** What a set of nodes changes. Every field's neutral value is what `buildStats([])` returns. */
export interface BuildStats {
  /** Max HP multiplier on the starter's level curve. */
  hp: number;
  /** Dodge rolls held at once (each refills over the dodge cooldown). */
  dodgeCharges: number;
  /** Tonics heal this much more (multiplier) and, if set, end a slow and a burn. */
  tonicHeal: number;
  tonicCleanse: boolean;
  /** Once per `lastBreathS` seconds, a hit that would kill leaves 1 HP instead (0 = never). */
  lastBreathS: number;
  /** Melee: damage multiplier, extra targets per swing, extra arc (degrees). */
  meleeDamage: number;
  meleeTargets: number;
  meleeArc: number;
  /** Added to a melee weapon's block fraction (capped at BLOCK_CAP). */
  block: number;
  /** Multiplier on heavy-attack cooldowns (the axe's chop, the hammer's slam). */
  heavyCooldown: number;
  /** Ranged (guns, bows, kunai, crossbow): damage multiplier, reload and draw time multipliers, falloff reach. */
  rangedDamage: number;
  reload: number;
  draw: number;
  falloffReach: number;
  /** Spells: power (damage and ward shell), cooldown multiplier, aether refill multiplier. */
  spellPower: number;
  spellCooldown: number;
  aetherRegen: number;
  /** Magic weapons: shots before overheating (multiplier). */
  heat: number;
  /** Run and sprint multiplier (on foot). */
  pace: number;
  /** Skipstep reach (m). */
  skipstepM: number;
  /** Falls up to this many metres (base gravity) do no damage; content §1: 8 m. */
  safeFallM: number;
}

export const NEUTRAL_BUILD: Readonly<BuildStats> = Object.freeze({
  hp: 1, dodgeCharges: 1, tonicHeal: 1, tonicCleanse: false, lastBreathS: 0,
  meleeDamage: 1, meleeTargets: 0, meleeArc: 0, block: 0, heavyCooldown: 1,
  rangedDamage: 1, reload: 1, draw: 1, falloffReach: 1,
  spellPower: 1, spellCooldown: 1, aetherRegen: 1, heat: 1,
  pace: 1, skipstepM: 10, safeFallM: 8,
});

/** A block never stops more than this (a full stop would make a guard a wall). */
export const BLOCK_CAP = 0.9;

export interface TreeNode {
  id: string;
  branch: BranchId;
  /** 1 = the top of its branch; a node needs the one with row − 1 in the same branch. */
  row: number;
  /** Points it takes. */
  cost: number;
  name: string;
  /** What it does, in plain words (numbers come from `nodeLines`). */
  blurb: string;
  /** Its change to the build (applied in tree order). */
  apply(s: BuildStats): void;
}

export const TREE: readonly TreeNode[] = [
  // Body
  { id: "body_hardy", branch: "body", row: 1, cost: 1, name: "Hardy", blurb: "More health.", apply: (s) => void (s.hp *= 1.06) },
  { id: "body_second_roll", branch: "body", row: 2, cost: 2, name: "Second Roll", blurb: "Hold two dodge rolls at once.", apply: (s) => void (s.dodgeCharges = 2) },
  { id: "body_tonic_craft", branch: "body", row: 3, cost: 3, name: "Tonic Craft", blurb: "Tonics heal more and end a slow and a burn.", apply: (s) => void ((s.tonicHeal *= 1.2), (s.tonicCleanse = true)) },
  { id: "body_last_breath", branch: "body", row: 4, cost: 3, name: "Last Breath", blurb: "A killing blow leaves you on 1 HP instead, once in a while.", apply: (s) => void (s.lastBreathS = 90) },
  // Blade
  { id: "blade_edge", branch: "blade", row: 1, cost: 1, name: "Keen Edge", blurb: "Melee hits harder.", apply: (s) => void (s.meleeDamage *= 1.08) },
  { id: "blade_cleave", branch: "blade", row: 2, cost: 2, name: "Cleave", blurb: "Each swing hits one more foe, in a wider arc.", apply: (s) => void ((s.meleeTargets += 1), (s.meleeArc += 30)) },
  { id: "blade_guard", branch: "blade", row: 3, cost: 3, name: "Iron Guard", blurb: "Blocking stops more of each hit.", apply: (s) => void (s.block += 0.05) },
  { id: "blade_riposte", branch: "blade", row: 4, cost: 3, name: "Riposte", blurb: "Heavy attacks come back sooner.", apply: (s) => void (s.heavyCooldown *= 0.65) },
  // Bow and gun
  { id: "aim_steady", branch: "aim", row: 1, cost: 1, name: "Steady Hands", blurb: "Bows, guns and throws hit harder.", apply: (s) => void (s.rangedDamage *= 1.08) },
  { id: "aim_quick_hands", branch: "aim", row: 2, cost: 2, name: "Quick Hands", blurb: "Faster reloads and a faster bow draw.", apply: (s) => void ((s.reload *= 0.7), (s.draw *= 0.75)) },
  { id: "aim_far_sight", branch: "aim", row: 3, cost: 3, name: "Far Sight", blurb: "Gun damage holds up over longer range.", apply: (s) => void (s.falloffReach *= 1.4) },
  // Magic
  { id: "magic_attuned", branch: "magic", row: 1, cost: 1, name: "Attuned", blurb: "Spells hit harder and the ward holds more.", apply: (s) => void (s.spellPower *= 1.08) },
  { id: "magic_quickened", branch: "magic", row: 2, cost: 2, name: "Quickened", blurb: "Spell cooldowns are shorter.", apply: (s) => void (s.spellCooldown *= 0.75) },
  { id: "magic_deep_well", branch: "magic", row: 3, cost: 3, name: "Deep Well", blurb: "Aether refills faster.", apply: (s) => void (s.aetherRegen *= 1.4) },
  { id: "magic_cool_head", branch: "magic", row: 4, cost: 3, name: "Cool Head", blurb: "Staves and quills fire longer before they overheat.", apply: (s) => void (s.heat *= 1.5) },
  // Travel
  { id: "travel_stride", branch: "travel", row: 1, cost: 1, name: "Long Stride", blurb: "Run and sprint faster on foot.", apply: (s) => void (s.pace *= 1.06) },
  { id: "travel_far_step", branch: "travel", row: 2, cost: 2, name: "Far Step", blurb: "Skipstep blinks farther.", apply: (s) => void (s.skipstepM = 15) },
  { id: "travel_featherfall", branch: "travel", row: 3, cost: 3, name: "Featherfall", blurb: "Longer drops before a fall hurts.", apply: (s) => void (s.safeFallM = 14) },
];

export const TREE_BY_ID: ReadonlyMap<string, TreeNode> = new Map(TREE.map((n) => [n.id, n]));

/** Coins a respec costs per point it gives back (content §1.6). Only in a safe zone. */
export const RESPEC = { coinsPerPoint: 10 } as const;

/** Points a level gives in all: one per level past the first. */
export const treePoints = (level: number) => Math.max(0, Math.floor(level) - 1);

/** Points the taken nodes cost. Unknown ids cost nothing (and do nothing). */
export function spentPoints(tree: readonly string[] | undefined): number {
  let n = 0;
  for (const id of tree ?? []) n += TREE_BY_ID.get(id)?.cost ?? 0;
  return n;
}

export const pointsLeft = (level: number, tree: readonly string[] | undefined) => treePoints(level) - spentPoints(tree);

export const respecCost = (tree: readonly string[] | undefined) => spentPoints(tree) * RESPEC.coinsPerPoint;

export type SpendRefusal = "unknown" | "taken" | "locked" | "points";

/** Why `id` can't be taken now (null = it can). The server decides; clients use it to grey a node. */
export function spendRefusal(level: number, tree: readonly string[] | undefined, id: string): SpendRefusal | null {
  const node = TREE_BY_ID.get(id);
  if (!node) return "unknown";
  const have = new Set(tree ?? []);
  if (have.has(id)) return "taken";
  if (node.row > 1 && !TREE.some((n) => n.branch === node.branch && n.row === node.row - 1 && have.has(n.id))) return "locked";
  if (node.cost > pointsLeft(level, tree)) return "points";
  return null;
}

/**
 * A saved tree made safe: known ids once each, every node's parent present, and no more spent than
 * the level gives (nodes are dropped from the end until it fits, e.g. after an admin lowers a level).
 */
export function normalizeTree(level: number, tree: readonly unknown[] | undefined): string[] {
  const out: string[] = [];
  for (const id of tree ?? []) if (typeof id === "string" && spendRefusal(99, out, id) === null) out.push(id);
  // A parent always comes before its child here, so dropping from the end never orphans a node.
  while (out.length && spentPoints(out) > treePoints(level)) out.pop();
  return out;
}

/** What a set of nodes does, in one object (see BuildStats). */
export function buildStats(tree: readonly string[] | undefined): BuildStats {
  const s: BuildStats = { ...NEUTRAL_BUILD };
  for (const id of tree ?? []) TREE_BY_ID.get(id)?.apply(s);
  return s;
}

/** A player's max HP: the level curve, the starter's multiplier and the Body branch. */
export function playerMaxHp(c: { starter: number; level: number; tree?: readonly string[] }): number {
  return Math.round(maxHp(c.level) * starterStats(c.starter).hp * buildStats(c.tree).hp);
}

/**
 * The least time between two roll starts (ms). A roll lasts 300 ms and the client sends `DODGE` in
 * every input packet through it (20 a second), so the server would count each packet as a new roll
 * while a second charge was left (build tree review 2). Rolls start at least this far apart on both
 * sides: a roll's own packets never spend a charge, and the 100 ms past the roll leaves the client
 * a packet or two out of the roll between back-to-back rolls and covers arrival jitter. One charge
 * never notices: every starter's cooldown is longer.
 */
export const ROLL_GAP_MS = 400;

/**
 * May a dodge roll start now (Second Roll)? `times`: when the rolls still counted were used. One
 * charge: a full cooldown since the last roll. More: fewer than `charges` rolls in the last cooldown,
 * so each charge comes back one cooldown after it was spent, and never within ROLL_GAP_MS of the
 * last start. The server validates with it and the client predicts with it.
 */
export function rollReady(times: readonly number[], now: number, cooldownMs: number, charges: number): boolean {
  let recent = 0;
  for (const t of times) {
    if (now - t < ROLL_GAP_MS) return false;
    if (now - t < cooldownMs) recent++;
  }
  return recent < Math.max(1, charges);
}

/**
 * How long a reload takes (ms) for this weapon tier and build: the tier's time (1.5 s when unset),
 * shortened by Quick Hands for ranged weapons. The only reload formula: the server's automatic
 * reload (an empty magazine) and the manual one (R) both use it, and so do the agent kit and the
 * balance model (build tree review 5).
 */
export function reloadMs(def: { cls: string }, tier: { reload?: number }, build: Pick<BuildStats, "reload">): number {
  return (tier.reload ?? 1.5) * 1000 * (def.cls === "ranged" ? build.reload : 1);
}

/** Shots before a magic weapon overheats for this build (Cool Head): the tier's, stretched and rounded. */
export function weaponHeat(heat: number, build: Pick<BuildStats, "heat">): number {
  return Math.round(heat * build.heat);
}

/** A caster's spell power: the starter's (content §8.5) times the Magic branch's. */
export function casterPower(c: { starter: number; tree?: readonly string[] }): number {
  return starterSpellPower(c.starter) * buildStats(c.tree).spellPower;
}

/** A spell's cooldown (s) for this tree (Quickened). */
export function spellCooldownS(def: Pick<SpellDef, "cooldownS">, tree: readonly string[] | undefined): number {
  return def.cooldownS * buildStats(tree).spellCooldown;
}

/** The node's effect in numbers for this character (the panel and the agent kit show these). */
export function nodeLine(id: string, c: { starter: number; level: number; tree?: readonly string[] }): string {
  const base = buildStats([]);
  const only = buildStats([id]);
  const pct = (m: number) => `${m > 1 ? "+" : "−"}${Math.round(Math.abs(m - 1) * 100)}%`;
  switch (id) {
    case "body_hardy": {
      const without = playerMaxHp({ ...c, tree: (c.tree ?? []).filter((x) => x !== id) });
      return `Max HP ${without} → ${playerMaxHp({ ...c, tree: [...(c.tree ?? []).filter((x) => x !== id), id] })}`;
    }
    case "body_second_roll": return `${only.dodgeCharges} rolls held, each back after its cooldown`;
    case "body_tonic_craft": return `Tonics heal ${pct(only.tonicHeal)} and clear slow and burn`;
    case "body_last_breath": return `Survive a killing blow on 1 HP, once every ${only.lastBreathS} s`;
    case "blade_edge": return `Melee damage ${pct(only.meleeDamage)}`;
    case "blade_cleave": return `+${only.meleeTargets} target per swing, arc +${only.meleeArc}°`;
    case "blade_guard": return `Block +${Math.round(only.block * 100)} points (up to ${Math.round(BLOCK_CAP * 100)}%)`;
    case "blade_riposte": return `Heavy cooldowns ${pct(only.heavyCooldown)}`;
    case "aim_steady": return `Ranged damage ${pct(only.rangedDamage)}`;
    case "aim_quick_hands": return `Reload ${pct(only.reload)}, bow draw ${pct(only.draw)}`;
    case "aim_far_sight": return `Gun falloff starts ${pct(only.falloffReach)} farther`;
    case "magic_attuned": return `Spell power ${pct(only.spellPower)}`;
    case "magic_quickened": return `Spell cooldowns ${pct(only.spellCooldown)}`;
    case "magic_deep_well": return `Aether refill ${pct(only.aetherRegen)}`;
    case "magic_cool_head": return `Shots before overheating ${pct(only.heat)}`;
    case "travel_stride": return `Run and sprint ${pct(only.pace)}`;
    case "travel_far_step": return `Skipstep ${base.skipstepM} m → ${only.skipstepM} m`;
    case "travel_featherfall": return `Safe drop ${base.safeFallM} m → ${only.safeFallM} m`;
    default: return "";
  }
}

/** The private tree state in `you.tree`. */
export interface TreeYou {
  /** Node ids taken, in the order taken. */
  nodes: string[];
  points: number;
  /** Coins a respec costs now. */
  respec: number;
}

export function treeYou(level: number, tree: readonly string[] | undefined): TreeYou {
  return { nodes: [...(tree ?? [])], points: pointsLeft(level, tree), respec: respecCost(tree) };
}
