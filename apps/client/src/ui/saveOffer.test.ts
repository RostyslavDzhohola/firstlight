import { describe, expect, it } from "vitest";
import { mayAutofocus, SaveOffer } from "./saveOffer.ts";

describe("level-up save offer", () => {
  it("opens once, on the first frame after the first level-up to 2+", () => {
    const o = new SaveOffer();
    expect(o.poll(false)).toBe(false);
    o.levelUp(2, 1);
    expect(o.poll(false)).toBe(true);
    expect(o.poll(false)).toBe(false);
    o.levelUp(3, 2);
    expect(o.poll(false)).toBe(false);
  });

  it("ignores the first `you` and anything that isn't a rise to level 2+", () => {
    const o = new SaveOffer();
    o.levelUp(1, 1);
    o.levelUp(5, 5); // joining at level 5: not a level-up
    o.levelUp(1, 0);
    expect(o.poll(false)).toBe(false);
  });

  it("waits while the tutorial is up, then opens once when it ends (T9: level 2 is paid mid-tutorial)", () => {
    const o = new SaveOffer();
    o.levelUp(2, 1); // the dummies paid level 2
    for (let i = 0; i < 600; i++) expect(o.poll(true)).toBe(false); // tips, then the "Tutorial complete" card
    expect(o.poll(false)).toBe(true);
    expect(o.poll(false)).toBe(false);
    expect(o.poll(true)).toBe(false);
  });

  it("a skipped tutorial releases it the same way", () => {
    const o = new SaveOffer();
    o.levelUp(2, 1);
    expect(o.poll(true)).toBe(false);
    o.levelUp(3, 2); // still one card
    expect(o.poll(false)).toBe(true);
    expect(o.poll(false)).toBe(false);
  });
});

describe("autofocus on the save card", () => {
  it("never takes keyboard focus while the game holds the pointer", () => {
    expect(mayAutofocus({ pointerLocked: true, requested: true, interacted: true })).toBe(false);
    expect(mayAutofocus({ pointerLocked: true, requested: false, interacted: false })).toBe(false);
  });

  it("an offer the game opened by itself waits for the player to click into it", () => {
    expect(mayAutofocus({ pointerLocked: false, requested: false, interacted: false })).toBe(false);
    expect(mayAutofocus({ pointerLocked: false, requested: false, interacted: true })).toBe(true);
  });

  it("one the player opened (Esc menu, sign-in) focuses its field", () => {
    expect(mayAutofocus({ pointerLocked: false, requested: true, interacted: false })).toBe(true);
  });
});
