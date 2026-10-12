import { describe, expect, it } from "vitest";
import { nameProblem, validSuggestion } from "./account.ts";

describe("display name suggestions", () => {
  it("pre-fills only names that pass the rules", () => {
    expect(validSuggestion("Wanderer-7904")).toBe("");
    expect(validSuggestion("Wren_07")).toBe("Wren_07");
    expect(validSuggestion(undefined)).toBe("");
  });
  it("always explains a disabled button", () => {
    expect(nameProblem("")).toMatch(/Type a name/);
    expect(nameProblem("ab")).toMatch(/3–16/);
    expect(nameProblem("Wanderer-7904")).toMatch(/letters, numbers and _/);
  });
});
