import { describe, expect, it } from "vitest";
import { DIALOGUE } from "@firstlight/shared/content/dialogue";
import { greetingIds, pickLine } from "./npcTalk.ts";

describe("who says what", () => {
  it("guides greet with their catalogue greeting or their own lines; Sela with the line for your progress", () => {
    expect(greetingIds("lark", { won: 0, opened: false })).toEqual(["lark.greet.0", ...DIALOGUE.filter((l) => l.who === "lark" && l.kind === "greet").map((l) => l.id)]);
    expect(greetingIds("juno", { won: 0, opened: false })).toEqual(["juno.greet.1", "juno.greet.2"]);
    expect(greetingIds("sela", { won: 0, opened: false })).toEqual(["sela.none"]);
    expect(greetingIds("sela", { won: 2, opened: false })).toEqual(["sela.some"]);
    expect(greetingIds("sela", { won: 3, opened: false })).toEqual(["sela.all"]);
    expect(greetingIds("sela", { won: 3, opened: true })).toEqual(["sela.opened"]);
  });

  it("never repeats the last line when there is another", () => {
    for (let i = 0; i < 20; i++) expect(pickLine(["a", "b", "c"], "b", () => i / 20)).not.toBe("b");
    expect(pickLine(["a"], "a")).toBe("a");
    expect(pickLine([], undefined)).toBeNull();
  });
});
