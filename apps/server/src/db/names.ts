// Display-name rules (SPEC §5.4.6): 3–16 chars of [A-Za-z0-9_], unique case-insensitively (enforced
// by the account table's index), and filtered for slurs and profanity.
//
// Filter: `obscenity` 0.4.6 (MIT, no dependencies; https://github.com/jo3-l/obscenity) with its
// English dataset and recommended transformers (leetspeak, confusables, repeated letters). Names are
// checked as typed, with underscores read as spaces, with underscores removed, and with camelCase
// split, so "xX_slur_Xx" and "SlurLord" are caught. A short in-repo list adds hate terms the dataset
// doesn't cover.

import { RegExpMatcher, englishDataset, englishRecommendedTransformers } from "obscenity";

export const NAME_MIN = 3;
export const NAME_MAX = 16;
const SHAPE = /^[A-Za-z0-9_]{3,16}$/;

const matcher = new RegExpMatcher({ ...englishDataset.build(), ...englishRecommendedTransformers });

// Lower-case substrings checked after removing underscores and mapping common digit swaps.
const EXTRA_BLOCKED = ["hitler", "nazi", "siegheil", "kkk", "wetback", "beaner", "raghead", "towelhead"];
// Whole tokens only (they would cause false positives as substrings).
const EXTRA_BLOCKED_TOKENS = new Set(["spic", "spick", "gook", "coon", "jap", "paki", "kyke", "1488"]);

const LEET: Record<string, string> = { "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "8": "b", "@": "a", "$": "s" };

function deLeet(s: string): string {
  return s.replace(/[0134578@$]/g, (c) => LEET[c] ?? c);
}

export type NameProblem = "length" | "chars" | "filtered" | "reserved";

// Names that would pass for staff or the game itself (F12 review). Matched after lower-casing,
// dropping underscores, undoing digit swaps and l/1 → i, and collapsing repeated letters.
const RESERVED_ANYWHERE = ["admin", "administrator", "firstlight", "moderator", "system", "oversight", "official", "gamemaster", "developer", "support", "server"];
// Short words only as whole name parts (they hide inside ordinary names otherwise).
const RESERVED_TOKENS = ["mod", "mods", "dev", "devs", "staff", "gm", "owner", "root", "sysop", "team"];

function reservedForm(s: string): string {
  return deLeet(s.toLowerCase().replace(/_/g, "")).replace(/[l|]/g, "i").replace(/(.)\1+/g, "$1");
}
const RESERVED_FORMS = RESERVED_ANYWHERE.map(reservedForm);
const RESERVED_TOKEN_FORMS = new Set(RESERVED_TOKENS.map(reservedForm));

export function isReservedName(name: string): boolean {
  const flat = reservedForm(name);
  if (RESERVED_FORMS.some((w) => flat.includes(w))) return true;
  const tokens = name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").split(/_+/).filter(Boolean);
  return tokens.some((t) => RESERVED_TOKEN_FORMS.has(reservedForm(t)));
}

/** Shape check only (length and characters). */
export function nameShapeProblem(name: string): NameProblem | null {
  if (name.length < NAME_MIN || name.length > NAME_MAX) return "length";
  if (!SHAPE.test(name)) return "chars";
  return null;
}

export function isOffensiveName(name: string): boolean {
  const variants = [
    name,
    name.replace(/_/g, " "),
    name.replace(/_/g, ""),
    name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/_/g, " "),
  ];
  if (variants.some((v) => matcher.hasMatch(v))) return true;
  const flat = deLeet(name.toLowerCase().replace(/_/g, ""));
  if (EXTRA_BLOCKED.some((w) => flat.includes(w))) return true;
  const tokens = name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/_+/)
    .filter(Boolean);
  return tokens.some((t) => EXTRA_BLOCKED_TOKENS.has(t) || EXTRA_BLOCKED_TOKENS.has(deLeet(t)));
}

/** Full check: shape, then the filter, then reserved names. */
export function displayNameProblem(name: string): NameProblem | null {
  return nameShapeProblem(name) ?? (isOffensiveName(name) ? "filtered" : isReservedName(name) ? "reserved" : null);
}

export const NAME_MESSAGES: Record<NameProblem | "taken", string> = {
  length: `Names are ${NAME_MIN}–${NAME_MAX} characters.`,
  chars: "Use letters, numbers and _ only.",
  filtered: "That name isn't allowed. Try another.",
  reserved: "That name is reserved. Try another.",
  taken: "That name is taken. Try another.",
};
