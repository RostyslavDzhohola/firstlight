import { describe, expect, it } from "vitest";
import { blastTrauma, CameraShake, SHAKE } from "./cameraShake.ts";

const DEG = Math.PI / 180;

describe("screen shake (content §0: trauma model)", () => {
  it("a blast shakes most inside it, less with distance, and not at all past its reach", () => {
    expect(blastTrauma(0, 4)).toBe(SHAKE.max);
    expect(blastTrauma(4, 4)).toBe(SHAKE.max);
    expect(blastTrauma(12, 4)).toBeLessThan(blastTrauma(8, 4));
    expect(blastTrauma(22, 4)).toBeCloseTo(SHAKE.max * 0.25, 5); // halfway out: a quarter
    expect(blastTrauma(40, 4)).toBe(0);
    expect(blastTrauma(200, 4)).toBe(0);
  });

  it("turns the camera by at most 2° of roll, drains to rest, and never leaves a turn behind", () => {
    const s = new CameraShake();
    s.add(SHAKE.max);
    s.add(5); // it tops out
    expect(s.trauma).toBe(1);
    let peakRoll = 0, peakTurn = 0, moved = 0;
    for (let i = 0; i < 60; i++) {
      const o = s.step(1 / 60, true);
      peakRoll = Math.max(peakRoll, Math.abs(o.roll));
      peakTurn = Math.max(peakTurn, Math.abs(o.pitch), Math.abs(o.yaw));
      if (o.roll !== 0) moved++;
    }
    expect(moved).toBeGreaterThan(30);
    expect(peakRoll).toBeGreaterThan(0.3 * DEG);
    expect(peakRoll).toBeLessThanOrEqual(SHAKE.maxRollDeg * DEG);
    expect(peakTurn).toBeLessThanOrEqual(SHAKE.maxTurnDeg * DEG);
    expect(s.trauma).toBe(0); // 1 ÷ 1.5 per second: gone within the second
    expect(s.step(1 / 60, true)).toEqual({ pitch: 0, yaw: 0, roll: 0 });
  });

  it("a light knock barely shows next to a big one (trauma squared)", () => {
    const peak = (amount: number) => {
      const s = new CameraShake();
      s.add(amount);
      let m = 0;
      for (let i = 0; i < 6; i++) m = Math.max(m, Math.abs(s.step(1 / 240, true).roll));
      return m;
    };
    expect(peak(SHAKE.light)).toBeLessThan(peak(SHAKE.max) / 8);
  });

  it("with the setting off nothing turns, and the trauma still drains", () => {
    const s = new CameraShake();
    s.add(SHAKE.max);
    for (let i = 0; i < 10; i++) expect(s.step(1 / 60, false)).toEqual({ pitch: 0, yaw: 0, roll: 0 });
    expect(s.trauma).toBeLessThan(SHAKE.max);
  });
});
