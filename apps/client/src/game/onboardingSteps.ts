// Onboarding steps (SPEC §6.12): what the tutorial asks for and when each step counts as done.
// Pure (unit-tested): the onboarding client feeds it one sample per frame from the local player and
// the server's dummy count. Movement steps are taught here and pay nothing; only the dummies (counted
// by the server) pay XP.

import { ANIM } from "@firstlight/shared/net/schema";

export type StepId = "move" | "look" | "jump" | "sprint" | "dodge" | "attack";

export interface StepDef {
  id: StepId;
  /** Checklist label. */
  label: string;
  /** Keycaps next to the label. */
  keys: string[];
  /** Big card: heading, keys ("+" draws a plus) and one or two sentences (**bold** allowed). */
  heading: string;
  cardKeys: string[];
  text: string;
  goal: number;
  unit: "m" | "°" | "s" | "";
  /** Show a progress bar (steps that take more than one press). */
  bar: boolean;
}

export const STEPS: readonly StepDef[] = [
  { id: "move", label: "Move", keys: ["W", "A", "S", "D"], heading: "Walk", cardKeys: ["W", "A", "S", "D"], text: "Walk with **W A S D**. The camera follows your mouse.", goal: 6, unit: "m", bar: true },
  { id: "look", label: "Look", keys: ["Mouse"], heading: "Look around", cardKeys: ["Mouse"], text: "Move the **mouse** to turn. Those planets in the sky are where the portals go.", goal: 180, unit: "°", bar: true },
  { id: "jump", label: "Jump", keys: ["Space"], heading: "Jump", cardKeys: ["Space"], text: "Press **Space** to jump. Falls of more than 8 m hurt.", goal: 1, unit: "", bar: false },
  { id: "sprint", label: "Sprint", keys: ["Shift"], heading: "Run faster", cardKeys: ["Shift", "+", "W"], text: "Hold **Shift** while you move forward. You can't attack while you sprint.", goal: 2, unit: "s", bar: true },
  { id: "dodge", label: "Dodge", keys: ["C"], heading: "Dodge-roll", cardKeys: ["C"], text: "Press **C** to roll out of the way. It's ready again a second later.", goal: 1, unit: "", bar: false },
  { id: "attack", label: "Attack the dummies", keys: ["LMB"], heading: "Knock them down", cardKeys: ["LMB"], text: "Walk up to a training dummy and **left-click** to attack. Three hits knock one down: **10 XP** each.", goal: 3, unit: "", bar: true },
];

export const STEP_BY_ID: ReadonlyMap<StepId, StepDef> = new Map(STEPS.map((s) => [s.id, s]));

/** One frame of what the player did. */
export interface Sample {
  dt: number;
  /** Metres moved this frame (along the ground). */
  moved: number;
  /** Camera turn this frame, radians (absolute). */
  lookRad: number;
  /** PlayerController.anim */
  anim: number;
  /** Dummies knocked down (from the server). */
  dummiesDown: number;
}

const WALKING: ReadonlySet<number> = new Set([ANIM.WALK, ANIM.RUN, ANIM.SPRINT]);

export class OnboardingSteps {
  private readonly progress = new Map<StepId, number>(STEPS.map((s) => [s.id, 0]));
  private readonly finished = new Set<StepId>();

  /** Feed one frame; returns the steps that completed on it. */
  observe(x: Sample): StepId[] {
    const before = new Set(this.finished);
    if (WALKING.has(x.anim)) this.add("move", x.moved);
    this.add("look", (x.lookRad * 180) / Math.PI);
    if (x.anim === ANIM.JUMP) this.add("jump", 1);
    if (x.anim === ANIM.SPRINT) this.add("sprint", x.dt);
    if (x.anim === ANIM.DODGE) this.add("dodge", 1);
    this.set("attack", x.dummiesDown);
    return STEPS.filter((s) => this.finished.has(s.id) && !before.has(s.id)).map((s) => s.id);
  }

  complete(id: StepId) {
    this.set(id, STEP_BY_ID.get(id)!.goal);
  }

  private add(id: StepId, v: number) {
    if (v > 0) this.set(id, (this.progress.get(id) ?? 0) + v);
  }

  private set(id: StepId, v: number) {
    if (this.finished.has(id)) return;
    const goal = STEP_BY_ID.get(id)!.goal;
    this.progress.set(id, Math.min(goal, v));
    if (v >= goal) this.finished.add(id);
  }

  isDone(id: StepId): boolean {
    return this.finished.has(id);
  }

  get doneCount(): number {
    return this.finished.size;
  }

  /** The first step not done yet (the big card), or null when all are. */
  get current(): StepDef | null {
    return STEPS.find((s) => !this.finished.has(s.id)) ?? null;
  }

  /** The step after the current one that is still to do. */
  get next(): StepDef | null {
    const cur = this.current;
    if (!cur) return null;
    return STEPS.find((s) => s !== cur && !this.finished.has(s.id) && STEPS.indexOf(s) > STEPS.indexOf(cur)) ?? null;
  }

  fraction(id: StepId): number {
    return Math.min(1, (this.progress.get(id) ?? 0) / STEP_BY_ID.get(id)!.goal);
  }

  /** "5 / 6 m", "108 / 180°", "1.0 / 2 s", "2 / 3". */
  progressText(id: StepId): string {
    const def = STEP_BY_ID.get(id)!;
    const v = this.progress.get(id) ?? 0;
    if (def.unit === "s") return `${v.toFixed(1)} / ${def.goal} s`;
    if (def.unit === "°") return `${Math.floor(v)} / ${def.goal}°`;
    if (def.unit === "m") return `${Math.floor(v)} / ${def.goal} m`;
    return `${Math.floor(v)} / ${def.goal}`;
  }
}
