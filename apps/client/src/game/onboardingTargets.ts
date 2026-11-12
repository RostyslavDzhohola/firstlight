// Map and minimap targets for the tutorial (#31): while the dummy step is on, each training dummy
// still standing is marked like a mission target, so a player who wandered off can find them again.

import type { V3 } from "../social/compassMath.ts";
import { dummyDir, TRAINING_DUMMIES } from "@firstlight/shared/content/onboarding";
import type { StepId } from "./onboardingSteps.ts";

export interface GuideTarget {
  id: string;
  dir: V3;
  label: string;
}

/** The dummies still standing, while "attack" (knock down the dummies) is the current step. */
export function dummyTargets(step: StepId | undefined, down: readonly boolean[]): GuideTarget[] {
  if (step !== "attack") return [];
  const out: GuideTarget[] = [];
  for (let i = 0; i < TRAINING_DUMMIES.length; i++) if (!down[i]) out.push({ id: `dummy:${i}`, dir: dummyDir(i) as V3, label: "Training dummy" });
  return out;
}

/**
 * The dummy callout's second line: how far the next dummy is once the player is more than a few
 * strides off (rounded to 5 m so the label isn't re-laid out every frame), then the rules (#31).
 */
export function dummyCalloutSub(dist: number): string {
  const rules = "10 XP each. Three hits knock one down.";
  if (!(dist > 12)) return rules;
  return `${Math.max(15, Math.round(dist / 5) * 5)} m away · ${rules}`;
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
