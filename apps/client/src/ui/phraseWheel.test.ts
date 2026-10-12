import { describe, expect, it } from "vitest";
import { wheelSector } from "./phraseWheel.ts";

describe("phrase wheel direction", () => {
  it("maps mouse direction to the six phrases (0 at the top, clockwise)", () => {
    expect(wheelSector(0, 0)).toBe(-1); // inside the dead zone
    expect(wheelSector(3, -5)).toBe(-1);
    expect(wheelSector(0, -50)).toBe(0); // up
    expect(wheelSector(43, -25)).toBe(1); // up-right
    expect(wheelSector(43, 25)).toBe(2); // down-right
    expect(wheelSector(0, 50)).toBe(3); // down
    expect(wheelSector(-43, 25)).toBe(4); // down-left
    expect(wheelSector(-43, -25)).toBe(5); // up-left
  });
});
