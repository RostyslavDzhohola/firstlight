import { describe, expect, it } from "vitest";
import { minimapRange, minimapSize, preferredMinimapSize } from "./minimapLayout.ts";

const W = 1600, H = 900;
/** The live 1600×900 HUD: the tutorial panel, the player card, the hotbar and the save card. */
const TUTORIAL = { left: 23, top: 107, right: 328, bottom: 717 };
const CARD = { left: 23, top: 755, right: 404, bottom: 879 };
const HOTBAR = { left: 600, top: 790, right: 1000, bottom: 880 };
const SAVE = { left: 1280, top: 520, right: 1577, bottom: 880 };
const overlaps = (a: { left: number; top: number; right: number; bottom: number }, b: typeof a) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;

describe("minimap placement (top right, clear of the HUD)", () => {
  it("takes its full size on a normal screen with everything open", () => {
    const s = minimapSize({ right: 1577, top: 17 }, 176, 110, [TUTORIAL, CARD, HOTBAR, SAVE], W, H);
    expect(s).toBe(176);
    const r = { left: 1577 - s, top: 17, right: 1577, bottom: 17 + s };
    for (const a of [TUTORIAL, CARD, HOTBAR, SAVE]) expect(overlaps(r, a)).toBe(false);
  });

  it("shrinks above a tall save card on a short window, and hides when there's no room", () => {
    const save = { left: 330, top: 150, right: 620, bottom: 480 };
    const s = minimapSize({ right: 620, top: 14 }, 176, 110, [save, null], 640, 500);
    expect(s).toBeGreaterThanOrEqual(110);
    expect(14 + s).toBeLessThanOrEqual(150);
    expect(minimapSize({ right: 620, top: 14 }, 176, 110, [{ left: 0, top: 60, right: 640, bottom: 500 }], 640, 500)).toBe(0);
  });

  it("never pushes past the left edge or the bottom", () => {
    expect(minimapSize({ right: 100, top: 10 }, 176, 110, [], 120, 400)).toBe(0);
    expect(minimapSize({ right: 600, top: 10 }, 176, 110, [], 640, 150)).toBeLessThanOrEqual(140);
  });

  it("sizes with the window and shows more ground on the planets than in town", () => {
    expect(preferredMinimapSize(1280)).toBe(150);
    expect(preferredMinimapSize(1600)).toBe(176);
    expect(preferredMinimapSize(3840)).toBe(220);
    expect(minimapRange("portus")).toBeLessThan(minimapRange("arcadia"));
  });
});
