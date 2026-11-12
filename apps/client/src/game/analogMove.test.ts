import { describe, expect, it } from "vitest";
import type { Terrain } from "@firstlight/shared";
import { ANIM } from "@firstlight/shared/net/schema";
import { MOVE, PlayerController } from "./PlayerController.ts";
import type { Input } from "./input.ts";

// Analog move from a stick or the touch stick (D-controls-5): a light push walks, a full push runs,
// diagonals never beat the keyboard's pace (the server's move check caps speed, not direction), and
// stick look turns the camera only while the input is captured.

const R = 500;
const terrain = { body: { radius: R }, groundHeight: () => 0 } as unknown as Terrain;

function stick(x: number, y: number, extra: Partial<Record<string, unknown>> = {}) {
  const keys = (extra.keys as Set<string> | undefined) ?? new Set<string>();
  return {
    locked: false, captured: true, mouseDX: 0, mouseDY: 0, lookYaw: 0, lookPitch: 0, wheel: 0, sensitivity: 0.002, invertY: false,
    moveX: x, moveY: y,
    pressed: new Set<string>(),
    down: (k: string) => keys.has(k),
    ...extra,
  } as unknown as Input;
}

function speedAfter(input: Input, seconds = 1.5): { speed: number; anim: number } {
  const pc = new PlayerController(terrain, -100);
  pc.teleport(0, R, 0);
  const start = pc.pos.clone();
  for (let t = 0; t < 0.3; t += 1 / 60) pc.update(1 / 60, stick(0, 0), false);
  start.copy(pc.pos);
  let anim = 0;
  const before = pc.pos.clone();
  for (let t = 0; t < seconds; t += 1 / 60) {
    before.copy(pc.pos);
    pc.update(1 / 60, input, false);
    anim = pc.anim;
  }
  return { speed: pc.pos.distanceTo(before) * 60, anim };
}

describe("analog move", () => {
  it("a full push forward runs at the keyboard's pace", () => {
    expect(speedAfter(stick(0, 1)).speed).toBeCloseTo(MOVE.run, 0);
  });

  it("a light push walks (slower, with the walk clip)", () => {
    const r = speedAfter(stick(0, 0.3));
    expect(r.speed).toBeGreaterThan(MOVE.run * 0.2);
    expect(r.speed).toBeLessThan(MOVE.run * 0.4);
    expect(r.anim).toBe(ANIM.WALK);
  });

  it("a full diagonal is no faster than straight (stick length is clamped upstream; the pace caps here)", () => {
    const d = Math.SQRT1_2;
    expect(speedAfter(stick(d, d)).speed).toBeLessThanOrEqual(MOVE.run + 0.05);
  });

  it("the sprint key with a stick pushed nearly straight ahead sprints", () => {
    const r = speedAfter(stick(0.3, 0.95, { keys: new Set(["ShiftLeft"]) }));
    expect(r.speed).toBeGreaterThan(MOVE.run + 0.5);
  });

  it("keys win over a stick (no doubled speed when both are used)", () => {
    const r = speedAfter(stick(0, 1, { keys: new Set(["KeyW"]) }));
    expect(r.speed).toBeCloseTo(MOVE.run, 0);
  });
});

describe("stick look", () => {
  it("turns the camera when captured, not otherwise", () => {
    const pc = new PlayerController(terrain, -100);
    pc.teleport(0, R, 0);
    const f0 = pc.camForward.clone();
    pc.update(1 / 60, stick(0, 0, { captured: false, lookYaw: 0.5 }), false);
    expect(pc.camForward.angleTo(f0)).toBeCloseTo(0, 5);
    pc.update(1 / 60, stick(0, 0, { lookYaw: 0.5 }), false);
    expect(pc.camForward.angleTo(f0)).toBeCloseTo(0.5, 2);
  });
});
