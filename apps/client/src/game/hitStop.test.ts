import { describe, expect, it } from "vitest";
import { HIT_STOP_MS, HitStop, hitWeight } from "./hitStop.ts";

describe("hit-stop (content §0)", () => {
  it("has the doc's four lengths", () => {
    expect(HIT_STOP_MS).toEqual({ light: 40, heavy: 80, kill: 120, bossKill: 400 });
  });

  it("weak points and big bites of the target's health are heavy", () => {
    expect(hitWeight(12, false, 200)).toBe("light");
    expect(hitWeight(12, true, 200)).toBe("heavy");
    expect(hitWeight(50, false, 200)).toBe("heavy");
    expect(hitWeight(50, false)).toBe("light"); // target unknown
  });

  it("holds for the weight's time; a shorter stop never cuts a longer one short", () => {
    const h = new HitStop();
    expect(h.frozen(0)).toBe(false);
    h.hit("kill", 1000);
    expect(h.frozen(1119)).toBe(true);
    h.hit("light", 1050);
    expect(h.frozen(1119)).toBe(true);
    expect(h.frozen(1120)).toBe(false);
    h.hit("bossKill", 2000);
    expect(h.frozen(2399)).toBe(true);
    expect(h.frozen(2400)).toBe(false);
  });
});
