// What the starter pick screen shows about each starter's body (issue #9, D-balance-4): the shared
// table's plain words and four 5-pip bars. Data only, so it is testable without a DOM.

import { starterBars, starterStats } from "@firstlight/shared/content/starters";

export interface StarterPickStats {
  traits: readonly string[];
  bars: { label: (typeof STARTER_BAR_LABELS)[number]; pips: number }[];
}

export const PIPS = 5;
/** The pick screen's bar rows, in order. Magic is the starter's spell power (content §8.5). */
export const STARTER_BAR_LABELS = ["Toughness", "Speed", "Dodge", "Magic"] as const;

export function starterPickStats(starter: number): StarterPickStats {
  const b = starterBars(starter);
  return {
    traits: starterStats(starter).traits,
    bars: [
      { label: "Toughness", pips: b.toughness },
      { label: "Speed", pips: b.speed },
      { label: "Dodge", pips: b.dodge },
      { label: "Magic", pips: b.magic },
    ],
  };
}
