import { describe, expect, it } from "vitest";
import { ANIM } from "@firstlight/shared/net/schema";
import { activeSteps, ALL_STEPS, OnboardingSteps, STEPS, type Sample, type StepId } from "./onboardingSteps.ts";

const s = (over: Partial<Sample> = {}): Sample => ({
  dt: 1 / 60, moved: 0, lookRad: 0, anim: ANIM.IDLE, dummiesDown: 0, pressed: new Set(), phrased: false, voiceOn: false, inPortal: false, ...over,
});
const keys = (...codes: string[]) => s({ pressed: new Set(codes) });
const FIRST: StepId[] = ["move", "look", "jump", "sprint", "dodge"];

describe("onboarding steps", () => {
  it("follow SPEC §6.12: movement, the dummies, then weapons, pick-up, map, phrases, voice and a portal", () => {
    expect(ALL_STEPS.map((x) => x.id)).toEqual(["move", "look", "jump", "sprint", "dodge", "attack", "switch", "pickup", "map", "wheel", "voice", "portal"]);
    expect(ALL_STEPS.filter((x) => x.optional).map((x) => x.id)).toEqual(["voice"]);
    expect(new OnboardingSteps().current?.id).toBe("move");
  });

  it("this build hides voice chat (D-controls-1): no voice tip, the same ids and order otherwise", () => {
    expect(STEPS.map((x) => x.id)).toEqual(["move", "look", "jump", "sprint", "dodge", "attack", "switch", "pickup", "map", "wheel", "portal"]);
    expect(activeSteps(true)).toBe(ALL_STEPS);
    const o = new OnboardingSteps();
    for (const id of ["move", "look", "jump", "sprint", "dodge", "attack", "switch", "pickup", "map"] as const) o.complete(id);
    expect(o.observe(s({ phrased: true }))).toEqual(["wheel"]);
    expect(o.current?.id).toBe("portal"); // straight from the phrase wheel to the portal
    expect(o.observe(keys("KeyV"))).toEqual([]); // V does nothing here
    expect(o.isDone("voice")).toBe(false);
    expect(o.observe(s({ inPortal: true }))).toEqual(["portal"]);
    expect(o.allDone).toBe(true);
    expect(o.doneCount).toBe(11);
  });

  it("move completes after walking 6 m on the ground (dodges don't count)", () => {
    const o = new OnboardingSteps();
    for (let i = 0; i < 20; i++) o.observe(s({ moved: 0.25, anim: ANIM.RUN }));
    expect(o.isDone("move")).toBe(false);
    expect(o.progressText("move")).toBe("5 / 6 m");
    o.observe(s({ moved: 3, anim: ANIM.DODGE }));
    expect(o.isDone("move")).toBe(false);
    expect(o.observe(s({ moved: 1, anim: ANIM.WALK }))).toEqual(["move"]);
    expect(o.current?.id).toBe("look");
  });

  it("look completes after turning about half a circle", () => {
    const o = new OnboardingSteps();
    o.observe(s({ lookRad: Math.PI * 0.6 }));
    expect(o.fraction("look")).toBeCloseTo(0.6, 5);
    expect(o.progressText("look")).toBe("108 / 180°");
    o.observe(s({ lookRad: Math.PI * 0.5 }));
    expect(o.isDone("look")).toBe(true);
  });

  it("jump and dodge complete on the first one; sprint after 2 s of sprinting", () => {
    const o = new OnboardingSteps();
    expect(o.observe(s({ anim: ANIM.JUMP }))).toEqual(["jump"]);
    expect(o.observe(s({ anim: ANIM.DODGE }))).toEqual(["dodge"]);
    for (let i = 0; i < 60; i++) o.observe(s({ anim: ANIM.SPRINT, moved: 0 }));
    expect(o.isDone("sprint")).toBe(false);
    expect(o.progressText("sprint")).toBe("1.0 / 2 s");
    for (let i = 0; i < 61; i++) o.observe(s({ anim: ANIM.SPRINT }));
    expect(o.isDone("sprint")).toBe(true);
  });

  it("steps done early stay done; the current card is the first one left", () => {
    const o = new OnboardingSteps();
    o.observe(s({ anim: ANIM.JUMP }));
    expect(o.current?.id).toBe("move");
    expect(o.doneCount).toBe(1);
    expect(o.next?.id).toBe("look");
  });

  it("the dummies step follows the server's count; the tutorial goes on after it", () => {
    const o = new OnboardingSteps();
    o.observe(s({ dummiesDown: 2 }));
    expect(o.progressText("attack")).toBe("2 / 3");
    expect(o.isDone("attack")).toBe(false);
    for (const id of FIRST) o.complete(id);
    expect(o.current?.id).toBe("attack");
    expect(o.next?.id).toBe("switch");
    o.observe(s({ dummiesDown: 3 }));
    expect(o.current?.id).toBe("switch");
    expect(o.allDone).toBe(false);
  });

  it("switch weapons takes two different slots; pick-up E, map M, phrase wheel a phrase", () => {
    const o = new OnboardingSteps();
    o.observe(keys("Digit2"));
    o.observe(keys("Digit2"));
    expect(o.isDone("switch")).toBe(false);
    expect(o.observe(keys("Digit1"))).toEqual(["switch"]);
    expect(o.observe(keys("KeyE"))).toEqual(["pickup"]);
    expect(o.observe(keys("KeyM"))).toEqual(["map"]);
    o.observe(keys("KeyG")); // opening the wheel isn't enough
    expect(o.isDone("wheel")).toBe(false);
    expect(o.observe(s({ phrased: true }))).toEqual(["wheel"]);
  });

  it("voice is optional: V or opting in completes it, else it moves on after 8 s on the card", () => {
    const a = new OnboardingSteps(ALL_STEPS);
    expect(a.observe(keys("KeyV"))).toEqual(["voice"]);
    const b = new OnboardingSteps(ALL_STEPS);
    expect(b.observe(s({ voiceOn: true }))).toEqual(["voice"]);
    const c = new OnboardingSteps(ALL_STEPS);
    for (const id of ["move", "look", "jump", "sprint", "dodge", "attack", "switch", "pickup", "map", "wheel"] as const) c.complete(id);
    expect(c.current?.id).toBe("voice");
    for (let i = 0; i < 7; i++) c.observe(s({ dt: 1 }));
    expect(c.isDone("voice")).toBe(false);
    c.observe(s({ dt: 1.1 }));
    expect(c.isDone("voice")).toBe(true);
    expect(c.current?.id).toBe("portal");
  });

  it("time on another card doesn't count toward voice's 8 s", () => {
    const o = new OnboardingSteps(ALL_STEPS);
    for (let i = 0; i < 20; i++) o.observe(s({ dt: 1 }));
    expect(o.isDone("voice")).toBe(false);
  });

  it("the portal is the final pointer: walking into one finishes the tutorial", () => {
    const o = new OnboardingSteps();
    for (const x of STEPS) if (x.id !== "portal") o.complete(x.id);
    expect(o.current?.id).toBe("portal");
    expect(o.next).toBeNull();
    expect(o.observe(s({ inPortal: true }))).toEqual(["portal"]);
    expect(o.current).toBeNull();
    expect(o.allDone).toBe(true);
    expect(o.doneCount).toBe(STEPS.length);
  });

  it("actually walking into a portal ticks it whatever the card says", () => {
    const o = new OnboardingSteps();
    expect(o.observe(s({ inPortal: true }))).toEqual(["portal"]);
    expect(o.current?.id).toBe("move");
  });

  it("only entering a ring ticks it: being near one never does, even with the portal card up (T9 review)", () => {
    const o = new OnboardingSteps();
    for (const x of STEPS) if (x.id !== "portal") o.complete(x.id);
    expect(o.current?.id).toBe("portal");
    for (let i = 0; i < 30; i++) expect(o.observe(s({ moved: 0.1 }))).toEqual([]);
    expect(o.isDone("portal")).toBe(false);
    expect(o.observe(s({ inPortal: true }))).toEqual(["portal"]);
  });

  it("sprint's counter never shows the goal before the step completes (live tutorial run: '2.0 / 2 s' unticked)", () => {
    const o = new OnboardingSteps();
    for (const x of FIRST.slice(0, 3)) o.complete(x);
    o.observe(s({ anim: ANIM.SPRINT, dt: 1.96 }));
    expect(o.isDone("sprint")).toBe(false);
    expect(o.progressText("sprint")).toBe("1.9 / 2 s");
  });

  it("a tip that moves on by itself is marked as moved on, not as done by the player", () => {
    const o = new OnboardingSteps();
    for (const x of STEPS) if (x.id !== "portal") o.complete(x.id);
    for (let i = 0; i < 46; i++) o.observe(s({ dt: 1 }));
    expect(o.isDone("portal")).toBe(true);
    expect(o.allDone).toBe(true);
    expect(o.movedOn("portal")).toBe(true);
    const walked = new OnboardingSteps();
    for (const x of STEPS) if (x.id !== "portal") walked.complete(x.id);
    walked.observe(s({ inPortal: true }));
    expect(walked.movedOn("portal")).toBe(false);
    expect(walked.movedOn("move")).toBe(false);
  });
});
