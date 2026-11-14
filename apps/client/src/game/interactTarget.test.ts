// E takes what the crosshair is on (review finding 3, D-view-6): two objects in reach, one under the
// crosshair and a nearer one beside it; behind the player in first person nothing is taken.
import { describe, expect, it } from "vitest";
import { INTERACT, pickInteract, type InteractCandidate } from "./interactTarget.ts";

// A flat-enough patch on top of a big planet: up is +y, we stand at the surface looking along +z.
const R = 10000;
const eye = [0, R + 1.62, 0] as const;
const ahead = [0, 0, 1] as const;

function at(x: number, z: number, id: string, dist = Math.hypot(x, z)): InteractCandidate<string> {
  return { item: id, pos: [x, R, z], dist };
}

describe("pickInteract", () => {
  const crate = at(0, 2.4, "crate"); // straight ahead, under the crosshair
  const lever = at(1.4, 0.6, "lever"); // nearer, off to the right (about 65° off the crosshair)

  it("first person: the one under the crosshair, not the nearer one beside it", () => {
    expect(pickInteract([lever, crate], eye, ahead, "first")).toBe("crate");
    expect(pickInteract([crate, lever], eye, ahead, "first")).toBe("crate");
  });

  it("third person: the crosshair wins too (the camera ray starts behind the head)", () => {
    const camera = [0.6, R + 2.2, -3.2] as const; // over the right shoulder
    const dir = [-0.11, -0.1, 0.99] as const; // the crosshair ray past the head
    expect(pickInteract([lever, crate], camera, dir, "third")).toBe("crate");
  });

  it("first person: nothing is taken behind or beside the player, even in reach", () => {
    expect(pickInteract([at(0, -1.2, "behind"), lever], eye, ahead, "first")).toBe(null);
  });

  it("third person: with nothing near the crosshair it falls back to the nearest in reach", () => {
    expect(pickInteract([at(0, -2, "behind"), at(0, -1.2, "nearer")], eye, ahead, "third")).toBe("nearer");
  });

  it("looking down at something at the feet takes it; looking up past it doesn't", () => {
    const feet = at(0, 0.9, "box");
    const down = [0, -Math.sin(0.9), Math.cos(0.9)] as const;
    expect(pickInteract([feet], eye, down, "first")).toBe("box");
    const up = [0, Math.sin(0.5), Math.cos(0.5)] as const;
    expect(pickInteract([feet], eye, up, "first")).toBe(null);
  });

  it("the cone is wide enough to forgive a rough aim", () => {
    const off = Math.tan(((INTERACT.coneDeg - 8) * Math.PI) / 180) * 2.4; // inside the cone at the object's middle height
    expect(pickInteract([at(off, 2.4, "near-miss")], [0, R + INTERACT.lift, 0], ahead, "first")).toBe("near-miss");
  });
});
