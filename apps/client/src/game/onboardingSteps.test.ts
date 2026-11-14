import { describe, expect, it } from "vitest";
import { ANIM } from "@firstlight/shared/net/schema";
import { activeSteps, ALL_STEPS, OnboardingSteps, STEPS, type Sample, type StepId } from "./onboardingSteps.ts";

const s = (over: Partial<Sample> = {}): Sample => ({
  dt: 1 / 60, moved: 0, lookRad: 0, anim: ANIM.IDLE, trained: false, pressed: new Set(), mapOpen: false, phrased: false, voiceOn: false, inPortal: false, ...over,
});
const keys = (...codes: string[]) => s({ pressed: new Set(codes) });
const FIRST: StepId[] = ["move", "look", "jump", "sprint", "dodge"];

describe("onboarding steps", () => {
  it("follow SPEC §6.12: movement, one attack, then weapons, pick-up, map, phrases and voice (the portal id stays for saved progress)", () => {
    expect(ALL_STEPS.map((x) => x.id)).toEqual(["move", "look", "jump", "sprint", "dodge", "attack", "switch", "pickup", "map", "wheel", "voice", "portal"]);
    expect(ALL_STEPS.filter((x) => x.optional).map((x) => x.id)).toEqual(["voice"]);
    expect(new OnboardingSteps().current?.id).toBe("move");
  });

  it("this build hides voice chat (D-controls-1) and no build walks into a portal (#68): it ends on the phrase wheel", () => {
    expect(STEPS.map((x) => x.id)).toEqual(["move", "look", "jump", "sprint", "dodge", "attack", "switch", "pickup", "map", "wheel"]);
    expect(activeSteps(true).map((x) => x.id)).toEqual(["move", "look", "jump", "sprint", "dodge", "attack", "switch", "pickup", "map", "wheel", "voice"]);
    const o = new OnboardingSteps();
    for (const id of ["move", "look", "jump", "sprint", "dodge", "attack", "switch", "pickup", "map"] as const) o.complete(id);
    expect(o.observe(keys("KeyV"))).toEqual([]); // V does nothing here
    expect(o.isDone("voice")).toBe(false);
    expect(o.observe(s({ inPortal: true }))).toEqual([]); // a portal is no step
    expect(o.observe(s({ phrased: true }))).toEqual(["wheel"]);
    expect(o.allDone).toBe(true);
    expect(o.doneCount).toBe(10);
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

  it("the attack step is one swing the server took (#68); the tutorial goes on after it", () => {
    const o = new OnboardingSteps();
    for (const id of FIRST) o.complete(id);
    expect(o.current?.id).toBe("attack");
    expect(o.current?.bar).toBe(false);
    expect(o.next?.id).toBe("switch");
    expect(o.observe(s({ trained: true }))).toEqual(["attack"]);
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
    // M alone (pressed under the pause menu, say) isn't enough: the map has to open (#35).
    o.observe(keys("KeyM"));
    expect(o.isDone("map")).toBe(false);
    expect(o.observe(s({ mapOpen: true }))).toEqual(["map"]);
    o.observe(keys("KeyG")); // opening the wheel isn't enough
    expect(o.isDone("wheel")).toBe(false);
    expect(o.observe(s({ phrased: true }))).toEqual(["wheel"]);
  });

  it("voice is optional: K or opting in completes it, else it moves on after 8 s on the card", () => {
    const a = new OnboardingSteps(activeSteps(true));
    expect(a.observe(keys("KeyK"))).toEqual(["voice"]);
    const b = new OnboardingSteps(activeSteps(true));
    expect(b.observe(s({ voiceOn: true }))).toEqual(["voice"]);
    const c = new OnboardingSteps(activeSteps(true));
    for (const id of ["move", "look", "jump", "sprint", "dodge", "attack", "switch", "pickup", "map", "wheel"] as const) c.complete(id);
    expect(c.current?.id).toBe("voice");
    for (let i = 0; i < 7; i++) c.observe(s({ dt: 1 }));
    expect(c.isDone("voice")).toBe(false);
    c.observe(s({ dt: 1.1 }));
    expect(c.isDone("voice")).toBe(true);
    expect(c.current).toBeNull();
  });

  it("time on another card doesn't count toward voice's 8 s", () => {
    const o = new OnboardingSteps(activeSteps(true));
    for (let i = 0; i < 20; i++) o.observe(s({ dt: 1 }));
    expect(o.isDone("voice")).toBe(false);
  });

  it("the last card is the phrase wheel: nothing comes after it, a portal never shows up (#68)", () => {
    const o = new OnboardingSteps();
    for (const x of STEPS) if (x.id !== "wheel") o.complete(x.id);
    expect(o.current?.id).toBe("wheel");
    expect(o.next).toBeNull();
    expect(o.observe(s({ inPortal: true }))).toEqual([]);
    expect(o.observe(s({ phrased: true }))).toEqual(["wheel"]);
    expect(o.current).toBeNull();
    expect(o.allDone).toBe(true);
    expect(o.doneCount).toBe(STEPS.length);
  });

  it("sprint's counter never shows the goal before the step completes (live tutorial run: '2.0 / 2 s' unticked)", () => {
    const o = new OnboardingSteps();
    for (const x of FIRST.slice(0, 3)) o.complete(x);
    o.observe(s({ anim: ANIM.SPRINT, dt: 1.96 }));
    expect(o.isDone("sprint")).toBe(false);
    expect(o.progressText("sprint")).toBe("1.9 / 2 s");
  });

  it("a tip that moves on by itself is marked as moved on, not as done by the player", () => {
    const o = new OnboardingSteps(activeSteps(true));
    for (const x of activeSteps(true)) if (x.id !== "voice") o.complete(x.id);
    for (let i = 0; i < 9; i++) o.observe(s({ dt: 1 }));
    expect(o.isDone("voice")).toBe(true);
    expect(o.allDone).toBe(true);
    expect(o.movedOn("voice")).toBe(true);
    const spoke = new OnboardingSteps(activeSteps(true));
    for (const x of activeSteps(true)) if (x.id !== "voice") spoke.complete(x.id);
    spoke.observe(keys("KeyV"));
    expect(spoke.movedOn("voice")).toBe(false);
    expect(spoke.movedOn("move")).toBe(false);
  });
});
