import { describe, expect, it } from "vitest";
import { ANIM } from "@firstlight/shared/net/schema";
import { frameClock } from "./frameClock.ts";
import { OnboardingSteps } from "./onboardingSteps.ts";

describe("frame clock (#33: no slow motion below 20 fps)", () => {
  it("passes a normal frame through as one step", () => {
    const f = frameClock(16.7);
    expect(f.dt).toBeCloseTo(0.0167, 6);
    expect(f.steps).toBe(1);
  });

  it("keeps game time with real time at 4 fps, in steps of at most 50 ms", () => {
    const f = frameClock(250);
    expect(f.dt).toBeCloseTo(0.25, 6);
    expect(f.steps).toBe(5);
    expect(frameClock(60).steps).toBe(2);
  });

  it("caps a slower frame at 250 ms: one packet must fit the server's 3.5 m movement bank", () => {
    expect(frameClock(400).dt).toBeCloseTo(0.25, 6);
    expect(frameClock(400).steps).toBe(5);
  });

  it("doesn't catch up a big gap (hidden tab, debugger, travel): one 50 ms step, as before", () => {
    expect(frameClock(1500)).toEqual({ dt: 0.05, steps: 1 });
    expect(frameClock(60_000)).toEqual({ dt: 0.05, steps: 1 });
  });

  it("never runs time backwards", () => {
    expect(frameClock(-5)).toEqual({ dt: 0, steps: 1 });
  });

  it("2 s of real sprinting at 4 fps completes the 2 s sprint step (8 frames, not 40)", () => {
    const o = new OnboardingSteps();
    const sample = (dt: number) => ({ anim: ANIM.SPRINT, dt, moved: 0, lookRad: 0, dummiesDown: 0, pressed: new Set<string>(), phrased: false, voiceOn: false, inPortal: false });
    for (let i = 0; i < 7; i++) o.observe(sample(frameClock(250).dt));
    expect(o.isDone("sprint")).toBe(false);
    o.observe(sample(frameClock(250).dt));
    expect(o.isDone("sprint")).toBe(true);
  });
});
