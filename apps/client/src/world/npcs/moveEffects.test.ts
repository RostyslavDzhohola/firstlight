import { describe, expect, it } from "vitest";
import { FROSTBLOOM } from "@firstlight/shared/content/spells";
import { moveEffectsAt, takeMoveEffect, type MoveEffect } from "./moveEffects.ts";

const T = 50_000;

describe("predicted movement effects", () => {
  it("creatures' effects stack as before: the strongest running slow counts, no-sprint beside it", () => {
    const fx: MoveEffect[] = [];
    takeMoveEffect(fx, { kind: "chill", ms: 2000, amount: 0.2 }, T);
    takeMoveEffect(fx, { kind: "slow", ms: 1000, amount: 0.5 }, T);
    takeMoveEffect(fx, { kind: "nosprint", ms: 3000, amount: 0 }, T);
    expect(moveEffectsAt(fx, T + 500)).toEqual({ slow: 0.5, noSprint: true });
    expect(moveEffectsAt(fx, T + 1500)).toEqual({ slow: 0.2, noSprint: true });
    expect(moveEffectsAt(fx, T + 3500)).toEqual({ slow: 0, noSprint: false });
    expect(fx).toHaveLength(0);
  });

  it("Frostbloom under a stronger slow: the server keeps the stronger one and says so, and nothing lingers after it (review 4)", () => {
    const fx: MoveEffect[] = [];
    // A creature's 60% slow with a second to go…
    takeMoveEffect(fx, { kind: "slow", ms: 1000, amount: 0.6 }, T);
    // …then a Frostbloom (40% for 3 s). The server ignores it while the stronger lasts and tells
    // us the slow it holds: 60% for the second that is left.
    takeMoveEffect(fx, { kind: "slow", ms: 1000, amount: 0.6, set: true }, T);
    expect(moveEffectsAt(fx, T + 500).slow).toBe(0.6);
    // Once that second is over the server allows full speed, and so do we (the 40% used to stay for 3 s).
    expect(moveEffectsAt(fx, T + 1100).slow).toBe(0);
    expect(FROSTBLOOM.slow).toBeLessThan(0.6);
  });

  it("Frostbloom over a weaker slow replaces it; a no-sprint beside it is left alone", () => {
    const fx: MoveEffect[] = [];
    takeMoveEffect(fx, { kind: "chill", ms: 10_000, amount: 0.2 }, T);
    takeMoveEffect(fx, { kind: "nosprint", ms: 10_000, amount: 0 }, T);
    takeMoveEffect(fx, { kind: "slow", ms: 3000, amount: 0.4, set: true }, T);
    expect(moveEffectsAt(fx, T + 1000)).toEqual({ slow: 0.4, noSprint: true });
    // The server dropped the 20% when the 40% took its place: after 3 s there is no slow at all.
    expect(moveEffectsAt(fx, T + 3100)).toEqual({ slow: 0, noSprint: true });
  });
});
