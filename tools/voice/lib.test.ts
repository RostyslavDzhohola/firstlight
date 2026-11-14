import { describe, expect, it } from "vitest";
import { RATE } from "../sfx/lib.ts";
import { SPOKEN_LINES } from "../../packages/shared/src/content/dialogue.ts";
import { CAST } from "./cast.ts";
import { stale, trimSpeech } from "./lib.ts";

describe("voice tool", () => {
  it("every speaker has a voice", () => {
    for (const l of SPOKEN_LINES) expect(CAST[l.speaker], l.speaker).toBeDefined();
  });

  it("records lines whose words changed or whose file is missing", () => {
    const lines = [{ id: "a", text: "one" }, { id: "b", text: "two" }, { id: "c", text: "three" }];
    const m = { model: "", kbps: 24, lines: { a: { k: "one", ms: 1 }, b: { k: "old", ms: 1 }, c: { k: "three", ms: 1 } } };
    expect(stale(lines, m, (t) => t, (id) => id !== "c")).toEqual(["b", "c"]);
  });

  it("cuts the silence around speech", () => {
    const x = new Float32Array(RATE * 2);
    for (let i = RATE / 2; i < RATE; i++) x[i] = Math.sin(i / 10) * 0.5;
    const y = trimSpeech(x);
    expect(y.length / RATE).toBeGreaterThan(0.5);
    expect(y.length / RATE).toBeLessThan(0.5 + 0.03 + 0.12 + 0.01);
  });
});
