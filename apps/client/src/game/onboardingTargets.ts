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

/** What the map and minimap draw besides mission targets; the tutorial sets it while it runs. */
export const guideTargets: { current: () => GuideTarget[] } = { current: () => [] };
