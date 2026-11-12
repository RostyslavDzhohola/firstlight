// The client predicts each starter's pace and roll from the shared table the server validates with
// (content/starters.ts, issue #9, D-balance-4).

import { afterEach, describe, expect, it } from "vitest";
import type { Terrain } from "@firstlight/shared";
import { STARTER_STATS, starterMove } from "@firstlight/shared/content/starters";
import { ANIM } from "@firstlight/shared/net/schema";
import type { Input } from "./input.ts";
import { MOVE, MOVE_BASE, PlayerController, setStarterMove } from "./PlayerController.ts";

const R = 500;
const terrain = { body: { radius: R }, groundHeight: () => 0 } as unknown as Terrain;
const idx = (id: string) => STARTER_STATS.findIndex((s) => s.id === id);
const UNIT7 = idx("unit7");

function input(keys: string[]) {
  const down = new Set(keys);
  return { locked: true, captured: true, mouseDX: 0, mouseDY: 0, wheel: 0, sensitivity: 0.002, invertY: false, pressed: new Set<string>(), down: (k: string) => down.has(k) } as unknown as Input & { pressed: Set<string> };
}

function sprintSpeed(): number {
  const pc = new PlayerController(terrain, -100);
  pc.teleport(0, R, 0);
  const keys = input(["KeyW", "ShiftLeft"]);
  for (let t = 0; t < 1.5; t += 1 / 60) pc.update(1 / 60, keys, false);
  return pc.vel.length();
}

afterEach(() => setStarterMove(UNIT7)); // the base pace (Unit 7 is the reference body)

describe("setStarterMove", () => {
  it("sets run, sprint and the dodge cooldown from the shared row, and the base NPC effects scale", () => {
    for (let i = 0; i < STARTER_STATS.length; i++) {
      setStarterMove(i);
      expect(MOVE.run).toBeCloseTo(starterMove(i).run);
      expect(MOVE.sprint).toBeCloseTo(starterMove(i).sprint);
      expect(MOVE.dodgeCooldown).toBeCloseTo(starterMove(i).dodgeCooldown);
      expect(MOVE_BASE.sprint).toBeCloseTo(starterMove(i).sprint);
    }
  });

  it("the controller sprints at the starter's speed: Hinoko faster, Brother Ash slower than the base", () => {
    setStarterMove(idx("ninja"));
    expect(sprintSpeed()).toBeCloseTo(starterMove(idx("ninja")).sprint, 0);
    setStarterMove(idx("ash"));
    expect(sprintSpeed()).toBeCloseTo(starterMove(idx("ash")).sprint, 0);
    expect(starterMove(idx("ash")).sprint).toBeLessThan(9);
    expect(starterMove(idx("ninja")).sprint).toBeGreaterThan(9);
  });

  it("rolls come at the starter's cooldown: Kappa rolls again at 1.05 s, Brother Ash does not", () => {
    const rollsIn = (starter: number, seconds: number) => {
      setStarterMove(starter);
      const pc = new PlayerController(terrain, -100);
      pc.teleport(0, R, 0);
      const keys = input(["KeyW"]);
      let rolls = 0, was = false;
      for (let t = 0; t < seconds; t += 1 / 60) {
        keys.pressed.clear();
        keys.pressed.add("KeyC"); // C held down: a roll as soon as one is allowed
        pc.update(1 / 60, keys, false);
        const rolling = pc.anim === ANIM.DODGE;
        if (rolling && !was) rolls++;
        was = rolling;
      }
      return rolls;
    };
    expect(rollsIn(idx("kappa"), 1.1)).toBe(2);
    expect(rollsIn(idx("ash"), 1.1)).toBe(1);
  });
});
