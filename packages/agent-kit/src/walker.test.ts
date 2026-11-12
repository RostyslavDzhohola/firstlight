// The walker moves at each starter's own pace (content/starters.ts): the row the server validates
// against, so a Hinoko agent isn't slow and a Brother Ash agent isn't corrected.

import { describe, expect, it } from "vitest";
import { STARTER_STATS, starterMove } from "@firstlight/shared/content/starters";
import { tangent, type V3 } from "./vec.ts";
import { WALK, Walker } from "./walker.ts";
import { bodyWorld } from "./world.ts";

/** A walker on open Arcadia ground outside the outpost, and a direction to walk in. */
function walker(starter: number): { w: Walker; dir: V3 } {
  const world = bodyWorld("arcadia");
  const w = new Walker(world);
  w.setStarter(starter);
  const at = world.onGround([0.05, 1, 0.12]);
  w.place(at[0], at[1], at[2]);
  return { w, dir: tangent(w.up(), [1, 0, 0])! };
}

describe("per-starter movement", () => {
  it("runs and sprints at the starter's speed from the shared table", () => {
    for (let i = 0; i < STARTER_STATS.length; i++) {
      const { w, dir } = walker(i);
      const m = starterMove(i);
      expect(w.run).toBeCloseTo(m.run);
      expect(w.sprint).toBeCloseTo(m.sprint);
      expect(w.dodgeCooldownMs).toBeCloseTo(m.dodgeCooldown * 1000 + WALK.dodgeSkewMs);
      // 2 s of sprinting on open ground covers what that speed says, never more.
      let moved = 0;
      for (let k = 0; k < 40; k++) {
        w.step(0.05, dir, w.sprint);
        moved += w.lastMoved;
        expect(w.lastMoved).toBeLessThanOrEqual(m.sprint * 0.05 + 0.02);
      }
      expect(moved).toBeGreaterThan(m.sprint * 2 * 0.9);
    }
    // Hinoko is the fastest, Brother Ash the slowest, and they differ.
    const ninja = starterMove(STARTER_STATS.findIndex((s) => s.id === "ninja"));
    const ash = starterMove(STARTER_STATS.findIndex((s) => s.id === "ash"));
    expect(ninja.sprint).toBeGreaterThan(9);
    expect(ash.sprint).toBeLessThan(9);
  });

  it("never walks faster than the starter's sprint, whatever speed is asked", () => {
    const ash = STARTER_STATS.findIndex((s) => s.id === "ash");
    const { w, dir } = walker(ash);
    w.step(0.05, dir, 20);
    expect(w.lastMoved).toBeLessThanOrEqual(starterMove(ash).sprint * 0.05 + 0.02);
  });

  it("rolls on the starter's cooldown", () => {
    const kappa = STARTER_STATS.findIndex((s) => s.id === "kappa");
    const ash = STARTER_STATS.findIndex((s) => s.id === "ash");
    for (const i of [kappa, ash]) {
      const { w, dir } = walker(i);
      const ms = starterMove(i).dodgeCooldown * 1000;
      expect(w.dodge(dir, 10_000)).toBe(true);
      expect(w.dodge(dir, 10_000 + ms - 1)).toBe(false); // the server would refuse this one
      expect(w.dodge(dir, 10_000 + ms + WALK.dodgeSkewMs)).toBe(true);
    }
  });

  it("walks by a slow the server enforces, and doesn't roll while slowed", () => {
    const { w, dir } = walker(3);
    const now = Date.now();
    w.addEffect("slow", 0.4, 3000, now);
    expect(w.sprint).toBeCloseTo(9 * 0.6);
    expect(w.run).toBeCloseTo(6 * 0.6);
    w.step(0.05, dir, 9);
    expect(w.lastMoved).toBeLessThanOrEqual(9 * 0.6 * 0.05 + 0.02);
    expect(w.dodge(dir, now)).toBe(false);
    w.addEffect("nosprint", 0, 3000, now);
    expect(w.sprint).toBeCloseTo(6 * 0.6);
  });
});
