import { describe, expect, it } from "vitest";
import { levelText, levelTone } from "./tags.ts";

describe("creature level tones (#73)", () => {
  it("bands against the player's level: easy 3+ below, even to +1, hard +2..+3, deadly beyond", () => {
    expect(levelTone(1, 4)).toBe("easy");
    expect(levelTone(2, 4)).toBe("even");
    expect(levelTone(5, 4)).toBe("even");
    expect(levelTone(6, 4)).toBe("hard");
    expect(levelTone(7, 4)).toBe("hard");
    expect(levelTone(8, 4)).toBe("deadly");
  });

  it("the text says it too, not only the colour", () => {
    expect(levelText(3, "even")).toBe("Lv 3");
    expect(levelText(6, "hard")).toBe("Lv 6!");
    expect(levelText(9, "deadly")).toBe("Lv 9!!");
  });
});
