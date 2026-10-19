import { describe, expect, it } from "vitest";
import * as THREE from "three/webgpu";
import type { Terrain } from "@firstlight/shared";
import { ANIM } from "@firstlight/shared/net/schema";
import { frameClock } from "./frameClock.ts";
import { OnboardingSteps } from "./onboardingSteps.ts";
import { TrainingDummies } from "../world/TrainingDummies.ts";

describe("frame clock (#33: no slow motion below 20 fps)", () => {
  it("passes a normal frame through as one step", () => {
    const f = frameClock(16.7);
    expect(f.dt).toBeCloseTo(0.0167, 6);
    expect(f.steps).toBe(1);
  });

  it("keeps game time with real time down to 5 fps, in steps of at most 50 ms", () => {
    const f = frameClock(200);
    expect(f.dt).toBeCloseTo(0.2, 6);
    expect(f.steps).toBe(4);
    expect(frameClock(60).steps).toBe(2);
  });

  it("caps a slower frame at 200 ms: one packet must fit the server's movement bank, galloping too", () => {
    expect(frameClock(250).dt).toBeCloseTo(0.2, 6); // 4 fps runs at 80 % (it was 20 %)
    expect(frameClock(400)).toEqual({ dt: 0.2, steps: 4 });
  });

  it("doesn't catch up a big gap (hidden tab, debugger, travel): one 50 ms step, as before", () => {
    expect(frameClock(1500)).toEqual({ dt: 0.05, steps: 1 });
    expect(frameClock(60_000)).toEqual({ dt: 0.05, steps: 1 });
  });

  it("never runs time backwards", () => {
    expect(frameClock(-5)).toEqual({ dt: 0, steps: 1 });
  });

  it("about 2 s of real sprinting at 5 fps completes the 2 s sprint step (not 40 frames)", () => {
    const o = new OnboardingSteps();
    const sample = (dt: number) => ({ anim: ANIM.SPRINT, dt, moved: 0, lookRad: 0, dummiesDown: 0, pressed: new Set<string>(), phrased: false, voiceOn: false, inPortal: false });
    for (let i = 0; i < 9; i++) o.observe(sample(frameClock(200).dt));
    expect(o.isDone("sprint")).toBe(false);
    o.observe(sample(frameClock(200).dt));
    o.observe(sample(frameClock(200).dt)); // ten 0.2 s steps sum to a hair under 2 in floating point
    expect(o.isDone("sprint")).toBe(true);
  });

  it("a hit training dummy settles at 5 fps as at 60 fps (its stiff spring steps at 50 ms, Codex review)", () => {
    const terrain = { body: { radius: 500 }, groundHeight: () => 0 } as unknown as Terrain;
    const slow = new TrainingDummies(new THREE.Scene(), terrain);
    const fast = new TrainingDummies(new THREE.Scene(), terrain);
    slow.hit(0);
    fast.hit(0);
    for (let i = 0; i < 10; i++) slow.update(0.2);
    for (let i = 0; i < 120; i++) fast.update(1 / 60);
    const angle = (d: TrainingDummies) => d.dummies[0]!.pivot.rotation.x;
    expect(Math.abs(angle(slow))).toBeLessThan(0.01);
    expect(angle(slow)).toBeCloseTo(angle(fast), 2);
    slow.dispose();
    fast.dispose();
  });
});
