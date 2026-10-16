// What plays for each game event. A sound name is either a ZzFX preset (presets.ts) or a sample
// name: an ElevenLabs recording on the asset Worker (samples.ts). Every sample has a ZzFX stand-in
// here, so a missing, late or broken file never silences an event. No imports beyond types, so the
// sample tooling (`tools/sfx`) can read this list in Node.

import type { PresetName } from "./presets.ts";

/** The ZzFX stand-in for a sample: preset, gain and playback rate. */
export interface Fallback {
  preset: PresetName;
  gain?: number;
  rate?: number;
}

/** Every sample name, with what plays until (or unless) its file loads. */
export const SAMPLE_FALLBACKS = {
  // feedback and UI
  hitmark: { preset: "hitmark" }, // a hit you landed
  crit: { preset: "hitmark", gain: 1.3, rate: 1.3 }, // a weak-point hit you landed
  ui: { preset: "ui" }, // toasts, tutorial steps, mounting
  coins: { preset: "coins" },
  levelUp: { preset: "levelUp" },
  hurt: { preset: "hurt" }, // you took a hit
  impact: { preset: "impact" }, // someone else took a hit; a bolt or bullet hit something
  death: { preset: "death" },
  portal: { preset: "portal" },
  bubble: { preset: "ui" }, // Prism Bubble deployed
  shatter: { preset: "meleeHit", rate: 0.7 }, // a prop broke
  // melee swings
  swing_fists: { preset: "swing" },
  swing_sword: { preset: "swing" },
  swing_staff: { preset: "swing" },
  swing_heavy: { preset: "swing" },
  // magic
  hexquill: { preset: "hexquill" },
  magic_hit: { preset: "impact" },
  emberglass: { preset: "emberglass" },
  stormcoil: { preset: "stormcoil" },
  // ranged and thrown
  carbine: { preset: "carbine" },
  scatterpipe: { preset: "scatterpipe" },
  stillshot: { preset: "stillshot" },
  longbow: { preset: "longbow" },
  comet: { preset: "comet" },
  grenade: { preset: "grenade" },
  kunai: { preset: "swing", gain: 0.8, rate: 1.6 }, // a thrown kunai's whip
  ember_seal: { preset: "emberglass", gain: 1.2, rate: 0.8 }, // the Ember Seal fireball
  explosion: { preset: "explosion" },
} as const satisfies Record<string, Fallback>;

export type SampleName = keyof typeof SAMPLE_FALLBACKS;
export type SoundName = SampleName | PresetName;

export const SAMPLE_NAMES = Object.keys(SAMPLE_FALLBACKS) as SampleName[];

export function isSampleName(name: string): name is SampleName {
  return Object.hasOwn(SAMPLE_FALLBACKS, name);
}

/** The ZzFX preset (with gain and rate) that plays a sound when no sample does. */
export function fallbackOf(name: SoundName): Required<Fallback> {
  const f: Fallback = isSampleName(name) ? SAMPLE_FALLBACKS[name] : { preset: name };
  return { preset: f.preset, gain: f.gain ?? 1, rate: f.rate ?? 1 };
}

/** The parts of a weapon definition (shared WEAPONS) that pick its sounds. */
export interface WeaponLike {
  id: string;
  cls: string;
  delivery: string;
}

const SWINGS: Record<string, SampleName> = {
  fists: "swing_fists",
  sunbrand: "swing_sword",
  riverstaff: "swing_staff",
  axe: "swing_heavy",
  hammer: "swing_heavy",
};

/** What a weapon appended later sounds like until it gets its own sample, by delivery. */
const BY_DELIVERY: Record<string, SampleName> = {
  hitscan: "carbine",
  pellets: "scatterpipe",
  chain: "stormcoil",
  arrow: "longbow",
  thrown: "grenade",
};

/** The swing of a melee weapon (by weapon id); unknown melee weapons get the sword's. */
export function swingSound(weaponId: string | undefined): SampleName {
  return (weaponId && SWINGS[weaponId]) || "swing_sword";
}

/** The fire, cast or throw sound of a weapon; melee weapons get their swing. */
export function attackSound(w: WeaponLike | undefined): SampleName {
  if (!w) return "swing_fists";
  if (w.delivery === "melee") return swingSound(w.id);
  if (isSampleName(w.id)) return w.id;
  if (w.delivery === "projectile") return w.cls === "magic" ? "hexquill" : "comet";
  return BY_DELIVERY[w.delivery] ?? "swing_sword";
}

/** Where a bolt, bullet or arrow lands without exploding: magic ones fizz, the rest thud. */
export function impactSound(w: WeaponLike | undefined): SampleName {
  return w?.cls === "magic" ? "magic_hit" : "impact";
}
