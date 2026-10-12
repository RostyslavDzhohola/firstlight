import { describe, expect, it } from "vitest";
import { ANIM } from "@firstlight/shared/net/schema";
import { OnboardingSteps, STEPS, type Sample } from "./onboardingSteps.ts";

const s = (over: Partial<Sample> = {}): Sample => ({ dt: 1 / 60, moved: 0, lookRad: 0, anim: ANIM.IDLE, dummiesDown: 0, ...over });

describe("onboarding steps", () => {
  it("are move, look, jump, sprint, dodge, then the dummies", () => {
    expect(STEPS.map((x) => x.id)).toEqual(["move", "look", "jump", "sprint", "dodge", "attack"]);
    expect(new OnboardingSteps().current?.id).toBe("move");
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

  it("the dummies step follows the server's count and finishes the list", () => {
    const o = new OnboardingSteps();
    o.observe(s({ dummiesDown: 2 }));
    expect(o.progressText("attack")).toBe("2 / 3");
    expect(o.isDone("attack")).toBe(false);
    for (const id of ["move", "look", "jump", "sprint", "dodge"] as const) o.complete(id);
    expect(o.current?.id).toBe("attack");
    expect(o.next).toBeNull();
    o.observe(s({ dummiesDown: 3 }));
    expect(o.current).toBeNull();
    expect(o.doneCount).toBe(STEPS.length);
  });
});
