// Map and minimap targets for the tutorial (#31): while the attack step is on, each training dummy
// still standing is marked like a mission target; once it's over, the Arcadia portal (#68).

import type { V3 } from "../social/compassMath.ts";
import { dummyDir, TRAINING_DUMMIES } from "@firstlight/shared/content/onboarding";
import type { StepId } from "./onboardingSteps.ts";

export interface GuideTarget {
  id: string;
  dir: V3;
  /** Empty: a star with no label of its own (one of a cluster the first one names). */
  label: string;
}

/**
 * The dummies still standing, while "attack" (knock down the dummies) is the current step. They
 * stand 2.5 m apart, one cluster on the map: each gets a star, only the first a label (three
 * identical labels stacked over each other, play-through).
 */
export function dummyTargets(step: StepId | undefined, down: readonly boolean[]): GuideTarget[] {
  if (step !== "attack") return [];
  const out: GuideTarget[] = [];
  const standing = TRAINING_DUMMIES.filter((_, i) => !down[i]).length;
  for (let i = 0; i < TRAINING_DUMMIES.length; i++) {
    if (down[i]) continue;
    const label = out.length ? "" : standing > 1 ? `Training dummies (${standing})` : "Training dummy";
    out.push({ id: `dummy:${i}`, dir: dummyDir(i) as V3, label });
  }
  return out;
}

/** What the map and minimap draw besides mission targets; the tutorial sets it while it runs. */
export const guideTargets: { current: () => GuideTarget[] } = { current: () => [] };

/** The standing dummy nearest `from` (any point; compared by direction from the planet's centre), or null when all are down. */
export function nextDummy(down: readonly boolean[], from: readonly [number, number, number]): number | null {
  const l = Math.hypot(from[0], from[1], from[2]) || 1;
  let best: number | null = null;
  let bestDot = -Infinity;
  for (let i = 0; i < TRAINING_DUMMIES.length; i++) {
    if (down[i]) continue;
    const d = dummyDir(i);
    const dot = (d[0] * from[0] + d[1] * from[1] + d[2] * from[2]) / l;
    if (dot > bestDot) {
      bestDot = dot;
      best = i;
    }
  }
  return best;
}
