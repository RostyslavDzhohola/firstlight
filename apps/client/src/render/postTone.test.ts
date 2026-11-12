import { describe, expect, it } from "vitest";
import { BODY_IDS } from "@firstlight/shared";
import { BODY_TONE, NEUTRAL_TONE, postUniforms, setTone, SPLIT_COOL, SPLIT_WARM, splitShift, toneCurve } from "./post.ts";

describe("the tone pass (D-gfx-hub-5)", () => {
  it("the S-curve keeps black, mid-grey and white where they were, deepens shadows and lifts highlights", () => {
    for (const k of [0, 0.2, 1]) {
      expect(toneCurve(0, k)).toBe(0);
      expect(toneCurve(0.5, k)).toBeCloseTo(0.5);
      expect(toneCurve(1, k)).toBe(1);
    }
    expect(toneCurve(0.2, 0.22)).toBeLessThan(0.2);
    expect(toneCurve(0.8, 0.22)).toBeGreaterThan(0.8);
    expect(toneCurve(0.3, 0)).toBe(0.3); // off: the grade's own picture
    // Monotonic: no banding or inversions at the strongest setting any body uses.
    const max = Math.max(...BODY_IDS.map((b) => BODY_TONE[b].contrast));
    for (let x = 0.01; x <= 1; x += 0.01) expect(toneCurve(x, max)).toBeGreaterThan(toneCurve(x - 0.01, max));
  });

  it("every body's curve is gentle (never over a quarter) and Portus is the warmest", () => {
    for (const b of BODY_IDS) {
      expect(BODY_TONE[b].contrast).toBeGreaterThan(0);
      expect(BODY_TONE[b].contrast).toBeLessThanOrEqual(0.25);
      expect(BODY_TONE[b].split).toBeLessThanOrEqual(BODY_TONE.portus.split);
    }
  });

  it("split toning warms highlights, cools shadows and leaves the mid-tones alone", () => {
    expect(splitShift(0.95, 0, 1)).toBeGreaterThan(0); // red up in the highlights
    expect(splitShift(0.95, 2, 1)).toBeLessThan(0); // blue down
    expect(splitShift(0.05, 2, 1)).toBeGreaterThan(0); // blue up in the shadows
    expect(splitShift(0.05, 0, 1)).toBeLessThan(0);
    for (const i of [0, 1, 2] as const) expect(splitShift(0.48, i, 1)).toBeCloseTo(0, 3);
    expect(splitShift(0.95, 0, 0)).toBeCloseTo(0);
    // Small shifts: a tint, not a filter.
    for (const v of [...SPLIT_WARM, ...SPLIT_COOL]) expect(Math.abs(v)).toBeLessThan(0.1);
  });

  it("setTone writes the shared uniforms (a body change builds nothing)", () => {
    setTone(BODY_TONE.portus);
    expect(postUniforms.toneContrast.value).toBe(BODY_TONE.portus.contrast);
    expect(postUniforms.toneSplit.value).toBe(BODY_TONE.portus.split);
    setTone(NEUTRAL_TONE);
    expect(postUniforms.toneContrast.value).toBe(0);
    expect(postUniforms.toneSplit.value).toBe(0);
  });
});
