import { describe, expect, it } from "vitest";
import { RATE } from "../sfx/lib.ts";
import { SPOKEN_LINES } from "../../packages/shared/src/content/dialogue.ts";
import { CAST } from "./cast.ts";
import { judge, stale, TARGET_LUFS, trimSpeech, voiceHome } from "./lib.ts";

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

  it("judges a recording by its measurements", () => {
    const ok = { sec: 3, lufs: TARGET_LUFS, peak: -2, flat: 0, gap: 0.4, speaker: "a", manifestMs: 3000 };
    const xs = [
      { ...ok, id: "fine", text: "x".repeat(45) },
      { ...ok, id: "fine2", text: "x".repeat(42) },
      { ...ok, id: "quiet", text: "x".repeat(45), lufs: TARGET_LUFS - 1.2 }, // over 1 LU under the others
      { ...ok, id: "near", text: "x".repeat(45), lufs: TARGET_LUFS - 0.9 },
      { ...ok, id: "silent", text: "x".repeat(45), lufs: -70 },
      { ...ok, id: "hot", text: "x".repeat(45), peak: -0.2, flat: 3 },
      { ...ok, id: "cut", text: "x".repeat(90) }, // half the time a line this long needs: cut off
      { ...ok, id: "stall", text: "x".repeat(45), gap: 2 },
      { ...ok, id: "long", text: "x".repeat(140), sec: 9.5, manifestMs: 9500 },
      { ...ok, id: "stale", text: "x".repeat(45), manifestMs: 2000 },
    ];
    const why = Object.fromEntries(judge(xs).map((v) => [v.id, v.why.join("; ")]));
    expect(why.fine).toBe("");
    expect(why.fine2).toBe("");
    expect(why.quiet).toMatch(/loudness/);
    expect(why.near).toBe("");
    expect(why.silent).toMatch(/silent/);
    expect(why.hot).toMatch(/clipped/);
    expect(why.cut).toMatch(/pace/);
    expect(why.stall).toMatch(/pause/);
    expect(why.long).toMatch(/length/);
    expect(why.stale).toMatch(/manifest/);
  });

  it("the model environment lives outside the repo, FL_VOICE_HOME first", () => {
    expect(voiceHome({ FL_VOICE_HOME: "/x/voice" })).toBe("/x/voice");
    expect(voiceHome({})).toMatch(/\.cache\/firstlight-voice$/);
  });
});
