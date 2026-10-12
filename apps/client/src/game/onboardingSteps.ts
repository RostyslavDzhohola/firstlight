// Onboarding steps (SPEC §6.12): what the tutorial asks for and when each step counts as done.
// Pure (unit-tested): the onboarding client feeds it one sample per frame from the local player and
// the server's dummy count. Only the dummies (counted by the server) pay XP; every other step is
// taught here and pays nothing. After the dummies come weapons, pick-up, map, phrase wheel, the
// optional voice tip and the final pointer to a portal (about 60–90 s in all).

import { ANIM } from "@firstlight/shared/net/schema";

export type StepId = "move" | "look" | "jump" | "sprint" | "dodge" | "attack" | "switch" | "pickup" | "map" | "wheel" | "voice" | "portal";

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
  /** Optional step (shown in italics). */
  optional?: boolean;
  /** Seconds on the card after which the step moves on by itself (tips, not tasks). */
  autoAfter?: number;
}

export const STEPS: readonly StepDef[] = [
  { id: "move", label: "Move", keys: ["W", "A", "S", "D"], heading: "Walk", cardKeys: ["W", "A", "S", "D"], text: "Walk with **W A S D**. The camera follows your mouse.", goal: 6, unit: "m", bar: true },
  { id: "look", label: "Look", keys: ["Mouse"], heading: "Look around", cardKeys: ["Mouse"], text: "Move the **mouse** to turn. Those planets in the sky are where the portals go.", goal: 180, unit: "°", bar: true },
  { id: "jump", label: "Jump", keys: ["Space"], heading: "Jump", cardKeys: ["Space"], text: "Press **Space** to jump. Falls of more than 8 m hurt.", goal: 1, unit: "", bar: false },
  { id: "sprint", label: "Sprint", keys: ["Shift"], heading: "Run faster", cardKeys: ["Shift", "+", "W"], text: "Hold **Shift** while you move forward. You can't attack while you sprint.", goal: 2, unit: "s", bar: true },
  { id: "dodge", label: "Dodge", keys: ["C"], heading: "Dodge-roll", cardKeys: ["C"], text: "Press **C** to roll out of the way. It's ready again a second later.", goal: 1, unit: "", bar: false },
  { id: "attack", label: "Attack the dummies", keys: ["LMB"], heading: "Knock them down", cardKeys: ["LMB"], text: "Walk up to a training dummy and **left-click** to attack. Three hits knock one down: **10 XP** each.", goal: 3, unit: "", bar: true },
  { id: "switch", label: "Switch weapons", keys: ["1–4"], heading: "Switch weapons", cardKeys: ["1", "2", "3", "4"], text: "**1**–**4** pick a hotbar slot; an empty slot means fists. Press **2**, then **1** to take your weapon back.", goal: 2, unit: "", bar: false },
  { id: "pickup", label: "Pick up", keys: ["E"], heading: "Pick things up", cardKeys: ["E"], text: "When someone dies, everything they carried drops as a glowing pile. Stand on one and press **E** to take it all. Press **E** to go on.", goal: 1, unit: "", bar: false },
  { id: "map", label: "Open the map", keys: ["M"], heading: "Open the map", cardKeys: ["M"], text: "Press **M** for the map: the planets, the pads and where you stand. **M** or **Esc** closes it.", goal: 1, unit: "", bar: false },
  { id: "wheel", label: "Phrase wheel", keys: ["G"], heading: "Say something", cardKeys: ["G"], text: "Hold **G**, point at a phrase and let go. Everyone near you sees it over your head.", goal: 1, unit: "", bar: false },
  { id: "voice", label: "Voice (optional)", keys: ["V"], heading: "Voice chat", cardKeys: ["V"], text: "Optional: turn voice on in **Esc → Voice & radio** (16+, never recorded), then hold **V** to talk to people near you. This tip moves on by itself.", goal: 1, unit: "", bar: false, optional: true, autoAfter: 8 },
  { id: "portal", label: "Walk through a portal", keys: [], heading: "Off you go", cardKeys: [], text: "The three rings around the plaza lead to the planets. Start on **Arcadia** (levels 1–7): walk into its portal.", goal: 1, unit: "", bar: false, autoAfter: 45 },
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
  /** Key codes pressed this frame while playing (Digit1–4, KeyE, KeyM, KeyV…). */
  pressed: ReadonlySet<string>;
  /** We said a phrase-wheel line this frame. */
  phrased: boolean;
  /** Voice chat is switched on. */
  voiceOn: boolean;
  /** Standing in a portal. */
  atPortal: boolean;
}

const DIGITS = ["Digit1", "Digit2", "Digit3", "Digit4"];

const WALKING: ReadonlySet<number> = new Set([ANIM.WALK, ANIM.RUN, ANIM.SPRINT]);

export class OnboardingSteps {
  private readonly progress = new Map<StepId, number>(STEPS.map((s) => [s.id, 0]));
  private readonly finished = new Set<StepId>();
  private readonly slots = new Set<string>();
  /** Seconds the current card has been up (for steps that move on by themselves). */
  private cardTime = 0;
  private cardId: StepId | null = null;

  /** Feed one frame; returns the steps that completed on it. */
  observe(x: Sample): StepId[] {
    const before = new Set(this.finished);
    if (WALKING.has(x.anim)) this.add("move", x.moved);
    this.add("look", (x.lookRad * 180) / Math.PI);
    if (x.anim === ANIM.JUMP) this.add("jump", 1);
    if (x.anim === ANIM.SPRINT) this.add("sprint", x.dt);
    if (x.anim === ANIM.DODGE) this.add("dodge", 1);
    this.set("attack", x.dummiesDown);
    for (const d of DIGITS) if (x.pressed.has(d)) this.slots.add(d);
    this.set("switch", this.slots.size);
    if (x.pressed.has("KeyE")) this.set("pickup", 1);
    if (x.pressed.has("KeyM")) this.set("map", 1);
    if (x.phrased) this.set("wheel", 1);
    if (x.voiceOn || x.pressed.has("KeyV")) this.set("voice", 1);
    if (x.atPortal) this.set("portal", 1);
    const cur = this.current;
    if (cur?.id !== this.cardId) {
      this.cardId = cur?.id ?? null;
      this.cardTime = 0;
    }
    if (cur?.autoAfter) {
      this.cardTime += x.dt;
      if (this.cardTime >= cur.autoAfter) this.complete(cur.id);
    }
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

  get allDone(): boolean {
    return this.finished.size === STEPS.length;
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
