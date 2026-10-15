import { describe, expect, it } from "vitest";
import { BODIES } from "@firstlight/shared";
import { townDir } from "@firstlight/shared/planet/townFrame";
import { creepsHiddenByTown } from "./townCull.ts";

const R = BODIES.portus.radius;
const flat = () => 0;
const cam = (east: number, north: number, up: number): [number, number, number] => {
  const d = townDir(east, north, R);
  return [d[0] * (R + up), d[1] * (R + up), d[2] * (R + up)];
};

describe("the town hides the creeps outside its walls (Portus draw budget)", () => {
  it("from the plaza, the streets and the castle ward: hidden", () => {
    for (const [e, n] of [[0, 0], [5, -6], [-25, 10], [20, -20], [0, 55]] as const) expect(creepsHiddenByTown(BODIES.portus, ...cam(e, n, 2), flat), `${e}, ${n}`).toBe(true);
  });

  it("looking out of a gate, over the walls, or from outside: drawn", () => {
    expect(creepsHiddenByTown(BODIES.portus, ...cam(41, 0, 2), flat)).toBe(false); // camera behind a player in the east gate
    expect(creepsHiddenByTown(BODIES.portus, ...cam(-38, 1, 2), flat)).toBe(false);
    expect(creepsHiddenByTown(BODIES.portus, ...cam(30, -30, 8), flat)).toBe(false); // on the wall walk
    expect(creepsHiddenByTown(BODIES.portus, ...cam(70, 10, 2), flat)).toBe(false);
    expect(creepsHiddenByTown(BODIES.portus, 0, -R - 2, 0, flat)).toBe(false); // the far side
  });

  it("never on the planets", () => {
    expect(creepsHiddenByTown(BODIES.arcadia, 0, 502, 0, flat)).toBe(false);
  });
});
